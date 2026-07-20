/**
 * 全剧本冒烟：把选本列表里的每一个剧本都从入座跑到结束。
 * 用法：node test-all-scripts.mjs [baseUrl]
 *
 * 剧本多了以后，逐个写整局测试不现实。这一支只问一件事：
 * **这个本能不能被玩完**——坐满、选角、读本、逐幕搜证、投票、复盘、结束。
 * 任何一本卡在中间都会被逮住。
 *
 * 【防剧透】只断言流程与结构，不打印任何剧本正文。
 */
const HTTP = process.argv[2] || "http://127.0.0.1:8788";
const WSBASE = HTTP.replace(/^http/, "ws");

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); c ? pass++ : (fail++, process.exitCode = 1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = [];

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await wait(120); }
  return false;
}
function conn(room, script) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WSBASE}/ws?room=${room}&script=${encodeURIComponent(script)}`);
    ALL.push(ws);
    const msgs = [], raw = [];
    ws.addEventListener("message", (e) => { raw.push(e.data); msgs.push(JSON.parse(e.data)); });
    ws.addEventListener("open", () => res({
      ws, send: (o) => ws.send(JSON.stringify(o)),
      last: (t) => [...msgs].reverse().find((m) => m.type === t),
      allRaw: () => raw.join("\n"),
      close: () => { try { ws.close(); } catch {} },
    }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("connect timeout")), 12000);
  });
}
const st = (p) => p.last("snapshot.full");

async function playOne(meta) {
  const { scriptId, players, title } = meta;
  console.log(`\n【${title}】${scriptId} · ${players} 人`);
  // 必须用服务端分配（/api/newroom），不能自己探号：
  // 空房不等于「这个本的空房」——一个先前用别的剧本建过、现在没人的房间
  // 同样是空的 lobby，探号会当它可用，然后整局跑的其实是另一个本的内容。
  const alloc = await fetch(`${HTTP}/api/newroom?script=${encodeURIComponent(scriptId)}`).then((r) => r.json());
  const room = alloc.room;
  ok(/^\d{4}$/.test(room || ""), `分到房号 ${room}`);
  const P = [];
  for (let i = 0; i < players; i++) {
    const c = await conn(room, scriptId);
    await wait(120);
    c.send({ type: "seat.claim", displayName: `P${i + 1}`, pin: String(1000 + i * 111) });
    await wait(200);
    P.push(c);
  }
  ok(st(P[0])?.room?.seatCount === players, `坐满 ${players} 人`);
  ok(st(P[0])?.script?.scriptId === scriptId, `房间用的确实是 ${scriptId}`);

  const chars = st(P[0])?.script?.characters ?? [];
  ok(chars.length === players, `角色数与人数一致（${chars.length}）`);
  for (let i = 0; i < players; i++) { P[i].send({ type: "character.pick", characterId: chars[i].id }); await wait(110); }
  ok(await waitFor(() => st(P[0])?.room?.phase === "reading"), "全员选角 → 进入阅读");

  const book = st(P[0])?.content?.[st(P[0])?.script?.myScriptKeys?.[0]] ?? "";
  ok(book.length > 600, `第一幕本文够读（${book.length} 字）`);
  ok(book.includes("【怎么玩】"), "本文含玩法说明（没有真人 DM 讲规则）");
  ok(/【你和(他们|她们)】/.test(book), "本文含角色关系（讨论抓手）");

  // 逐幕：搜完配额就绪推进
  const actCount = st(P[0])?.script?.actCount ?? 0;
  for (let a = 0; a < actCount; a++) {
    for (const p of P) { p.send({ type: "act.ready" }); await wait(70); }
    if (!(await waitFor(() => P.every((x) => st(x)?.room?.actIndex === a && st(x)?.room?.phase === "playing")))) {
      // 最后一幕之后会离开 playing，属正常
      if (a < actCount) break;
    }
    for (const p of P) {
      for (let k = 0; k < 6; k++) {
        const s = st(p);
        const av = s?.script?.locationsAvailable ?? [];
        if (!av.length || s.script.searchUsed >= s.script.searchQuota) break;
        p.send({ type: "clue.unlock", locationId: av[Math.floor(Math.random() * av.length)] });
        await wait(130);
      }
    }
    // 本幕有投票就投第一个选项
    const v = st(P[0])?.vote;
    if (v) {
      for (const p of P) { p.send({ type: "vote.cast", voteId: v.voteId, choice: v.options[0].id }); await wait(110); }
      ok(await waitFor(() => (st(P[0])?.vote?.castCount ?? 0) === players), `第 ${a + 1} 幕投票全部记录`);
    }
  }

  for (const p of P) { p.send({ type: "act.ready" }); await wait(70); }

  // 带解谜机制的本，最后一幕要「拼对」才推得动，而这个通用脚本不知道答案。
  // 这里如实跳过并说明，不能让它看起来像是覆盖到了。
  const puzzle = st(P[0])?.mechanic;
  if (puzzle && st(P[0])?.room?.phase === "playing") {
    console.log(`  跳过 复盘流程：本幕有需要解谜的机制（${puzzle.mechanicId}），通用脚本无法作答`);
    console.log(`       —— 该剧本的完整流程由它自己的整局测试覆盖`);
  } else {
    ok(await waitFor(() => st(P[0])?.room?.phase === "debrief"), "走完全部幕 → 进入复盘");
    P[0].send({ type: "debrief.next" });
    ok(await waitFor(() => (st(P[0])?.debrief ?? []).length >= 1), "复盘可以逐段解锁");
    for (let i = 0; i < 12; i++) { P[0].send({ type: "debrief.next" }); await wait(140); }
    ok(await waitFor(() => st(P[0])?.room?.phase === "ended"), "复盘走完 → 对局结束");
  }

  for (const p of P) p.close();
  await wait(200);
}

const list = await fetch(HTTP + "/api/scripts").then((r) => r.json());
console.log(`目标: ${HTTP} | 选本列表共 ${list.scripts.length} 个剧本`);

// 选本页要能让人不点进去就知道这是个什么本
console.log("\n【选本卡】每个本都要有描述与分类");
for (const s of list.scripts) {
  const miss = [];
  if (!s.subtitle) miss.push("钩子");
  if (!s.blurb || s.blurb.length < 20) miss.push("简介");
  if (!(s.tags || []).length) miss.push("分类标签");
  if (!s.difficulty) miss.push("难度");
  ok(miss.length === 0, `${s.title}：描述齐全${miss.length ? "（缺 " + miss.join("、") + "）" : ""}`);
  // 正则查不出真剧透，只能挡住最直白的那几种写法（「凶手是…」这类）
  ok(!/(?:凶手是|真凶是|真相是|其实是.{0,8}(?:干的|杀|偷))/.test(s.subtitle + s.blurb),
     `${s.title}：选本卡没有直接写出答案`);
}

for (const meta of list.scripts) await playOne(meta);

console.log(`\n=== 全剧本冒烟：${pass} 通过 / ${fail} 失败 ===`);
for (const w of ALL) { try { w.close(); } catch {} }
setTimeout(() => process.exit(fail ? 1 : 0), 400);
