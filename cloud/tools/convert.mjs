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
        ? `【第一轮搜证开始】\n${old.background}\n\n现在，去各个地点找线索吧。每人 ${old.search_points ?? 2} 次机会，搜到的线索会公开给所有人。`
        : `【第${i + 1}轮搜证开始】\n新的区域开放了。第一轮没能解释的疑点，答案也许就在这一轮里。`),
    closingNarrationKey: put(`nar.${id}.close`,
      i === searchActs - 1
        ? `【搜证结束】\n所有线索都摆在桌面上了。接下来，是你们自己的判断。`
        : `【第${i + 1}轮结束】\n把手上的线索对一对——有些说法，已经开始站不住脚了。`),
    scriptKeys,
    locations: Object.keys(old.rounds[i].locations).map((n) => locKey[n]),
    searchQuota: { perSeat: old.search_points ?? 2 },
    advance: { type: "all_ready_or_timeout", requires: i === 0 ? ["all_read"] : [], timeoutMin: 25 },
    mechanics: [],
    hints: [{
      afterMin: 12,
      narrationKey: put(`nar.${id}.hint1`,
        `【提示】还没头绪的话，试着把「谁在什么时间、在什么地方」摆成一条时间线——对不上的那个人，就是突破口。`),
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
    `【最后的讨论】\n所有线索都已公开。现在，把你的推理说出来，也听听别人怎么说。\n准备好之后，投票指认你认为的凶手。`),
  closingNarrationKey: put(`nar.${voteAct}.close`, `【投票结束】\n真相，即将揭晓。`),
  scriptKeys: voteScriptKeys,
  locations: [],
  searchQuota: { perSeat: 0 },
  advance: { type: "all_ready_or_timeout", requires: ["vote_done"], timeoutMin: 30 },
  mechanics: [],
  hints: [{
    afterMin: 15,
    narrationKey: put(`nar.${voteAct}.hint1`, `【提示】时间不多了。就算不确定，也请投出你最怀疑的那个人。`),
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
    { match: `unanimous_${old.murderer}`, narrationKey: put("end.allright", `【全场一致】\n所有人都指向了同一个人……这一票，会是对的吗？`) },
    { match: "split", narrationKey: put("end.split", `【意见分歧】\n你们没能达成一致。真相不会因为投票而改变——让我们看看到底发生了什么。`) },
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
