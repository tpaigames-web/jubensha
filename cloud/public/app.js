/* 剧本杀小馆 · 新引擎前端
   要点：
   - 身份挂在席位上：token 同时写入 localStorage 与 URL（微信场景 URL 最可靠）
   - 恢复优先级：URL token → localStorage token → 房号+昵称+PIN
   - 计时用服务端时钟：本地只算偏移量，四端一致
   - 客户端不做任何权限判断，只渲染服务端投影下来的内容
*/
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const S = {
  ws: null,
  st: null,            // 最新 snapshot
  room: "",
  token: "",
  name: "",
  pin: "",
  offset: 0,           // serverNow - Date.now()
  tab: "script",
  narration: [],
  seen: { clue: 0, dm: 0, chat: 0 },
  chatThread: null,        // null=全部(公开)，否则为对方 seatId
  seenThread: {},          // 每个会话已读到的条数
  connected: false,
  retry: 0,
  sound: true,
  fontIdx: 1,
  wakeLock: null,
  audioReady: false,
};
const FONTS = [15, 17, 19, 22];

// ---------------- 小工具 ----------------
function toast(msg, ok) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (ok ? " ok" : "");
  t.style.display = "block";
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.style.display = "none"), 2600);
}
function banner(msg, cls) {
  const b = $("banner");
  if (!msg) { b.style.display = "none"; return; }
  b.textContent = msg;
  b.className = "banner " + (cls || "warn");
  b.style.display = "block";
}
function show(view) {
  for (const v of ["login", "room", "lobby", "game"]) $("v-" + v).style.display = v === view ? "block" : "none";
  window.scrollTo(0, 0);
}
function send(o) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o));
}
const serverNow = () => Date.now() + S.offset;

// ---------------- 会话持久化 ----------------
function saveSession() {
  try {
    localStorage.setItem("jbs2", JSON.stringify({ room: S.room, token: S.token }));
  } catch {}
  // 令牌写进 URL：微信里用户不会重输网址，但聊天记录里的链接永远在
  if (S.token) {
    const u = new URL(location.href);
    u.searchParams.set("room", S.room);
    u.searchParams.set("t", S.token);
    history.replaceState(null, "", u.toString());
    $("my-link").textContent = u.toString();
  }
}
function loadSession() {
  const u = new URL(location.href);
  const urlRoom = u.searchParams.get("room");
  const urlTok = u.searchParams.get("t");
  if (urlRoom && urlTok) return { room: urlRoom, token: urlTok };   // 优先级 1
  try {
    const v = JSON.parse(localStorage.getItem("jbs2") || "null");
    if (v && v.room && v.token) return v;                            // 优先级 2
  } catch {}
  return null;
}

// ---------------- 连接 ----------------
function connect(room, onOpen) {
  S.room = room;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
  S.ws = ws;

  ws.onopen = () => {
    S.connected = true; S.retry = 0; banner("");
    onOpen && onOpen();
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    S.connected = false;
    banner("连接已断开，正在重连…", "warn");
    const delay = Math.min(1000 * Math.pow(1.6, S.retry++), 8000);
    setTimeout(() => reconnect(), delay);
  };
  ws.onerror = () => {};
}
function reconnect() {
  if (S.connected) return;
  connect(S.room, () => {
    if (S.token) send({ type: "seat.resume", seatToken: S.token });
  });
}

// ---------------- 消息处理 ----------------
function handle(m) {
  switch (m.type) {
    case "hello": {
      if (typeof m.serverNow === "number") S.offset = m.serverNow - Date.now();
      // 「加入房间」时若该房号其实还没人，说明多半是输错了。
      // 若直接入座，服务端会用默认剧本把空房建出来，玩家就再也没机会选本——必须先问清楚。
      const j = S._pendingJoin;
      if (j) {
        S._pendingJoin = null;
        if (m.room.seatsTaken === 0 && !j.expectNew) {
          try { if (S.ws) { S.ws.onclose = null; S.ws.close(); } } catch {}
          S.ws = null; S.connected = false;
          banner("");
          show("room");
          toast(`房号 ${j.code} 还没有人。要开新局请在上面选剧本；加入朋友请核对房号。`);
          return;
        }
        send({ type: "seat.claim", displayName: S.name, pin: S.pin });
      }
      break;
    }

    case "snapshot.full": {
      S.offset = m.room.serverNow - Date.now();
      if (m.seatToken) { S.token = m.seatToken; saveSession(); showLinkOnce(); }
      const prevPhase = S.st?.room?.phase;
      S.st = m;
      if (Array.isArray(m.narration) && m.narration.length >= S.narration.length) S.narration = m.narration;
      render();
      if (prevPhase && prevPhase !== m.room.phase) speak(phaseName(m.room.phase) + " 开始");
      break;
    }

    case "seats.updated":
      if (S.st) { S.st.seats = m.seats; renderSeats(); }
      break;

    case "narration":
      S.narration.push({ key: m.key, at: m.at || serverNow(), text: m.text, style: m.style });
      if (S.tab !== "dm") { $("n-dm").style.display = "inline-block"; $("n-dm").textContent = S.narration.length - S.seen.dm; }
      renderDM();
      showNarration(m.text);   // 文字弹层 + 朗读，可跳过
      break;

    case "act.changed":
      toast("进入新的一幕", true);
      break;

    case "clue.granted":
      toast("获得线索", true);
      break;

    case "seat.elsewhere":
      banner("你的席位已在其他设备打开（两端都可继续操作）", "warn");
      setTimeout(() => banner(""), 6000);
      break;

    case "error":
      toast(m.message || m.code);
      // 服务端拒绝时不推快照，主动要一次，避免界面停在过期状态
      if (S.st && m.code === "bad_input") setTimeout(() => send({ type: "snapshot.request" }), 400);
      if (m.code === "bad_token") {           // 令牌失效 → 用昵称+PIN 自动找回
        S.token = "";
        try { localStorage.removeItem("jbs2"); } catch {}
        if (S.name && S.pin) {
          send({ type: "seat.recover", displayName: S.name, pin: S.pin });
        } else {
          banner("");
          show("login");
          toast("专属链接已失效，请重新输入昵称和 PIN");
        }
      }
      if (m.code === "seat_not_found" && S.name && S.pin) {
        // 房间被重置过：当作新玩家重新入座
        send({ type: "seat.claim", displayName: S.name, pin: S.pin });
      }
      break;
  }
}

