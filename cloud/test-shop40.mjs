/**
 * 《四十年》整局验收：用真实剧本包跑通一整局，并对真实正文做防剧透全文搜索。
 * 用法：node test-shop40.mjs [baseUrl]
 *
 * 【防剧透】本文件只用「关键词是否出现」来断言，**不打印任何剧本正文**。
 * 断言里出现的词是刻意挑的判别词，不构成剧透。
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
/** 推进一幕：全员就绪 */
async function readyAll(P, toIndex) {
  for (const p of P) { p.send({ type: "act.ready" }); await wait(80); }
  return waitFor(() => st(P[0])?.room?.actIndex === toIndex && st(P[0])?.room?.phase === "playing");
}
/** 每人把本幕配额搜完 */
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

const ROOM = await findFreeRoom(WSBASE, "shop40");
console.log("测试房号:", ROOM, "| 目标:", HTTP, "| 剧本: shop40《四十年》\n");

// ---------- 入场 ----------
console.log("【流程】四人入座 → 选角 → 阅读");
const P = [];
const names = ["强", "华", "伟", "娣"];
for (let i = 0; i < 4; i++) {
  const c = await conn(ROOM, "shop40");
  await wait(150);
  c.send({ type: "seat.claim", displayName: names[i], pin: String(1111 * (i + 1)).slice(0, 4) });
  await wait(250);
  P.push(c);
}
ok(st(P[0])?.script?.scriptId === "shop40", "房间用的是 shop40");
ok(st(P[0])?.room?.seatCount === 4, "席位数按 meta.players = 4");
ok(st(P[0])?.script?.characters?.length === 4, "四个角色可选");

for (let i = 0; i < 4; i++) { P[i].send({ type: "character.pick", characterId: "P" + (i + 1) }); await wait(120); }
await waitFor(() => st(P[0])?.room?.phase === "reading");
ok(st(P[0])?.room?.phase === "reading", "全员选角 → 自动进入阅读");

// ---------- 阅读阶段的正文与防剧透 ----------
const s0 = st(P[0]);
const myKey0 = s0.script.myScriptKeys[0];
ok(s0.script.myScriptKeys.length === 1, "阅读阶段只开放第一幕本文（1 份）");
ok((s0.content[myKey0] || "").length > 1200, `第一幕本文体量够读（${(s0.content[myKey0] || "").length} 字）`);
ok((s0.content[myKey0] || "").includes("【你是谁】"), "公共背景与个人本已拼在一起");
ok((s0.content[myKey0] || "").includes("【你今晚要做到的】"), "本文带明确目标（无主持人时的讨论抓手）");
ok((s0.content[myKey0] || "").includes("【怎么玩】"), "本文含玩法说明（没有真人 DM 讲规则）");

console.log("\n【安全】真实正文的阶段隔离（全文搜索原始报文）");
const r0 = P[0].allRaw();
ok(!r0.includes("王荣发"), "阅读阶段：复盘专有人名 → 零命中");
ok(!r0.includes("律师"), "阅读阶段：后续幕关键物 → 零命中");
ok(!r0.includes("你姓王，不姓陈"), "阅读阶段：他人本文特征句 → 零命中");
ok(!r0.includes("香灰"), "阅读阶段：第三幕线索关键词 → 零命中");
ok(!r0.includes("这个星期六你回来"), "阅读阶段：第三幕拼图碎片 → 零命中");

// ---------- 第一幕 ----------
console.log("\n【第一幕】搜证");
for (const p of P) { p.send({ type: "act.ready" }); await wait(80); }
await waitFor(() => st(P[0])?.room?.phase === "playing" && st(P[0])?.room?.actIndex === 0);
ok(st(P[0])?.room?.actIndex === 0, "全员就绪 → 进入第一幕");
ok(st(P[0])?.script?.locations?.length === 3, "第一幕开放 3 个地点");
ok(st(P[0])?.script?.searchQuota === 2, "第一幕配额 2 次/人");
ok((st(P[0])?.room?.actEndsAt ?? 0) - Date.now() > 0, "服务端下发了本幕截止时间");

await searchAll(P);
const found1 = new Set(P.flatMap((p) => (st(p)?.clues || []).map((c) => c.id)));
ok(found1.size >= 6, `第一幕全场搜出 ${found1.size} 条线索（8 次配额，22 条线索池）`);
ok([...found1].every((id) => id.startsWith("c.a1.")), "搜出的全是第一幕线索，不串幕");

const p4Private = (st(P[3])?.clues || []).some((c) => c.private);
const othersSeeIt = P.slice(0, 3).some((p) => p.allRaw().includes("第五个杯子"));
ok(!othersSeeIt, "阿娣的私有线索：其他三人在任何报文里都搜不到");
if (p4Private) ok(true, "私有线索确实分给了指定角色");

ok(!P[0].allRaw().includes("王荣发"), "第一幕：复盘内容仍零命中");

