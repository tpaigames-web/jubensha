/**
 * RoomDO —— 一个房间一个实例。
 *
 * 本阶段（地基）只验证三件事，业务逻辑留给后续阶段：
 *   1. WebSocket Hibernation：安静时段休眠不烧计算，状态仍在
 *   2. 存储持久化：每次变更立刻落盘，实例被回收后重连能读回
 *   3. 广播按「连接集合」推送（后续会改为按 seatId 路由）
 *
 * 注意：这里刻意不做任何剧本正文处理。引擎只认 key 与 id，
 * 正文由后续的 content 层在下发瞬间解析。
 */

interface RoomState {
  roomId: string;
  phase: "lobby" | "reading" | "playing" | "debrief" | "ended";
  actIndex: number;
  createdAt: number;
  /** 仅用于地基验证：证明状态确实落盘并能跨实例回收存活 */
  eventSeq: number;
}

const KEY_STATE = "room:state";

export class RoomDO implements DurableObject {
  private ctx: DurableObjectState;
  private env: unknown;

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }

  private async loadState(roomId: string): Promise<RoomState> {
    const existing = await this.ctx.storage.get<RoomState>(KEY_STATE);
    if (existing) return existing;
    const fresh: RoomState = {
      roomId,
      phase: "lobby",
      actIndex: 0,
      createdAt: Date.now(),
      eventSeq: 0,
    };
    await this.ctx.storage.put(KEY_STATE, fresh);
    return fresh;
  }

  private async saveState(s: RoomState): Promise<void> {
    // 立刻落盘，不依赖定时快照
    await this.ctx.storage.put(KEY_STATE, s);
  }

  /** 广播给该房间所有活跃连接 */
  private broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // 连接已失效，交由 webSocketClose 清理
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.searchParams.get("room") ?? "0000";

    const state = await this.loadState(roomId);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API：注册后 DO 可休眠，消息到达时自动唤醒
    this.ctx.acceptWebSocket(server);

    server.send(
      JSON.stringify({
        type: "hello",
        room: {
          roomId: state.roomId,
          phase: state.phase,
          actIndex: state.actIndex,
          eventSeq: state.eventSeq,
        },
        serverNow: Date.now(),
        connections: this.ctx.getWebSockets().length,
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: { type?: string };
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "bad_json" }));
      return;
    }

    const state = await this.ctx.storage.get<RoomState>(KEY_STATE);
    if (!state) {
      ws.send(JSON.stringify({ type: "error", code: "no_state" }));
      return;
    }

    switch (msg.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong", serverNow: Date.now() }));
        return;

      // 地基验证用：每次自增并立刻落盘，用来证明持久化与广播都工作
      case "bump": {
        state.eventSeq += 1;
        await this.saveState(state);
        this.broadcast({ type: "state.patch", eventSeq: state.eventSeq, serverNow: Date.now() });
        return;
      }

      default:
        ws.send(JSON.stringify({ type: "error", code: "unknown_type" }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* 已关闭 */
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