function phaseName(p) {
  return { lobby: "等待入座", reading: "阅读剧本", playing: "对局中", debrief: "复盘", ended: "已结束" }[p] || p;
}

// ---------------- 第一步：身份 ----------------
$("btn-login").onclick = () => {
  const name = $("in-name").value.trim();
  const pin = $("in-pin").value.trim();
  if (!name) return toast("请输入昵称");
  if (!/^\d{4}$/.test(pin)) return toast("PIN 必须是4位数字");
  S.name = name; S.pin = pin;
  try { localStorage.setItem("jbs2_id", JSON.stringify({ name, pin })); } catch {}
  unlockAudio();
  // 从别人分享的房间链接进来的：登记完身份直接入座
  if (S._joinAfterLogin) { const r = S._joinAfterLogin; S._joinAfterLogin = null; return enterRoom(r); }
  gotoRoomView();
};
$("btn-back-login").onclick = () => show("login");

function gotoRoomView() {
  $("who-label").textContent = S.name;
  show("room");
  loadScripts();
}

// ---------------- 第二步：选本 / 加入 ----------------
async function loadScripts() {
  try {
    const r = await fetch("/api/scripts").then((x) => x.json());
    $("script-list").innerHTML = r.scripts.map((s) => `
      <div class="char-card" data-script="${esc(s.scriptId)}">
        <b>${esc(s.title)}</b>
        <div class="hint">${s.players} 人本 · 约 ${s.durationMin} 分钟</div>
      </div>`).join("") || '<p class="hint">暂无可用剧本</p>';
    $("script-list").querySelectorAll("[data-script]").forEach((el) => {
      el.onclick = () => createRoom(el.dataset.script);
    });
  } catch {
    $("script-list").innerHTML = '<p class="hint">剧本列表加载失败，检查网络后重试</p>';
  }
}

const rnd4 = () => String(Math.floor(1000 + Math.random() * 9000));

/** 开新局：随机房号，若撞上已有人的房间则换一个 */
function createRoom(scriptId, tries = 0) {
  if (tries > 6) return toast("房号分配失败，请重试");
  const code = rnd4();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const probe = new WebSocket(`${proto}://${location.host}/ws?room=${code}&script=${encodeURIComponent(scriptId)}`);
  const timer = setTimeout(() => { try { probe.close(); } catch {} ; createRoom(scriptId, tries + 1); }, 6000);
  probe.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== "hello") return;
    clearTimeout(timer);
    probe.onmessage = null;
    try { probe.close(); } catch {}
    if (m.room.seatsTaken > 0) return createRoom(scriptId, tries + 1); // 撞号了，换一个
    enterRoom(code, true); // 自己刚开的新局，空房是正常的
  };
  probe.onerror = () => { clearTimeout(timer); toast("连接失败"); };
}

$("btn-join").onclick = () => {
  const code = $("in-room").value.trim();
  if (!/^\d{4}$/.test(code)) return toast("请输入4位房号");
  enterRoom(code);
};

/**
 * 入座。expectNew=true 表示这是「选本开局」刚建好的房间，空房属正常；
 * 否则视为「加入朋友的房间」，空房要先警告，避免误建成默认剧本的房间。
 */
function enterRoom(code, expectNew = false) {
  unlockAudio();
  connect(code, () => {
    S._pending = { name: S.name, pin: S.pin };
    S._pendingJoin = { code, expectNew };
  });
}

// 认领失败（重名/已开始）时自动走找回
const origHandle = handle;
function handleWithFallback(m) {
  if (m.type === "error" && S._pending && (m.code === "name_taken" || m.code === "bad_input")) {
    const { name, pin } = S._pending;
    S._pending = null;
    send({ type: "seat.recover", displayName: name, pin });
    return;
  }
  if (m.type === "snapshot.full") S._pending = null;
  origHandle(m);
}
handle = handleWithFallback;

