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
  // 先把上一条连接彻底断掉并解绑回调。不解绑的话，旧 socket 晚一步关闭时
  // 它的 onclose 仍会触发重连，把刚建好的这条连接顶掉——表现就是「刚进房又被踢出来」。
  closeSocket();
  S.room = room;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
  S.ws = ws;

  ws.onopen = () => {
    if (S.ws !== ws) return;                 // 已被更新的连接取代
    S.connected = true; S.retry = 0; banner("");
    onOpen && onOpen();
  };
  ws.onmessage = (e) => { if (S.ws === ws) handle(JSON.parse(e.data)); };
  ws.onclose = () => {
    if (S.ws !== ws) return;                 // 这是条过期连接，别拿它去重连
    S.connected = false;
    banner("连接已断开，正在重连…", "warn");
    const delay = Math.min(1000 * Math.pow(1.6, S.retry++), 8000);
    setTimeout(() => reconnect(), delay);
  };
  ws.onerror = () => {};
}

/** 断开当前连接并解绑，之后它再关闭也不会引发重连 */
function closeSocket() {
  const ws = S.ws;
  S.ws = null; S.connected = false;
  if (!ws) return;
  try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); } catch {}
}

function reconnect() {
  if (S.connected || !S.room) return;        // 不在任何房间里就别重连
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
          closeSocket();
          S.room = "";
          banner("");
          show("room");
          toast(`房号 ${j.code} 还没有人。要开新局请在下面选剧本；加入朋友请核对房号。`);
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
      toast("你搜到一条线索（只有你看得见）", true);
      break;

    case "clue.published":
      toast(`${m.byName} 公开了一条线索`, true);
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
/** 分类的显示顺序。本子上的标签是自由文本，这里只固定常用几类的次序 */
const TAG_ORDER = ["新手", "欢乐", "悬疑烧脑", "硬核", "还原", "情感", "灵异"];
const SCRIPTS = { all: [], nPlayers: "", tag: "" };

async function loadScripts() {
  try {
    const r = await fetch("/api/scripts").then((x) => x.json());
    // 按人数排，人数相同的短本在前——找本的人多半先想「今晚几个人」
    SCRIPTS.all = (r.scripts || []).sort((a, b) => a.players - b.players || a.durationMin - b.durationMin);
    renderScriptFilters();
    renderScriptList();
  } catch {
    $("script-list").innerHTML = '<p class="hint">剧本列表加载失败，检查网络后重试</p>';
  }
}

function renderScriptFilters() {
  const counts = [...new Set(SCRIPTS.all.map((s) => s.players))].sort((a, b) => a - b);
  const tags = [...new Set(SCRIPTS.all.flatMap((s) => s.tags || []))]
    .filter((t) => t !== "AI创作")                       // 这个不是分类，是署名
    .sort((a, b) => {
      const ia = TAG_ORDER.indexOf(a), ib = TAG_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  const chip = (label, kind, val, on) =>
    `<button class="chip ${on ? "on" : ""}" data-kind="${kind}" data-val="${esc(val)}">${esc(label)}</button>`;

  $("script-filters").innerHTML =
    `<div class="chips">${chip("全部人数", "n", "", !SCRIPTS.nPlayers)}` +
      counts.map((n) => chip(`${n} 人`, "n", String(n), SCRIPTS.nPlayers === String(n))).join("") + `</div>` +
    `<div class="chips">${chip("全部类型", "t", "", !SCRIPTS.tag)}` +
      tags.map((t) => chip(t, "t", t, SCRIPTS.tag === t)).join("") + `</div>`;

  $("script-filters").querySelectorAll("[data-kind]").forEach((el) => {
    el.onclick = () => {
      if (el.dataset.kind === "n") SCRIPTS.nPlayers = el.dataset.val;
      else SCRIPTS.tag = el.dataset.val;
      renderScriptFilters();
      renderScriptList();
    };
  });
}

function renderScriptList() {
  const list = SCRIPTS.all.filter((s) =>
    (!SCRIPTS.nPlayers || String(s.players) === SCRIPTS.nPlayers) &&
    (!SCRIPTS.tag || (s.tags || []).includes(SCRIPTS.tag)));

  $("script-list").innerHTML = list.map((s) => {
    const tags = (s.tags || []).map((t) =>
      `<span class="tag ${t === "AI创作" ? "" : "cat"}">${esc(t)}</span>`).join("");
    return `<div class="script-card" data-script="${esc(s.scriptId)}">
      <div class="sc-head">
        <b>${esc(s.title)}</b>
        <span class="sc-meta">${s.players} 人 · 约 ${s.durationMin} 分钟</span>
      </div>
      ${s.subtitle ? `<div class="sc-sub">${esc(s.subtitle)}</div>` : ""}
      ${s.blurb ? `<div class="sc-blurb">${esc(s.blurb)}</div>` : ""}
      <div class="sc-tags">${tags}${s.difficulty ? `<span class="tag">${esc(s.difficulty)}</span>` : ""}</div>
    </div>`;
  }).join("") || '<p class="hint">这个条件下没有本。换个人数或类型看看。</p>';

  $("script-list").querySelectorAll("[data-script]").forEach((el) => {
    el.onclick = () => createRoom(el.dataset.script);
  });
}

/**
 * 开新局：房号由服务端挑（/api/newroom），一次 HTTP 请求定好房号与剧本。
 * 以前是前端连开好几条 WebSocket 逐个试号，手机网络一抖就整个开局失败，
 * 且失败后不重试——玩家只看到「连接失败」，再点也没反应。
 */
async function createRoom(scriptId, tries = 0) {
  try {
    const r = await fetch("/api/newroom?script=" + encodeURIComponent(scriptId), { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!j.room) throw new Error(j.error || "no_room");
    enterRoom(j.room, true);            // 服务端保证是空房，不必再警告
  } catch (e) {
    if (tries < 2) return setTimeout(() => createRoom(scriptId, tries + 1), 800);
    toast("开局失败，请检查网络后再试一次");
  }
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

// 入座链接：不带令牌的干净网址，可以放心发群里。带房号，点开直接进这一局。
$("btn-copy-site").onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${S.room}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("已复制，发群里就行", true);
  } catch {
    toast(`复制失败，念房号 ${S.room} 给他们也一样`);
  }
};

$("btn-random").onclick = () => send({ type: "character.pick", random: true });

// ---------------- 渲染 ----------------
function render() {
  const st = S.st;
  if (!st) return;
  if (st.room.phase === "lobby") { show("lobby"); renderLobby(); }
  else { show("game"); renderGame(); }
  applyBgm(st.script.bgm || null);   // 等人的时候就该有底噪，不是开局才有
}

function renderLobby() {
  const st = S.st;
  $("lobby-room").textContent = st.room.roomId;
  const waiting = st.room.seatCount - st.seats.length;
  $("lobby-count").textContent = waiting > 0
    ? `${st.seats.length} / ${st.room.seatCount} 人已入座 · 还差 ${waiting} 个`
    : `${st.seats.length} / ${st.room.seatCount} 人已入座 · 齐了`;
  $("lobby-count2").textContent = String(st.seats.length);
  $("site-url").textContent = location.host + location.pathname.replace(/\/$/, "");
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

/** 已经看见过的席位。面对面开局时，要能看出「谁刚进来」 */
const SEEN_SEATS = new Set();
function renderSeats() {
  const st = S.st; if (!st) return;
  const fresh = [];
  const html = st.seats.map((s) => {
    const isNew = !SEEN_SEATS.has(s.seatId);
    if (isNew) { SEEN_SEATS.add(s.seatId); if (s.seatId !== st.me.seatId) fresh.push(s.displayName); }
    return `
    <div class="seat-row ${isNew ? "just-in" : ""}">
      <span class="dot ${s.online ? "on" : ""}"></span>
      <span class="grow">${esc(s.displayName)}${s.seatId === st.me.seatId ? "（我）" : ""}</span>
      ${s.ready ? '<span class="tag ok">已就绪</span>' : ""}
      ${s.characterId ? `<span class="tag">${esc(st.content[(st.script.characters.find((c) => c.id === s.characterId) || {}).nameKey] || s.characterId)}</span>` : '<span class="tag">未选角</span>'}
    </div>`;
  }).join("");
  const box = $("lobby-seats"); if (box) box.innerHTML = html;
  if (fresh.length && st.room.phase === "lobby") toast(`${fresh.join("、")} 入座了`, true);
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
    const rem = st.script.locationRemaining || {};
    const avail = new Set(st.script.locationsAvailable || st.script.locations);
    const nothingLeft = avail.size === 0;
    html += `<div class="card"><h2>🔍 搜证</h2>
      <p class="hint" style="margin-bottom:8px">本幕剩余 <b style="color:#d9b45b">${left}</b> 次${nothingLeft ? " · 这一幕已经没有你能搜到的线索了" : ""}</p>
      <div class="loc-grid">${st.script.locations.map((l) => {
        const n = rem[l] ?? 0;
        const off = left <= 0 || !avail.has(l);
        const tail = avail.has(l) ? `剩余线索 ${n} 条` : "已搜空";
        return `<button class="loc-btn" data-loc="${esc(l)}" ${off ? "disabled" : ""}>📍 ${esc(st.content[l] || l)}<small>${tail}</small></button>`;
      }).join("")}</div>
    </div>`;
  }

  // 手上的（还没公开）和已经摊开的分两栏——摊不摊牌是这个游戏最要紧的选择
  const clueCard = (c) => `
    <div class="clue ${c.published ? "" : "private"}">
      <div class="hint">📍 ${esc(st.content[c.location] || c.location || "随身")}
        ${c.private ? "· 🎭 角色专属" : ""}
        ${c.published && c.byName ? `· 由 ${esc(c.byName)} 公开` : ""}</div>
      ${c.titleKey && st.content[c.titleKey] ? `<div class="clue-t">${esc(st.content[c.titleKey])}</div>` : ""}
      <div>${esc(st.content[c.contentKey] || "")}</div>
      ${!c.published && c.mine
        ? `<div class="row" style="margin-top:9px"><button class="btn ghost" data-pub="${esc(c.id)}">📢 公开给所有人</button></div>`
        : ""}
    </div>`;

  const held = st.clues.filter((c) => !c.published);
  const open = st.clues.filter((c) => c.published);

  html += `<div class="card"><h2>🔒 我手上的线索（${held.length}）</h2>
    <p class="hint" style="margin-bottom:8px">只有你看得见。什么时候摊出来，你自己决定——公开之后不能收回。</p>
    ${held.length ? held.map(clueCard).join("") : '<p class="hint">还没有线索</p>'}</div>`;

  html += `<div class="card"><h2>📢 已公开的线索（${open.length}）</h2>
    ${open.length ? open.map(clueCard).join("") : '<p class="hint">还没有人摊牌。</p>'}</div>`;

  $("p-clue").innerHTML = html;
  $("p-clue").querySelectorAll("[data-loc]").forEach((el) => {
    el.onclick = () => send({ type: "clue.unlock", locationId: el.dataset.loc });
  });
  $("p-clue").querySelectorAll("[data-pub]").forEach((el) => {
    el.onclick = () => {
      if (!confirm("公开之后所有人都能看到，而且收不回来。确定吗？")) return;
      send({ type: "clue.publish", clueId: el.dataset.pub });
    };
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
/** 碎片正文：自己的给全文，别人的只有一行摘要——服务端已按席位投影，这里只负责显示 */
function fragText(f) {
  const st = S.st || {};
  return (f.textKey && (st.content || {})[f.textKey]) || f.label || "（无内容）";
}
function fragBox(f, cls) {
  const decoy = f.revealedDecoy ? '<span class="tag warn">已确认是干扰项</span>' : "";
  const who = f.summaryOnly ? '<span class="tag">别人的·只有摘要</span>' : "";
  return `<div class="${cls}" data-frag="${esc(f.fragId)}">
    <div class="frag-meta">${who}${decoy}</div>${esc(fragText(f))}</div>`;
}

function renderMechanic(m) {
  const s = m.state || {};
  const st = S.st || {};
  const key = (k) => (k ? (st.content || {})[k] : null);

  const slots = (s.slots || []).map((sl, i) => {
    const label = key(sl.labelKey) || sl.label;
    const tag = label ? `<span class="slot-t">${esc(label)}</span>` : "";
    const lock = sl.locked ? '<span class="tag ok">已确认</span>' : "";
    const body = sl.frag
      ? `${lock}${esc(fragText(sl.frag))}`
      : `<span class="hint">${label ? "还没人放" : `第 ${i + 1} 格（空）`}</span>`;
    return `<div class="slot ${sl.frag ? "filled" : ""} ${sl.locked ? "locked" : ""}"
                 data-slot="${esc(sl.slotId)}">${tag}${body}</div>`;
  }).join("");

  const mine = (s.myFragments || []).map((f) => fragBox(f, "frag")).join("");
  const dumped = (s.discarded || []).map((f) => fragBox(f, "frag out")).join("");

  // 校对：只回报「对了几个」，不说是哪几个
  const cd = s.nextCheckAt && s.nextCheckAt > serverNow()
    ? Math.ceil((s.nextCheckAt - serverNow()) / 1000) : 0;
  let status;
  if (m.complete) status = "✅ 拼对了，这就是那一天。";
  else if (!s.filled) status = `还剩 ${(s.emptySlots || []).length} 格 · 其他人手上还有 ${s.othersHolding ?? 0} 枚`;
  else if (s.lastCorrect === null || s.lastCorrect === undefined) status = "都摆上了，可以校对一次";
  else status = `上次校对：${s.lastCorrect} / ${s.needCorrect} 个在正确位置（不会告诉你是哪几个）`;

  return `<div class="card" id="mech-box" data-mid="${esc(m.mechanicId)}">
    <h2>🧩 时间线拼合</h2>
    <p class="hint" style="margin-bottom:8px">${status}</p>
    <div class="timeline">${slots}</div>
    <div style="margin-top:12px">
      <div class="hint" style="margin-bottom:6px">
        我的碎片（拖到格子里，或点一下再点格子）。<b>别人只看得到你这段的一行摘要——细节要你自己念出来。</b>
      </div>
      <div class="fraglist">${mine || '<span class="hint">已全部放置</span>'}</div>
    </div>
    ${s.discardEnabled ? `<div style="margin-top:12px">
      <div class="hint" style="margin-bottom:6px">${esc(key(s.discardLabelKey) || "弃置区（放不进时间线的那一段）")}</div>
      <div class="fraglist" id="mech-discard">${dumped || '<span class="hint">空</span>'}</div>
    </div>` : ""}
    ${!m.complete && s.graded ? `<div class="row" style="margin-top:12px">
      <button class="btn" id="mech-check" ${cd ? "disabled" : ""}>
        ${cd ? `校对（${cd}s 后可用）` : "🔍 校对一次"}</button>
    </div>` : ""}
  </div>`;
}

let pickedFrag = null;
const hitsEl = (el, ev) => {
  const r = el.getBoundingClientRect();
  return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
};
function bindMechanic() {
  const box = $("mech-box"); if (!box) return;
  const mid = box.dataset.mid;
  const ghost = $("drag-ghost");
  const dropZone = $("mech-discard");

  const act = (payload) => send({ type: "mechanic.action", mechanicId: mid, payload });
  const chk = $("mech-check");
  if (chk) chk.onclick = () => act({ op: "check" });

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
          act({ op: "place", fragId, slot: target.dataset.slot });
          pickedFrag = null;
        } else if (dropZone && hitsEl(dropZone, ev)) {
          act({ op: "discard", fragId });
          pickedFrag = null;
        }
      };
      document.addEventListener("pointermove", move, { passive: false });
      document.addEventListener("pointerup", up);
    });
  });

  box.querySelectorAll("[data-slot]").forEach((el) => {
    el.onclick = () => {
      const slot = el.dataset.slot;
      if (el.classList.contains("locked")) return toast("这一格已经确认过了");
      if (el.classList.contains("filled")) { act({ op: "take", slot }); return; }
      if (pickedFrag) { act({ op: "place", fragId: pickedFrag, slot }); pickedFrag = null; }
      else toast("先点一枚自己的碎片");
    };
  });

  // 弃置区：点一下把选中的碎片丢进去；已在里面的点一下拿回来
  if (dropZone) {
    dropZone.onclick = (e) => {
      const on = e.target.closest("[data-frag]");
      if (on) return act({ op: "undiscard", fragId: on.dataset.frag });
      if (pickedFrag) { act({ op: "discard", fragId: pickedFrag }); pickedFrag = null; }
      else toast("先点一枚碎片，再点这里把它弃置");
    };
  }
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
  closeSocket();
  S.st = null; S.token = ""; S.room = ""; S.narration = [];
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
  toast(S.sound ? "主持人念白已开启" : "已静音", true);
};

