/**
 * 《台风夜》整局验收：3 人本跑通一整局，并验证新加的「多数决」结算分支。
 * 用法：node test-typhoon.mjs [baseUrl]
 *
 * 【防剧透】只用「关键词是否出现」断言，**不打印任何剧本正文**。
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
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch { /* 未就绪 */ }
    await wait(100);
  }
  return false;
}

function conn(room, script) {
  return new Promise((res, rej) => {
    const q = script ? `&script=${encodeURIComponent(script)}` : "";
    const ws = new WebSocket(`${WSBASE}/ws?room=${room}${q}`);
    ALL.push(ws);
    const msgs = [], raw = [];
    ws.addEventListener("message", (e) => { raw.push(e.data); msgs.push(JSON.parse(e.data)); });
    ws.addEventListener("open", () => res({
      ws, msgs, raw,
      send: (o) => ws.send(JSON.stringify(o)),
      last: (t) => [...msgs].reverse().find((m) => m.type === t),
      allRaw: () => raw.join("\n"),
    }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("timeout")), 10000);
  });
}

const st = (p) => p.last("snapshot.full");
/** 推进一幕：全员就绪，且等**所有**端都收到新幕快照 */
async function readyAll(P, toIndex) {
  for (const p of P) { p.send({ type: "act.ready" }); await wait(80); }
  return waitFor(() => P.every((p) =>
    st(p)?.room?.actIndex === toIndex && st(p)?.room?.phase === "playing"));
}
async function searchAll(P) {
  for (const p of P) {
    for (let k = 0; k < 8; k++) {
      const s = st(p);
      const avail = s?.script?.locationsAvailable || [];
      if (!avail.length || s.script.searchUsed >= s.script.searchQuota) break;
      p.send({ type: "clue.unlock", locationId: avail[Math.floor(Math.random() * avail.length)] });
      await wait(160);
    }
  }
}

const ROOM = await findFreeRoom(WSBASE, "typhoon");
console.log("测试房号:", ROOM, "| 目标:", HTTP, "| 剧本: typhoon《台风夜》\n");

// ---------- 入场 ----------
console.log("【流程】三人入座 → 选角 → 阅读");
const P = [];
const names = ["豪", "满", "珍"];
for (let i = 0; i < 3; i++) {
  const c = await conn(ROOM, "typhoon");
  await wait(150);
  c.send({ type: "seat.claim", displayName: names[i], pin: String(1111 * (i + 1)).slice(0, 4) });
  await wait(250);
  P.push(c);
}
ok(st(P[0])?.script?.scriptId === "typhoon", "房间用的是 typhoon");
ok(st(P[0])?.room?.seatCount === 3, "席位数按 meta.players = 3");
ok(st(P[0])?.script?.characters?.length === 3, "三个角色可选");

for (let i = 0; i < 3; i++) { P[i].send({ type: "character.pick", characterId: "P" + (i + 1) }); await wait(120); }
await waitFor(() => st(P[0])?.room?.phase === "reading");
ok(st(P[0])?.room?.phase === "reading", "全员选角 → 自动进入阅读");

const s0 = st(P[0]);
const myKey0 = s0.script.myScriptKeys[0];
ok((s0.content[myKey0] || "").length > 1200, `第一幕本文体量够读（${(s0.content[myKey0] || "").length} 字）`);
ok((s0.content[myKey0] || "").includes("【你今晚要做到的】"), "本文带明确目标");
ok((s0.content[myKey0] || "").includes("【怎么玩】"), "本文含玩法说明");

console.log("\n【安全】真实正文的阶段隔离（全文搜索原始报文）");
const r0 = P[0].allRaw();
ok(!r0.includes("她不是坏人"), "阅读阶段：复盘特征句 → 零命中");
ok(!r0.includes("三十七秒"), "阅读阶段：第三幕线索关键词 → 零命中");
ok(!r0.includes("0914"), "阅读阶段：第二幕线索关键词 → 零命中");
ok(!r0.includes("你是林小雨的妹妹"), "阅读阶段：他人本文秘密 → 零命中");
ok(!r0.includes("我打了999"), "阅读阶段：第三幕拼图碎片 → 零命中");

// ---------- 第一幕 ----------
console.log("\n【第一幕】搜证");
ok(await readyAll(P, 0), "全员就绪 → 进入第一幕");
ok(st(P[0])?.script?.locations?.length === 3, "第一幕开放 3 个地点");
ok(st(P[0])?.script?.searchQuota === 2, "第一幕配额 2 次/人");
await searchAll(P);
const found1 = new Set(P.flatMap((p) => (st(p)?.clues || []).map((c) => c.id)));
ok(found1.size >= 5, `第一幕全场搜出 ${found1.size} 条线索（6 次配额，7 条线索池）`);
ok([...found1].every((id) => id.startsWith("c.a1.")), "搜出的全是第一幕线索，不串幕");
ok(!P[0].allRaw().includes("你手机相册第一张") && !P[2].allRaw().includes("你手机相册第一张"),
   "小满的私有线索：另外两人在任何报文里都搜不到");