function showLinkOnce() {
  if (localStorage.getItem("jbs2_linktip")) return;
  try { localStorage.setItem("jbs2_linktip", "1"); } catch {}
  setTimeout(() => toast("这是你的专属链接，换设备时打开它就能回来", true), 800);
}

$("btn-copy").onclick = async () => {
  const url = $("my-link").textContent;
  try {
    await navigator.clipboard.writeText(url);
    toast("已复制，发给自己保存一下", true);
  } catch {
    // 微信等环境剪贴板可能受限：退化为选中文本
    const r = document.createRange();
    r.selectNodeContents($("my-link"));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    toast("已选中，请长按复制");
  }
};

$("btn-random").onclick = () => send({ type: "character.pick", random: true });

// ---------------- 渲染 ----------------
function render() {
  const st = S.st;
  if (!st) return;
  if (st.room.phase === "lobby") { show("lobby"); renderLobby(); }
  else { show("game"); renderGame(); }
}

function renderLobby() {
  const st = S.st;
  $("lobby-room").textContent = st.room.roomId;
  $("lobby-count").textContent = `${st.seats.length} / ${st.room.seatCount} 人已入座`;
  $("lobby-script").textContent = st.content[st.script.titleKey] || st.script.scriptId;
  renderSeats();

  const taken = {};
  st.seats.forEach((s) => { if (s.characterId) taken[s.characterId] = s; });
  $("lobby-chars").innerHTML = st.script.characters.map((c) => {
    const o = taken[c.id];
    const mine = o && o.seatId === st.me.seatId;
    return `<div class="char-card ${mine ? "mine" : o ? "taken" : ""}" data-char="${esc(c.id)}">
      <b>${esc(st.content[c.nameKey] || c.id)}</b>
      ${o ? `<span class="tag" style="float:right">${mine ? "我的角色" : esc(o.displayName)}</span>` : ""}
      <div class="hint">${esc(st.content[c.briefKey] || "")}</div>
    </div>`;
  }).join("");
  $("lobby-chars").querySelectorAll("[data-char]").forEach((el) => {
    el.onclick = () => send({ type: "character.pick", characterId: el.dataset.char });
  });
}

function renderSeats() {
  const st = S.st; if (!st) return;
  const html = st.seats.map((s) => `
    <div class="seat-row">
      <span class="dot ${s.online ? "on" : ""}"></span>
      <span class="grow">${esc(s.displayName)}${s.seatId === st.me.seatId ? "（我）" : ""}</span>
      ${s.ready ? '<span class="tag ok">已就绪</span>' : ""}
      ${s.characterId ? `<span class="tag">${esc(st.content[(st.script.characters.find((c) => c.id === s.characterId) || {}).nameKey] || s.characterId)}</span>` : '<span class="tag">未选角</span>'}
    </div>`).join("");
  const box = $("lobby-seats"); if (box) box.innerHTML = html;
}

function renderGame() {
  const st = S.st;
  $("g-phase").textContent = st.room.phase === "playing"
    ? `第${st.room.actIndex + 1}幕 / ${st.script.actCount}`
    : phaseName(st.room.phase);
  renderScript(); renderClue(); renderAct(); renderChat(); renderDM(); renderActionBar();
  const n = chatUnreadTotal();
  if (n > 0) { $("n-chat").textContent = n > 99 ? "99+" : n; $("n-chat").style.display = "inline-block"; }
  else $("n-chat").style.display = "none";
  applyBgm(st.script.bgm || null);   // 幕切换时自动换曲；剧本没配就静默
  tickTimer();
}

// --- 剧本页（含阅读进度上报） ---
function renderScript() {
  const st = S.st;
  const keys = st.script.myScriptKeys || [];
  const body = keys.map((k, i) => `
    <div class="card">
      <h2>第${i + 1}幕 · 我的剧本</h2>
      <div class="script-text">${esc(st.content[k] || "（本幕正文尚未开放）")}</div>
    </div>`).join("");

  const meSeat = st.seats.find((s) => s.seatId === st.me.seatId) || {};
  const others = st.seats.map((s) => `
    <div class="seat-row">
      <span class="dot ${s.online ? "on" : ""}"></span>
      <span style="min-width:4em">${esc(s.displayName)}</span>
      <div class="progressbar"><i style="width:${Math.round((s.readProgress || 0) * 100)}%"></i></div>
      ${s.ready ? '<span class="tag ok">就绪</span>' : `<span class="tag">${Math.round((s.readProgress || 0) * 100)}%</span>`}
    </div>`).join("");

  $("p-script").innerHTML = body + `
    <div class="card"><h2>📚 阅读进度</h2>${others}
      <p class="hint" style="margin-top:8px">进度条只是给大家看看谁还在读。<b>必须每个人自己点下面的「我读完了」</b>才会推进——滚到底不算数，慢慢看。</p>
    </div>`;
}

// 滚动上报阅读进度（节流）
let lastReport = 0;
window.addEventListener("scroll", () => {
  if (!S.st || S.tab !== "script") return;
  const now = Date.now();
  if (now - lastReport < 1200) return;
  lastReport = now;
  const h = document.documentElement.scrollHeight - window.innerHeight;
  const p = h <= 0 ? 1 : Math.min(1, window.scrollY / h);
  if (p > (S.st.me.readProgress || 0) + 0.02) send({ type: "read.progress", progress: p });
}, { passive: true });