// ---- 背景音乐：默认没有。剧本在 skeleton 里声明了 audio 才放 ----
// 现在没有任何剧本声明——三小时的底噪吵，还压念白。这套播放层留着备用。
// 用 Web Audio 循环，不用 <audio loop>：mp3 首尾带编码填充，
// <audio loop> 每转一圈会漏出几十毫秒空档，垫在持续低音上非常刺耳。
const BGM = {
  ctx: null, master: null, src: null, cur: null, cache: new Map(),
  // 音量刻意压得很低：真要开 BGM，它只能是垫在念白底下的东西，不能抢
  el: null, elTimer: null, VOL: 0.16, DUCK: 0.06,
};

/** 惰性建 AudioContext，并在每次用到时尝试恢复（移动端会自动挂起） */
function audioCtx() {
  if (!BGM.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      BGM.ctx = new Ctx();
      BGM.master = BGM.ctx.createGain();
      BGM.master.gain.value = 0;
      BGM.master.connect(BGM.ctx.destination);
    } catch { return null; }
  }
  if (BGM.ctx.state === "suspended") BGM.ctx.resume().catch(() => {});
  return BGM.ctx;
}

function decodeAudio(ctx, ab) {
  return new Promise((res, rej) => {
    const p = ctx.decodeAudioData(ab, res, rej);   // 老 iOS 只有回调式
    if (p && p.then) p.then(res, rej);
  });
}

