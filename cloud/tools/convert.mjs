/**
 * 把旧版单文件剧本（scripts/*.json）转换成新引擎的「骨架 + 文案包」。
 *   骨架 skeleton.json —— 只有结构与 key，无正文
 *   文案 content.pack  —— key → 正文
 *
 * 用法: node tools/convert.mjs <旧剧本路径> <新剧本id>
 * 例:   node tools/convert.mjs ../scripts/radio.json radio
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const [srcPath, newId] = process.argv.slice(2);
if (!srcPath || !newId) {
  console.error("用法: node tools/convert.mjs <旧剧本路径> <新剧本id>");
  process.exit(1);
}

const old = JSON.parse(readFileSync(resolve(__dir, srcPath), "utf8"));
const C = {};                     // content pack
const put = (k, v) => { C[k] = String(v ?? ""); return k; };

/**
 * 增补层：tools/enrich/<id>.mjs（有就用，没有就退回旧数据）。
 * 老剧本每人只有两三百字，且完全没写角色之间的关系——没有关系，
 * 三个小时里就没人知道该跟谁说话。这些是要真写的东西，机械转换给不出来，
 * 所以单独放一层，由人（或我）逐本补。
 *
 *   export default {
 *     roles: { <角色id>: { story, rel: { <另一角色id>: "…" }, act2, act3 } },
 *     opening: "…可选：覆盖第一幕开场播报的引子…",
 *   }
 */
const enrichPath = resolve(__dir, "enrich", `${newId}.mjs`);
const EN = existsSync(enrichPath)
  ? (await import(pathToFileURL(enrichPath).href)).default
  : { roles: {} };
const role = (id) => EN.roles?.[id] ?? {};
const nameOf = (id) => old.characters.find((c) => c.id === id)?.name ?? id;

/** 没有真人主持，规则得写进本子里 */
const HOWTO = (searchPerAct) => `
———

【怎么玩】
这一局没有真人主持。分幕、放线索、计时、结算，全部由程序来做。

· 先读自己的本。读完点「我读完了」，所有人都点了才会进下一幕——不要替别人跳过。
· 每一幕你有 ${searchPerAct} 次搜证机会，搜到的东西会当场摆在所有人面前。
· 你手上有别人不知道的事。**什么时候说、说多少、要不要说，是你自己的选择**，这就是这个本的玩法。
· 讨论区可以公开发言，也可以单独找某一个人私聊。
· 卡住的时候等一等，主持人会自己放提示。
`.trim();

/**
 * 【你和他们】。逐个写出这个角色眼里的其他人。
 *
 * 增补层只需要写「有渊源」的那几对；这些本里很多角色本来就是陌生人
 * （荒岛、客栈、萍水相逢），硬编出交情反而假。没写的自动退回对方的公开身份，
 * 也就是「你只知道他自称是谁」——对陌生人来说这才是对的。
 */
function relationBlock(c) {
  const r = role(c.id).rel ?? {};
  const body = old.characters
    .filter((x) => x.id !== c.id)
    .map((o) => `**${o.name}**——${r[o.id] ?? `你今晚才见到他。他自称${o.brief}。${o.public}`}`)
    .join("\n\n");
  return `【你和他们】\n\n${body}`;
}

// ---- 元信息 ----
put("meta.title", old.title);
// 选本卡上的钩子与简介。**只讲设定，不讲剧情**——背景本来就是全员公开的那一段。
put("meta.subtitle", old.tagline ?? "");
put("meta.blurb", EN.blurb ?? blurbOf(old.background));

/**
 * 简介：从背景里取头几句。背景本来就是全员公开的那一段，拿来当简介不会剧透。
 * 卡片上放不下太多字，超过 80 就收在上一句。
 */
function blurbOf(text) {
  const parts = String(text ?? "").split(/(?<=[。！？])/).filter((s) => s.trim());
  let out = "";
  for (const p of parts) {
    if (out.length >= 45) break;              // 够一眼看明白就收，别贪
    if (out && (out + p).length > 100) break; // 但也不能让一个长句撑爆卡片
    out += p;
  }
  return out.trim();
}

/** 旧数据的难度字段里塞了人数（「中等 · 5人」），而卡片已经单独显示人数了 */
const difficultyLabel = String(old.difficulty ?? "")
  .split("·").map((x) => x.trim()).filter((x) => x && !/^\d+\s*人$/.test(x)).join(" · ");

// ---- 角色 ----
const characters = old.characters.map((c) => ({
  id: c.id,
  nameKey: put(`char.${c.id}.name`, c.name),
  briefKey: put(`char.${c.id}.brief`, `${c.brief}\n${c.public}`),
}));

// ---- 地点：旧格式用中文名做 key，这里映射成 loc.N ----
const locNames = [];
for (const r of old.rounds) for (const name of Object.keys(r.locations)) {
  if (!locNames.includes(name)) locNames.push(name);
}
const locKey = {};
locNames.forEach((name, i) => { locKey[name] = put(`loc.${i + 1}`, name); });

