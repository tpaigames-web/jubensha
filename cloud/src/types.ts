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
  /** 当前幕下标；lobby 为 -1 */
  actIndex: number;
  actStartedAt: number | null;
  actEndsAt: number | null;
  seatCount: number;
  createdAt: number;
  config: Record<string, unknown>;
  unlockedClues: { clueId: string; bySeatId: string; at: number }[];
  /** 已下发的播报 key（重连时回放） */
  narrationLog: { key: string; at: number }[];
  /** 已触发过的防卡车提示 key，避免重复放 */
  hintsFired: string[];
  debriefUnlocked: string[];
  /** voteId → (seatId → choice)。保留完整票型，结算按票型分支。
   *  单选为 string；ranked/multi 为 string[] */
  votes: Record<string, Record<string, string | string[]>>;
  /** mechanicId → 机制内部状态（由各自 validator 定义，引擎不解释） */
  mechanics: Record<string, unknown>;
  /** 聊天记录。to=null 为公开发言；to=某 seatId 为私聊，仅收发双方可见 */
  chat: ChatMsg[];
}

export interface ChatMsg {
  id: string;
  from: string;          // seatId
  to: string | null;     // null=公开
  text: string;
  at: number;
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
  /** actIndex → 已用搜证次数 */
  searchUsed: Record<number, number>;
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
  | { type: "clue.unlock"; locationId: string }
  | { type: "vote.cast"; voteId: string; choice: string | string[] }
  | { type: "mechanic.action"; mechanicId: string; payload: unknown }
  | { type: "chat.send"; to?: string | null; text: string }
  | { type: "debrief.next" }
  /** 主动索要一次全量快照：操作被拒或客户端自认状态可疑时用 */
  | { type: "snapshot.request" }
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
  script: {
    scriptId: string;
    titleKey: string;
    characters: { id: string; nameKey: string; briefKey: string }[];
    actCount: number;
    locations: string[];
    /** 其中对本席位仍有可搜线索的地点 */
    locationsAvailable: string[];
    searchQuota: number;
    searchUsed: number;
    myScriptKeys: string[];
    /** 当前阶段该放的背景音乐（public/audio/ 下的相对路径）；无则为 null */
    bgm: string | null;
  };
  clues: { id: string; contentKey: string; location: string; private: boolean }[];
  vote: {
    voteId: string;
    mode: string;
    promptKey: string;
    options: { id: string; labelKey: string }[];
    myChoice: string | string[] | null;
    castCount: number;
    seatCount: number;
    /** 仅实名公开模式回传完整票型；匿名模式只回统计 */
    ballots?: Record<string, string | string[]>;
    tally?: Record<string, number>;
  } | null;
  /** 当前幕激活的机制（已按本席位视角投影） */
  mechanic: { mechanicId: string; state: unknown; complete: boolean } | null;
  debrief: { id: string; contentKey: string }[];
  narration: { key: string; at: number; text: string }[];
  /** 本席位可见的聊天：全部公开发言 + 与自己相关的私聊 */
  chat: (ChatMsg & { fromName: string; toName: string | null })[];
  /** key → 正文。只含本席位【此刻有权】解析的 key（已过 entitledKeys 闸门） */
  content: Record<string, string>;
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
