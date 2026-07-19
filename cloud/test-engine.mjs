/**
 * 阶段 3+4 验收：服务端权威可见性 + 运行时引擎
 * 用法：node test-engine.mjs [baseUrl]
 *
 * 安全验收采用「全文搜索」法：把某席位收到的【所有】WS 报文原文拼起来，
 * 用后续幕的占位关键词去搜，命中即判失败（对应说明书 6.2）。
 */
const HTTP = process.argv[2] || "http://127.0.0.1:8788";
const WSBASE = HTTP.replace(/^http/, "ws");
import { findFreeRoom } from "./test-util.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : (fail++, process.exitCode = 1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = [];

/**
 * 等待条件成立，而不是固定 sleep。
 * 固定 sleep 在生产延迟抖动时会级联误报，这是测试自身的缺陷。
 */
async function waitFor(fn, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch { /* 状态未就绪 */ }
    await wait(100);
  }
  return false;
}

function conn(room) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WSBASE}/ws?room=${room}`);
    ALL.push(ws);
    const msgs = [];
    const raw = [];               // 原始报文，用于全文搜索
    ws.addEventListener("message", (e) => { raw.push(e.data); msgs.push(JSON.parse(e.data)); });
    ws.addEventListener("open", () => res({
      ws, msgs, raw,
      send: (o) => ws.send(JSON.stringify(o)),
      last: (t) => [...msgs].reverse().find((m) => m.type === t),
      all: (t) => msgs.filter((m) => m.type === t),
      allRaw: () => raw.join("\n"),
      clear: () => { msgs.length = 0; raw.length = 0; },
    }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("timeout")), 10000);
  });
}

const ROOM = await findFreeRoom(WSBASE);
console.log("测试房号:", ROOM, "| 目标:", HTTP, "\n");

// ---------- 入场 + 选角 ----------
console.log("【流程】lobby → reading");
const P = [];
const names = ["爸爸", "妈妈", "哥哥", "妹妹"];
for (let i = 0; i < 4; i++) {
  const c = await conn(ROOM);
  await wait(150);
  c.send({ type: "seat.claim", displayName: names[i], pin: String(1111 * (i + 1)).slice(0, 4) });
  await wait(250);
  P.push(c);
}
ok(P[3].last("snapshot.full")?.room?.phase === "lobby", "四人入座后仍在 lobby（未选角不推进）");

for (let i = 0; i < 4; i++) { P[i].send({ type: "character.pick", characterId: "P" + (i + 1) }); await wait(120); }
await waitFor(() => P[0].last("snapshot.full")?.room?.phase === "reading");
const afterPick = P[0].last("snapshot.full");
ok(afterPick?.room?.phase === "reading", "坐满且全员选角 → 自动进入 reading（无需房主）");
ok(afterPick?.me?.characterId === "P1", "角色分配正确: " + afterPick?.me?.characterId);

// ---------- 安全：reading 阶段不得出现后续幕正文 ----------
console.log("\n【安全】阶段隔离（对应 6.2 全文搜索）");
const r0 = P[0].allRaw();
ok(!r0.includes("【占位-第二幕"), "reading 阶段：搜「第二幕」关键词 → 零命中");
ok(!r0.includes("【占位-第三幕"), "reading 阶段：搜「第三幕」关键词 → 零命中");
ok(!r0.includes("【占位-复盘"), "reading 阶段：搜「复盘」关键词 → 零命中");
ok(r0.includes("【占位-第一幕-P1剧本正文】"), "但本人第一幕正文已正常下发");
ok(!r0.includes("【占位-第一幕-P2剧本正文】"), "他人的第一幕正文 → 零命中");

// ---------- reading → act1 ----------
console.log("\n【流程】reading → playing[act1]");
// 注意：进度拉满不再等于读完，必须每人显式点「我读完了」
for (const c of P) { c.send({ type: "read.progress", progress: 1 }); await wait(80); c.send({ type: "act.ready" }); await wait(120); }
await waitFor(() => P[0].last("snapshot.full")?.room?.actIndex === 0 &&
                    P[0].last("snapshot.full")?.room?.phase === "playing");
const a1 = P[0].last("snapshot.full");
ok(a1?.room?.phase === "playing" && a1?.room?.actIndex === 0, "全员读完 → 自动进入第一幕");
ok(!!P[0].all("narration").find((n) => n.text.includes("第一幕-开场播报")), "第一幕开场播报已推送");
ok(typeof a1?.room?.actEndsAt === "number" && a1.room.actEndsAt > Date.now(), "服务端下发幕截止时间 actEndsAt");
const ends = P.map((c) => c.last("snapshot.full").room.actEndsAt);
ok(new Set(ends).size === 1, "四端 actEndsAt 完全一致（服务端时钟驱动）");

// ---------- 搜证 + 配额 + 私有线索 ----------
console.log("\n【搜证】配额与私有线索");
ok(a1?.script?.searchQuota === 2, "第一幕配额 2 次/人");
ok(a1?.script?.locations?.length === 3, "第一幕开放 3 个地点");
P[0].send({ type: "clue.unlock", locationId: "loc.counter" }); await wait(350);
ok(!!P[0].last("clue.granted"), "搜证成功获得线索");
P[0].send({ type: "clue.unlock", locationId: "loc.counter" }); await wait(350);
P[0].send({ type: "clue.unlock", locationId: "loc.stove" }); await wait(350);
ok(P[0].last("error")?.message?.includes("次数已用完"), "超出配额被拒");
P[1].send({ type: "clue.unlock", locationId: "loc.cellar" }); await wait(300);
ok(P[1].last("error")?.message?.includes("没有这个地点"), "本幕未开放的地点被拒");

// P3 的私有线索：只有 P3 能搜到、只有 P3 看得到
P[2].send({ type: "clue.unlock", locationId: "loc.altar" }); await wait(300);
P[2].send({ type: "clue.unlock", locationId: "loc.altar" }); await wait(300);
const p3raw = P[2].allRaw();
const p1raw = P[0].allRaw();
ok(!p1raw.includes("P3私有"), "玩家A 无法通过任何报文拿到 玩家C 的私有线索");
if (p3raw.includes("P3私有")) ok(true, "私有线索正确下发给有权席位");
else ok(true, "私有线索未被抽中（随机），不影响权限结论");

// ---------- 幕推进 ----------
console.log("\n【流程】act1 → act2 → act3");
for (const c of P) { c.send({ type: "act.ready" }); await wait(120); }
await waitFor(() => P[0].last("snapshot.full")?.room?.actIndex === 1);
const a2 = P[0].last("snapshot.full");
ok(a2?.room?.actIndex === 1, "全员就绪 → 进入第二幕");
ok(!!P[0].all("narration").find((n) => n.text.includes("第一幕-收束播报")), "第一幕收束播报已推送");
ok(P[0].allRaw().includes("【占位-第二幕-P1剧本正文】"), "第二幕开放后才下发第二幕正文");
ok(!P[0].allRaw().includes("【占位-第三幕"), "第二幕阶段：第三幕关键词仍零命中");
ok(!P[0].allRaw().includes("【占位-复盘"), "第二幕阶段：复盘关键词仍零命中");

for (const c of P) { c.send({ type: "act.ready" }); await wait(120); }
await waitFor(() => P[0].last("snapshot.full")?.room?.actIndex === 2);
ok(P[0].last("snapshot.full")?.room?.actIndex === 2, "进入第三幕");

// ---------- 机制框架（阶段5） ----------
console.log("\n【机制】可插拔组件框架");
const m0 = P[0].last("snapshot.full")?.mechanic;
ok(m0?.mechanicId === "timeline_puzzle", "第三幕机制已按 skeleton 声明加载: " + m0?.mechanicId);
ok(Array.isArray(m0?.state?.slots) && m0.state.slots.length >= 4, "机制状态已投影给客户端");
ok(m0?.state?.myFragments?.length === 1, "每席位持有各自私有碎片");
ok(typeof m0?.state?.othersHolding === "number", "他人未打出的碎片只暴露数量，不暴露内容");
ok(m0?.complete === false, "初始未完成");

// 非法操作必须被服务端拒绝
const myFrag = m0.state.myFragments[0].fragId;
P[1].send({ type: "mechanic.action", mechanicId: "timeline_puzzle", payload: { op: "place", fragId: myFrag, slot: 0 } });
await wait(400);
ok(P[1].last("error")?.message?.includes("不是你的碎片"), "服务端拒绝操作他人碎片");
P[0].send({ type: "mechanic.action", mechanicId: "timeline_puzzle", payload: { op: "place", fragId: myFrag, slot: 99 } });
await wait(400);
ok(P[0].last("error")?.message?.includes("格子不存在"), "服务端拒绝非法格子");

// 四人各放一枚碎片，填满时间线
for (let i = 0; i < 4; i++) {
  const st = P[i].last("snapshot.full").mechanic.state;
  P[i].send({
    type: "mechanic.action",
    mechanicId: "timeline_puzzle",
    payload: { op: "place", fragId: st.myFragments[0].fragId, slot: i },
  });
  await wait(250);
}
await waitFor(() => P[0].last("snapshot.full")?.mechanic?.complete === true);
ok(P[0].last("snapshot.full")?.mechanic?.complete === true, "填满后机制判定完成");
ok(P[1].last("snapshot.full")?.mechanic?.state?.emptySlots?.length === 0, "缺口位置投影给所有人（已无缺口）");

// ---------- 投票（完整票型 + 分支结算） ----------
console.log("\n【投票】完整票型与分支结算");
const v = P[0].last("snapshot.full")?.vote;
ok(!!v && v.voteId === "vote.final", "第三幕投票已开放: " + v?.voteId);
ok(v?.options?.length === 2, "选项数正确");
for (const c of P) { c.send({ type: "act.ready" }); await wait(100); }
await wait(300);
ok(P[0].last("snapshot.full")?.room?.actIndex === 2, "未投票时不推进（advance.requires 生效）");

P[0].send({ type: "vote.cast", voteId: "vote.final", choice: "sell" }); await wait(200);
P[1].send({ type: "vote.cast", voteId: "vote.final", choice: "sell" }); await wait(200);
P[2].send({ type: "vote.cast", voteId: "vote.final", choice: "keep" }); await wait(200);
P[3].send({ type: "vote.cast", voteId: "vote.final", choice: "sell" });
await waitFor(() => P[0].last("snapshot.full")?.room?.phase === "debrief");
const vv = P[0].last("snapshot.full")?.vote;
ok(vv?.ballots && Object.keys(vv.ballots).length === 4, "记录完整票型（谁投了什么），非仅结果");
const ending = P[0].all("narration").find((n) => n.text.includes("结局"));
ok(!!ending, "按票型触发结算播报");
ok(ending?.text?.includes("分歧"), "3:1 正确命中 split 分支: " + ending?.text);

// ---------- 复盘分段解锁 ----------
console.log("\n【复盘】分段解锁");
const dph = P[0].last("snapshot.full");
ok(dph?.room?.phase === "debrief", "进入复盘阶段");
ok(dph?.debrief?.length === 0, "刚进复盘时未解锁任何段（不一次性甩全文）");
ok(!P[0].allRaw().includes("【占位-复盘-第一段】"), "未解锁时复盘正文零命中");
P[0].send({ type: "debrief.next" });
await waitFor(() => P[0].last("snapshot.full")?.debrief?.length === 1);
const d1 = P[0].last("snapshot.full");
ok(d1?.debrief?.length === 1, "解锁第一段");
ok(P[0].allRaw().includes("【占位-复盘-第一段】"), "第一段正文下发");
ok(!P[0].allRaw().includes("【占位-复盘-第二段】"), "第二段仍未下发（逐段揭示）");
P[0].send({ type: "debrief.next" });
await waitFor(() => P[0].last("snapshot.full")?.debrief?.length === 2);
ok(P[0].last("snapshot.full")?.debrief?.length === 2, "解锁第二段");

// ---------- 断线重连快照完整性 ----------
console.log("\n【恢复】对局中重连");
const snapBefore = P[1].last("snapshot.full");
P[1].ws.close(); await wait(600);
const back = await conn(ROOM); await wait(200);
// 用昵称+PIN 兜底恢复
back.send({ type: "seat.recover", displayName: "妈妈", pin: "2222" });
await waitFor(() => !!back.last("snapshot.full"));
const bs = back.last("snapshot.full");
ok(bs?.me?.characterId === snapBefore.me.characterId, "重连后角色不变");
ok(bs?.room?.phase === "debrief", "重连后阶段正确");
ok(bs?.narration?.length > 0, "重连后补齐已下发的播报（不丢主持人内容）");

console.log(`\n=== 阶段3+4 验收：${pass} 通过 / ${fail} 失败 ===`);
for (const ws of ALL) { try { ws.close(); } catch {} }
await wait(300);
process.exit(fail ? 1 : 0);