async function loadBuf(url) {
  if (BGM.cache.has(url)) return BGM.cache.get(url);
  const ctx = audioCtx(); if (!ctx) return null;
  const r = await fetch(url);
  if (!r.ok) return null;                          // 剧本声明了但文件没放，静默跳过
  const buf = await decodeAudio(ctx, await r.arrayBuffer());
  if (BGM.cache.size >= 3) BGM.cache.delete(BGM.cache.keys().next().value);
  BGM.cache.set(url, buf);
  return buf;
}

function applyBgm(rel) {
  if (!S.sound || !rel) { stopBgm(); return; }
  const url = "/audio/" + rel;
  if (BGM.cur === url) return;
  BGM.cur = url;
  if (!audioCtx()) { applyBgmFallback(url); return; }
  loadBuf(url).then((buf) => {
    if (!buf) { BGM.cur = null; return; }
    if (BGM.cur !== url) return;                   // 幕切得比加载还快，丢弃过期结果
    const ctx = BGM.ctx;
    stopSrc(1.2);                                  // 上一首交叉淡出
    const node = ctx.createBufferSource();
    node.buffer = buf; node.loop = true;
    // mp3 解码后会比原始素材多出几毫秒编码填充，照单全收的话每圈会漏出一小段静音。
    // 循环长度按最近的半秒取整；差得太多说明本来就不是整长度素材，不动它。
    const exact = Math.round(buf.duration * 2) / 2;
    if (exact > 0 && Math.abs(buf.duration - exact) < 0.08) { node.loopStart = 0; node.loopEnd = exact; }
    const g = ctx.createGain(); g.gain.value = 0;
    node.connect(g); g.connect(BGM.master);
    node.start(0);
    g.gain.setTargetAtTime(1, ctx.currentTime, 0.5);
    BGM.src = { node, gain: g };
    fadeTo(BGM.VOL);
  }).catch(() => { BGM.cur = null; });
}

