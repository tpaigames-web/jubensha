/**
 * 陪练机器人：自动补足其余席位并跟着流程走，方便一个人测完整局。
 * 用法：node bots.mjs <房号> [人数=3] [baseUrl]
 *
 * 机器人会：选角 → 读完 → 就绪 → 搜证 → 投票 → 放碎片 → 复盘推进
 */
const ROOM = process.argv[2];
const N = Number(process.argv[3] || 3);
const HTTP = process.argv[4] || "http://127.0.0.1:8788";
const WSBASE = HTTP.replace(/^http/, "ws");

if (!ROOM) { console.error("用法: node bots.mjs <房号> [人数] [baseUrl]"); process.exit(1); }

const NAMES = ["机器人乙", "机器人丙", "机器人丁", "机器人戊", "机器人己", "机器人庚"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeBot(name, pin) {
  const ws = new WebSocket(`${WSBASE}/ws?room=${ROOM}`);
  const bot = { name, ws, st: null, done: new Set() };

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "seat.claim", displayName: name, pin }));
  });

  ws.addEventListener("message", async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "error") {
      if (m.code === "name_taken" || m.code === "bad_input") {
        ws.send(JSON.stringify({ type: "seat.recover", displayName: name, pin }));
        return;
      }
      // 操作被拒（例如抢同一个格子失败）：服务端不会推快照，需自己要一次再重试
      await wait(600 + Math.random() * 600);
      ws.send(JSON.stringify({ type: "snapshot.request" }));
      return;
    }
    if (m.type !== "snapshot.full") return;
    bot.st = m;
    const st = m;

    // 选角：挑一个没人要的
    if (st.room.phase === "lobby" && !st.me.characterId) {
      const taken = new Set(st.seats.map((s) => s.characterId).filter(Boolean));
      const free = st.script.characters.find((c) => !taken.has(c.id));
      if (free) { await wait(300 + Math.random() * 500); ws.send(JSON.stringify({ type: "character.pick", characterId: free.id })); }
      return;
    }

    // 读本：慢慢读，模拟真人
    if (st.room.phase === "reading" && !st.me.ready) {
      const key = "read" + st.room.actIndex;
      if (!bot.done.has(key)) {
        bot.done.add(key);
        await wait(1500 + Math.random() * 2000);
        ws.send(JSON.stringify({ type: "read.progress", progress: 1 }));
        ws.send(JSON.stringify({ type: "act.ready" }));
      }
      return;
    }

    if (st.room.phase !== "playing") {
      // 复盘：跟着推进
      if (st.room.phase === "debrief") {
        const key = "deb" + st.debrief.length;
        if (!bot.done.has(key)) { bot.done.add(key); await wait(2500); ws.send(JSON.stringify({ type: "debrief.next" })); }
      }
      return;
    }

    const act = st.room.actIndex;

    // 搜证：把本幕次数用掉（只搜「对我还有货」的地点，否则会在搜空的地点空转）
    const avail = st.script.locationsAvailable || st.script.locations;
    if (st.script.searchUsed < st.script.searchQuota && avail.length) {
      const key = `search${act}_${st.script.searchUsed}`;
      if (!bot.done.has(key)) {
        bot.done.add(key);
        await wait(800 + Math.random() * 1200);
        ws.send(JSON.stringify({ type: "clue.unlock", locationId: avail[Math.floor(Math.random() * avail.length)] }));
        return;
      }
    }

    // 机制：把自己的碎片放进空格
    // 注意：多人可能抢同一个空格，服务端会拒绝其中一个。
    // 因此这里不能"尝试一次就永久标记完成"，必须允许重试并随机挑格子降低碰撞。
    if (st.mechanic && !st.mechanic.complete) {
      const s = st.mechanic.state || {};
      if (s.myFragments?.length && s.emptySlots?.length) {
        const now = Date.now();
        if (now - (bot.lastMech || 0) > 900) {
          bot.lastMech = now;
          await wait(300 + Math.random() * 900);
          const slot = s.emptySlots[Math.floor(Math.random() * s.emptySlots.length)];
          ws.send(JSON.stringify({
            type: "mechanic.action", mechanicId: st.mechanic.mechanicId,
            payload: { op: "place", fragId: s.myFragments[0].fragId, slot },
          }));
          return;
        }
      }
    }

    // 投票
    if (st.vote && !st.vote.myChoice) {
      const key = "vote" + st.vote.voteId;
      if (!bot.done.has(key)) {
        bot.done.add(key);
        await wait(1200 + Math.random() * 1500);
        const mode = st.vote.mode;
        const ids = st.vote.options.map((o) => o.id);
        const choice = mode === "ranked" ? ids : mode === "multi" ? [ids[0]] : ids[Math.floor(Math.random() * ids.length)];
        ws.send(JSON.stringify({ type: "vote.cast", voteId: st.vote.voteId, choice }));
        return;
      }
    }

    // 就绪
    if (!st.me.ready) {
      const key = "ready" + act;
      if (!bot.done.has(key)) {
        bot.done.add(key);
        await wait(2000 + Math.random() * 2000);
        ws.send(JSON.stringify({ type: "act.ready" }));
      }
    }
  });

  ws.addEventListener("close", () => console.log(`[${name}] 断开`));
  return bot;
}

console.log(`陪练机器人加入房间 ${ROOM}（${N} 个）→ ${HTTP}`);
const bots = [];
for (let i = 0; i < N; i++) {
  bots.push(makeBot(NAMES[i], String(2222 + i * 1111).slice(0, 4)));
  await wait(400);
}

setInterval(() => {
  const b = bots[0];
  if (b?.st) {
    const st = b.st;
    process.stdout.write(`\r阶段=${st.room.phase} 幕=${st.room.actIndex + 1} 就绪=${st.seats.filter((s) => s.ready).length}/${st.seats.length}   `);
  }
}, 2000);
