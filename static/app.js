/* 剧本杀小馆 前端逻辑 */
"use strict";

const $ = id => document.getElementById(id);
let SESSION = null;   // {room, player_id, name}
let STATE = null;     // 最新服务器状态
let SCRIPTS = [];
let activeTab = "script";
let pollTimer = null;
let chatSeen = 0;     // 已读聊天数
let cluesSeen = 0;    // 已读公开线索数
const rendered = {};  // 区域渲染缓存，避免重复刷 DOM

// ---------- 基础 ----------

async function api(path, body, qs) {
  const url = "/api/" + path + (qs ? "?" + new URLSearchParams(qs) : "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const opt = body !== undefined
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal }
    : { signal: ctrl.signal };
  try {
    const res = await fetch(url, opt);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("网络超时");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function toast(msg, ok) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (ok ? " ok" : "");
  t.style.display = "block";
  clearTimeout(t._h);
  t._h = setTimeout(() => t.style.display = "none", 2600);
}

function modal(html) {
  $("modal-box").innerHTML = html;
  $("modal").style.display = "flex";
}
function closeModal() { $("modal").style.display = "none"; }
$("modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function setIf(id, html) {
  // 只有内容变化才写 DOM，避免闪烁
  if (rendered[id] !== html) { rendered[id] = html; $(id).innerHTML = html; }
}

function showView(name) {
  for (const v of ["home", "lobby", "game"]) {
    $("view-" + v).style.display = v === name ? "block" : "none";
  }
}

function saveSession() { localStorage.setItem("jbs_session", JSON.stringify(SESSION)); }
function loadSession() {
  try { SESSION = JSON.parse(localStorage.getItem("jbs_session")); } catch (e) { SESSION = null; }
}
function clearSession() { SESSION = null; localStorage.removeItem("jbs_session"); }

// ---------- 首页 ----------

async function initHome() {
  showView("home");
  const saved = localStorage.getItem("jbs_name");
  if (saved) $("home-name").value = saved;
  try {
    SCRIPTS = (await api("scripts")).scripts;
    $("script-list").innerHTML = SCRIPTS.map(s => `
      <div class="script-card" data-id="${s.id}">
        <span class="sc-go">创建 ›</span>
        <div class="sc-title">《${esc(s.title)}》</div>
        <div class="sc-tag">${esc(s.tagline)}</div>
        <div class="sc-meta">${s.players}人本 · ${esc(s.difficulty)} · ${esc(s.duration)}</div>
      </div>`).join("");
    document.querySelectorAll(".script-card").forEach(el =>
      el.addEventListener("click", () => createRoom(el.dataset.id)));
  } catch (e) {
    $("script-list").textContent = "剧本加载失败：" + e.message;
  }
}

function myName() {
  const name = $("home-name").value.trim();
  if (!name) { toast("请先输入昵称"); return null; }
  localStorage.setItem("jbs_name", name);
  return name;
}

async function createRoom(scriptId) {
  const name = myName(); if (!name) return;
  try {
    const r = await api("create", { name, script_id: scriptId });
    SESSION = { room: r.room, player_id: r.player_id, name };
    saveSession();
    startPolling();
  } catch (e) { toast(e.message); }
}

$("btn-join").addEventListener("click", async () => {
  const name = myName(); if (!name) return;
  const code = $("join-code").value.trim();
  if (code.length !== 4) { toast("请输入4位房号"); return; }
  try {
    const r = await api("join", { name, room: code });
    SESSION = { room: r.room, player_id: r.player_id, name };
    saveSession();
    startPolling();
  } catch (e) { toast(e.message); }
});

// ---------- 轮询 ----------

function startPolling() {
  stopPolling();
  poll();
  pollTimer = setInterval(poll, 1500);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

let lastVer = -1;
let failCount = 0;

function setConnBanner(show) {
  const b = $("conn-banner");
  if (b) b.style.display = show ? "block" : "none";
}

async function poll(force) {
  if (!SESSION) return;
  try {
    const data = await api("state", undefined, {
      room: SESSION.room, player: SESSION.player_id,
      ver: force ? -1 : lastVer,
    });
    failCount = 0;
    setConnBanner(false);
    if (data.unchanged) return;   // 状态没变，什么都不用做
    lastVer = data.ver;
    STATE = data;
    render();
  } catch (e) {
    if (/房间不存在|不在这个房间/.test(e.message)) {
      stopPolling(); clearSession();
      toast("房间已关闭"); initHome();
      return;
    }
    // 网络抖动：连续失败2次以上才提示，恢复后自动消失
    failCount++;
    if (failCount >= 2) setConnBanner(true);
  }
}

// ---------- 总渲染 ----------

function render() {
  const s = STATE;
  if (s.phase === "lobby") { renderLobby(); showView("lobby"); }
  else { renderGame(); showView("game"); }
}

// ---------- 大厅 ----------

function renderLobby() {
  const s = STATE;
  $("lobby-code").textContent = s.room;
  setIf("lobby-script", `《${esc(s.script.title)}》· ${esc(s.script.tagline)}`);
  $("lobby-count").textContent = `${s.players.length}/${s.script.characters.length}`;

  setIf("lobby-players", s.players.map(p => `
    <div class="player-row">
      <span class="p-dot ${p.online ? "on" : ""}"></span>
      <span class="p-name">${esc(p.name)}${p.is_me ? "（我）" : ""}</span>
      ${p.is_host ? '<span class="p-tag host">房主</span>' : ""}
      ${p.char_name ? `<span class="p-tag">🎭 ${esc(p.char_name)}</span>`
                     : p.want_random ? '<span class="p-tag">🎲 随机</span>'
                     : '<span class="p-tag">未选角</span>'}
    </div>`).join(""));

  const takenBy = {};
  s.players.forEach(p => { if (p.char_id) takenBy[p.char_id] = p; });
  setIf("lobby-chars", s.script.characters.map(c => {
    const owner = takenBy[c.id];
    const mine = owner && owner.is_me;
    return `
    <div class="char-card ${mine ? "mine" : owner ? "taken" : ""}" data-char="${c.id}">
      ${owner ? `<span class="cc-owner">${mine ? "✓ 我的角色" : esc(owner.name)}</span>` : ""}
      <div class="cc-name">${esc(c.name)}</div>
      <div class="cc-brief">${esc(c.brief)}</div>
      <div class="cc-pub">${esc(c.public)}</div>
    </div>`;
  }).join(""));

  const need = s.script.characters.length;
  setIf("lobby-host-area", s.is_host ? `
    <button id="btn-start" class="btn primary wide" style="margin-top:4px">
      🎬 开始游戏（${s.players.length}/${need}人）
    </button>` : `<p class="hint" style="text-align:center">等待房主开始游戏…</p>`);
  const bs = $("btn-start");
  if (bs) bs.onclick = async () => {
    try { await api("start", { room: SESSION.room, player_id: SESSION.player_id }); poll(); }
    catch (e) { toast(e.message); }
  };
}

$("btn-random").addEventListener("click", async () => {
  try { await api("pick", { room: SESSION.room, player_id: SESSION.player_id, char_id: "random" }); poll(); }
  catch (e) { toast(e.message); }
});

$("btn-leave").addEventListener("click", () => {
  if (!confirm("确定离开房间？")) return;
  stopPolling(); clearSession(); initHome();
});

// ---------- 游戏 ----------

const NEXT_LABEL = {
  reading: "▶ 进入第一轮搜证",
  vote: "▶ 揭晓真相",
};

function renderGame() {
  const s = STATE;
  $("game-phase").textContent = s.phase_label;
  $("game-room").textContent = "房" + s.room;

  // 房主推进按钮
  let hostBtn = "";
  if (s.is_host && s.phase !== "reveal") {
    let label = NEXT_LABEL[s.phase] || "▶ 下一阶段";
    if (s.phase.startsWith("round")) {
      // phase顺序: lobby, reading, round..., vote, reveal
      label = s.phase_idx === s.phase_count - 3 ? "▶ 进入投票" : "▶ 进入下一轮搜证";
    }
    hostBtn = `<button id="btn-next" class="btn ghost" style="padding:7px 12px;font-size:13px">${label}</button>`;
  }
  if (s.is_host && s.phase === "reveal") {
    hostBtn = `<button id="btn-restart" class="btn ghost" style="padding:7px 12px;font-size:13px">↺ 重开</button>`;
  }
  setIf("game-host-btn", hostBtn);
  const bn = $("btn-next");
  if (bn) bn.onclick = async () => {
    if (!confirm("确定进入下一阶段？（请确认大家都准备好了）")) return;
    try { await api("next_phase", { room: SESSION.room, player_id: SESSION.player_id }); poll(); }
    catch (e) { toast(e.message); }
  };
  const br = $("btn-restart");
  if (br) br.onclick = async () => {
    if (!confirm("回到大厅重新开局？")) return;
    try { await api("restart", { room: SESSION.room, player_id: SESSION.player_id }); poll(); }
    catch (e) { toast(e.message); }
  };

  renderScriptPanel();
  renderCluesPanel();
  renderChatPanel();
  renderVotePanel();
  renderBadges();
}

function renderScriptPanel() {
  const s = STATE;
  let html = "";
  if (s.phase === "reveal" && s.reveal) {
    html += revealHtml();
  }
  if (s.my_char) {
    html += `
    <div class="card">
      <div class="mychar-head">🎭 ${esc(s.my_char.name)}</div>
      <div class="cc-brief">${esc(s.my_char.brief)}</div>
      <div class="private-warn">⚠️ 以下内容只有你能看到，请勿直接展示手机给他人</div>
      <div class="sec"><div class="sec-title">你的故事</div>
        <div class="story-text">${esc(s.my_char.story)}</div></div>
      <div class="sec"><div class="sec-title">你的秘密</div>
        ${s.my_char.secrets.map(x => `<div class="secret-item">🤫 ${esc(x)}</div>`).join("")}</div>
      <div class="sec"><div class="sec-title">你的任务</div>
        ${s.my_char.goals.map(x => `<div class="goal-item">🎯 ${esc(x)}</div>`).join("")}</div>
    </div>`;
  }
  html += `
  <div class="card">
    <div class="sec"><div class="sec-title">案件背景</div>
      <div class="story-text">${esc(s.script.background)}</div></div>
    ${s.script.victim ? `<div class="sec"><div class="sec-title">案件核心</div>
      <div class="story-text">${esc(s.script.victim)}</div></div>` : ""}
    <div class="sec"><div class="sec-title">人物介绍（公开信息）</div>
      ${s.script.characters.map(c => `
        <div style="margin-bottom:10px">
          <b style="color:#f0e9d8">${esc(c.name)}</b>
          <span class="cc-brief" style="display:inline;margin-left:6px">${esc(c.brief)}</span>
          <div class="cc-pub">${esc(c.public)}</div>
        </div>`).join("")}
    </div>
  </div>`;
  setIf("panel-script", html);
}

function revealHtml() {
  const r = STATE.reveal;
  return `
  <div class="card">
    <div class="reveal-hero">
      <div style="font-size:14px;color:#9a97a8">真相揭晓 · 真凶是</div>
      <div class="who">${esc(r.murderer_name)}</div>
    </div>
    <div class="sec"><div class="sec-title">投票结果</div>
      ${r.tally.length ? r.tally.map(t => `
        <div class="tally-row"><span>${esc(t.char_name)}${t.char_id === r.murderer_id ? " 🔪" : ""}</span>
        <b>${t.votes} 票</b></div>`).join("") : '<p class="hint">无人投票</p>'}
    </div>
    <div class="sec"><div class="sec-title">真相复盘</div>
      <div class="truth-text">${esc(r.truth)}</div></div>
    <div class="sec"><div class="sec-title">各角色的秘密</div>
      ${r.characters.map(c => `
        <div style="margin-bottom:12px"><b style="color:#f0e9d8">${esc(c.name)}</b>
        ${c.secrets.map(x => `<div class="secret-item">🤫 ${esc(x)}</div>`).join("")}</div>`).join("")}
    </div>
  </div>`;
}

function renderCluesPanel() {
  const s = STATE;
  let html = "";
  const searching = s.phase.startsWith("round");
  if (searching) {
    html += `
    <div class="card">
      <div class="sec-title">🔍 前往地点搜证</div>
      <div class="search-left">你剩余搜证次数：<b>${s.my_search_left}</b> 次</div>
      <div class="loc-grid">
        ${s.locations.map(l => `
          <button class="loc-btn" data-loc="${esc(l.name)}" ${s.my_search_left <= 0 || l.remaining <= 0 ? "disabled" : ""}>
            📍 ${esc(l.name)}<small>${l.remaining > 0 ? "剩余线索 " + l.remaining + " 条" : "已搜空"}</small>
          </button>`).join("")}
      </div>
    </div>`;
  } else if (s.phase === "reading") {
    html += `<div class="card"><p class="hint">阅读剧本阶段。进入搜证轮后即可前往各地点搜集线索。</p></div>`;
  }

  if (s.my_clues.length) {
    html += `<div class="card"><div class="sec-title">🔒 我的私藏线索（他人不可见）</div>
      ${s.my_clues.map(c => `
      <div class="clue-card private">
        <div class="clue-loc">📍 ${esc(c.location)}</div>
        <div class="clue-title">${esc(c.title)}</div>
        <div class="clue-text">${esc(c.text)}</div>
        <div style="margin-top:8px"><button class="btn primary" style="padding:6px 14px;font-size:13px" data-pub="${c.id}">📢 公开此线索</button></div>
      </div>`).join("")}</div>`;
  }

  html += `<div class="card"><div class="sec-title">📢 已公开线索（${s.public_clues.length}）</div>
    ${s.public_clues.length ? s.public_clues.map(c => `
      <div class="clue-card">
        <div class="clue-loc">📍 ${esc(c.location)}</div>
        <div class="clue-title">${esc(c.title)}</div>
        <div class="clue-text">${esc(c.text)}</div>
        <div class="clue-finder">由 ${esc(c.finder)} 发现</div>
      </div>`).join("") : '<p class="hint">还没有公开的线索</p>'}</div>`;

  setIf("panel-clues", html);
}

async function doSearch(loc) {
  try {
    const r = await api("search", { room: SESSION.room, player_id: SESSION.player_id, location: loc });
    modal(`
      <h3>🔍 在「${esc(loc)}」发现线索！</h3>
      <div class="clue-card private" style="margin:0 0 4px">
        <div class="clue-title">${esc(r.clue.title)}</div>
        <div class="clue-text">${esc(r.clue.text)}</div>
      </div>
      <p class="hint">公开：所有人立刻可见 ｜ 私藏：只有你可见，之后随时可公开</p>
      <div class="modal-actions">
        <button class="btn ghost" id="m-keep">🔒 先私藏</button>
        <button class="btn primary" id="m-pub">📢 立即公开</button>
      </div>`);
    $("m-keep").onclick = () => { closeModal(); poll(); };
    $("m-pub").onclick = async () => {
      try { await api("publish", { room: SESSION.room, player_id: SESSION.player_id, clue_id: r.clue.id }); }
      catch (e) { toast(e.message); }
      closeModal(); poll();
    };
  } catch (e) { toast(e.message); }
}

function renderChatPanel() {
  const s = STATE;
  const html = s.chat.map(m => {
    if (m.system) return `<div class="msg sys"><span class="msg-body">${esc(m.text)}</span></div>`;
    const me = m.name === SESSION.name;
    return `<div class="msg ${me ? "me" : ""}">
      <div class="msg-meta"><b>${esc(m.name)}</b>${m.char_name ? "（" + esc(m.char_name) + "）" : ""}</div>
      <div class="msg-body">${esc(m.text)}</div></div>`;
  }).join("");
  if (rendered["chat-list"] !== html) {
    rendered["chat-list"] = html;
    const list = $("chat-list");
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.innerHTML = html;
    if (activeTab === "chat") window.scrollTo(0, document.body.scrollHeight);
  }
  if (activeTab === "chat") chatSeen = s.chat.length;
}

async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try { await api("chat", { room: SESSION.room, player_id: SESSION.player_id, text }); poll(); }
  catch (e) { toast(e.message); input.value = text; }
}
$("btn-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

function renderVotePanel() {
  const s = STATE;
  let html = "";
  if (s.phase === "vote") {
    html = `<div class="card">
      <div class="sec-title">🗳️ ${esc(s.script.vote_question)}</div>
      <div class="vote-status">已投票：${s.votes_done}/${s.players.length} 人${s.my_vote ? " · 你可以随时改票" : ""}</div>
      ${s.script.characters.map(c => `
        <div class="vote-card ${s.my_vote === c.id ? "sel" : ""}" data-vote="${c.id}">
          <div><div class="cc-name">${esc(c.name)}</div><div class="cc-brief">${esc(c.brief)}</div></div>
          <div>${s.my_vote === c.id ? "✅ 已指认" : "指认"}</div>
        </div>`).join("")}
      ${s.is_host ? '<p class="hint">全员投票后，点击顶部「揭晓真相」</p>' : ""}
    </div>`;
  } else if (s.phase === "reveal") {
    html = revealHtml();
  } else {
    html = `<div class="card"><p class="hint">还没到投票阶段。完成搜证与讨论后，由房主开启投票。</p></div>`;
  }
  setIf("panel-vote", html);
}

// ---------- 事件委托（只绑定一次，避免轮询重复挂监听器） ----------

$("lobby-chars").addEventListener("click", async e => {
  const el = e.target.closest(".char-card");
  if (!el) return;
  try { await api("pick", { room: SESSION.room, player_id: SESSION.player_id, char_id: el.dataset.char }); poll(); }
  catch (err) { toast(err.message); }
});

$("panel-clues").addEventListener("click", async e => {
  const lb = e.target.closest(".loc-btn");
  if (lb) { if (!lb.disabled) doSearch(lb.dataset.loc); return; }
  const pb = e.target.closest("[data-pub]");
  if (pb) {
    try { await api("publish", { room: SESSION.room, player_id: SESSION.player_id, clue_id: pb.dataset.pub }); poll(); }
    catch (err) { toast(err.message); }
  }
});

$("panel-vote").addEventListener("click", async e => {
  const el = e.target.closest("[data-vote]");
  if (!el) return;
  try { await api("vote", { room: SESSION.room, player_id: SESSION.player_id, char_id: el.dataset.vote }); poll(); }
  catch (err) { toast(err.message); }
});

function renderBadges() {
  const s = STATE;
  const unreadChat = s.chat.length - chatSeen;
  const cb = $("chat-badge");
  if (activeTab !== "chat" && unreadChat > 0) {
    cb.textContent = unreadChat > 99 ? "99+" : unreadChat;
    cb.style.display = "inline-block";
  } else cb.style.display = "none";

  const unreadClues = s.public_clues.length - cluesSeen;
  const lb = $("clue-badge");
  if (activeTab !== "clues" && unreadClues > 0) {
    lb.textContent = unreadClues;
    lb.style.display = "inline-block";
  } else lb.style.display = "none";
  if (activeTab === "clues") cluesSeen = s.public_clues.length;
}

// 标签切换
document.querySelectorAll(".tab").forEach(el =>
  el.addEventListener("click", () => {
    activeTab = el.dataset.tab;
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === el));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    $("panel-" + activeTab).classList.add("active");
    if (activeTab === "chat" && STATE) {
      chatSeen = STATE.chat.length;
      window.scrollTo(0, document.body.scrollHeight);
    }
    if (activeTab === "clues" && STATE) cluesSeen = STATE.public_clues.length;
    renderBadges && STATE && renderBadges();
  }));

// 手机锁屏/切后台回来时立刻强制刷新一次，不用等下个轮询
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && SESSION) poll(true);
});

// ---------- 启动 ----------

(async function boot() {
  loadSession();
  if (SESSION) {
    try {
      await api("state", undefined, { room: SESSION.room, player: SESSION.player_id });
      startPolling();
      return;
    } catch (e) { clearSession(); }
  }
  initHome();
})();