// ---------- 第二幕 ----------
console.log("\n【第二幕】");
ok(await readyAll(P, 1), "全员就绪 → 进入第二幕");
ok(st(P[0])?.script?.locations?.length === 4, "第二幕开放 4 个地点（多了后仓与监控）");
ok(st(P[0])?.script?.myScriptKeys?.length === 2, "第二幕本文开放，共 2 份");
await searchAll(P);
ok([...new Set(P.flatMap((p) => (st(p)?.clues || []).map((c) => c.id)))].some((id) => id.startsWith("c.a2.")),
   "搜到第二幕线索");
ok(!P[1].allRaw().includes("后仓通风管上面那个铁盒") && !P[2].allRaw().includes("后仓通风管上面那个铁盒"),
   "阿豪的私有线索：另外两人零命中");
ok(!P[0].allRaw().includes("她不是坏人"), "第二幕：复盘内容仍零命中");
ok(!P[0].allRaw().includes("三十七秒"), "第二幕：第三幕线索仍零命中");

// ---------- 第三幕：六格拼图 ----------
console.log("\n【第三幕】时间线拼合 + 三选项投票");
ok(await readyAll(P, 2), "全员就绪 → 进入第三幕");
const m0 = st(P[0])?.mechanic;
ok(m0?.mechanicId === "timeline_puzzle", "第三幕加载时间线拼图");
ok(m0?.state?.slots?.length === 6, "时间线 6 格（3 人本靠每人两枚碎片撑起难度）");
ok((m0?.state?.slotLabels || []).length === 6, "六格都带时间提示");
ok((m0?.state?.slotLabels || []).includes("23:31"), "时间提示是真实时刻");

await waitFor(() => P.every((p) => (st(p)?.mechanic?.state?.myFragments || []).length === 2));
const frags = P.map((p) => st(p)?.mechanic?.state?.myFragments || []);
ok(frags.every((f) => f.length === 2), "每人恰好持有 2 枚碎片");
ok(new Set(frags.flat().map((f) => f.label)).size === 6, "六枚碎片内容各不相同");
ok(!P[1].allRaw().includes(frags[0][0].label), "别人手上未打出的碎片：全文搜索零命中");

// 真实时序：P1→格2、格5；P2→格3、格6；P3→格1、格4（下标 0 起）
const right = { P1: [1, 4], P2: [2, 5], P3: [0, 3] };
for (let i = 0; i < 3; i++) {
  const slots = right["P" + (i + 1)];
  for (let k = 0; k < 2; k++) {
    P[i].send({ type: "mechanic.action", mechanicId: "timeline_puzzle",
                payload: { op: "place", fragId: frags[i][k].fragId, slot: slots[k] } });
    await wait(160);
  }
}
ok(await waitFor(() => st(P[0])?.mechanic?.complete === true), "六枚碎片拼满 → 机制完成");
ok(await waitFor(() => st(P[0])?.mechanic?.state?.ordered === true), "按真实时序摆好 → 判定顺序正确");

// ---------- 投票：2:1 应命中多数决分支，而不是笼统的「分歧」 ----------
const v = st(P[0])?.vote;
ok(v?.voteId === "vote.final", "第三幕开放最终投票");
ok(v?.options?.length === 3, "三个选项：报警 / 当面说清 / 就当没发生");

P[0].send({ type: "vote.cast", voteId: "vote.final", choice: "call" }); await wait(150);
P[1].send({ type: "vote.cast", voteId: "vote.final", choice: "call" }); await wait(150);
P[2].send({ type: "vote.cast", voteId: "vote.final", choice: "keep" }); await wait(150);
ok(await waitFor(() => (st(P[0])?.vote?.castCount ?? 0) === 3), "三票全部记录");

for (const p of P) { p.send({ type: "act.ready" }); await wait(80); }
ok(await waitFor(() => st(P[0])?.room?.phase === "debrief"), "投票+拼图完成 → 进入复盘");
const raw = P[0].allRaw();
ok(raw.includes("多数 · 报警"), "2:1 命中 majority_call 分支（不再被笼统归入「分歧」）");
ok(!raw.includes("三个人，三个方向"), "没有误触 split 兜底");
ok(!raw.includes("全场一致"), "没有误判为全票一致");

// ---------- 复盘 ----------
console.log("\n【复盘】逐段揭示");
ok((st(P[0])?.debrief || []).length === 0, "刚进复盘时一段都没解锁");
ok(!P[0].allRaw().includes("她不是坏人"), "未解锁时复盘正文零命中");
P[0].send({ type: "debrief.next" });
ok(await waitFor(() => (st(P[0])?.debrief || []).length === 1), "解锁第一段");
for (let i = 0; i < 8; i++) { P[0].send({ type: "debrief.next" }); await wait(180); }
ok(await waitFor(() => (st(P[0])?.debrief || []).length === 6), "六段全部解锁");
ok(P[0].allRaw().includes("她不是坏人"), "复盘正文此时才下发");
ok(await waitFor(() => st(P[0])?.room?.phase === "ended"), "复盘走完 → 对局结束");

console.log(`\n=== 《台风夜》整局验收：${pass} 通过 / ${fail} 失败 ===`);
for (const w of ALL) { try { w.close(); } catch {} }
setTimeout(() => process.exit(fail ? 1 : 0), 300);
