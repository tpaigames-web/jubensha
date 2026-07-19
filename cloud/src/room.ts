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
import { getSkeleton, hasSkeleton, Skeleton } from "./skeleton";
import { getContent } from "./content";
import { availableLocations, entitledKeys, searchCandidates, visibleClues, VisibilityCtx } from "./visibility";
import { getMechanic } from "./mechanics";

const K_ROOM = "room";
const K_SEATS = "seats";

type SeatMap = Record<string, Seat>;

export class RoomDO implements DurableObject {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
  }

  // ================= 存储 =================

  private async getRoom(roomId: string, scriptId = "placeholder"): Promise<RoomState> {
    const r = await this.ctx.storage.get<RoomState>(K_ROOM);
    if (r) return r;
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
      debriefUnlocked: room.debriefUnlocked,
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
    const myClues = visibleClues(sk, vctx).map((c) => ({
      id: c.id,
      contentKey: c.contentKey,
      location: c.location,
      private: c.visibility.type === "private",
    }));

    // 已下发过的播报（重连时补齐），同样只回放本席位有权看到的
    const narration = room.narrationLog
      .filter((n) => allowed.has(n.key) || n.key.startsWith("nar.") || n.key.startsWith("end."))
      .map((n) => ({ key: n.key, at: n.at, text: getContent(room.scriptId).resolve(n.key) ?? "" }));

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
        /** 其中「对我还有可搜线索」的子集：界面据此把搜空的地点置灰 */
        locationsAvailable: availableLocations(sk, vctx),
        searchQuota: act ? act.searchQuota.perSeat : 0,
        searchUsed: me.searchUsed?.[room.actIndex] ?? 0,
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
      mechanic: this.mechanicView(room, sk, me),
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
    const act = this.sk(room).acts[room.actIndex];
    const times: number[] = [];
    for (const h of act.hints) {
      const at = room.actStartedAt + h.afterMin * 60_000;
      if (!room.hintsFired.includes(h.narrationKey) && at > Date.now()) times.push(at);
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
    await this.narrate(room, act.closingNarrationKey, "act-close");

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
    if (uniq.length === 1) match = "unanimous_" + uniq[0];

    const branch =
      v.resultBranches.find((b) => b.match === match) ??
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

      case "read.progress":
        return this.withSeat(ws, room, (seat) => {
          const p = Number(msg.progress);
          if (!Number.isFinite(p)) return "进度值非法";
          seat.readProgress = Math.max(seat.readProgress, Math.min(1, Math.max(0, p)));
        });

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

          const res = impl.onAction(st, seat.seatId, msg.payload);
          if (res.reject) return res.reject;
          room.mechanics[mid] = res.nextState;

          // 机制自定义事件：定向或广播
          for (const ev of res.events) {
            if (ev.toSeatId) this.sendToSeat(ev.toSeatId, { type: "mechanic.event", mechanicId: mid, ...ev });
            else this.broadcast({ type: "mechanic.event", mechanicId: mid, ...ev });
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
