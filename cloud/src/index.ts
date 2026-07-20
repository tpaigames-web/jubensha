/**
 * Worker 入口：把 /ws?room=XXXX 路由到对应房间的 Durable Object，
 * 其余请求交给静态资源。
 *
 * 设计要点：房号（4位）→ DO id，一个房间恒定落到同一个 DO 实例，
 * 因此房间状态天然强一致，且不受实例回收影响。
 */

export { RoomDO } from "./room";

import { hasSkeleton, listScripts, HIDDEN_SCRIPTS } from "./skeleton";
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

    /**
     * 开一局新的：服务端挑一个空房号并把剧本定下来，一次 HTTP 搞定。
     * 以前是前端连开好几条 WebSocket 逐个试房号——手机在微信里网络一抖就全盘失败，
     * 而且前端一旦收到 error 就彻底放弃，玩家只会看到「连接失败」，再点也没反应。
     */
    if (url.pathname === "/api/newroom") {
      const script = url.searchParams.get("script") ?? "";
      if (!hasSkeleton(script) || HIDDEN_SCRIPTS.has(script)) {
        return Response.json({ error: "unknown_script" }, { status: 400 });
      }
      for (let i = 0; i < 12; i++) {
        const code = String(Math.floor(1000 + Math.random() * 9000));
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        try {
          const r = await stub.fetch(
            `https://do/alloc?room=${code}&script=${encodeURIComponent(script)}`
          );
          if (r.ok && ((await r.json()) as { free?: boolean }).free) {
            return Response.json({ room: code });
          }
        } catch {
          /* 这个号不行就换下一个 */
        }
      }
      return Response.json({ error: "no_free_room" }, { status: 503 });
    }

    // 可选剧本列表：只回公开元信息（标题/人数/时长），不含任何剧情
    if (url.pathname === "/api/scripts") {
      const scripts = listScripts()
        .filter((s) => !HIDDEN_SCRIPTS.has(s.scriptId)) // 测试/在制品不对玩家展示
        .map((s) => {
          const src = getContent(s.scriptId);
          return {
            scriptId: s.scriptId,
            players: s.players,
            durationMin: s.durationMin,
            title: src.resolve(s.titleKey) ?? s.scriptId,
            // 选本页只给设定与分类，绝不给剧情
            subtitle: s.subtitleKey ? src.resolve(s.subtitleKey) ?? "" : "",
            blurb: s.blurbKey ? src.resolve(s.blurbKey) ?? "" : "",
            tags: s.tags,
            difficulty: s.difficultyLabel ?? "",
          };
        });
      return Response.json({ scripts });
    }

    return env.ASSETS.fetch(request);
  },
};