// --- 线索页 ---
function renderClue() {
  const st = S.st;
  let html = "";
  if (st.room.phase === "playing" && st.script.locations.length) {
    const left = st.script.searchQuota - st.script.searchUsed;
    const avail = new Set(st.script.locationsAvailable || st.script.locations);
    const nothingLeft = avail.size === 0;
    html += `<div class="card"><h2>🔍 搜证</h2>
      <p class="hint" style="margin-bottom:8px">本幕剩余 <b style="color:#d9b45b">${left}</b> 次${nothingLeft ? " · 这一幕已经没有你能搜到的线索了" : ""}</p>
      <div class="loc-grid">${st.script.locations.map((l) => {
        const off = left <= 0 || !avail.has(l);
        return `<button class="loc-btn" data-loc="${esc(l)}" ${off ? "disabled" : ""}>📍 ${esc(st.content[l] || l)}${!avail.has(l) ? "<br><span class='hint'>已搜空</span>" : ""}</button>`;
      }).join("")}</div>
    </div>`;
  }
  html += `<div class="card"><h2>📜 我掌握的线索（${st.clues.length}）</h2>` +
    (st.clues.length ? st.clues.map((c) => `
      <div class="clue ${c.private ? "private" : ""}">
        <div class="hint">📍 ${esc(st.content[c.location] || c.location)} ${c.private ? "· 🔒 私有" : ""}</div>
        <div>${esc(st.content[c.contentKey] || "")}</div>
      </div>`).join("") : '<p class="hint">还没有线索</p>') + `</div>`;
  $("p-clue").innerHTML = html;
  $("p-clue").querySelectorAll("[data-loc]").forEach((el) => {
    el.onclick = () => send({ type: "clue.unlock", locationId: el.dataset.loc });
  });
  S.seen.clue = st.clues.length;
}

// --- 行动页：投票 + 机制 + 复盘 ---
function renderAct() {
  const st = S.st;
  let html = "";

  if (st.mechanic) html += renderMechanic(st.mechanic);
  if (st.vote) html += renderVote(st.vote);

  if (st.room.phase === "debrief" || st.room.phase === "ended") {
    html += `<div class="card"><h2>🎬 复盘</h2>` +
      (st.debrief.length ? st.debrief.map((d, i) => `
        <div class="narration" style="margin-bottom:10px"><div class="t">第 ${i + 1} 段</div>${esc(st.content[d.contentKey] || "")}</div>`).join("")
        : '<p class="hint">点下面的「揭示下一段」开始复盘</p>') +
      (st.room.phase === "debrief" ? `<button class="btn primary wide" id="btn-debrief">▶ 揭示下一段</button>` : "<p class=hint>复盘完毕，本局结束。</p>") +
      `</div>`;
  }

  if (!html) html = `<div class="card"><p class="hint">当前没有需要行动的事项，安心读本与讨论即可。</p></div>`;
  $("p-act").innerHTML = html;

  const db = $("btn-debrief");
  if (db) db.onclick = () => send({ type: "debrief.next" });
  bindVote();
  bindMechanic();
}

function renderVote(v) {
  const st = S.st;
  const mode = v.mode;
  const my = v.myChoice;
  const isMulti = mode === "multi", isRank = mode === "ranked";
  const sel = Array.isArray(my) ? my : my ? [my] : [];

  const opts = v.options.map((o) => {
    const idx = sel.indexOf(o.id);
    const on = idx >= 0;
    return `<div class="vote-opt ${on ? "sel" : ""}" data-opt="${esc(o.id)}">
      <span>${esc(st.content[o.labelKey] || o.id)}</span>
      <span>${isRank && on ? `<span class="rank-num">${idx + 1}</span>` : on ? "✅" : ""}</span>
    </div>`;
  }).join("");

  const tallyHtml = v.ballots
    ? `<p class="hint" style="margin-top:6px">实名公开：${Object.entries(v.ballots).map(([sid, c]) => {
        const s = st.seats.find((x) => x.seatId === sid);
        const label = (Array.isArray(c) ? c : [c]).map((cc) => st.content[(v.options.find((o) => o.id === cc) || {}).labelKey] || cc).join(" > ");
        return `${esc(s ? s.displayName : "?")}→${esc(label)}`;
      }).join("；")}</p>`
    : v.tally
      ? `<p class="hint" style="margin-top:6px">匿名统计：${Object.entries(v.tally).map(([c, n]) => `${esc(st.content[(v.options.find((o) => o.id === c) || {}).labelKey] || c)} ${n}票`).join("，")}</p>`
      : "";

  const modeName = { single_public: "单选·实名", single_anonymous: "单选·匿名", ranked: "排序", multi: "多选" }[mode] || mode;
  return `<div class="card" id="vote-box" data-vote="${esc(v.voteId)}" data-mode="${esc(mode)}">
    <h2>🗳️ ${esc(st.content[v.promptKey] || "投票")}</h2>
    <p class="hint" style="margin-bottom:8px">${modeName} · 已投 ${v.castCount}/${v.seatCount}${isRank ? " · 依次点击完成排序" : isMulti ? " · 可多选" : ""}</p>
    ${opts}
    ${isRank || isMulti ? `<button class="btn primary wide" id="btn-vote-submit" style="margin-top:6px">提交</button>` : ""}
    ${tallyHtml}
  </div>`;
}

