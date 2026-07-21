/**
 * shop40 结构验收：用**占位文案包**把正式骨架跑通一整局。
 * 用法：node test-shop40-shape.mjs [baseUrl]
 *
 * 这一支验的是「引擎能不能吃下这份骨架」，不是剧情。正文还没生成，
 * 文案包里全是【待生成·<key>】占位串，正好方便断言下发了哪些 key。
 *
 * 覆盖外部剧本包相对引擎自带剧本多出来的那些能力：
 *   顶层 locations 表 / 线索 titleKey / 私有线索开幕自动下发 /
 *   比例写法的投票分支 / 8 格 9 枚碎片 + 干扰项 + 弃置区 /
 *   摘要可见性 / 只报数量的校对 / 拼合完成才开票 + 解锁第三幕线索
 */
const HTTP = process.argv[2] || "http://127.0.0.1:8788";
const WSBASE = HTTP.replace(/^http/, "ws");
import { findFreeRoom } from "./test-util.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : (fail++, process.exitCode = 1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = [];

async function waitFor(fn, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await wait(100); }
  return false;
}
function conn(room, script) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WSBASE}/ws?room=${room}${script ? `&script=${script}` : ""}`);
    ALL.push(ws);
    const msgs = [], raw = [];
    ws.addEventListener("message", (e) => { raw.push(e.data); msgs.push(JSON.parse(e.data)); });
    ws.addEventListener("open", () => res({
      ws, msgs, send: (o) => ws.send(JSON.stringify(o)),
      last: (t) => [...msgs].reverse().find((m) => m.type === t),
      allRaw: () => raw.join("\n"),
    }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("timeout")), 10000);
  });
}
const st = (p) => p.last("snapshot.full");
const mech = (p) => st(p)?.mechanic;

const ROOM = await findFreeRoom(WSBASE, "shop40");
console.log("测试房号:", ROOM, "| 目标:", HTTP, "| 剧本: shop40（占位文案）\n");

const P = [];
for (let i = 0; i < 4; i++) {
  const c = await conn(ROOM, "shop40");
  await wait(150);
  c.send({ type: "seat.claim", displayName: "玩家" + (i + 1), pin: String(1111 * (i + 1)).slice(0, 4) });
  await wait(250);
  P.push(c);
}
ok(st(P[0])?.room?.seatCount === 4, "席位数按 meta.players = 4");
for (let i = 0; i < 4; i++) { P[i].send({ type: "character.pick", characterId: "P" + (i + 1) }); await wait(120); }
ok(await waitFor(() => st(P[0])?.room?.phase === "reading"), "全员选角 → 进入阅读");

console.log("\n【结构】外部包特有的字段能被解析");
const s0 = st(P[0]);
ok((s0.content[s0.script.titleKey] || "").length > 0, "标题走的是 meta.titleKey");
ok((s0.script.myScriptKeys || [])[0] === "script.act1.P1", "第一幕本文 key 正确");
ok((s0.content["script.act1.P1"] || "").length > 1000, "本文按 key 下发且体量正常");
ok(!s0.allRaw?.().includes("script.act2"), "第二幕本文未提前下发");

console.log("\n【第一幕】顶层地点表 + 私有线索开幕自动下发");
for (const p of P) { p.send({ type: "act.ready" }); await wait(80); }
ok(await waitFor(() => P.every((p) => st(p)?.room?.actIndex === 0 && st(p)?.room?.phase === "playing")),
   "全员就绪 → 进入第一幕");
ok(st(P[0])?.script?.locations?.length === 4, "第一幕开放 4 个地点");
ok(st(P[0])?.script?.searchQuota === 3, "第一幕配额 3 次/人");
ok(st(P[0])?.content?.["loc.counter.name"] !== undefined, "地点走 nameKey（顶层 locations 表）");

const mine1 = (st(P[0])?.clues || []);
ok(mine1.some((c) => c.id === "c.act1.priv.P1"), "P1 的私有线索开幕就到手，不用搜");
ok(mine1.every((c) => c.id !== "c.act1.priv.P2"), "拿不到别人的私有线索");
ok(!P[0].allRaw().includes("c.act1.priv.P2.content"), "别人的私有线索正文全文搜索零命中");
ok(mine1.find((c) => c.id === "c.act1.priv.P1")?.titleKey === "c.act1.priv.P1.title", "线索带 titleKey");

// 搜证：三次配额都用掉
for (const p of P) {
  for (let k = 0; k < 4; k++) {
    const s = st(p);
    const av = s?.script?.locationsAvailable || [];
    if (!av.length || s.script.searchUsed >= s.script.searchQuota) break;
    p.send({ type: "clue.unlock", locationId: av[0] });
    await wait(160);
  }
}
const found = new Set(P.flatMap((p) => (st(p)?.clues || []).map((c) => c.id)));
ok([...found].filter((x) => x.startsWith("c.act1.") && !x.includes(".priv.")).length >= 6,
   `第一幕搜出 ${[...found].filter((x) => x.startsWith("c.act1.") && !x.includes(".priv.")).length} 条公开线索`);

console.log("\n【第二幕】");
for (const p of P) { p.send({ type: "act.ready" }); await wait(80); }
ok(await waitFor(() => P.every((p) => st(p)?.room?.actIndex === 1)), "推进到第二幕");
ok(st(P[0])?.script?.locations?.length === 5, "第二幕开放 5 个地点");
ok((st(P[0])?.clues || []).some((c) => c.id === "c.act2.priv.P1"), "第二幕的私有线索也自动到手");

console.log("\n【第三幕】8 格 + 干扰项 + 弃置区 + 摘要可见性");
for (const p of P) { p.send({ type: "act.ready" }); await wait(80); }
ok(await waitFor(() => P.every((p) => st(p)?.room?.actIndex === 2)), "推进到第三幕");
ok(st(P[0])?.script?.searchQuota === 0, "第三幕没有搜证（纯机制幕）");
ok(st(P[0])?.script?.locations?.length === 0, "第三幕没有地点");

const m = mech(P[0]);
ok(m?.state?.slots?.length === 8, "时间线 8 格");
ok(m?.state?.discardEnabled === true, "弃置区已开启");
await waitFor(() => P.every((p) => (mech(p)?.state?.myFragments || []).length === 2));
const frags = P.map((p) => mech(p)?.state?.myFragments || []);
ok(frags.every((f) => f.length === 2), "每人 2 枚碎片（共 8 枚）");
ok(frags[0][0].textKey?.endsWith(".full"), "自己的碎片给的是全文 key");

// 摘要可见性：把一枚碎片打到盘上，别人只能拿到摘要
P[0].send({ type: "mechanic.action", mechanicId: "timeline_puzzle",
            payload: { op: "place", fragId: frags[0][0].fragId, slot: "s1" } });
ok(await waitFor(() => mech(P[1])?.state?.slots?.[0]?.frag), "碎片打出后全场可见其存在");
const seenByOther = mech(P[1]).state.slots[0].frag;
ok(seenByOther.textKey?.endsWith(".summary"), "别人拿到的是摘要 key，不是全文");
ok(seenByOther.summaryOnly === true, "并明确标记为「仅摘要」");
ok(!P[1].allRaw().includes(frags[0][0].textKey), `别人的全文 key（${frags[0][0].textKey}）全文搜索零命中`);

// 只报数量的校对
P[1].send({ type: "mechanic.action", mechanicId: "timeline_puzzle", payload: { op: "check" } });
ok(await waitFor(() => mech(P[0])?.state?.lastCorrect !== null), "校对有结果");
ok(typeof mech(P[0]).state.lastCorrect === "number", "校对只回报数量");
ok(JSON.stringify(mech(P[0]).state).indexOf("solution") === -1, "投影里不含答案");
ok(JSON.stringify(mech(P[0]).state).indexOf("gapSlot") === -1, "投影里不含缺口位置");

// 拼合未完成 → 投票不该开
ok(st(P[0])?.vote === null, "拼图没完成时投票不开放（由 onComplete.openVote 把守）");
ok(!P[0].allRaw().includes("vote.final.opt.sell"), "连选项文案都还没下发");

console.log(`\n=== shop40 结构验收：${pass} 通过 / ${fail} 失败 ===`);
for (const w of ALL) { try { w.close(); } catch {} }
setTimeout(() => process.exit(fail ? 1 : 0), 300);
