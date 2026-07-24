/**
 * RoomDO —— 一个房间一个 Durable Object 实例。
 *
 * 已交付：
 *  阶段1 Seat 身份模型（令牌/PIN/三级恢复/按 seatId 广播/席位互斥/无房主）
 *  阶段3 服务端权威可见性（全部下发过 visibility 闸门）
 *  阶段4 运行时引擎（状态机 / 服务端计时 / 主持人播报 / 防卡车提示 / 阅读进度 / 搜证 / 投票 / 复盘）
 *
 * 休眠安全：连接↔席位映射存在 WebSocket attachment；计时用 DO Alarm，
 * 二者都不依赖内存变量，实例被回收后行为不变。
 *
 * 【防剧透】本文件只处理 id 与 key，绝不内联正文；所有正文经 content.resolveMany
 * 在通过 entitledKeys 闸门之后才解析。
 */

import {
  ClientMsg, ConnAttachment, ERR, Phase, RoomState, Seat, SeatPublic, SnapshotFull,
} from "./types";
import { hashPin, hashToken, newId, newSalt, newSeatToken, timingSafeEqual } from "./crypto";
import { getSkeleton, hasSkeleton, isGranted, Skeleton } from "./skeleton";
import { getContent } from "./content";
import {
  availableLocations, clueVisibleToCharacter, entitledKeys, locationRemaining,
  searchCandidates, visibleClues, VisibilityCtx,
} from "./visibility";
import { getMechanic } from "./mechanics";
import { lockOneCorrect, revealDecoy, TimelineState } from "./mechanics/timeline_puzzle";

const K_ROOM = "room";
const K_SEATS = "seats";

type SeatMap = Record<string, Seat>;

/**
 * 从机制投影里挑出所有 content key（字段名以 Key 结尾的字符串）。
 * 机制自己决定投给谁哪一个 key，这里只负责把它们解析成正文。
 */
function collectKeys(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) collectKeys(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string" && k.endsWith("Key")) out.add(v);
    else collectKeys(v, out);
  }
  return out;
}