let pendingSel = [];
function bindVote() {
  const box = $("vote-box"); if (!box) return;
  const mode = box.dataset.mode, voteId = box.dataset.vote;
  const my = S.st.vote.myChoice;
  if (pendingSel.length === 0 && Array.isArray(my)) pendingSel = [...my];

  box.querySelectorAll("[data-opt]").forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.opt;
      if (mode === "single_public" || mode === "single_anonymous") {
        send({ type: "vote.cast", voteId, choice: id });
        return;
      }
      const i = pendingSel.indexOf(id);
      if (i >= 0) pendingSel.splice(i, 1); else pendingSel.push(id);
      // 本地即时反馈
      S.st.vote.myChoice = [...pendingSel];
      renderAct();
    };
  });
  const sub = $("btn-vote-submit");
  if (sub) sub.onclick = () => {
    if (!pendingSel.length) return toast("请先选择");
    send({ type: "vote.cast", voteId, choice: [...pendingSel] });
    toast("已提交", true);
  };
}

// --- 机制：时间线拖拽（Pointer Events，手机可用） ---
function renderMechanic(m) {
  const s = m.state || {};
  const slots = (s.slots || []).map((x, i) => `
    <div class="slot ${x ? "filled" : ""}" data-slot="${i}">
      ${x ? `${esc(x.label)}${x.byMe ? ' <span class="tag" style="margin-left:6px">我放的·点击取回</span>' : ""}` : `第 ${i + 1} 格（空）`}
    </div>`).join("");
  const frags = (s.myFragments || []).map((f) => `<div class="frag" data-frag="${esc(f.fragId)}">${esc(f.label)}</div>`).join("");
  return `<div class="card" id="mech-box" data-mid="${esc(m.mechanicId)}">
    <h2>🧩 时间线拼合</h2>
    <p class="hint" style="margin-bottom:8px">
      ${m.complete ? "✅ 已拼合完整" : `还剩 ${(s.emptySlots || []).length} 格 · 其他人手上还有 ${s.othersHolding ?? 0} 枚`}
    </p>
    <div class="timeline">${slots}</div>
    <div style="margin-top:12px">
      <div class="hint" style="margin-bottom:6px">我的碎片（拖到格子里，或点一下再点格子）</div>
      <div class="row" style="flex-wrap:wrap">${frags || '<span class="hint">已全部放置</span>'}</div>
    </div>
  </div>`;
}

let pickedFrag = null;
function bindMechanic() {
  const box = $("mech-box"); if (!box) return;
  const mid = box.dataset.mid;
  const ghost = $("drag-ghost");

  const act = (payload) => send({ type: "mechanic.action", mechanicId: mid, payload });

  // 点击式（无障碍 & 兜底）
  box.querySelectorAll("[data-frag]").forEach((el) => {
    el.onclick = () => {
      pickedFrag = el.dataset.frag;
      box.querySelectorAll("[data-frag]").forEach((x) => x.classList.remove("dragging"));
      el.classList.add("dragging");
      toast("已选中，点一个空格放入");
    };
    // 拖拽式：用 Pointer Events（HTML5 DnD 在移动端支持极差）
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const fragId = el.dataset.frag;
      ghost.textContent = el.textContent;
      ghost.style.display = "block";
      const move = (ev) => {
        ghost.style.left = ev.clientX - 40 + "px";
        ghost.style.top = ev.clientY - 24 + "px";
        box.querySelectorAll(".slot").forEach((sl) => {
          const r = sl.getBoundingClientRect();
          const hit = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
          sl.classList.toggle("hover", hit && !sl.classList.contains("filled"));
        });
      };
      const up = (ev) => {
        ghost.style.display = "none";
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        let target = null;
        box.querySelectorAll(".slot").forEach((sl) => {
          const r = sl.getBoundingClientRect();
          if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) target = sl;
          sl.classList.remove("hover");
        });
        if (target && !target.classList.contains("filled")) {
          act({ op: "place", fragId, slot: Number(target.dataset.slot) });
          pickedFrag = null;
        }
      };
      document.addEventListener("pointermove", move, { passive: false });
      document.addEventListener("pointerup", up);
    });
  });

  box.querySelectorAll("[data-slot]").forEach((el) => {
    el.onclick = () => {
      const slot = Number(el.dataset.slot);
      if (el.classList.contains("filled")) { act({ op: "take", slot }); return; }
      if (pickedFrag) { act({ op: "place", fragId: pickedFrag, slot }); pickedFrag = null; }
      else toast("先点一枚自己的碎片");
    };
  });
}

// --- 播报：弹层（文字必现，朗读可跳过） ---
function showNarration(text) {
  $("dm-pop-text").textContent = text;
  $("dm-pop").style.display = "flex";
  speak(text);
}
function closeNarration() { $("dm-pop").style.display = "none"; stopSpeak(); }
$("dm-skip").onclick = () => { stopSpeak(); toast("已跳过朗读，文字保留在【播报】页", true); };
$("dm-ok").onclick = closeNarration;
$("dm-pop").onclick = (e) => { if (e.target.id === "dm-pop") closeNarration(); };