/** 没有 Web Audio 的浏览器退回 <audio>：会有循环缝，但总比没有强 */
function applyBgmFallback(url) {
  if (!BGM.el) {
    BGM.el = new Audio();
    BGM.el.loop = true;
    BGM.el.volume = 0;
    BGM.el.addEventListener("error", () => { BGM.cur = null; });
  }
  BGM.el.src = url;
  BGM.el.volume = 0;
  BGM.el.play().then(() => fadeTo(BGM.VOL)).catch(() => { BGM.cur = null; });
}

function stopSrc(fadeSec) {
  const s = BGM.src; if (!s) return;
  BGM.src = null;
  const ctx = BGM.ctx, t = ctx.currentTime;
  s.gain.gain.setTargetAtTime(0, t, fadeSec / 3);
  try { s.node.stop(t + fadeSec); } catch {}
}

function fadeTo(target) {
  if (BGM.master) {
    const t = BGM.ctx.currentTime;
    BGM.master.gain.cancelScheduledValues(t);
    BGM.master.gain.setTargetAtTime(target, t, 0.35);
    return;
  }
  clearInterval(BGM.elTimer);                      // 退回路径：手动补间
  BGM.elTimer = setInterval(() => {
    if (!BGM.el) return clearInterval(BGM.elTimer);
    const d = target - BGM.el.volume;
    if (Math.abs(d) < 0.02) { BGM.el.volume = target; clearInterval(BGM.elTimer); return; }
    BGM.el.volume = Math.max(0, Math.min(1, BGM.el.volume + d * 0.15));
  }, 60);
}

function stopBgm() {
  clearInterval(BGM.elTimer);
  fadeTo(0);
  stopSrc(0.6);
  if (BGM.el) { try { BGM.el.pause(); } catch {} }
  BGM.cur = null;
}

/** 念白期间把 BGM 压低，说完恢复 */
function duckBgm(down) {
  if (!BGM.cur) return;
  fadeTo(down ? BGM.DUCK : BGM.VOL);
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
  const ctx = audioCtx();              // 建/恢复的是 BGM 那一个，不另开
  if (S.audioReady) return;
  try {
    if (ctx) { const o = ctx.createOscillator(); const g = ctx.createGain(); g.gain.value = 0; o.connect(g); g.connect(ctx.destination); o.start(0); o.stop(ctx.currentTime + 0.01); }
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
