/**
 * 生产环境验证：确认 Durable Objects + WebSocket + 持久化在真实边缘节点上成立。
 * 用法：node test-prod.mjs [baseUrl]
 */
const HTTP = process.argv[2] || "https://jubensha.tpaigames.workers.dev";
const WSBASE = HTTP.replace(/^http/, "ws");

const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(room) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WSBASE}/ws?room=${room}`);
    const msgs = [];
    ws.addEventListener("message", (e) => msgs.push(JSON.parse(e.data)));
    ws.addEventListener("open", () => res({ ws, msgs }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("connect timeout")), 15000);
  });
}

// 随机房号，避免与历史状态冲突
const ROOM = String(Math.floor(1000 + Math.random() * 9000));
console.log("测试房号:", ROOM, "| 目标:", HTTP);

const t0 = Date.now();
const h = await fetch(HTTP + "/health").then((r) => r.json());
ok(h.ok === true, `/health 可用（往返 ${Date.now() - t0}ms）`);

const a = await connect(ROOM);
await wait(600);
const hello = a.msgs.find((m) => m.type === "hello");
ok(!!hello, "生产环境 WebSocket 连接成功");
ok(hello?.room?.roomId === ROOM, "房号路由到独立 DO: " + hello?.room?.roomId);
ok(hello?.room?.eventSeq === 0, "新房间初始状态干净");

// 广播 + 落盘
const b = await connect(ROOM);
await wait(600);
a.ws.send(JSON.stringify({ type: "bump" }));
await wait(800);
const pa = a.msgs.filter((m) => m.type === "state.patch");
const pb = b.msgs.filter((m) => m.type === "state.patch");
ok(pa.length === 1 && pb.length === 1, "广播到达房间内全部连接");

// 关键：全部断开후重连，状态必须存活
a.ws.close(); b.ws.close();
await wait(2000);
const c = await connect(ROOM);
await wait(800);
const hello3 = c.msgs.find((m) => m.type === "hello");
ok(hello3?.room?.eventSeq === 1, `【关键】断连后状态在生产环境存活: eventSeq=${hello3?.room?.eventSeq}`);

// 延迟采样：等待 pong 事件本身，不能用固定 sleep（否则量到的是 sleep 时长）
function pingOnce(conn) {
  return new Promise((res) => {
    const s = Date.now();
    const on = (e) => {
      if (JSON.parse(e.data).type === "pong") {
        conn.ws.removeEventListener("message", on);
        res(Date.now() - s);
      }
    };
    conn.ws.addEventListener("message", on);
    conn.ws.send(JSON.stringify({ type: "ping" }));
  });
}
const lat = [];
for (let i = 0; i < 3; i++) lat.push(await pingOnce(c));
console.log("WS 真实往返延迟:", lat.map((x) => x + "ms").join(", "));

c.ws.close();
console.log("\n=== 生产环境验证完成 ===");
