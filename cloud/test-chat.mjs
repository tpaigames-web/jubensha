/**
 * 验收：阅读不被跳过 + 聊天（公开/私聊）权限
 * 用法：node test-chat.mjs [baseUrl]
 */
const HTTP = process.argv[2] || "http://127.0.0.1:8788";
const WSBASE = HTTP.replace(/^http/, "ws");
import { findFreeRoom } from "./test-util.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : (fail++, process.exitCode = 1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = [];
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await wait(120); }
  return false;
}
function conn(room) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WSBASE}/ws?room=${room}`);
    ALL.push(ws);
    const msgs = [];
    ws.addEventListener("message", (e) => msgs.push(JSON.parse(e.data)));
    ws.addEventListener("open", () => res({
      ws, msgs,
      send: (o) => ws.send(JSON.stringify(o)),
      last: (t) => [...msgs].reverse().find((m) => m.type === t),
      raw: () => msgs.map((m) => JSON.stringify(m)).join("\n"),
    }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("timeout")), 10000);
  });
}

const ROOM = await findFreeRoom(WSBASE);
console.log("测试房号:", ROOM, "| 目标:", HTTP, "\n");

const P = [];
const names = ["甲", "乙", "丙", "丁"];
for (let i = 0; i < 4; i++) {
  const c = await conn(ROOM); await wait(150);
  c.send({ type: "seat.claim", displayName: names[i], pin: String(1111 * (i + 1)).slice(0, 4) });
  await wait(250);
  P.push(c);
}
for (let i = 0; i < 4; i++) { P[i].send({ type: "character.pick", characterId: "P" + (i + 1) }); await wait(150); }
await waitFor(() => P[0].last("snapshot.full")?.room?.phase === "reading");
ok(P[0].last("snapshot.full")?.room?.phase === "reading", "进入阅读阶段");

// ---- 阅读进度拉满不应推进 ----
console.log("\n【阅读】滚到底不算读完");
for (const c of P) { c.send({ type: "read.progress", progress: 1 }); await wait(150); }
await wait(2500);
ok(P[0].last("snapshot.full")?.room?.phase === "reading", "四人进度都拉到100%，仍停在阅读阶段（不被跳过）");
ok(P[0].last("snapshot.full")?.seats?.every((s) => s.readProgress === 1), "进度条仍如实显示100%");
ok(P[0].last("snapshot.full")?.seats?.every((s) => !s.ready), "但没有人被判定为已就绪");

console.log("\n【阅读】只有点了「我读完了」才推进");
for (let i = 0; i < 3; i++) { P[i].send({ type: "act.ready" }); await wait(200); }
await wait(1500);
ok(P[0].last("snapshot.full")?.room?.phase === "reading", "3/4 就绪时仍不推进");
P[3].send({ type: "act.ready" });
ok(await waitFor(() => P[0].last("snapshot.full")?.room?.phase === "playing"), "全员点完才进入第一幕");

// ---- 聊天 ----
console.log("\n【聊天】公开与私聊");
const seatIds = P[0].last("snapshot.full").seats.map((s) => s.seatId);
const meId = P[0].last("snapshot.full").me.seatId;
const otherId = P[0].last("snapshot.full").seats.find((s) => s.seatId !== meId).seatId;

P[0].send({ type: "chat.send", to: null, text: "大家好这是公开发言" });
await waitFor(() => (P[2].last("snapshot.full")?.chat || []).some((m) => m.text.includes("公开发言")));
ok((P[1].last("snapshot.full").chat || []).some((m) => m.text.includes("公开发言")), "公开发言：其他人都能看到");
ok((P[3].last("snapshot.full").chat || []).some((m) => m.text.includes("公开发言")), "公开发言：全场可见");

// 甲私聊乙
P[0].send({ type: "chat.send", to: otherId, text: "这是只给你的悄悄话" });
await wait(1200);
const inA = (P[0].last("snapshot.full").chat || []).some((m) => m.text.includes("悄悄话"));
const target = P.find((c) => c.last("snapshot.full")?.me?.seatId === otherId);
const inB = (target.last("snapshot.full").chat || []).some((m) => m.text.includes("悄悄话"));
const outsiders = P.filter((c) => {
  const id = c.last("snapshot.full")?.me?.seatId;
  return id !== meId && id !== otherId;
});
ok(inA && inB, "私聊：收发双方都能看到");
ok(outsiders.every((c) => !c.raw().includes("悄悄话")), "私聊：无关的人在【任何报文】里都搜不到内容");

// 边界
P[0].send({ type: "chat.send", to: "seat_不存在", text: "x" }); await wait(500);
ok(P[0].last("error")?.message?.includes("私聊对象不存在"), "私聊不存在的席位被拒");
P[0].send({ type: "chat.send", to: meId, text: "x" }); await wait(500);
ok(P[0].last("error")?.message?.includes("不能私聊自己"), "不能私聊自己");
P[0].send({ type: "chat.send", to: null, text: "   " }); await wait(500);
ok(P[0].last("error")?.message?.includes("不能为空"), "空消息被拒");

console.log(`\n=== 阅读与聊天验收：${pass} 通过 / ${fail} 失败 ===`);
for (const ws of ALL) { try { ws.close(); } catch {} }
await wait(300);
process.exit(fail ? 1 : 0);