// ---- 幕：N 个搜证轮 + 最后一幕讨论投票 ----
const searchActs = old.rounds.length;
const acts = [];

for (let i = 0; i < searchActs; i++) {
  const id = `act${i + 1}`;
  const scriptKeys = {};
  for (const c of old.characters) {
    if (i === 0) {
      // 第一幕：公共背景 + 玩法 + 个人本 + 关系 + 目标 + 秘密
      scriptKeys[c.id] = put(`script.${id}.${c.id}`, [
        old.background,
        HOWTO(old.search_points ?? 2),
        `———\n\n【你是谁】\n${role(c.id).story ?? c.story}`,
        relationBlock(c),
        `【你今晚要做到的】\n\n${c.goals.map((g, n) => `${n + 1}. ${g}`).join("\n")}`,
        `【你不能让人知道的】\n\n${c.secrets.map((s) => `· ${s}`).join("\n")}`,
      ].join("\n\n"));
    } else {
      // 第二幕起：给这个人自己的处境，而不是所有人一份同样的模板
      scriptKeys[c.id] = put(`script.${id}.${c.id}`,
        role(c.id)[`act${i + 1}`] ??
        `【第${i + 1}幕】\n\n第一批线索摊开了。有些说法开始站不住脚——包括你自己的。\n\n` +
        `你现在要盯住两件事：\n` +
        `一、有没有哪条线索，正在往你身上指。\n` +
        `二、你手上那些不能说的事，还瞒得住多久。\n\n` +
        `【别忘了你要做到的】\n${c.goals.map((g, n) => `${n + 1}. ${g}`).join("\n")}`);
    }
  }
  acts.push({
    id,
    durationMin: 20,
    openingNarrationKey: put(`nar.${id}.open`,
      i === 0
        ? `第一幕 · 案发之后\n\n` +
          (EN.opening ?? `${String(old.tagline ?? "").trim()}\n\n`) +
          `各位手上现在是自己的角色本——公共背景、你的来历、你的目标、你不能说的事，都在里面。\n` +
          `不用赶，慢慢读完，读完了自己点一下「我读完了」。等所有人都点了，我们才往下走。\n\n` +
          `接下来这一幕，每人有 ${old.search_points ?? 2} 次搜证机会。\n` +
          `搜到的东西会当场摊在所有人面前——所以先搜哪里、什么时候搜，本身就是一种表态。`
        : `第${i + 1}幕 · 越挖越深\n\n` +
          `新的地方可以去了。上一幕里那些对不上的说法，答案也许就压在这里。\n\n` +
          `提醒一句：急着撇清自己的人，往往比沉默的人更值得多看两眼。\n` +
          `还是 ${old.search_points ?? 2} 次机会，用在你最想不通的那个疑点上。`),
    closingNarrationKey: put(`nar.${id}.close`,
      i === searchActs - 1
        ? `搜证到此为止\n\n` +
          `所有能找到的东西，都已经摆在桌面上了。\n` +
          `剩下的不是运气，是你们怎么把它们串起来。`
        : `第${i + 1}幕 · 落幕\n\n` +
          `第一批线索已经摊开了。有些说法，开始站不住脚。\n` +
          `不必急着指认谁——但请记住此刻让你在意的那个细节，它待会儿可能会救你，也可能会咬你一口。`),
    scriptKeys,
    locations: Object.keys(old.rounds[i].locations).map((n) => locKey[n]),
    searchQuota: { perSeat: old.search_points ?? 2 },
    advance: { type: "all_ready_or_timeout", requires: i === 0 ? ["all_read"] : [], timeoutMin: 25 },
    mechanics: [],
    hints: [{
      afterMin: 12,
      narrationKey: put(`nar.${id}.hint1`,
        `给还卡着的各位一个方向\n\n` +
        `别再纠结「谁看起来像坏人」了，试着做一件很笨但很管用的事：\n` +
        `把每个人「几点 · 在哪 · 做了什么」一条条列出来，排成一条时间线。\n\n` +
        `真相很少藏在谁说了什么，多半藏在——谁的时间对不上。`),
    }],
  });
}

// ---- 最后一幕：讨论与指认 ----
const voteAct = `act${searchActs + 1}`;
const voteScriptKeys = {};
for (const c of old.characters) {
  voteScriptKeys[c.id] = put(`script.${voteAct}.${c.id}`,
    role(c.id).actLast ??
    `【最后的讨论】\n\n证据到此为止了。接下来是自由辩论，然后投票指认。\n\n` +
    `投票之前，先想清楚一件事：你手上那些没说出口的，现在说还来得及。\n` +
    `等票投完了，说什么都只是解释。\n\n` +
    `【别忘了你要做到的】\n${c.goals.map((g, n) => `${n + 1}. ${g}`).join("\n")}`);
}
acts.push({
  id: voteAct,
  durationMin: 25,
  openingNarrationKey: put(`nar.${voteAct}.open`,
    `最后的讨论\n\n` +
    `证据到此为止。接下来的时间，属于你们自己。\n\n` +
    `把你的推理讲出来，也听听别人怎么讲。\n` +
    `留意那些回避的地方——还有那些，解释得太完整、太顺的说辞。\n\n` +
    `聊够了，就在「行动」页投出你的一票。所有人投完，真相揭晓。`),
  closingNarrationKey: put(`nar.${voteAct}.close`,
    `票投完了\n\n` +
    `无论你们指认了谁，那一夜发生过的事都不会因此改变。\n` +
    `现在，让我把它讲给你们听。`),
  scriptKeys: voteScriptKeys,
  locations: [],
  searchQuota: { perSeat: 0 },
  advance: { type: "all_ready_or_timeout", requires: ["vote_done"], timeoutMin: 30 },
  mechanics: [],
  hints: [{
    afterMin: 15,
    narrationKey: put(`nar.${voteAct}.hint1`,
      `时间不多了\n\n` +
      `没有人能拿到百分之百的把握，这本来就不是一道有标准答案的题。\n` +
      `就算还在犹豫，也请投出你此刻最怀疑的那个人——弃权，才是真的把机会让给了凶手。`),
  }],
});

