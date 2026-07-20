/**
 * 把旧版单文件剧本（scripts/*.json）转换成新引擎的「骨架 + 文案包」。
 *   骨架 skeleton.json —— 只有结构与 key，无正文
 *   文案 content.pack  —— key → 正文
 *
 * 用法: node tools/convert.mjs <旧剧本路径> <新剧本id>
 * 例:   node tools/convert.mjs ../scripts/radio.json radio
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const [srcPath, newId] = process.argv.slice(2);
if (!srcPath || !newId) {
  console.error("用法: node tools/convert.mjs <旧剧本路径> <新剧本id>");
  process.exit(1);
}

const old = JSON.parse(readFileSync(resolve(__dir, srcPath), "utf8"));
const C = {};                     // content pack
const put = (k, v) => { C[k] = String(v ?? ""); return k; };

// ---- 元信息 ----
put("meta.title", old.title);

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
      // 第一幕给完整角色本
      scriptKeys[c.id] = put(`script.${id}.${c.id}`,
        `${c.story}\n\n【你的秘密】\n${c.secrets.map((s, n) => `${n + 1}. ${s}`).join("\n")}` +
        `\n\n【你的任务】\n${c.goals.map((g, n) => `${n + 1}. ${g}`).join("\n")}`);
    } else {
      scriptKeys[c.id] = put(`script.${id}.${c.id}`,
        `【第${i + 1}轮搜证】\n带着上一轮的发现，重新审视每个人的说辞——谁的时间线对不上？谁在回避什么？\n\n` +
        `别忘了你的任务：\n${c.goals.map((g, n) => `${n + 1}. ${g}`).join("\n")}`);
    }
  }
  acts.push({
    id,
    durationMin: 20,
    openingNarrationKey: put(`nar.${id}.open`,
      i === 0
        ? `第一幕 · 案发之后\n\n${old.background}\n\n` +
          `各位手上现在是自己的角色本——那里面写着只有你知道的事。\n` +
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
    `【最后的讨论】\n证据到此为止了。接下来是自由辩论，然后投票指认。\n\n` +
    `别忘了你的任务：\n${c.goals.map((g, n) => `${n + 1}. ${g}`).join("\n")}`);
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
    players: old.characters.length,
    durationMin: acts.reduce((a, x) => a + x.durationMin, 0),
    type: "whodunit",
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
