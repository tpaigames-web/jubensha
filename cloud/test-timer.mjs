/**
 * 计时链路验收：DO Alarm 驱动的「防卡车提示」与「幕超时自动推进」。
 * 用秒级压缩的 fasttest 剧本，验证无人操作时引擎能自己把局推下去。
 * 用法：node test-timer.mjs [baseUrl]
 */
const HTTP = process.argv[2] || "http://127.0.0.1:8788";
const WSBASE = HTTP.replace(/^http/, "ws");
import { findFreeRoom } from "./test-util.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : (fail++, process.exitCode = 1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = [];

async function waitFor(fn, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch {}
    await wait(150);
  }
  return false;
}

function conn(room) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WSBASE}/ws?room=${room}&script=fasttest`);
    ALL.push(ws);
    const msgs = [];
    ws.addEventListener("message", (e) => msgs.push(JSON.parse(e.data)));
    ws.addEventListener("open", () => res({
      ws, msgs,
      send: (o) => ws.send(JSON.stringify(o)),
      last: (t) => [...msgs].reverse().find((m) => m.type === t),
      all: (t) => msgs.filter((m) => m.type === t),
    }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("timeout")), 10000);
  });
}

const ROOM = await findFreeRoom(WSBASE, "fasttest");
console.log("测试房号:", ROOM, "| 目标:", HTTP, "| 剧本: fasttest（秒级压缩）\n");

// 2 人入座并选角
const A = await conn(ROOM); await wait(200);
A.send({ type: "seat.claim", displayName: "甲", pin: "1111" }); await wait(300);
const B = await conn(ROOM); await wait(200);
B.send({ type: "seat.claim", displayName: "乙", pin: "2222" }); await wait(300);
ok(A.last("snapshot.full")?.room?.seatCount === 2, "按剧本 meta.players 决定席位数: " + A.last("snapshot.full")?.room?.seatCount);

A.send({ type: "character.pick", characterId: "P1" }); await wait(200);
B.send({ type: "character.pick", characterId: "P2" });
ok(await waitFor(() => A.last("snapshot.full")?.room?.phase === "reading"), "进入 reading");

// 进度拉满不再等于读完，必须显式就绪
A.send({ type: "read.progress", progress: 1 }); A.send({ type: "act.ready" }); await wait(200);
B.send({ type: "read.progress", progress: 1 }); B.send({ type: "act.ready" });
// 注意：reading 阶段 actIndex 已是 0，必须同时判 phase，否则会匹配到 reading 的快照
ok(
  await waitFor(() => {
    const r = A.last("snapshot.full")?.room;
    return r?.phase === "playing" && r?.actIndex === 0;
  }),
  "进入第一幕（playing）"
);

const actStart = Date.now();
const ends = A.last("snapshot.full").room.actEndsAt;
const remain = ends - Date.now();
ok(
  typeof ends === "number" && remain > 0 && remain < 15000,
  `幕截止时间已下发且为秒级（剩余 ${Math.round(remain / 1000)}s）`
);

// ---- 关键：此后【不做任何操作】，看引擎自己推进 ----
console.log("\n【关键】以下全程不做任何操作，验证引擎自驱动：");

const gotHint = await waitFor(
  () => A.all("narration").some((n) => n.text.includes("防卡车引导提示")),
  20000
);
ok(gotHint, `防卡车提示自动放出（等待 ${Math.round((Date.now() - actStart) / 1000)}s，无人操作）`);
ok(
  B.all("narration").some((n) => n.text.includes("防卡车引导提示")),
  "提示同时推送给房间内所有席位"
);

const advanced = await waitFor(() => A.last("snapshot.full")?.room?.actIndex === 1, 25000);
ok(advanced, `幕超时自动推进到第二幕（等待 ${Math.round((Date.now() - actStart) / 1000)}s，无人按就绪）`);
ok(
  A.all("narration").some((n) => n.text.includes("第一幕-收束播报")),
  "超时推进时收束播报正常触发"
);
ok(
  A.all("narration").some((n) => n.text.includes("第二幕-开场播报")),
  "第二幕开场播报正常触发"
);
ok(A.last("snapshot.full")?.room?.actEndsAt > Date.now(), "新幕重新计时");

// 第二幕同样应超时推进 → debrief
const toDebrief = await waitFor(() => A.last("snapshot.full")?.room?.phase === "debrief", 25000);
ok(toDebrief, "最后一幕超时后自动进入复盘阶段");

console.log(`\n=== 计时链路验收：${pass} 通过 / ${fail} 失败 ===`);
for (const ws of ALL) { try { ws.close(); } catch {} }
await wait(300);
process.exit(fail ? 1 : 0);