// ---- 线索 ----
const clues = [];
old.rounds.forEach((r, i) => {
  for (const [locName, list] of Object.entries(r.locations)) {
    for (const c of list) {
      clues.push({
        id: c.id,
        act: `act${i + 1}`,
        location: locKey[locName],
        contentKey: put(`clue.${c.id}`, `【${c.title}】\n${c.text}`),
        visibility: { type: "public" },
      });
    }
  }
});

// ---- 投票：指认凶手 ----
const votes = [{
  id: "vote.final",
  act: voteAct,
  mode: "single_public",
  promptKey: put("vote.final.prompt", old.vote_question || "你认为谁是凶手？"),
  options: old.characters.map((c) => ({
    id: c.id,
    labelKey: put(`vote.final.${c.id}`, c.name),
  })),
  resultBranches: [
    {
      match: `unanimous_${old.murderer}`,
      narrationKey: put("end.allright",
        `全场一致\n\n所有人的手，都指向了同一个人。\n没有分歧，没有犹豫。\n\n这一次，你们没有被骗过去。`),
    },
    // 多数决单独成档。人多、选项也多的本（5 人指认 5 个嫌疑人）几乎不可能全票一致，
    // 只有 split 兜底的话，每一局都会撞到同一句「你们没能达成一致」，等于没有结局。
    ...old.characters.map((c) =>
      c.id === old.murderer
        ? {
            match: `majority_${c.id}`,
            narrationKey: put("end.maj.right",
              `多数指认 · ${c.name}\n\n不是全票，但大多数人的手指向了同一个方向。\n` +
              `有人到最后一刻还在摇头。\n\n——你们指对了。`),
          }
        : {
            match: `majority_${c.id}`,
            narrationKey: put(`end.maj.${c.id}`,
              `多数指认 · ${c.name}\n\n大多数人认定了${c.name}。\n` +
              `${c.name}百口莫辩，因为你们手上的东西，看起来确实都指向他。\n\n` +
              `——而真正的那个人，此刻正在心里松一口气。`),
          }
    ),
    {
      match: "split",
      narrationKey: put("end.split",
        `意见分歧\n\n你们没能达成一致。\n有人被说服了，有人还在怀疑，还有人从头到尾都没敢确定。\n\n` +
        `而此刻，凶手也许正在心里松了一口气。\n\n那么——真相，究竟是什么？`),
    },
  ],
}];

// ---- 复盘：把真相拆成若干段逐段揭示 ----
const paras = String(old.truth || "").split(/\n\n+/).filter(Boolean);
const segments = paras.map((p, i) => ({
  id: `d${i + 1}`,
  contentKey: put(`debrief.${i + 1}`, p),
  unlock: "manual",
}));

const skeleton = {
  scriptId: newId,
  schemaVersion: 1,
  meta: {
    titleKey: "meta.title",
    subtitleKey: "meta.subtitle",
    blurbKey: "meta.blurb",
    players: old.characters.length,
    durationMin: acts.reduce((a, x) => a + x.durationMin, 0),
    type: "whodunit",
    // 「AI创作」不再作为标签：全站剧本都是 AI 写的，挂在每张卡上不区分任何东西。
    // 署名改成在选本页整页说一次（见 public/index.html）。
    tags: (EN.tags ?? old.tags ?? []).filter((t) => t !== "AI创作"),
    difficultyLabel: EN.difficultyLabel ?? difficultyLabel,
  },
  characters,
  acts,
  clues,
  votes,
  mechanics: [],
  debrief: { segments },
};

const outDir = resolve(__dir, "..", "scripts", newId);
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "skeleton.json"), JSON.stringify(skeleton, null, 2), "utf8");
writeFileSync(resolve(outDir, "content.pack"), JSON.stringify(C, null, 2), "utf8");

console.log(`已生成 scripts/${newId}/`);
console.log(`  角色 ${characters.length} · 幕 ${acts.length} · 线索 ${clues.length} · 地点 ${locNames.length} · 复盘 ${segments.length} 段 · 文案 ${Object.keys(C).length} 条`);
