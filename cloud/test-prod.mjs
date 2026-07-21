/**
 * 传输层冒烟测试：Worker 路由 / DO 隔离 / WebSocket / 输入校验 / 延迟。
 * （地基阶段的 bump/eventSeq 假逻辑已被真实 Seat 模型取代，此文件相应重写）
 * 用法：node test-prod.mjs [baseUrl]
 */
const HTTP = process.argv[2] || "http://127.0.0.1:8788";
const WSBASE = HTTP.replace(/^http/, "ws");
import { findFreeRoom } from "./test-util.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : (fail++, process.exitCode = 1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = [];

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
    }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("connect timeout")), 15000);
  });
}
async function waitFor(fn, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await wait(120); }
  return false;
}

const R1 = await findFreeRoom(WSBASE);
const R2 = await findFreeRoom(WSBASE);
console.log("目标:", HTTP, "| 房号:", R1, R2, "\n");

const t0 = Date.now();
const h = await fetch(HTTP + "/health").then((r) => r.json());
ok(h.ok === true, `/health 可用（HTTP 往返 ${Date.now() - t0}ms）`);

const a = await conn(R1);
ok(await waitFor(() => !!a.last("hello")), "WebSocket 连接成功并收到 hello");
const hello = a.last("hello");
ok(hello?.room?.roomId === R1, "房号正确路由到独立 DO: " + hello?.room?.roomId);
ok(hello?.room?.phase === "lobby", "新房间初始阶段为 lobby");
ok(hello?.room?.seatsTaken === 0, "新房间无人入座");
ok(!JSON.stringify(hello).includes("【占位"), "未入座时不下发任何剧本正文");

// 房间隔离：R2 与 R1 互不影响
a.send({ type: "seat.claim", displayName: "甲", pin: "1111" });
ok(await waitFor(() => !!a.last("snapshot.full")), "入座成功");
const b = await conn(R2);
ok(await waitFor(() => !!b.last("hello")), "第二个房间连接成功");
ok(b.last("hello")?.room?.seatsTaken === 0, "不同房号隔离到不同 DO（互不影响）");

// 持久化：断开重连后席位仍在
const token = a.last("snapshot.full").seatToken;
a.ws.close();
await wait(1500);
const c = await conn(R1);
c.send({ type: "seat.resume", seatToken: token });
ok(await waitFor(() => c.last("snapshot.full")?.me?.displayName === "甲"), "断连后席位与身份在存储中存活");

// 输入校验
const bad = await fetch(HTTP + "/ws?room=abc");
ok(bad.status === 400, "非法房号被拒: " + bad.status);
const noUp = await fetch(HTTP + "/ws?room=" + R1);
ok(noUp.status === 426, "合法房号但非 WS 请求被拒: " + noUp.status);

// 开新局：服务端分配房号（取代前端连开多条 WS 试号的老做法）
const nr = await fetch(HTTP + "/api/newroom?script=gallery").then((r) => r.json());
ok(/^\d{4}$/.test(nr.room || ""), "开新局拿到 4 位房号: " + nr.room);
const fresh = await conn(nr.room);
ok(await waitFor(() => !!fresh.last("hello")), "分配到的房号可直接连上");
ok(fresh.last("hello")?.room?.seatsTaken === 0, "分配到的一定是空房");
ok(fresh.last("hello")?.room?.seatCount === 4, "剧本已按请求定为 gallery（4 人本）");

const nr2 = await fetch(HTTP + "/api/newroom?script=gallery").then((r) => r.json());
ok(nr2.room !== nr.room, "连续开局不会分到同一个房号");

const badScript = await fetch(HTTP + "/api/newroom?script=nope");
ok(badScript.status === 400, "未知剧本被拒: " + badScript.status);
const hidden = await fetch(HTTP + "/api/newroom?script=fasttest");
ok(hidden.status === 400, "隐藏的测试本不能被玩家开局: " + hidden.status);

// 真实往返延迟（等 pong 事件，不用固定 sleep）
function pingOnce(x) {
  return new Promise((res) => {
    const s = Date.now();
    const on = (e) => {
      if (JSON.parse(e.data).type === "pong") { x.ws.removeEventListener("message", on); res(Date.now() - s); }
    };
    x.ws.addEventListener("message", on);
    x.send({ type: "ping" });
  });
}
const lat = [];
for (let i = 0; i < 3; i++) lat.push(await pingOnce(c));
console.log("WS 真实往返延迟:", lat.map((x) => x + "ms").join(", "));

console.log(`\n=== 传输层冒烟：${pass} 通过 / ${fail} 失败 ===`);
for (const ws of ALL) { try { ws.close(); } catch {} }
await wait(300);
process.exit(fail ? 1 : 0);
