/**
 * 地基验证脚本：证明 DO + WebSocket + 持久化三件事都成立。
 * 用法：node test-foundation.mjs
 */
const BASE = "http://127.0.0.1:8788";
const WS = "ws://127.0.0.1:8788/ws?room=1234";

const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const msgs = [];
    ws.addEventListener("message", (e) => msgs.push(JSON.parse(e.data)));
    ws.addEventListener("open", () => res({ ws, msgs }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("connect timeout")), 5000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. HTTP 健康检查
const h = await fetch(BASE + "/health").then((r) => r.json());
ok(h.ok === true, "Worker /health 可用");

// 2. WebSocket 连上 DO，收到 hello
const a = await connect(WS);
await wait(300);
const hello = a.msgs.find((m) => m.type === "hello");
ok(!!hello, "WS 连接成功并收到 hello");
ok(hello?.room?.roomId === "1234", "房号正确路由到对应 DO: " + hello?.room?.roomId);
const seq0 = hello.room.eventSeq;

// 3. 第二条连接进同一房间 → 应落到同一个 DO（看到同一状态）
const b = await connect(WS);
await wait(300);
const hello2 = b.msgs.find((m) => m.type === "hello");
ok(hello2?.room?.eventSeq === seq0, "第二条连接落到同一 DO，状态一致");

// 4. 广播：a 发 bump，a 和 b 都应收到
a.ws.send(JSON.stringify({ type: "bump" }));
await wait(400);
const pa = a.msgs.filter((m) => m.type === "state.patch");
const pb = b.msgs.filter((m) => m.type === "state.patch");
ok(pa.length === 1 && pb.length === 1, "广播到达该房间的全部连接");
ok(pa[0].eventSeq === seq0 + 1, "状态自增正确: " + seq0 + " -> " + pa[0].eventSeq);

// 5. 持久化：全部断开后重连，状态必须还在（证明落盘而非内存）
const after = pa[0].eventSeq;
a.ws.close(); b.ws.close();
await wait(800);
const c = await connect(WS);
await wait(400);
const hello3 = c.msgs.find((m) => m.type === "hello");
ok(hello3?.room?.eventSeq === after, `断开重连后状态存活: ${hello3?.room?.eventSeq}（应为 ${after}）`);

// 6. 不同房号 → 不同 DO，互不干扰
const d = await connect("ws://127.0.0.1:8788/ws?room=5678");
await wait(400);
const hello4 = d.msgs.find((m) => m.type === "hello");
ok(hello4?.room?.roomId === "5678" && hello4?.room?.eventSeq === 0, "不同房号隔离到不同 DO");

// 7. 非法房号被拒（房号校验早于 Upgrade 校验，故普通请求即可验证）
const bad = await fetch(BASE + "/ws?room=abc");
ok(bad.status === 400, "非法房号被拒: " + bad.status);
const noUpgrade = await fetch(BASE + "/ws?room=1234");
ok(noUpgrade.status === 426, "合法房号但非 WS 请求被拒: " + noUpgrade.status);

c.ws.close(); d.ws.close();
console.log("\n=== 地基验证完成 ===");