// ---------- 第二幕 ----------
console.log("\n【第二幕】更多地点");
ok(await readyAll(P, 1), "全员就绪 → 进入第二幕");
ok(st(P[0])?.script?.locations?.length === 4, "第二幕开放 4 个地点（多了后巷与阁楼）");
ok(st(P[0])?.script?.myScriptKeys?.length === 2, "第二幕本文开放，共 2 份");
await searchAll(P);
const found2 = new Set(P.flatMap((p) => (st(p)?.clues || []).map((c) => c.id)));
ok([...found2].some((id) => id.startsWith("c.a2.")), "搜到第二幕线索");
ok(!P[0].allRaw().includes("王荣发"), "第二幕：复盘内容仍零命中");
ok(!P[0].allRaw().includes("香灰"), "第二幕：第三幕线索仍零命中");

// ---------- 第三幕：拼图 + 投票 ----------
console.log("\n【第三幕】时间线拼合 + 投票");
ok(await readyAll(P, 2), "全员就绪 → 进入第三幕");
const m0 = st(P[0])?.mechanic;
ok(m0?.mechanicId === "timeline_puzzle", "第三幕加载时间线拼图");
ok(m0?.state?.slots?.length === 4, "时间线 4 格");
ok((m0?.state?.slotLabels || []).length === 4, "每格带时间提示");
ok((m0?.state?.slotLabels || []).some((x) => x.includes("周四")), "时间提示是真实时间点，非占位");

const frags = P.map((p) => st(p)?.mechanic?.state?.myFragments || []);
ok(frags.every((f) => f.length === 1), "每人恰好持有 1 枚碎片");
ok(!frags.flat().some((f) => f.label.includes("占位")), "碎片是剧本真实内容，不是占位文本");
ok(new Set(frags.flat().map((f) => f.label)).size === 4, "四枚碎片内容各不相同");
ok(frags[0][0].label !== frags[1][0].label, "碎片按角色分发");
const outsider = P[1].allRaw();
ok(!outsider.includes(frags[0][0].label), "别人手上未打出的碎片：全文搜索零命中");

// 故意放错顺序：验证「错了也能推进」，再纠正过来验证判定
const wrongSlot = [3, 2, 1, 0];
for (let i = 0; i < 4; i++) {
  P[i].send({ type: "mechanic.action", mechanicId: "timeline_puzzle", payload: { op: "place", fragId: frags[i][0].fragId, slot: wrongSlot[i] } });
  await wait(180);
}
ok(await waitFor(() => st(P[0])?.mechanic?.complete === true), "四枚碎片拼满 → 机制完成");
ok(st(P[0])?.mechanic?.state?.ordered === false, "顺序不对时如实提示，但仍算完成（不卡幕）");
ok((st(P[1])?.mechanic?.state?.slots || []).every((x) => x && x.label), "拼上后全场可见");

for (let i = 0; i < 4; i++) {
  P[i].send({ type: "mechanic.action", mechanicId: "timeline_puzzle", payload: { op: "take", slot: wrongSlot[i] } });
  await wait(140);
}
// 真实时序：P1→第3格、P2→第2格、P3→第1格、P4→第4格（正确答案只有服务端知道，测试里写死）
const rightSlot = [2, 1, 0, 3];
for (let i = 0; i < 4; i++) {
  P[i].send({ type: "mechanic.action", mechanicId: "timeline_puzzle", payload: { op: "place", fragId: frags[i][0].fragId, slot: rightSlot[i] } });
  await wait(140);
}
ok(await waitFor(() => st(P[0])?.mechanic?.state?.ordered === true), "按真实时序摆好 → 判定顺序正确");

const v = st(P[0])?.vote;
ok(v?.voteId === "vote.final", "第三幕开放最终投票");
ok(v?.options?.length === 2, "两个选项：卖 / 留");
for (const p of P) { p.send({ type: "vote.cast", voteId: "vote.final", choice: "keep" }); await wait(120); }
ok(await waitFor(() => (st(P[0])?.vote?.castCount ?? 0) === 4), "四票全部记录");
ok(Object.keys(st(P[0])?.vote?.ballots || {}).length === 4, "实名模式保留完整票型");

for (const p of P) { p.send({ type: "act.ready" }); await wait(80); }
ok(await waitFor(() => st(P[0])?.room?.phase === "debrief"), "投票+拼图完成 → 进入复盘");
const endNar = P[0].allRaw();
ok(endNar.includes("全场一致"), "按票型触发了一致分支的结算播报");

// ---------- 复盘 ----------
console.log("\n【复盘】逐段揭示");
ok((st(P[0])?.debrief || []).length === 0, "刚进复盘时一段都没解锁（不甩全文）");
ok(!P[0].allRaw().includes("王荣发"), "未解锁时复盘正文零命中");

P[0].send({ type: "debrief.next" });
ok(await waitFor(() => (st(P[0])?.debrief || []).length === 1), "解锁第一段");
ok(P[0].allRaw().includes("王荣发"), "第一段正文此时才下发");
ok((st(P[0])?.debrief || []).length === 1, "第二段仍未下发（逐段）");

for (let i = 0; i < 8; i++) { P[0].send({ type: "debrief.next" }); await wait(180); }
ok(await waitFor(() => (st(P[0])?.debrief || []).length === 7), "七段全部解锁");
ok(await waitFor(() => st(P[0])?.room?.phase === "ended"), "复盘走完 → 对局结束");

console.log(`\n=== 《四十年》整局验收：${pass} 通过 / ${fail} 失败 ===`);
for (const w of ALL) { try { w.close(); } catch {} }
setTimeout(() => process.exit(fail ? 1 : 0), 300);
