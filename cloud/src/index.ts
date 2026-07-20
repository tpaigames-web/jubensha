/**
 * Worker 入口：把 /ws?room=XXXX 路由到对应房间的 Durable Object，
 * 其余请求交给静态资源。
 *
 * 设计要点：房号（4位）→ DO id，一个房间恒定落到同一个 DO 实例，
 * 因此房间状态天然强一致，且不受实例回收影响。
 */

export { RoomDO } from "./room";

import { listScripts, HIDDEN_SCRIPTS } from "./skeleton";
import { getContent } from "./content";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const ROOM_CODE_RE = /^\d{4}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room") ?? "";
      if (!ROOM_CODE_RE.test(room)) {
        return new Response("bad room code", { status: 400 });
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      // 房号作为 DO 名称：同一房号永远同一个实例
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(request);
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, ts: Date.now() });
    }

    // 可选剧本列表：只回公开元信息（标题/人数/时长），不含任何剧情
    if (url.pathname === "/api/scripts") {
      const scripts = listScripts()
        .filter((s) => !HIDDEN_SCRIPTS.has(s.scriptId)) // 测试/探针本不对玩家展示
        .map((s) => ({
          scriptId: s.scriptId,
          players: s.players,
          durationMin: s.durationMin,
          title: getContent(s.scriptId).resolve(s.titleKey) ?? s.scriptId,
        }));
      return Response.json({ scripts });
    }

    return env.ASSETS.fetch(request);
  },
};