// --- 播报页（历史，可重播） ---
function renderDM() {
  const html = S.narration.length
    ? S.narration.slice().reverse().map((n, i) => `
      <div class="narration ${esc(n.style || "")}">
        <div class="t">${new Date(n.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
          <button class="btn ghost" style="float:right;min-height:32px;padding:4px 10px;font-size:.85em" data-replay="${S.narration.length - 1 - i}">🔊 重播</button>
        </div>
        <div style="white-space:pre-wrap">${esc(n.text)}</div>
      </div>`).join("")
    : '<div class="card"><p class="hint">主持人还没有说话。</p></div>';
  $("p-dm").innerHTML = html;
  $("p-dm").querySelectorAll("[data-replay]").forEach((el) => {
    el.onclick = () => { const n = S.narration[Number(el.dataset.replay)]; if (n) showNarration(n.text); };
  });
  if (S.tab === "dm") { S.seen.dm = S.narration.length; $("n-dm").style.display = "none"; }
}

// --- 聊天页：公开 + 私聊 ---
// 面板只搭一次；之后每次快照只刷新消息列表，
// 否则正在输入的文字和已选的私聊对象会被冲掉。
function renderChat() {
  const st = S.st;
  if (!st) return;
  if (!$("chat-list")) buildChatPanel();
  updateChatTargets();
  renderChatMessages();
}

/** 页签角标：所有会话的未读之和（当前打开的那个不算） */
function chatUnreadTotal() {
  const st = S.st; if (!st) return 0;
  const meId = st.me.seatId;
  const keys = [null].concat(st.seats.filter((s) => s.seatId !== meId).map((s) => s.seatId));
  let n = 0;
  for (const k of keys) {
    if (S.tab === "chat" && (S.chatThread || null) === k) continue;
    const total = (st.chat || []).filter((m) => threadOf(m, meId) === k).length;
    n += Math.max(0, total - (S.seenThread[k ?? "__all__"] || 0));
  }
  return n;
}

function buildChatPanel() {
  $("p-chat").innerHTML = `
    <div class="card">
      <div class="chat-wrap">
        <div class="chat-threads" id="chat-threads"></div>
        <div class="chat-main">
          <div class="chat-hint" id="chat-hint"></div>
          <div class="chat-list" id="chat-list"></div>
          <div class="chat-bar">
            <input id="chat-input" class="grow" maxlength="500" placeholder="说点什么…">
            <button class="btn primary" id="chat-send" style="flex:none">发送</button>
          </div>
        </div>
      </div>
    </div>`;
  const doSend = () => {
    const el = $("chat-input");
    const v = el.value.trim();
    if (!v) return;
    send({ type: "chat.send", to: S.chatThread || null, text: v });
    el.value = "";
  };
  $("chat-send").onclick = doSend;
  $("chat-input").onkeydown = (e) => { if (e.key === "Enter") doSend(); };
}

/** 某条消息属于哪个会话：公开→null，私聊→对方的 seatId */
function threadOf(m, meId) {
  if (m.to === null) return null;
  return m.from === meId ? m.to : m.from;
}

/** 会话列表：全部 + 每个其他玩家一条，带未读数 */
function updateChatTargets() {
  const st = S.st;
  const box = $("chat-threads");
  const others = st.seats.filter((s) => s.seatId !== st.me.seatId);
  const msgs = st.chat || [];

  const unread = (key) => {
    const seen = S.seenThread[key ?? "__all__"] || 0;
    const total = msgs.filter((m) => threadOf(m, st.me.seatId) === key).length;
    return Math.max(0, total - seen);
  };

  const item = (key, title, sub) => {
    const on = (S.chatThread || null) === key;
    const n = on ? 0 : unread(key);
    return `<button class="thread ${on ? "on" : ""}" data-thread="${key === null ? "" : esc(key)}">
      ${esc(title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}
      ${n > 0 ? `<span class="dot-n">${n > 99 ? "99+" : n}</span>` : ""}
    </button>`;
  };

  const html = [item(null, "全部", "所有人可见")]
    .concat(others.map((s) => {
      const cn = st.content[(st.script.characters.find((c) => c.id === s.characterId) || {}).nameKey];
      return item(s.seatId, "🔒 " + s.displayName, cn || "");
    })).join("");

  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
    box.querySelectorAll("[data-thread]").forEach((el) => {
      el.onclick = () => {
        S.chatThread = el.dataset.thread || null;
        markThreadSeen();
        renderChat();
        $("chat-input")?.focus();
      };
    });
  }
}

function markThreadSeen() {
  const st = S.st; if (!st) return;
  const key = S.chatThread || null;
  const total = (st.chat || []).filter((m) => threadOf(m, st.me.seatId) === key).length;
  S.seenThread[key ?? "__all__"] = total;
}

