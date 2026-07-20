/**
 * 剧本包校验器：在开局之前把问题挑出来，而不是玩到一半才发现。
 * 用法: node tools/validate.mjs [剧本id]   （不带参数则校验全部）
 *
 * 【防剧透】只检查结构与 key 的完整性，不打印任何正文内容。
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(__dir, "..", "scripts");

let problems = 0;
const bad = (id, msg) => { console.log(`  ✗ [${id}] ${msg}`); problems++; };
const warn = (id, msg) => console.log(`  ⚠ [${id}] ${msg}`);   // 能跑，但体验会打折
const good = (msg) => console.log(`  ✓ ${msg}`);

function validate(id) {
  console.log(`\n检查《${id}》`);
  const dir = join(scriptsDir, id);
  const skPath = join(dir, "skeleton.json");
  if (!existsSync(skPath)) return bad(id, "缺少 skeleton.json");

  let sk;
  try { sk = JSON.parse(readFileSync(skPath, "utf8")); }
  catch (e) { return bad(id, "skeleton.json 不是合法 JSON: " + e.message); }

  const packPath = join(dir, "content.pack");
  let pack = null;
  if (existsSync(packPath)) {
    try { pack = JSON.parse(readFileSync(packPath, "utf8")); }
    catch (e) { return bad(id, "content.pack 不是合法 JSON: " + e.message); }
  }

  // 基本结构
  if (sk.scriptId !== id) bad(id, `scriptId(${sk.scriptId}) 与文件夹名(${id}) 不一致`);
  if (!sk.meta?.players) bad(id, "meta.players 缺失");
  if (!Array.isArray(sk.characters) || !sk.characters.length) bad(id, "characters 为空");
  if (sk.characters?.length !== sk.meta?.players)
    bad(id, `角色数(${sk.characters?.length}) 与 meta.players(${sk.meta?.players}) 不一致`);
  if (!Array.isArray(sk.acts) || !sk.acts.length) bad(id, "acts 为空");

  const charIds = new Set((sk.characters || []).map((c) => c.id));
  if (charIds.size !== (sk.characters || []).length) bad(id, "角色 id 有重复");

  // 每幕
  const actIds = new Set();
  for (const [i, a] of (sk.acts || []).entries()) {
    const tag = `act[${i}]${a.id ? "(" + a.id + ")" : ""}`;
    if (!a.id) bad(id, `${tag} 缺少 id`);
    if (actIds.has(a.id)) bad(id, `${tag} id 重复`);
    actIds.add(a.id);
    for (const cid of charIds) {
      if (!a.scriptKeys?.[cid]) bad(id, `${tag} 缺少角色 ${cid} 的 scriptKeys`);
    }
    if (!a.openingNarrationKey) bad(id, `${tag} 缺少开场播报`);
    if (!a.closingNarrationKey) bad(id, `${tag} 缺少收束播报`);
    if (!a.advance?.type) bad(id, `${tag} 缺少 advance.type`);
    const quota = a.searchQuota?.perSeat ?? 0;
    if (quota > 0) {
      // 线索数是否够全场搜：不够的话会有人白点
      const clues = (sk.clues || []).filter((c) => c.act === a.id);
      const need = quota * (sk.meta?.players ?? 0);
      if (clues.length < need)
        console.log(`  ⚠ [${id}] ${tag} 线索 ${clues.length} 条 < 全场可搜次数 ${need}，会有人搜到空（引擎会置灰，但体验略差）`);
      for (const loc of a.locations || []) {
        if (!clues.some((c) => c.location === loc))
          bad(id, `${tag} 地点 ${loc} 一条线索都没有`);
      }
    }
  }

  // 线索
  const clueIds = new Set();
  for (const c of sk.clues || []) {
    if (clueIds.has(c.id)) bad(id, `线索 id 重复: ${c.id}`);
    clueIds.add(c.id);
    if (!actIds.has(c.act)) bad(id, `线索 ${c.id} 指向不存在的幕 ${c.act}`);
    if (c.visibility?.type === "private") {
      for (const cid of c.visibility.characters || []) {
        if (!charIds.has(cid)) bad(id, `线索 ${c.id} 的私有可见角色 ${cid} 不存在`);
      }
    }
  }

  // 投票
  for (const v of sk.votes || []) {
    if (!actIds.has(v.act)) bad(id, `投票 ${v.id} 指向不存在的幕 ${v.act}`);
    if (!["single_public", "single_anonymous", "ranked", "multi"].includes(v.mode))
      bad(id, `投票 ${v.id} 的 mode 非法: ${v.mode}`);
    if (!v.options?.length) bad(id, `投票 ${v.id} 没有选项`);
    if (!v.resultBranches?.some((b) => b.match === "split"))
      bad(id, `投票 ${v.id} 缺少兜底的 split 分支（票型不匹配时会没有结算播报）`);

    // 分支名拼错不会报错，只会静静地退回 split——这类问题只有玩到最后才发现
    const optIds = new Set((v.options || []).map((o) => o.id));
    for (const b of v.resultBranches || []) {
      if (b.match === "split") continue;
      const m = /^(unanimous|majority)_(.+)$/.exec(b.match || "");
      if (!m) bad(id, `投票 ${v.id} 的分支名 ${b.match} 无法识别（应为 unanimous_<选项> / majority_<选项> / split）`);
      else if (!optIds.has(m[2])) bad(id, `投票 ${v.id} 的分支 ${b.match} 指向不存在的选项 ${m[2]}`);
    }
    // 选项多于两个时，2:1 / 3:2 这类结果很常见，只有 split 兜底会让大多数局撞到同一个结尾
    if ((v.options || []).length > 2 && !v.resultBranches?.some((b) => b.match.startsWith("majority_")))
      warn(id, `投票 ${v.id} 有 ${v.options.length} 个选项却没写 majority_* 分支，多数决的局会全部落到 split`);
  }

  // 机制声明
  for (const a of sk.acts || []) {
    for (const mid of a.mechanics || []) {
      if (!(sk.mechanics || []).some((m) => m.id === mid))
        bad(id, `幕 ${a.id} 声明了机制 ${mid}，但 mechanics 里没有它的参数`);
    }
  }

  if (!sk.debrief?.segments?.length) bad(id, "debrief.segments 为空（结束后没有复盘）");

  // 所有 key 必须能在文案包里找到
  if (pack) {
    const keys = new Set();
    const add = (k) => k && keys.add(k);
    add(sk.meta?.titleKey);
    for (const c of sk.characters || []) { add(c.nameKey); add(c.briefKey); }
    for (const a of sk.acts || []) {
      add(a.openingNarrationKey); add(a.closingNarrationKey);
      Object.values(a.scriptKeys || {}).forEach(add);
      (a.locations || []).forEach(add);
      (a.hints || []).forEach((h) => add(h.narrationKey));
    }
    for (const c of sk.clues || []) add(c.contentKey);
    for (const v of sk.votes || []) {
      add(v.promptKey);
      (v.options || []).forEach((o) => add(o.labelKey));
      (v.resultBranches || []).forEach((b) => add(b.narrationKey));
    }
    for (const s of sk.debrief?.segments || []) add(s.contentKey);

    const missing = [...keys].filter((k) => !(k in pack));
    if (missing.length) bad(id, `文案包缺少 ${missing.length} 个 key：${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`);
    else good(`${keys.size} 个 key 在文案包中齐全`);

    const unused = Object.keys(pack).filter((k) => !keys.has(k));
    if (unused.length) console.log(`  ⚠ [${id}] 文案包有 ${unused.length} 个 key 没被引用（不影响运行）`);
  } else {
    console.log(`  ⚠ [${id}] 没有独立 content.pack（将复用 placeholder 的文案包）`);
  }

  if (!problems) good("结构完整");
}

const only = process.argv[2];
const ids = readdirSync(scriptsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(scriptsDir, d.name, "skeleton.json")))
  .map((d) => d.name)
  .filter((id) => !only || id === only);

if (!ids.length) { console.error("没找到要校验的剧本"); process.exit(1); }
for (const id of ids) { const before = problems; validate(id); if (problems === before) {} }

console.log(problems ? `\n✗ 发现 ${problems} 个问题` : "\n✓ 全部通过");
process.exit(problems ? 1 : 0);
