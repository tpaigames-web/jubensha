/**
 * 数据模型与 WebSocket 协议定义。
 *
 * 设计铁律：
 *  - 身份主体是「席位 Seat」，不是连接、不是设备。一个 seat 可被 0..N 条连接同时认领。
 *  - 无「房主」概念：房间生命周期由席位占用与状态机决定，与谁创建无关。
 *  - 引擎只认 key 与 id，不接触剧本正文。
 */

export type Phase = "lobby" | "reading" | "playing" | "debrief" | "ended";

export interface RoomState {
  roomId: string;
  scriptId: string;
  phase: Phase;
  actIndex: number;
  actStartedAt: number | null;
  actEndsAt: number | null;
  seatCount: number;
  createdAt: number;
  config: Record<string, unknown>;
}

export interface Seat {
  seatId: string;
  /** 令牌只存哈希；明文仅在签发时返回一次 */
  seatTokenHash: string;
  /** 4 位 PIN 的哈希（含每席位独立 salt） */
  pinHash: string;
  pinSalt: string;
  displayName: string;
  characterId: string | null;
  readProgress: number;
  ready: boolean;
  privateState: Record<string, unknown>;
  joinedAt: number;
  lastSeenAt: number;
}

/** 连接上附着的信息，必须用 serializeAttachment 存活于 DO 休眠 */
export interface ConnAttachment {
  seatId: string;
  connId: string;
}

/** 对外暴露的席位视图（不含任何哈希/私密字段） */
export interface SeatPublic {
  seatId: string;
  displayName: string;
  characterId: string | null;
  online: boolean;
  ready: boolean;
  readProgress: number;
}

// ---------- Client → Server ----------
export type ClientMsg =
  | { type: "seat.claim"; displayName: string; pin: string }
  | { type: "seat.resume"; seatToken: string }
  | { type: "seat.recover"; displayName: string; pin: string }
  | { type: "character.pick"; characterId?: string; random?: boolean }
  | { type: "read.progress"; progress: number }
  | { type: "act.ready" }
  | { type: "ping" };

// ---------- Server → Client ----------
export interface SnapshotFull {
  type: "snapshot.full";
  room: {
    roomId: string;
    phase: Phase;
    actIndex: number;
    actEndsAt: number | null;
    seatCount: number;
    serverNow: number;
  };
  me: {
    seatId: string;
    displayName: string;
    characterId: string | null;
    ready: boolean;
    readProgress: number;
    privateState: Record<string, unknown>;
  };
  seats: SeatPublic[];
  /** 仅首次认领时下发一次，客户端需自行持久化 */
  seatToken?: string;
}

export const ERR = {
  ROOM_FULL: "room_full",
  NAME_TAKEN: "name_taken",
  BAD_PIN: "bad_pin",
  BAD_TOKEN: "bad_token",
  NOT_SEATED: "not_seated",
  BAD_INPUT: "bad_input",
  SEAT_NOT_FOUND: "seat_not_found",
} as const;
