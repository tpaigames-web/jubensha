/**
 * 把 content/ 下的创作产物组装成扁平的 { key: value } 表。
 * 校验器与打包器共用这一份逻辑，避免两边算出来的包不一样。
 *
 * 【防剧透】本文件里带正文的常量（角色简介、地点描述、机制文案、投票选项）
 * 属于密封内容，玩家不应阅读。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
const C = (p) => join(root, "content", p);

export const paths = { root, C };
export const skeleton = JSON.parse(readFileSync(join(root, "scripts/shop40/skeleton.json"), "utf8"));
export const truth = JSON.parse(readFileSync(C("truth.json"), "utf8"));
export const clues = JSON.parse(readFileSync(C("clues.json"), "utf8"));
export const frags = JSON.parse(readFileSync(C("fragments.json"), "utf8"));
export const sol = JSON.parse(readFileSync(C("solution.json"), "utf8"));
export const nar = JSON.parse(readFileSync(C("narration.json"), "utf8"));

/** 把 md 拆成 key → 正文 */
export function parseMd(path) {
  const out = {};
  const t = readFileSync(path, "utf8");
  t.split(/^## /m).slice(1).forEach((b) => {
    const nl = b.indexOf("\n");
    out[b.slice(0, nl).trim()] = b.slice(nl).trim();
  });
  return out;
}

// ---- 组装出完整的 key → value 表（build_pack 用同一套逻辑）----
export function assemble() {
  const pack = {};
  for (const [k, v] of Object.entries(nar)) if (!k.startsWith("_")) pack[k] = v;
  // 没有真人主持，规则得写进本子里。这段是引擎级样板，不是角色内容，
  // 所以统一在这里追加，不写进四份手稿。
  for (const p of ["P1", "P2", "P3", "P4"]) {
    const md = parseMd(C(`scripts/${p}.md`));
    md[`script.act1.${p}`] = `${md[`script.act1.${p}`]}\n\n---\n\n${HOWTO}`;
    Object.assign(pack, md);
  }
  Object.assign(pack, parseMd(C("debrief.md")));
  for (const [id, c] of Object.entries(clues)) {
    if (id.startsWith("_")) continue;
    pack[`${id}.title`] = c.title;
    pack[`${id}.content`] = c.content;
  }
  for (const [id, f] of Object.entries(frags)) {
    if (id.startsWith("_")) continue;
    pack[`tl.frag.${id}.full`] = f.full;
    pack[`tl.frag.${id}.summary`] = f.summary;
  }
  // 骨架里声明、但内容分散在别处的零碎 key
  for (const ch of skeleton.characters) {
    const t = truth.cast[ch.id];
    pack[ch.nameKey] = t.name;
    pack[ch.briefKey] = BRIEF[ch.id];
    pack[ch.tagsKey] = TAGS[ch.id];
  }
  for (const l of skeleton.locations) {
    pack[l.nameKey] = LOC[l.id].name;
    pack[l.descKey] = LOC[l.id].desc;
  }
  for (const s of skeleton.mechanics[0].params.slots) pack[s.labelKey] = SLOT_LABEL[s.id];
  const m = skeleton.mechanics[0].params;
  pack[m.boardTitleKey] = BOARD.title;
  pack[m.boardHintKey] = BOARD.hint;
  pack[m.discardZone.labelKey] = BOARD.discard;
  const v = skeleton.votes[0];
  pack[v.promptKey] = VOTE.prompt;
  for (const o of v.options) pack[o.labelKey] = VOTE[o.id];
  return pack;
}

const HOWTO = `【怎么玩】
这一局没有真人主持。分幕、放线索、计时、播报、结算，全部由程序来做。

· 先读自己的本。读完点「我读完了」，四个人都点了才会进下一幕——不要替别人跳过。
· 每一幕你有三次搜证机会。**搜到的东西默认只有你自己看得见**，要不要摊出来是你的选择；一旦公开就收不回。
· 有些线索开幕就直接在你手上，那是只属于你的东西。
· 讨论区可以公开发言，也可以单独找某一个人私聊。
· 卡住的时候等一等，主持人会自己放提示。
· 这个本不用抓人。你们要做的是把一个谁都只看见一小段的日子拼回来。`;

const BRIEF = {
  P1: "42 岁 · 长子。十八岁那年争吵后离家，在城里做事，多年不回。这次回来是要把一件事办完的。",
  P2: "39 岁 · 次女。一直留在镇上，每星期回店里帮忙，这几年的账都是她记的。",
  P3: "34 岁 · 养子。十岁被店主收留，在店里长大，二十岁不告而别去了外地，十四年没回来过。",
  P4: "29 岁 · 外甥女。店主妹妹的女儿。母亲与舅舅二十多年不往来，她这次是替母亲来的。",
};
const TAGS = {
  P1: "主张卖店 · 话不多 · 心里有事",
  P2: "主张留下 · 什么都记得 · 有一件事憋了六年",
  P3: "没有立场 · 全场最不自在的人",
  P4: "旁观者 · 带着一句话来的",
};
const LOC = {
  "loc.counter": { name: "柜台", desc: "四十年都在这儿收钱、写小黑板、跟人讲价。木头外沿被摸得发亮。" },
  "loc.stove": { name: "灶台", desc: "炭炉、铁锅、一排搪瓷杯。这一块的地砖比别处黑。" },
  "loc.altar": { name: "神龛", desc: "供着一张黑白照片，前面几只小茶杯，底下压着一个旧饼干盒。" },
  "loc.wall": { name: "厨房那面墙", desc: "刻了很多年的身高线，还挂着一本厚厚的旧日历。" },
  "loc.bedroom": { name: "他的房间", desc: "一张床、一个床头柜。收拾得干净得不像一个七十多岁的人。" },
  "loc.storage": { name: "后仓", desc: "堆着搬不动又扔不掉的旧物，木箱一层叠一层。" },
  "loc.courtyard": { name: "后院", desc: "水泥地，晾衣绳，角落停着一辆锈住的旧摩托。还有一扇通后巷的小门。" },
  "loc.cabinet": { name: "橱柜", desc: "碗碟之外，上层塞着几个信封和一些说不清为什么要留的纸。" },
  "loc.attic": { name: "阁楼", desc: "一张折叠床，几个纸箱，一扇要用撑杆撑住的窗。" },
};
const SLOT_LABEL = {
  s1: "清晨 · 天刚亮", s2: "上午 · 七点半后", s3: "上午 · 八点半后", s4: "上午 · 十点后",
  s5: "上午 · 十一点后", s6: "中午 · 十一点半后", s7: "下午 · 一点后", s8: "傍晚 · 六点后",
};
const BOARD = {
  title: "那一天",
  hint: "把手上的回忆摆到它该在的时刻。天色、地面干湿、店里的声音——这些东西不会说谎。\n有一段时间谁都没看见，那一格会一直空着。\n还有一枚碎片是真的，但它不属于这一天。",
  discard: "不属于这一天",
};
const VOTE = {
  prompt: "老福顺，卖还是留？",
  sell: "卖 —— 让所有人都能往前走",
  keep: "留 —— 有些东西不能用钱算",
};

