/**
 * shop40 内容包自动校验（指令书第 4 章）。
 * 用法: node tools/validate_content.mjs
 *
 * 只输出校验结果，**不打印任何正文**——出错时也只报 key 与长度，不回显内容。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assemble, skeleton, truth, clues, frags, sol, paths } from "./pack_source.mjs";

const root = paths.root;
let bad = 0;
const fail = (m) => { console.log("  ✗ " + m); bad++; };
const okk = (m) => console.log("  ✓ " + m);

// ================= 校验 =================
console.log("shop40 内容包校验\n");

// 1 键完整性
console.log("【1】键完整性");
const pack = assemble();
const want = readFileSync(join(root, "content", "content-keys.txt"), "utf8")
  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const have = new Set(Object.keys(pack));
const missing = want.filter((k) => !have.has(k));
const extra = [...have].filter((k) => !want.includes(k));
if (missing.length) fail(`缺少 ${missing.length} 个键：${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}`);
if (extra.length) fail(`多出 ${extra.length} 个键：${extra.slice(0, 10).join(", ")}${extra.length > 10 ? " …" : ""}`);
if (!missing.length && !extra.length) okk(`${want.length} / ${want.length} 个键，一个不多一个不少`);

// 2 可追溯性
console.log("\n【2】可追溯性");
const eventIds = new Set(truth.events.map((e) => e.id));
const slotIds = new Set(truth.theDay.slots.map((s) => s.slotId));
let traceBad = 0;
for (const [id, c] of Object.entries(clues)) {
  if (id.startsWith("_")) continue;
  if (!eventIds.has(c.traceTo) && !slotIds.has(c.traceTo)) { fail(`线索 ${id} 的 traceTo=${c.traceTo} 在真相层不存在`); traceBad++; }
}
for (const s of truth.theDay.slots) {
  if (!eventIds.has(s.traceTo)) { fail(`时段 ${s.slotId} 的 traceTo=${s.traceTo} 不存在`); traceBad++; }
}
if (!traceBad) okk(`34/34 线索、8/8 时段全部可追溯到真相层`);

// 3 结构一致性
console.log("\n【3】结构一致性");
const skClue = new Set(skeleton.clues.map((c) => c.id));
const myClue = new Set(Object.keys(clues).filter((k) => !k.startsWith("_")));
const cd = [...skClue].filter((x) => !myClue.has(x)).concat([...myClue].filter((x) => !skClue.has(x)));
cd.length ? fail(`线索 id 与骨架不一致：${cd.join(", ")}`) : okk(`线索 id 集合与骨架完全一致（${skClue.size} 条）`);

const skFrag = skeleton.mechanics[0].params.fragments;
let fragBad = 0;
for (const f of skFrag) {
  if (!frags[f.id]) { fail(`骨架声明了碎片 ${f.id}，内容里没有`); fragBad++; continue; }
  if (frags[f.id].owner !== f.owner) { fail(`碎片 ${f.id} 归属不符：骨架 ${f.owner} / 内容 ${frags[f.id].owner}`); fragBad++; }
}
if (!fragBad) okk(`8/8 碎片归属与骨架一致`);

// 4 信息隔离
console.log("\n【4】信息隔离");
const KEYWORDS = {
  P1: ["没出声", "没关门", "看见你", "在里面看见"],
  P2: ["母亲的名字", "外婆的名字", "接手"],
  P3: ["七次", "正式收养", "亲属关系证明"],
  P4: ["匿名", "住院费是", "祖屋修缮费"],
};
let isoBad = 0;
for (const p of ["P1", "P2", "P3", "P4"]) {
  const own = ["act1", "act2", "act3"].map((a) => pack[`script.${a}.${p}`]).join("\n");
  for (const w of KEYWORDS[p]) {
    if (own.includes(w)) { fail(`${p} 的剧本里出现了他不该知道的关键词「${w}」`); isoBad++; }
  }
}
if (!isoBad) okk(`四份角色本都不含各自 whatTheyNeverKnew 的关键词`);

// 5 红线扫描
console.log("\n【5】红线扫描");
const RED = ["凶手", "杀人", "尸体", "他杀", "谋杀", "出轨", "外遇", "私生子", "自杀", "上吊", "跳楼",
  "家暴", "虐待", "强奸", "赌债", "高利贷", "逼债", "黑道", "精神病", "疯了"];
let redHit = 0;
for (const [k, v] of Object.entries(pack)) {
  for (const w of RED) if (String(v).includes(w)) { fail(`红线词「${w}」出现在 ${k}`); redHit++; }
}
if (!redHit) okk(`${RED.length} 个红线词，0 命中`);

// 6 字数
console.log("\n【6】字数区间");
const len = (s) => String(s ?? "").replace(/\s/g, "").length;
const ranges = [];
for (const p of ["P1", "P2", "P3", "P4"]) {
  ranges.push([`script.act1.${p}`, 1400, 1800], [`script.act2.${p}`, 700, 1000], [`script.act3.${p}`, 350, 550]);
}
for (const id of Object.keys(clues)) if (!id.startsWith("_")) ranges.push([`${id}.content`, 60, 260]);
for (const id of Object.keys(frags)) if (!id.startsWith("_")) {
  ranges.push([`tl.frag.${id}.full`, 220, 420], [`tl.frag.${id}.summary`, 20, 60]);
}
for (const k of ["end.sell.unanimous", "end.keep.unanimous", "end.sell.majority", "end.keep.majority", "end.tie"]) ranges.push([k, 150, 600]);
for (const d of ["d1", "d2", "d3", "d4", "d5"]) ranges.push([`debrief.${d}.content`, 300, 1200]);
ranges.push(["debrief.epilogue", 60, 260]);
let lenBad = 0;
for (const [k, lo, hi] of ranges) {
  const v = len(pack[k]);
  if (v < lo || v > hi) { fail(`${k} 字数 ${v}，应在 ${lo}-${hi}`); lenBad++; }
}
if (!lenBad) okk(`${ranges.length} 个字段全部落在规定区间`);

// 7 槽位
console.log("\n【7】槽位映射");
const mapped = Object.keys(sol.mapping);
const slots = skeleton.mechanics[0].params.slots.map((s) => s.id);
const used = Object.values(sol.mapping);
if (mapped.length !== 7) fail(`mapping 覆盖 ${mapped.length} 枚碎片，应为 7 枚`);
else if (new Set(used).size !== 7) fail(`有两枚碎片映射到了同一格`);
else if (used.includes(sol.gapSlot)) fail(`缺口格 ${sol.gapSlot} 被占用了`);
else if (mapped.includes(sol.decoy)) fail(`干扰项 ${sol.decoy} 不该出现在 mapping 里`);
else if (!slots.includes(sol.gapSlot)) fail(`gapSlot ${sol.gapSlot} 不在骨架的槽位里`);
else okk(`7 枚碎片映射 + 1 枚干扰项 ${sol.decoy}，缺口格 ${sol.gapSlot} 保持空置`);

// 8 摘要不能泄底
console.log("\n【8】摘要模糊度");
let sumBad = 0;
for (const [id, f] of Object.entries(frags)) {
  if (id.startsWith("_")) continue;
  // 「时候」这类虚词不算；只挡真能定位到时段的词
  if (/上午|下午|傍晚|清晨|早上|中午|夜里|天刚亮|天黑|[一二三四五六七八九十两]+点/.test(f.summary)) {
    fail(`碎片 ${id} 的摘要含明确时间词，能直接排序`); sumBad++;
  }
}
if (!sumBad) okk(`8 条摘要都不含明确时间词，排序必须靠全文细节`);

console.log(bad ? `\n✗ 发现 ${bad} 个问题` : `\n✓ 全部通过`);
process.exit(bad ? 1 : 0);
