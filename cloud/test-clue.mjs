/**
 * 搜证与摊牌验收：搜到的线索默认只有自己看得见，公开与否由玩家决定。
 * 用法：node test-clue.mjs [baseUrl]
 *
 * 这套机制在迁移到云引擎时整个丢过一次（搜到即全场可见），
 * 而玩法说明里明明写着「什么时候说、说多少、要不要说，是你自己的选择」。
 * 所以这里用全文搜索原始报文的方式钉死它。
 */
const HTTP = process.argv[2] || "http://127.0.0.1:8788";
const WSBASE = HTTP.replace(/^http/, "ws");

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : (fail++, process.exitCode = 1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = [];

async function waitFor(fn, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await wait(110); }
  return false;
}
function conn(room) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WSBASE}/ws?room=${room}`);
    ALL.push(ws);
    const msgs = [], raw = [];
    ws.addEventListener("message", (e) => { raw.push(e.data); msgs.push(JSON.parse(e.data)); });
    ws.addEventListener("open", () => res({
      ws, send: (o) => ws.send(JSON.stringify(o)),
      last: (t) => [...msgs].reverse().find((m) => m.type === t),
      all: (t) => msgs.filter((m) => m.type === t),
      allRaw: () => raw.join("\n"),
    }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("timeout")), 10000);
  });
}
const st = (p) => p.last("snapshot.full");

const SCRIPT = "lighthouse";                    // 3 人，跑得快
const alloc = await fetch(`${HTTP}/api/newroom?script=${SCRIPT}`).then((r) => r.json());
console.log("测试房号:", alloc.room, "| 目标:", HTTP, "| 剧本:", SCRIPT, "\n");

const P = [];
for (let i = 0; i < 3; i++) {
  const c = await conn(alloc.room);
  await wait(130);
  c.send({ type: "seat.claim", displayName: "玩家" + (i + 1), pin: String(1111 * (i + 1)).slice(0, 4) });
  await wait(220);
  P.push(c);
}
const chars = st(P[0]).script.characters;
for (let i = 0; i < 3; i++) { P[i].send({ type: "character.pick", characterId: chars[i].id }); await wait(120); }
await waitFor(() => st(P[0])?.room?.phase === "reading");
for (const p of P) { p.send({ type: "act.ready" }); await wait(80); }
ok(await waitFor(() => P.every((p) => st(p)?.room?.phase === "playing")), "进入第一幕");

console.log("\n【搜证】每个地点剩几条要如实告诉玩家");
const rem = st(P[0])?.script?.locationRemaining;
ok(!!rem && Object.keys(rem).length === st(P[0]).script.locations.length, "每个地点都给出了剩余条数");
ok(Object.values(rem).every((n) => typeof n === "number"), "剩余条数是数字");
const firstLoc = st(P[0]).script.locations.find((l) => rem[l] > 0);
const before = rem[firstLoc];

console.log("\n【私藏】搜到的线索默认只有自己看得见");
P[0].send({ type: "clue.unlock", locationId: firstLoc });
ok(await waitFor(() => (st(P[0])?.clues ?? []).length > 0), "玩家1 搜到线索");
const got = st(P[0]).clues[0];
ok(got.mine === true, "标记为「我手上的」");
ok(got.published === false, "默认未公开");
ok(st(P[0]).script.locationRemaining[firstLoc] === before - 1, `该地点剩余条数递减（${before} → ${before - 1}）`);

const text = st(P[0]).content[got.contentKey];
ok(!!text && text.length > 10, "自己能读到正文");
// 正文里有换行，在原始报文里是 JSON 转义过的（\n）。直接拿原串去 includes 永远搜不到，
// 那样负向断言会「因为搜错了」而通过——必须比对转义后的形态。
const wire = JSON.stringify(text).slice(1, -1);
ok(P[0].allRaw().includes(wire), "自检：转义后的正文确实能在自己的报文里搜到（保证下面的负向断言有效）");

await wait(600);
ok((st(P[1])?.clues ?? []).length === 0, "玩家2 的线索列表里没有它");
ok(!P[1].allRaw().includes(wire), "玩家2 的【任何报文】里都搜不到这条正文");
ok(!P[2].allRaw().includes(wire), "玩家3 也搜不到");

console.log("\n【摊牌】只有持有者能公开，公开后全场可见");
P[1].send({ type: "clue.publish", clueId: got.id });
await wait(500);
ok(P[1].last("error")?.message?.includes("不是你手上的"), "别人不能替你公开");
ok(!P[1].allRaw().includes(wire), "被拒之后仍然搜不到正文");

P[0].send({ type: "clue.publish", clueId: got.id });
ok(await waitFor(() => (st(P[1])?.clues ?? []).some((c) => c.id === got.id)), "公开后玩家2 看得到了");
ok(P[1].allRaw().includes(wire), "正文此时才下发给别人");
const seen = (st(P[1]).clues ?? []).find((c) => c.id === got.id);
ok(seen.published === true, "标记为已公开");
ok(seen.mine === false, "对别人来说不是「我手上的」");
ok(seen.byName === "玩家1", "记录了是谁摊的牌: " + seen.byName);
ok(!!P[1].all("clue.published").length, "全场收到公开广播");

P[0].send({ type: "clue.publish", clueId: got.id });
await wait(400);
ok(P[0].last("error")?.message?.includes("已经公开"), "不能重复公开");

console.log(`\n=== 搜证与摊牌验收：${pass} 通过 / ${fail} 失败 ===`);
for (const w of ALL) { try { w.close(); } catch {} }
setTimeout(() => process.exit(fail ? 1 : 0), 300);
