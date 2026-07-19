/**
 * RoomDO —— 一个房间一个 Durable Object 实例。
 *
 * 阶段 1 交付：Seat 身份模型
 *   - 身份挂在席位上，不挂在连接/设备上
 *   - seatToken（32字节随机）只存哈希，明文仅签发时返回一次
 *   - 三级恢复：token → (客户端 localStorage/URL) → 房号+昵称+PIN 兜底
 *   - 广播按 seatId 路由：一个席位的多条连接全部推送
 *   - 席位互斥提示：新设备认领时通知该席位的旧连接
 *   - 无「房主」概念
 *
 * 休眠安全：连接↔席位映射存在 WebSocket attachment 里（serializeAttachment），
 * DO 休眠后仍能还原，绝不依赖内存变量。
 *
 * 注意：本文件不接触任何剧本正文，只处理 id 与 key。
 */

import {
  ClientMsg, ConnAttachment, ERR, Phase, RoomState, Seat, SeatPublic, SnapshotFull,
} from "./types";
import { hashPin, hashToken, newId, newSalt, newSeatToken, timingSafeEqual } from "./crypto";

const K_ROOM = "room";
const K_SEATS = "seats";
const DEFAULT_SEAT_COUNT = 4;

type SeatMap = Record<string, Seat>;