function renderChatMessages() {
  const st = S.st;
  const meId = st.me.seatId;
  const key = S.chatThread || null;
  const msgs = (st.chat || []).filter((m) => threadOf(m, meId) === key);

  const other = key ? st.seats.find((s) => s.seatId === key) : null;
  $("chat-hint").textContent = key
    ? `🔒 与 ${other ? other.displayName : "?"} 的私聊 —— 只有你们两人能看到`
    : "📢 公开讨论 —— 所有人可见";
  $("chat-input").placeholder = key ? `私聊 ${other ? other.displayName : ""}…` : "对所有人说…";

  const list = msgs.map((m) => {
    const mine = m.from === meId;
    return `<div class="msg ${mine ? "me" : ""} ${m.to !== null ? "pm" : ""}">
      <div class="meta">${esc(mine ? "我" : m.fromName)} · ${new Date(m.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</div>
      <div style="white-space:pre-wrap">${esc(m.text)}</div>
    </div>`;
  }).join("");

  const box = $("chat-list");
  const sig = key + ":" + msgs.length;
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = list || `<p class="hint">${key ? "还没有和 TA 说过话。这里说的只有你们两人看得到。" : "还没有人说话。"}</p>`;
    box.scrollTop = box.scrollHeight;
  }
  if (S.tab === "chat") markThreadSeen();
}

// --- 底部操作条 ---
function renderActionBar() {
  const st = S.st;
  const bar = $("actionbar");
  const me = st.seats.find((s) => s.seatId === st.me.seatId) || {};

  if (st.room.phase === "reading" || st.room.phase === "playing") {
    bar.innerHTML = me.ready
      ? `<button class="btn ghost wide" disabled>已就绪，等待其他人…（${st.seats.filter((s) => s.ready).length}/${st.seats.length}）</button>`
      : `<button class="btn primary wide" id="btn-ready">✅ 我读完了 / 准备推进</button>`;
    const b = $("btn-ready");
    // 只有点了这个按钮才算读完；滚到底不再自动判定，避免有人一拉到底就把整幕跳过
    if (b) b.onclick = () => send({ type: "act.ready" });
    return;
  }

  if (st.room.phase === "ended") {
    // 局已结束：必须给出口，否则刷新会一直回到这个房间
    bar.innerHTML = `
      <button class="btn primary grow" id="btn-again">🔄 再来一局</button>
      <button class="btn ghost" id="btn-leave" style="flex:none">🚪 离开</button>`;
    $("btn-again").onclick = () => leaveRoom(S.st?.script?.scriptId || null);
    $("btn-leave").onclick = () => leaveRoom(null);
    return;
  }

  bar.innerHTML = "";
}

/** 离开当前房间：清掉会话与 URL 令牌，回到选本页；带 scriptId 则直接开同一剧本的新局 */
function leaveRoom(scriptId) {
  try { if (S.ws) { S.ws.onclose = null; S.ws.close(); } } catch {}
  S.ws = null; S.st = null; S.token = ""; S.room = ""; S.narration = []; S.connected = false;
  try { localStorage.removeItem("jbs2"); } catch {}
  history.replaceState(null, "", location.pathname);
  banner("");
  if (scriptId) { show("room"); loadScripts(); createRoom(scriptId); toast("正在开新的一局…", true); }
  else gotoRoomView();
}

const confirmLeave = () => {
  const ended = S.st?.room?.phase === "ended";
  if (ended || confirm("确定离开这个房间吗？你的席位会保留，用同样的房号+昵称+PIN 可以回来。")) leaveRoom(null);
};
$("btn-exit").onclick = confirmLeave;
$("btn-lobby-exit").onclick = confirmLeave;

// ---------------- 计时器（服务端时钟） ----------------
setInterval(tickTimer, 1000);
function tickTimer() {
  const st = S.st; if (!st) return;
  const el = $("g-timer"); if (!el) return;
  if (!st.room.actEndsAt) { el.textContent = ""; return; }
  const left = Math.max(0, st.room.actEndsAt - serverNow());
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  el.textContent = `⏳ ${m}:${String(s).padStart(2, "0")}`;
  el.classList.toggle("urgent", left < 60000);
}

// ---------------- 页签 ----------------
document.querySelectorAll(".tab").forEach((el) => {
  el.onclick = () => {
    S.tab = el.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === el));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    $("p-" + S.tab).classList.add("active");
    if (S.tab === "dm") { S.seen.dm = S.narration.length; $("n-dm").style.display = "none"; }
    if (S.tab === "chat" && S.st) { markThreadSeen(); renderChat(); $("n-chat").style.display = "none"; }
    window.scrollTo(0, 0);
  };
});

// ---------------- 移动端加固 ----------------
// 字号
$("btn-font").onclick = () => {
  S.fontIdx = (S.fontIdx + 1) % FONTS.length;
  document.documentElement.style.setProperty("--fs", FONTS[S.fontIdx] + "px");
  try { localStorage.setItem("jbs2_fs", String(S.fontIdx)); } catch {}
  toast("字号：" + ["小", "标准", "大", "特大"][S.fontIdx], true);
};
// 声音
$("btn-sound").onclick = () => {
  S.sound = !S.sound;
  $("btn-sound").textContent = S.sound ? "🔊" : "🔇";
  try { localStorage.setItem("jbs2_sound", S.sound ? "1" : "0"); } catch {}
  if (S.sound) { unlockAudio(); applyBgm(S.st?.script?.bgm || null); }
  else { stopSpeak(); stopBgm(); }
  toast(S.sound ? "声音已开启（念白+背景音乐）" : "已静音", true);
};