export class RoomDO implements DurableObject {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
  }

  // ================= 存储 =================

  private async getRoom(roomId: string, scriptId = "placeholder"): Promise<RoomState> {
    const r = await this.ctx.storage.get<RoomState>(K_ROOM);
    if (r) {
      // 剧本被改名或下架后，老房间会指向一个不存在的 id。
      // 不接住的话 getSkeleton 抛错 → DO 返回 500 → WebSocket 握手直接失败，
      // 玩家只会看到「连接失败」，连房间坏在哪都不知道。
      if (!hasSkeleton(r.scriptId)) {
        r.scriptId = "placeholder";
        r.phase = "ended";                 // 老局已经没法继续了，让它体面地结束
        await this.ctx.storage.put(K_ROOM, r);
      }
      return r;
    }
    const sk = getSkeleton(hasSkeleton(scriptId) ? scriptId : "placeholder");
    const fresh: RoomState = {
      roomId,
      scriptId: sk.scriptId,
      phase: "lobby",
      actIndex: -1,
      actStartedAt: null,
      actEndsAt: null,
      seatCount: sk.meta.players,
      createdAt: Date.now(),
      config: {},
      unlockedClues: [],
      narrationLog: [],
      hintsFired: [],
      debriefUnlocked: [],
      votes: {},
      mechanics: {},
      chat: [],
    };
    await this.ctx.storage.put(K_ROOM, fresh);
    return fresh;
  }

  private async mustGetRoom(): Promise<RoomState | null> {
    return (await this.ctx.storage.get<RoomState>(K_ROOM)) ?? null;
  }

  private async putRoom(r: RoomState): Promise<void> {
    await this.ctx.storage.put(K_ROOM, r);
  }

  private async getSeats(): Promise<SeatMap> {
    return (await this.ctx.storage.get<SeatMap>(K_SEATS)) ?? {};
  }

  private async putSeats(seats: SeatMap): Promise<void> {
    await this.ctx.storage.put(K_SEATS, seats);
  }

  private sk(room: RoomState): Skeleton {
    return getSkeleton(room.scriptId);
  }

  // ================= 连接 ↔ 席位 =================

  private attachmentOf(ws: WebSocket): ConnAttachment | null {
    try {
      return (ws.deserializeAttachment() as ConnAttachment) ?? null;
    } catch {
      return null;
    }
  }

  private socketsOfSeat(seatId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => this.attachmentOf(ws)?.seatId === seatId);
  }

  private onlineSeatIds(): Set<string> {
    const s = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachmentOf(ws);
      if (a?.seatId) s.add(a.seatId);
    }
    return s;
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* 连接失效，由 close 清理 */
    }
  }

  private broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (!this.attachmentOf(ws)?.seatId) continue;
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  private sendToSeat(seatId: string, payload: unknown): void {
    for (const ws of this.socketsOfSeat(seatId)) this.send(ws, payload);
  }

  // ================= 视图与快照 =================

  private ctxFor(room: RoomState, seat: Seat): VisibilityCtx {
    return {
      phase: room.phase,
      actIndex: room.actIndex,
      characterId: seat.characterId,
      unlockedClueIds: room.unlockedClues.map((u) => u.clueId),
      publishedClueIds: room.unlockedClues.filter((u) => u.published).map((u) => u.clueId),
      myClueIds: room.unlockedClues.filter((u) => u.bySeatId === seat.seatId).map((u) => u.clueId),
      debriefUnlocked: room.debriefUnlocked,
      completedMechanics: Object.entries(room.mechanics)
        .filter(([mid, s]) => {
          const impl = getMechanic(mid);
          return !!impl && s !== undefined && impl.isComplete(s);
        })
        .map(([mid]) => mid),
    };
  }

  private seatsPublic(seats: SeatMap): SeatPublic[] {
    const online = this.onlineSeatIds();
    return Object.values(seats)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((s) => ({
        seatId: s.seatId,
        displayName: s.displayName,
        characterId: s.characterId,
        online: online.has(s.seatId),
        ready: s.ready,
        readProgress: s.readProgress,
      }));
  }

  /** 快照：所有正文都经 entitledKeys 闸门后才解析 */
  private snapshot(room: RoomState, seats: SeatMap, me: Seat, seatToken?: string): SnapshotFull {
    const sk = this.sk(room);
    const vctx = this.ctxFor(room, me);
    const allowed = entitledKeys(sk, vctx);
    const content = getContent(room.scriptId).resolveMany([...allowed]);

    const act = room.actIndex >= 0 ? sk.acts[room.actIndex] : null;
    const byId = new Map(room.unlockedClues.map((u) => [u.clueId, u]));
    const myClues = visibleClues(sk, vctx).map((c) => {
      const u = byId.get(c.id);
      return {
        id: c.id,
        titleKey: c.titleKey,
        contentKey: c.contentKey,
        location: c.location,
        private: c.visibility.type === "private",
        published: !!u?.published,
        mine: u?.bySeatId === me.seatId,
        byName: u?.published && u.bySeatId ? seats[u.bySeatId]?.displayName : undefined,
      };
    });

    // 已下发过的播报（重连时补齐），同样只回放本席位有权看到的
    const narration = room.narrationLog
      .filter((n) => allowed.has(n.key) || n.key.startsWith("nar.") || n.key.startsWith("end."))
      .map((n) => ({ key: n.key, at: n.at, text: getContent(room.scriptId).resolve(n.key) ?? "" }));

    const mechanic = this.mechanicView(room, sk, me);
    // 机制投影里出现的 content key 才解析。投影本身就是该机制的可见性闸门
    // （比如时间线：自己的碎片给全文 key，别人的只给摘要 key），
    // 所以这里照单解析是安全的——越权的 key 根本不会出现在投影里。
    if (mechanic) {
      const src = getContent(room.scriptId);
      for (const k of collectKeys(mechanic.state)) {
        const t = src.resolve(k);
        if (t !== null && t !== undefined) content[k] = t;
      }
    }

    const snap: SnapshotFull = {
      type: "snapshot.full",
      room: {
        roomId: room.roomId,
        phase: room.phase,
        actIndex: room.actIndex,
        actEndsAt: room.actEndsAt,
        seatCount: room.seatCount,
        serverNow: Date.now(),
      },
      me: {
        seatId: me.seatId,
        displayName: me.displayName,
        characterId: me.characterId,
        ready: me.ready,
        readProgress: me.readProgress,
        privateState: me.privateState,
      },
      seats: this.seatsPublic(seats),
      script: {
        scriptId: sk.scriptId,
        titleKey: sk.meta.titleKey,
        characters: sk.characters.map((c) => ({ id: c.id, nameKey: c.nameKey, briefKey: c.briefKey })),
        actCount: sk.acts.length,
        /** 仅当前幕的可搜地点与配额 */
        locations: act ? act.locations : [],
        locationNames: this.locationNames(sk, act ? act.locations : []),
        /** 其中「对我还有可搜线索」的子集：界面据此把搜空的地点置灰 */
        locationsAvailable: availableLocations(sk, vctx),
        locationRemaining: locationRemaining(sk, vctx),
        searchQuota: act ? act.searchQuota.perSeat : 0,
        searchUsed: me.searchUsed?.[room.actIndex] ?? 0,
        bgm: this.bgmFor(room, sk, act),
        /** 仅已开放幕的自己剧本 key */
        myScriptKeys: me.characterId
          ? sk.acts
              .slice(0, room.phase === "lobby" ? 0 : room.phase === "reading" ? 1 : room.actIndex + 1)
              .map((a) => a.scriptKeys[me.characterId!])
              .filter(Boolean)
          : [],
      },
      clues: myClues,
      vote: this.voteView(room, sk, me, Object.keys(seats).length),
      mechanic,
      debrief:
        room.phase === "debrief" || room.phase === "ended"
          ? sk.debrief.segments
              .filter((s) => room.debriefUnlocked.includes(s.id))
              .map((s) => ({ id: s.id, contentKey: s.contentKey }))
          : [],
      narration,
      chat: this.chatFor(room, seats, me),
      content,
    };
    if (seatToken) snap.seatToken = seatToken;
    return snap;
  }

  private voteView(room: RoomState, sk: Skeleton, me: Seat, seatCount: number) {
    const act = room.actIndex >= 0 ? sk.acts[room.actIndex] : null;
    if (!act) return null;
    const v = sk.votes.find((x) => x.act === act.id);
    if (!v) return null;
    // 有机制把守的投票，拼完之前不露面——连问题带选项都不下发
    const gate = this.voteGatedBy(sk, v.id);
    if (gate) {
      const impl = getMechanic(gate);
      const st = room.mechanics[gate];
      if (!impl || st === undefined || !impl.isComplete(st)) return null;
    }
    const ballots = room.votes[v.id] ?? {};

    // 匿名模式只回统计，不回「谁投了什么」
    let tally: Record<string, number> | undefined;
    if (v.mode !== "single_public") {
      tally = {};
      for (const choice of Object.values(ballots)) {
        for (const c of Array.isArray(choice) ? choice : [choice]) {
          tally[c] = (tally[c] ?? 0) + 1;
        }
      }
    }

    return {
      voteId: v.id,
      mode: v.mode,
      promptKey: v.promptKey,
      options: v.options.map((o) => ({ id: o.id, labelKey: o.labelKey })),
      myChoice: ballots[me.seatId] ?? null,
      castCount: Object.keys(ballots).length,
      seatCount,
      ballots: v.mode === "single_public" ? ballots : undefined,
      tally,
    };
  }

  /**
   * 地点 id → 中文名。两种剧本格式都要覆盖：
   *  - 外部包：顶层 locations 表，id=loc.counter，中文名在 loc.counter.name
   *  - 简写本：location 字段本身就是文案 key，content[id] 即中文名
   * 地点名是当前幕的公开信息，不涉及剧透。
   */
  private locationNames(sk: Skeleton, locs: string[]): Record<string, string> {
    const src = getContent(sk.scriptId);
    const table = new Map((sk.locations ?? []).map((l) => [l.id, l]));
    const out: Record<string, string> = {};
    for (const id of locs) {
      const def = table.get(id);
      out[id] = (def?.nameKey && src.resolve(def.nameKey)) || src.resolve(id) || id;
    }
    return out;
  }

  /**
   * 当前阶段该放的 BGM。**剧本没声明就是没有**，不做任何兜底——
   * 三小时的底噪只会吵到人，念白听不清。想配乐的本自己在 skeleton 里声明。
   */
  private bgmFor(room: RoomState, sk: Skeleton, act: { id: string } | null): string | null {
    const a = sk.audio;
    if (!a) return null;
    if (room.phase === "debrief" || room.phase === "ended") return a.bgmDebrief ?? null;
    if (room.phase === "playing" && act) return a.bgmByAct?.[act.id] ?? a.bgmLobby ?? null;
    return a.bgmLobby ?? null;
  }

  /** 当前幕的机制（按席位投影） */
  private mechanicView(room: RoomState, sk: Skeleton, me: Seat) {
    const act = room.actIndex >= 0 ? sk.acts[room.actIndex] : null;
    if (!act || !act.mechanics.length) return null;
    const mid = act.mechanics[0];
    const impl = getMechanic(mid);
    const st = room.mechanics[mid];
    if (!impl || st === undefined) return null;
    return {
      mechanicId: mid,
      state: impl.projectFor(st, me.seatId),
      complete: impl.isComplete(st),
    };
  }

  /**
   * 开幕自动下发的线索（grant: on_act_start）。
   * 这类线索没有地点、不进搜证池，开幕就直接进对应席位的背包——
   * 可见性仍由 entitledKeys 裁决，这里只负责把它标记为「已解锁」。
   */
  private grantActStartClues(room: RoomState, sk: Skeleton, actId: string): void {
    for (const c of sk.clues) {
      if (c.act !== actId || !isGranted(c)) continue;
      if (room.unlockedClues.some((u) => u.clueId === c.id)) continue;
      room.unlockedClues.push({ clueId: c.id, bySeatId: "", at: Date.now() });
    }
  }

  /**
   * 机制自带的分阶段提示（在 mechanics[].params.hints 里，与幕的 hints 分开）。
   * 支持按经过时间（afterMin）和按校对次数（afterAttempts）两种触发，
   * 并可带效果：锁定一个已摆对的格子 / 点破干扰项。
   */
  private fireMechanicHints(room: RoomState, sk: Skeleton, mid: string, now: number): void {
    const decl = sk.mechanics.find((m) => m.id === mid);
    const hints = Array.isArray(decl?.params?.hints)
      ? (decl!.params.hints as { afterMin?: number; afterAttempts?: number; narrationKey: string; effect?: string }[])
      : [];
    if (!hints.length) return;

    const st = room.mechanics[mid] as { checks?: number } | undefined;
    const attempts = Number(st?.checks ?? 0);
    const elapsedMin = room.actStartedAt ? (now - room.actStartedAt) / 60_000 : 0;

    for (const h of hints) {
      if (room.hintsFired.includes(h.narrationKey)) continue;
      const byTime = h.afterMin !== undefined && elapsedMin >= h.afterMin;
      const byTries = h.afterAttempts !== undefined && attempts >= h.afterAttempts;
      if (!byTime && !byTries) continue;

      room.hintsFired.push(h.narrationKey);
      if (h.effect === "lock_one_correct") {
        room.mechanics[mid] = lockOneCorrect(room.mechanics[mid] as TimelineState);
      } else if (h.effect === "reveal_decoy") {
        room.mechanics[mid] = revealDecoy(room.mechanics[mid] as TimelineState);
      }
      this.pushNarration(room, h.narrationKey, "hint");
    }
  }

  /** 同步版播报：记入回放日志并广播。narrate 的同步形态，供非 async 路径调用 */
  private pushNarration(room: RoomState, key: string, style: string): void {
    const text = getContent(room.scriptId).resolve(key);
    if (text === null || text === undefined) return;
    room.narrationLog.push({ key, at: Date.now() });
    this.broadcast({ type: "narration", key, text, style, serverNow: Date.now() });
  }

  /** 机制刚刚完成：放揭示播报、解锁它挂的线索、开放它把守的投票 */
  private onMechanicComplete(room: RoomState, sk: Skeleton, mid: string): void {
    const oc = sk.mechanics.find((m) => m.id === mid)?.params?.onComplete as
      | { narrationKey?: string; unlockClues?: string[] }
      | undefined;
    if (!oc) return;
    for (const id of oc.unlockClues ?? []) {
      if (!sk.clues.some((c) => c.id === id)) continue;
      if (room.unlockedClues.some((u) => u.clueId === id)) continue;
      room.unlockedClues.push({ clueId: id, bySeatId: "", at: Date.now() });
    }
    if (oc.narrationKey && !room.hintsFired.includes(oc.narrationKey)) {
      room.hintsFired.push(oc.narrationKey);
      this.pushNarration(room, oc.narrationKey, "reveal");
    }
  }

  /** 该机制是否把守着某个投票（拼完之前不开票） */
  private voteGatedBy(sk: Skeleton, voteId: string): string | null {
    for (const m of sk.mechanics) {
      const oc = m.params?.onComplete as { openVote?: string } | undefined;
      if (oc?.openVote === voteId) return m.id;
    }
    return null;
  }

  /** 进入某幕时初始化该幕声明的机制 */
  private initMechanics(room: RoomState, sk: Skeleton, seats: SeatMap, actIndex: number): void {
    const act = sk.acts[actIndex];
    for (const mid of act.mechanics ?? []) {
      const impl = getMechanic(mid);
      if (!impl || room.mechanics[mid] !== undefined) continue;
      const decl = sk.mechanics.find((m) => m.id === mid);
      room.mechanics[mid] = impl.init(
        decl?.params ?? {},
        Object.values(seats).map((s) => ({ seatId: s.seatId, characterId: s.characterId }))
      );
    }
  }

  /** 该幕声明的机制是否全部完成 */
  private mechanicsDone(room: RoomState, sk: Skeleton): boolean {
    const act = sk.acts[room.actIndex];
    if (!act) return true;
    for (const mid of act.mechanics ?? []) {
      const impl = getMechanic(mid);
      const st = room.mechanics[mid];
      if (impl && st !== undefined && !impl.isComplete(st)) return false;
    }
    return true;
  }

  /** 服务端过滤：公开发言人人可见；私聊只给收发双方 */
  private chatFor(room: RoomState, seats: SeatMap, me: Seat) {
    const nameOf = (sid: string | null) => (sid ? seats[sid]?.displayName ?? "?" : null);
    return room.chat
      .filter((m) => m.to === null || m.from === me.seatId || m.to === me.seatId)
      .slice(-200)
      .map((m) => ({ ...m, fromName: nameOf(m.from) ?? "?", toName: nameOf(m.to) }));
  }

  private async pushSnapshotAll(room: RoomState, seats: SeatMap): Promise<void> {
    for (const seat of Object.values(seats)) {
      this.sendToSeat(seat.seatId, this.snapshot(room, seats, seat));
    }
  }

  private broadcastSeats(seats: SeatMap): void {
    this.broadcast({ type: "seats.updated", seats: this.seatsPublic(seats), serverNow: Date.now() });
  }

  // ================= 主持人播报 =================

  /** 记录并推送播报。正文在此刻解析（播报对全体可见） */
  private async narrate(room: RoomState, key: string, style = "normal"): Promise<void> {
    const text = getContent(room.scriptId).resolve(key);
    if (text === null) return;
    room.narrationLog.push({ key, at: Date.now() });
    this.broadcast({ type: "narration", key, text, style, serverNow: Date.now() });
  }

  // ================= 计时器（DO Alarm） =================

  /** 下一次唤醒 = min(下一条未触发的提示, 本幕截止) */
  private async scheduleAlarm(room: RoomState): Promise<void> {
    if (room.phase !== "playing" || room.actIndex < 0 || !room.actStartedAt) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const sk = this.sk(room);
    const act = sk.acts[room.actIndex];
    const times: number[] = [];
    for (const h of act.hints) {
      const at = room.actStartedAt + h.afterMin * 60_000;
      if (!room.hintsFired.includes(h.narrationKey) && at > Date.now()) times.push(at);
    }
    // 机制自带的定时提示也要唤醒 DO，否则休眠期间永远不会放
    for (const mid of act.mechanics ?? []) {
      const hints = sk.mechanics.find((m) => m.id === mid)?.params?.hints;
      for (const h of Array.isArray(hints) ? (hints as { afterMin?: number; narrationKey: string }[]) : []) {
        if (h.afterMin === undefined || room.hintsFired.includes(h.narrationKey)) continue;
        const at = room.actStartedAt + h.afterMin * 60_000;
        if (at > Date.now()) times.push(at);
      }
    }
    if (room.actEndsAt && room.actEndsAt > Date.now()) times.push(room.actEndsAt);
    if (!times.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  /** DO 唤醒：放提示 / 幕超时推进。休眠期间也会准时触发 */
  async alarm(): Promise<void> {
    const room = await this.mustGetRoom();
    if (!room || room.phase !== "playing" || room.actIndex < 0 || !room.actStartedAt) return;
    const seats = await this.getSeats();
    const act = this.sk(room).acts[room.actIndex];
    const now = Date.now();

    // 防卡车提示
    for (const h of act.hints) {
      const at = room.actStartedAt + h.afterMin * 60_000;
      if (now >= at && !room.hintsFired.includes(h.narrationKey)) {
        room.hintsFired.push(h.narrationKey);
        await this.narrate(room, h.narrationKey, "hint");
      }
    }
    // 机制自带的定时提示（可能带锁定/点破效果）
    for (const mid of act.mechanics ?? []) this.fireMechanicHints(room, this.sk(room), mid, now);

    // 幕超时
    if (room.actEndsAt && now >= room.actEndsAt && act.advance.type !== "all_ready") {
      await this.putRoom(room);
      return this.advance(room, seats, "timeout");
    }

    await this.putRoom(room);
    await this.scheduleAlarm(room);
    await this.pushSnapshotAll(room, seats);
  }

  // ================= 状态机 =================

  private allSeated(seats: SeatMap, room: RoomState): boolean {
    return Object.keys(seats).length >= room.seatCount;
  }

  private allPickedCharacter(seats: SeatMap): boolean {
    return Object.values(seats).every((s) => !!s.characterId);
  }

  /**
   * 「读完了」只认玩家自己点的就绪，不认滚动进度。
   * 否则有人一拉到底就被判定读完，整幕直接被跳过。
   * readProgress 仅用于让大家看到彼此的阅读进度条。
   */
  private allRead(seats: SeatMap): boolean {
    return Object.values(seats).every((s) => s.ready);
  }

  private allReady(seats: SeatMap): boolean {
    return Object.values(seats).every((s) => s.ready);
  }

  private voteDone(room: RoomState, sk: Skeleton, seats: SeatMap): boolean {
    const act = sk.acts[room.actIndex];
    const v = sk.votes.find((x) => x.act === act?.id);
    if (!v) return true;
    return Object.keys(room.votes[v.id] ?? {}).length >= Object.keys(seats).length;
  }

  /** lobby → reading：坐满且全员选定角色（随机意向由此统一指派） */
  private async tryStart(room: RoomState, seats: SeatMap): Promise<boolean> {
    if (room.phase !== "lobby") return false;
    if (!this.allSeated(seats, room)) return false;

    const sk = this.sk(room);
    const wantRandom = Object.values(seats).filter(
      (s) => !s.characterId && s.privateState?.wantRandom
    );
    const undecided = Object.values(seats).filter((s) => !s.characterId && !s.privateState?.wantRandom);
    if (undecided.length) return false;

    // 引擎统一随机指派，避免与客户端各自随机打架
    const taken = new Set(Object.values(seats).map((s) => s.characterId).filter(Boolean) as string[]);
    const free = sk.characters.map((c) => c.id).filter((id) => !taken.has(id));
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    for (const s of wantRandom) s.characterId = free.pop() ?? null;

    room.phase = "reading";
    room.actIndex = 0;
    for (const s of Object.values(seats)) {
      s.ready = false;
      s.readProgress = 0;
    }
    await this.putSeats(seats);
    await this.putRoom(room);
    return true;
  }

  /** 进入某一幕：重置就绪、开计时、放开场播报 */
  private async enterAct(room: RoomState, seats: SeatMap, index: number): Promise<void> {
    const sk = this.sk(room);
    const act = sk.acts[index];
    room.phase = "playing";
    room.actIndex = index;
    room.actStartedAt = Date.now();
    room.actEndsAt = Date.now() + act.durationMin * 60_000;
    for (const s of Object.values(seats)) {
      s.ready = false;
      s.searchUsed = { ...(s.searchUsed ?? {}), [index]: 0 };
    }
    this.initMechanics(room, sk, seats, index);
    this.grantActStartClues(room, sk, act.id);
    await this.putSeats(seats);
    await this.narrate(room, act.openingNarrationKey, "act-open");
    await this.putRoom(room);
    await this.scheduleAlarm(room);
    this.broadcast({
      type: "act.changed",
      actIndex: index,
      actEndsAt: room.actEndsAt,
      serverNow: Date.now(),
    });
  }

  /** 推进：收束播报 → 下一幕 / 复盘 */
  private async advance(room: RoomState, seats: SeatMap, reason: string): Promise<void> {
    const sk = this.sk(room);

    if (room.phase === "reading") {
      await this.enterAct(room, seats, 0);
      await this.pushSnapshotAll(room, seats);
      return;
    }

    if (room.phase !== "playing") return;

    const act = sk.acts[room.actIndex];
    // 最后一幕可以不写收束播报（外部包的 act3 就是 null），直接进结算
    if (act.closingNarrationKey) await this.narrate(room, act.closingNarrationKey, "act-close");

    if (room.actIndex + 1 < sk.acts.length) {
      await this.enterAct(room, seats, room.actIndex + 1);
    } else {
      // 最终投票结算 → 复盘
      await this.settleFinalVote(room, sk, seats);
      room.phase = "debrief";
      room.actEndsAt = null;
      await this.ctx.storage.deleteAlarm();
      await this.putRoom(room);
      this.broadcast({ type: "phase.changed", phase: room.phase, serverNow: Date.now() });
    }
    await this.pushSnapshotAll(room, seats);
    this.broadcast({ type: "advanced", reason, serverNow: Date.now() });
  }

  /** 按完整票型分支结算 */
  private async settleFinalVote(room: RoomState, sk: Skeleton, seats: SeatMap): Promise<void> {
    const act = sk.acts[room.actIndex];
    const v = sk.votes.find((x) => x.act === act?.id);
    if (!v) return;
    const ballots = room.votes[v.id] ?? {};
    const choices = Object.values(ballots);
    if (!choices.length) return;

    // 单选看是否一致；ranked/multi 看首选项是否一致
    const primary = choices.map((c) => (Array.isArray(c) ? c[0] : c));
    const uniq = [...new Set(primary)];
    let match = "split";
    if (uniq.length === 1) {
      match = "unanimous_" + uniq[0];
    } else {
      // 严格多数（过半，且没有并列第一）单独成一档：3 人的 2:1、5 人的 3:2
      // 才是最常见的收场，全塞进 split 的话大多数局都拿到同一个兜底结尾。
      const count = new Map<string, number>();
      for (const p of primary) count.set(p, (count.get(p) ?? 0) + 1);
      const rank = [...count.entries()].sort((a, b) => b[1] - a[1]);
      const leadsAlone = rank.length < 2 || rank[0][1] > rank[1][1];
      if (leadsAlone && rank[0][1] * 2 > primary.length) match = "majority_" + rank[0][0];
    }

    const branch =
      v.resultBranches.find((b) => b.match === match) ??
      // 剧本没写这一档就退回 split，老剧本不受影响
      v.resultBranches.find((b) => b.match === "split");
    if (branch) await this.narrate(room, branch.narrationKey, "ending");
  }

  /** 每次可能改变推进条件时调用 */
  private async checkAdvance(room: RoomState, seats: SeatMap): Promise<void> {
    const sk = this.sk(room);

    if (room.phase === "lobby") {
      if (await this.tryStart(room, seats)) {
        await this.pushSnapshotAll(room, seats);
        this.broadcast({ type: "phase.changed", phase: room.phase, serverNow: Date.now() });
      }
      return;
    }

    if (room.phase === "reading") {
      if (this.allRead(seats)) await this.advance(room, seats, "all_read");
      return;
    }

    if (room.phase !== "playing") return;

    const act = sk.acts[room.actIndex];
    const req = act.advance.requires ?? [];
    const reqOk =
      (!req.includes("all_read") || this.allRead(seats)) &&
      (!req.includes("vote_done") || this.voteDone(room, sk, seats)) &&
      (!req.includes("mechanic_done") || this.mechanicsDone(room, sk));

    if (act.advance.type !== "timeout" && this.allReady(seats) && reqOk) {
      await this.advance(room, seats, "all_ready");
    }
  }

  // ================= 入座 / 恢复 =================

  private async bindConnection(ws: WebSocket, seatId: string): Promise<void> {
    ws.serializeAttachment({ seatId, connId: newId("conn") } satisfies ConnAttachment);
  }

  private async claim(ws: WebSocket, room: RoomState, name: string, pin: string) {
    const seats = await this.getSeats();
    const list = Object.values(seats);
    if (room.phase !== "lobby") {
      return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "游戏已开始，无法加入" });
    }
    if (list.some((s) => s.displayName === name)) {
      return this.send(ws, { type: "error", code: ERR.NAME_TAKEN, message: "这个昵称已经有人用了" });
    }
    if (list.length >= room.seatCount) {
      return this.send(ws, { type: "error", code: ERR.ROOM_FULL, message: "房间已满" });
    }

    const token = newSeatToken();
    const salt = newSalt();
    const seat: Seat = {
      seatId: newId("seat"),
      seatTokenHash: await hashToken(token),
      pinHash: await hashPin(pin, salt),
      pinSalt: salt,
      displayName: name,
      characterId: null,
      readProgress: 0,
      ready: false,
      searchUsed: {},
      privateState: {},
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    seats[seat.seatId] = seat;
    await this.putSeats(seats);
    await this.bindConnection(ws, seat.seatId);

    this.send(ws, this.snapshot(room, seats, seat, token));
    this.broadcastSeats(seats);
    await this.checkAdvance(room, seats);
  }

  private async resume(ws: WebSocket, room: RoomState, token: string) {
    const seats = await this.getSeats();
    const wanted = await hashToken(token);
    const seat = Object.values(seats).find((s) => timingSafeEqual(s.seatTokenHash, wanted));
    if (!seat) {
      return this.send(ws, { type: "error", code: ERR.BAD_TOKEN, message: "专属链接无效或房间已重置" });
    }
    await this.attachToSeat(ws, room, seats, seat);
  }

  private async recover(ws: WebSocket, room: RoomState, name: string, pin: string) {
    const seats = await this.getSeats();
    const seat = Object.values(seats).find((s) => s.displayName === name);
    if (!seat) {
      return this.send(ws, { type: "error", code: ERR.SEAT_NOT_FOUND, message: "没有这个昵称的席位" });
    }
    const given = await hashPin(pin, seat.pinSalt);
    if (!timingSafeEqual(seat.pinHash, given)) {
      return this.send(ws, { type: "error", code: ERR.BAD_PIN, message: "PIN 不正确" });
    }
    await this.attachToSeat(ws, room, seats, seat);
  }

  private async attachToSeat(ws: WebSocket, room: RoomState, seats: SeatMap, seat: Seat) {
    for (const old of this.socketsOfSeat(seat.seatId)) {
      this.send(old, { type: "seat.elsewhere", message: "你的席位已在其他设备打开", serverNow: Date.now() });
    }
    seat.lastSeenAt = Date.now();
    seats[seat.seatId] = seat;
    await this.putSeats(seats);
    await this.bindConnection(ws, seat.seatId);
    this.send(ws, this.snapshot(room, seats, seat));
    this.broadcastSeats(seats);
  }

  // ================= 席位动作 =================

  private async withSeat(
    ws: WebSocket,
    room: RoomState,
    fn: (seat: Seat, seats: SeatMap) => Promise<string | void> | string | void
  ) {
    const att = this.attachmentOf(ws);
    if (!att?.seatId) return this.send(ws, { type: "error", code: ERR.NOT_SEATED, message: "尚未入座" });
    const seats = await this.getSeats();
    const seat = seats[att.seatId];
    if (!seat) return this.send(ws, { type: "error", code: ERR.SEAT_NOT_FOUND, message: "席位已不存在" });

    const err = await fn(seat, seats);
    if (typeof err === "string") {
      return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: err });
    }
    seat.lastSeenAt = Date.now();
    seats[seat.seatId] = seat;
    await this.putSeats(seats);
    await this.putRoom(room);
    await this.checkAdvance(room, seats);
    await this.pushSnapshotAll(room, seats);
    this.broadcastSeats(seats);
  }

  // ================= WebSocket 生命周期 =================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    /**
     * 开新局占号：只由 Worker 侧调用（见 index.ts 的 /api/newroom）。
     * 以前是前端连开好几条 WebSocket 去试房号，手机在微信里很容易失败，
     * 而且失败一次整个「开一局新的」就没反应了。改成服务端一次定好。
     */
    if (url.pathname === "/alloc") {
      const existing = await this.mustGetRoom();
      const seats = await this.getSeats();
      const empty = Object.keys(seats).length === 0;
      if (existing && !empty) return Response.json({ free: false });

      const want = url.searchParams.get("script") ?? "placeholder";
      // 空房但剧本不是想要的那个（多半是以前探号留下的残壳）：没人坐过，重置无损
      if (existing && empty && existing.scriptId !== want && existing.phase === "lobby") {
        await this.ctx.storage.deleteAll();
      }
      await this.getRoom(url.searchParams.get("room") ?? "0000", want);
      return Response.json({ free: true });
    }

    // script 仅在房间首次创建时生效；已存在的房间不会被后来者改剧本
    const room = await this.getRoom(
      url.searchParams.get("room") ?? "0000",
      url.searchParams.get("script") ?? "placeholder"
    );
    const seats = await this.getSeats();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    // 未入座前只给最小信息，绝不含任何剧本正文
    this.send(server, {
      type: "hello",
      room: {
        roomId: room.roomId,
        phase: room.phase,
        seatCount: room.seatCount,
        seatsTaken: Object.keys(seats).length,
        takenNames: Object.values(seats).map((s) => s.displayName),
      },
      serverNow: Date.now(),
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "bad json" });
    }

    const room = await this.mustGetRoom();
    if (!room) {
      return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "房间状态丢失，请重新连接" });
    }
    const sk = this.sk(room);

    switch (msg.type) {
      case "ping":
        return this.send(ws, { type: "pong", serverNow: Date.now() });

      case "snapshot.request": {
        const att = this.attachmentOf(ws);
        if (!att?.seatId) return this.send(ws, { type: "error", code: ERR.NOT_SEATED, message: "尚未入座" });
        const seats = await this.getSeats();
        const seat = seats[att.seatId];
        if (!seat) return this.send(ws, { type: "error", code: ERR.SEAT_NOT_FOUND, message: "席位已不存在" });
        return this.send(ws, this.snapshot(room, seats, seat));
      }

      case "seat.claim": {
        const name = String(msg.displayName ?? "").trim().slice(0, 12);
        const pin = String(msg.pin ?? "");
        if (!name) return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "请输入昵称" });
        if (!/^\d{4}$/.test(pin))
          return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "PIN 必须是4位数字" });
        return this.claim(ws, room, name, pin);
      }

      case "seat.resume": {
        const t = String(msg.seatToken ?? "");
        if (!t) return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "缺少令牌" });
        return this.resume(ws, room, t);
      }

      case "seat.recover": {
        const name = String(msg.displayName ?? "").trim();
        const pin = String(msg.pin ?? "");
        if (!name || !/^\d{4}$/.test(pin))
          return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "昵称或 PIN 格式不对" });
        return this.recover(ws, room, name, pin);
      }

      case "character.pick":
        return this.withSeat(ws, room, (seat, seats) => {
          if (room.phase !== "lobby") return "游戏已开始，不能换角色";
          if (msg.random) {
            seat.characterId = null;
            seat.privateState = { ...seat.privateState, wantRandom: true };
            return;
          }
          const cid = String(msg.characterId ?? "");
          if (!sk.characters.some((c) => c.id === cid)) return "角色不存在";
          if (Object.values(seats).some((s) => s.seatId !== seat.seatId && s.characterId === cid))
            return "该角色已被选择";
          seat.characterId = cid;
          seat.privateState = { ...seat.privateState, wantRandom: false };
        });

      case "read.progress": {
        // 进度上报单独走一条轻量路径，**不能**用 withSeat：后者每次都会 pushSnapshotAll，
        // 而玩家一滚动就上报，等于自己把全量快照拉回来、被前端重渲染弹回顶部——读不下去。
        // 进度只影响别人看到的进度条，用 seats.updated 广播即可，绝不回推 snapshot.full。
        const att = this.attachmentOf(ws);
        if (!att?.seatId) return;
        const seats = await this.getSeats();
        const seat = seats[att.seatId];
        if (!seat) return;
        const p = Number(msg.progress);
        if (!Number.isFinite(p)) return;
        const next = Math.max(seat.readProgress, Math.min(1, Math.max(0, p)));
        if (next === seat.readProgress) return;   // 没变化就不广播，省流量
        seat.readProgress = next;
        seat.lastSeenAt = Date.now();
        await this.putSeats(seats);
        this.broadcastSeats(seats);
        return;
      }

      case "act.ready":
        return this.withSeat(ws, room, (seat) => {
          seat.ready = true;
        });

      case "clue.unlock":
        return this.withSeat(ws, room, (seat, seats) => {
          if (room.phase !== "playing") return "当前不是搜证阶段";
          const act = sk.acts[room.actIndex];
          const used = seat.searchUsed?.[room.actIndex] ?? 0;
          if (used >= act.searchQuota.perSeat) return "本幕搜证次数已用完";

          const loc = String(msg.locationId ?? "");
          const vctx = this.ctxFor(room, seat);
          const cands = searchCandidates(sk, vctx, loc);
          if (!act.locations.includes(loc)) return "没有这个地点";
          if (!cands.length) return "这里已经搜不到新线索了（不消耗次数）";

          const clue = cands[Math.floor(Math.random() * cands.length)];
          room.unlockedClues.push({ clueId: clue.id, bySeatId: seat.seatId, at: Date.now() });
          seat.searchUsed = { ...(seat.searchUsed ?? {}), [room.actIndex]: used + 1 };

          // 私有线索只推给有权的席位；公开线索随各自快照下发
          this.sendToSeat(seat.seatId, {
            type: "clue.granted",
            clue: {
              id: clue.id,
              contentKey: clue.contentKey,
              location: clue.location,
              private: clue.visibility.type === "private",
            },
            text: getContent(room.scriptId).resolve(clue.contentKey) ?? "",
            serverNow: Date.now(),
          });
        });

      case "clue.publish":
        return this.withSeat(ws, room, (seat) => {
          const id = String(msg.clueId ?? "");
          const u = room.unlockedClues.find((x) => x.clueId === id);
          if (!u) return "这条线索还没被找到";
          if (u.published) return "这条线索已经公开了";
          // 只有持有者能摊牌。开幕自动下发的（bySeatId 为空）由角色归属判定
          const clue = sk.clues.find((c) => c.id === id);
          const owned = u.bySeatId
            ? u.bySeatId === seat.seatId
            : !!clue && clueVisibleToCharacter(clue, seat.characterId);
          if (!owned) return "这不是你手上的线索";

          u.published = true;
          u.bySeatId = u.bySeatId || seat.seatId;
          this.broadcast({
            type: "clue.published",
            clueId: id,
            byName: seat.displayName,
            serverNow: Date.now(),
          });
        });

      case "vote.cast":
        return this.withSeat(ws, room, (seat) => {
          if (room.phase !== "playing") return "当前不是投票阶段";
          const act = sk.acts[room.actIndex];
          const v = sk.votes.find((x) => x.act === act?.id);
          if (!v || v.id !== String(msg.voteId ?? "")) return "投票不存在";
          const valid = new Set(v.options.map((o) => o.id));

          let choice: string | string[];
          if (v.mode === "ranked" || v.mode === "multi") {
            const arr = Array.isArray(msg.choice) ? msg.choice.map(String) : [];
            if (!arr.length) return "请至少选择一项";
            if (arr.some((c) => !valid.has(c))) return "选项不存在";
            if (new Set(arr).size !== arr.length) return "不能重复选择同一项";
            if (v.mode === "ranked" && arr.length !== v.options.length) return "排序模式需要对全部选项排序";
            choice = arr;
          } else {
            const c = String(msg.choice ?? "");
            if (!valid.has(c)) return "选项不存在";
            choice = c;
          }
          room.votes[v.id] = { ...(room.votes[v.id] ?? {}), [seat.seatId]: choice };
        });

      case "mechanic.action":
        return this.withSeat(ws, room, (seat) => {
          if (room.phase !== "playing") return "当前不在对局中";
          const act = sk.acts[room.actIndex];
          const mid = String(msg.mechanicId ?? "");
          if (!act.mechanics?.includes(mid)) return "该机制在本幕未激活";
          const impl = getMechanic(mid);
          if (!impl) return "机制不存在";
          const st = room.mechanics[mid];
          if (st === undefined) return "机制未初始化";

          const wasDone = impl.isComplete(st);
          const res = impl.onAction(st, seat.seatId, msg.payload);
          if (res.reject) return res.reject;
          room.mechanics[mid] = res.nextState;

          // 机制自定义事件：定向或广播
          for (const ev of res.events) {
            if (ev.toSeatId) this.sendToSeat(ev.toSeatId, { type: "mechanic.event", mechanicId: mid, ...ev });
            else this.broadcast({ type: "mechanic.event", mechanicId: mid, ...ev });
          }

          // 校对次数到了就放对应提示；刚拼完则触发 onComplete
          this.fireMechanicHints(room, sk, mid, Date.now());
          if (!wasDone && impl.isComplete(room.mechanics[mid])) {
            this.onMechanicComplete(room, sk, mid);
          }
        });

      case "chat.send": {
        const att = this.attachmentOf(ws);
        if (!att?.seatId) return this.send(ws, { type: "error", code: ERR.NOT_SEATED, message: "尚未入座" });
        const seats = await this.getSeats();
        const me = seats[att.seatId];
        if (!me) return this.send(ws, { type: "error", code: ERR.SEAT_NOT_FOUND, message: "席位已不存在" });

        const text = String(msg.text ?? "").trim().slice(0, 500);
        if (!text) return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "内容不能为空" });
        const to = msg.to ? String(msg.to) : null;
        if (to && !seats[to]) return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "私聊对象不存在" });
        if (to === me.seatId) return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "不能私聊自己" });

        const m2 = { id: newId("msg"), from: me.seatId, to, text, at: Date.now() };
        room.chat.push(m2);
        if (room.chat.length > 400) room.chat.splice(0, room.chat.length - 400);
        await this.putRoom(room);

        // 公开发言推给全场；私聊只推给收发双方（服务端裁决，不靠前端隐藏）
        if (to === null) await this.pushSnapshotAll(room, seats);
        else {
          for (const sid of [me.seatId, to]) {
            const s = seats[sid];
            if (s) this.sendToSeat(sid, this.snapshot(room, seats, s));
          }
        }
        return;
      }

      case "debrief.next":
        return this.withSeat(ws, room, () => {
          if (room.phase !== "debrief") return "当前不是复盘阶段";
          const next = sk.debrief.segments.find((s) => !room.debriefUnlocked.includes(s.id));
          if (!next) {
            room.phase = "ended";
            return;
          }
          room.debriefUnlocked.push(next.id);
        });

      default:
        return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: "unknown type" });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = this.attachmentOf(ws);
    try {
      ws.close();
    } catch {
      /* 已关闭 */
    }
    if (att?.seatId) this.broadcastSeats(await this.getSeats());
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      /* 已关闭 */
    }
  }
}