export class RoomDO implements DurableObject {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
  }

  // ---------- 存储 ----------

  private async getRoom(roomId: string): Promise<RoomState> {
    const r = await this.ctx.storage.get<RoomState>(K_ROOM);
    if (r) return r;
    const fresh: RoomState = {
      roomId,
      scriptId: "placeholder",
      phase: "lobby",
      actIndex: 0,
      actStartedAt: null,
      actEndsAt: null,
      seatCount: DEFAULT_SEAT_COUNT,
      createdAt: Date.now(),
      config: {},
    };
    await this.ctx.storage.put(K_ROOM, fresh);
    return fresh;
  }

  /** 消息处理阶段读取房间：此时房间必然已由 fetch 建好，不再用默认房号兜底 */
  private async mustGetRoom(): Promise<RoomState | null> {
    return (await this.ctx.storage.get<RoomState>(K_ROOM)) ?? null;
  }

  private async getSeats(): Promise<SeatMap> {
    return (await this.ctx.storage.get<SeatMap>(K_SEATS)) ?? {};
  }

  /** 每次变更立刻落盘，不依赖定时快照 */
  private async putSeats(seats: SeatMap): Promise<void> {
    await this.ctx.storage.put(K_SEATS, seats);
  }

  // ---------- 连接 ↔ 席位 ----------

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
      /* 连接已失效，由 close 回调清理 */
    }
  }

  /** 广播给房间内所有已入座的连接 */
  private broadcast(payload: unknown, exceptSeatId?: string): void {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachmentOf(ws);
      if (!a?.seatId) continue;
      if (exceptSeatId && a.seatId === exceptSeatId) continue;
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  /** 按 seatId 路由：该席位的所有连接都推 */
  private sendToSeat(seatId: string, payload: unknown): void {
    for (const ws of this.socketsOfSeat(seatId)) this.send(ws, payload);
  }

  // ---------- 视图 ----------

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

  private snapshot(room: RoomState, seats: SeatMap, me: Seat, seatToken?: string): SnapshotFull {
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
    };
    if (seatToken) snap.seatToken = seatToken;
    return snap;
  }

  /** 席位名册变化后，让所有人刷新 seats 视图 */
  private broadcastSeats(seats: SeatMap): void {
    this.broadcast({ type: "seats.updated", seats: this.seatsPublic(seats), serverNow: Date.now() });
  }

  // ---------- 入座 / 恢复 ----------

  private async bindConnection(ws: WebSocket, seatId: string): Promise<void> {
    const att: ConnAttachment = { seatId, connId: newId("conn") };
    ws.serializeAttachment(att);
  }

  private async claim(ws: WebSocket, room: RoomState, name: string, pin: string) {
    const seats = await this.getSeats();
    const list = Object.values(seats);

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
      privateState: {},
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    seats[seat.seatId] = seat;
    await this.putSeats(seats);
    await this.bindConnection(ws, seat.seatId);

    // 明文 token 只在这里返回一次
    this.send(ws, this.snapshot(room, seats, seat, token));
    this.broadcastSeats(seats);
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

  /** 认领已存在的席位：先通知旧连接（互斥提示），再绑定新连接 */
  private async attachToSeat(ws: WebSocket, room: RoomState, seats: SeatMap, seat: Seat) {
    const previous = this.socketsOfSeat(seat.seatId);
    for (const old of previous) {
      this.send(old, {
        type: "seat.elsewhere",
        message: "你的席位已在其他设备打开",
        serverNow: Date.now(),
      });
    }

    seat.lastSeenAt = Date.now();
    seats[seat.seatId] = seat;
    await this.putSeats(seats);
    await this.bindConnection(ws, seat.seatId);

    // 家庭局不强制踢线：旧连接仍可用，只是知道发生了什么
    this.send(ws, this.snapshot(room, seats, seat));
    this.broadcastSeats(seats);
  }

  // ---------- 席位自身状态 ----------

  private async mutateSeat(
    ws: WebSocket,
    room: RoomState,
    fn: (seat: Seat, seats: SeatMap) => void | string
  ) {
    const att = this.attachmentOf(ws);
    if (!att?.seatId) {
      return this.send(ws, { type: "error", code: ERR.NOT_SEATED, message: "尚未入座" });
    }
    const seats = await this.getSeats();
    const seat = seats[att.seatId];
    if (!seat) {
      return this.send(ws, { type: "error", code: ERR.SEAT_NOT_FOUND, message: "席位已不存在" });
    }
    const err = fn(seat, seats);
    if (typeof err === "string") {
      return this.send(ws, { type: "error", code: ERR.BAD_INPUT, message: err });
    }
    seat.lastSeenAt = Date.now();
    seats[seat.seatId] = seat;
    await this.putSeats(seats);
    this.sendToSeat(seat.seatId, this.snapshot(room, seats, seat));
    this.broadcastSeats(seats);
  }

  // ---------- WebSocket 生命周期 ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const room = await this.getRoom(url.searchParams.get("room") ?? "0000");
    const seats = await this.getSeats();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    // 未入座前只给最小信息：够客户端决定「认领 / 恢复」即可
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

    switch (msg.type) {
      case "ping":
        return this.send(ws, { type: "pong", serverNow: Date.now() });

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
        return this.mutateSeat(ws, room, (seat, seats) => {
          if (msg.random) {
            seat.characterId = null; // 阶段4由引擎统一随机分配
            seat.privateState = { ...seat.privateState, wantRandom: true };
            return;
          }
          const cid = String(msg.characterId ?? "");
          if (!cid) return "缺少角色";
          const taken = Object.values(seats).some(
            (s) => s.seatId !== seat.seatId && s.characterId === cid
          );
          if (taken) return "该角色已被选择";
          seat.characterId = cid;
          seat.privateState = { ...seat.privateState, wantRandom: false };
        });

      case "read.progress":
        return this.mutateSeat(ws, room, (seat) => {
          const p = Number(msg.progress);
          if (!Number.isFinite(p)) return "进度值非法";
          // 只允许前进，避免来回滚动把进度刷回去
          seat.readProgress = Math.max(seat.readProgress, Math.min(1, Math.max(0, p)));
        });

      case "act.ready":
        return this.mutateSeat(ws, room, (seat) => {
          seat.ready = true;
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
    // 该席位若已无连接，广播在线状态变化
    if (att?.seatId) {
      const seats = await this.getSeats();
      this.broadcastSeats(seats);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      /* 已关闭 */
    }
  }
}