// ---- 背景音乐：剧本声明了才放，文件缺失静默跳过 ----
const BGM = { el: null, cur: null, fadeTimer: null };
function applyBgm(rel) {
  if (!S.sound) { stopBgm(); return; }
  if (!rel) { stopBgm(); return; }
  const url = "/audio/" + rel;
  if (BGM.cur === url && BGM.el && !BGM.el.paused) return;
  if (!BGM.el) {
    BGM.el = new Audio();
    BGM.el.loop = true;
    BGM.el.volume = 0;
    // 文件不存在就当没这回事，绝不打扰玩家
    BGM.el.addEventListener("error", () => { BGM.cur = null; });
  }
  BGM.cur = url;
  BGM.el.src = url;
  BGM.el.volume = 0;
  BGM.el.play().then(() => fadeTo(0.35)).catch(() => { /* 未解锁或文件缺失 */ });
}
function fadeTo(target) {
  clearInterval(BGM.fadeTimer);
  BGM.fadeTimer = setInterval(() => {
    if (!BGM.el) return clearInterval(BGM.fadeTimer);
    const d = target - BGM.el.volume;
    if (Math.abs(d) < 0.02) { BGM.el.volume = target; clearInterval(BGM.fadeTimer); return; }
    BGM.el.volume = Math.max(0, Math.min(1, BGM.el.volume + d * 0.15));
  }, 60);
}
function stopBgm() {
  clearInterval(BGM.fadeTimer);
  if (BGM.el) { try { BGM.el.pause(); } catch {} }
  BGM.cur = null;
}
/** 念白期间把 BGM 压低，说完恢复 */
function duckBgm(down) {
  if (BGM.el && !BGM.el.paused) fadeTo(down ? 0.12 : 0.35);
}

// 念白：先用浏览器内建 TTS 顶替，后续可替换为录音
function speak(text) {
  if (!S.sound || !text || !window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/[【】]/g, " "));
    u.lang = "zh-CN"; u.rate = 1.02;
    duckBgm(true);                        // 念白时压低背景音乐
    u.onend = () => duckBgm(false);
    u.onerror = () => duckBgm(false);
    speechSynthesis.speak(u);
  } catch { duckBgm(false); }
}
function stopSpeak() {
  try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch {}
  duckBgm(false);
}
// 移动端必须在用户手势里解锁音频
function unlockAudio() {
  if (S.audioReady) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) { const c = new Ctx(); const o = c.createOscillator(); const g = c.createGain(); g.gain.value = 0; o.connect(g); g.connect(c.destination); o.start(0); o.stop(0.01); }
    if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
    S.audioReady = true;
  } catch {}
}
// 微信内必须等 JSBridge 就绪，否则音频永远不响
if (/micromessenger/i.test(navigator.userAgent)) {
  document.addEventListener("WeixinJSBridgeReady", unlockAudio, false);
}
document.addEventListener("touchend", unlockAudio, { once: true, passive: true });

// 屏幕常亮：读剧本时手机十几秒就锁屏，体感极差
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && !S.wakeLock) S.wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}
// 回到前台：立刻重连并拉全量快照（微信杀后台常是整页重载，这里覆盖非重载的情况）
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  keepAwake();
  if (!S.connected) reconnect();
  else if (S.token) send({ type: "seat.resume", seatToken: S.token });
});

// ---------------- 启动 ----------------
(function boot() {
  try {
    const f = localStorage.getItem("jbs2_fs");
    if (f !== null) { S.fontIdx = Number(f); document.documentElement.style.setProperty("--fs", FONTS[S.fontIdx] + "px"); }
    const snd = localStorage.getItem("jbs2_sound");
    if (snd !== null) { S.sound = snd === "1"; $("btn-sound").textContent = S.sound ? "🔊" : "🔇"; }
  } catch {}

  // 记住身份，免得每局重输
  try {
    const id = JSON.parse(localStorage.getItem("jbs2_id") || "null");
    if (id?.name) { S.name = id.name; S.pin = id.pin; $("in-name").value = id.name; $("in-pin").value = id.pin || ""; }
  } catch {}

  const sess = loadSession();
  if (sess) {
    S.token = sess.token;
    show("lobby");
    banner("正在恢复你的席位…", "warn");
    connect(sess.room, () => {
      send({ type: "seat.resume", seatToken: sess.token });
      saveSession();
    });
    keepAwake();
    return;
  }

  const u = new URL(location.href);
  const urlRoom = u.searchParams.get("room");
  if (urlRoom && S.name && S.pin) {
    // 别人分享的房间链接（无令牌）：身份已记住，直接入座
    enterRoom(urlRoom);
  } else if (urlRoom) {
    show("login");
    S._joinAfterLogin = urlRoom;
  } else if (S.name && S.pin) {
    gotoRoomView();
  } else {
    show("login");
  }
  keepAwake();
})();
