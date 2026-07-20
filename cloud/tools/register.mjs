/**
 * 扫描 scripts/ 下的剧本，生成 src/registry.gen.ts。
 * 加新剧本 = 把 <剧本id>/{skeleton.json,content.pack} 丢进 scripts/，然后跑一次本脚本。
 * 不需要手改任何源码。
 *
 * 用法: node tools/register.mjs
 */
import { readdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(__dir, "..", "scripts");

const ids = readdirSync(scriptsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((id) => existsSync(join(scriptsDir, id, "skeleton.json")))
  .sort();

if (!ids.length) {
  console.error("scripts/ 下没有找到任何剧本");
  process.exit(1);
}

const safe = (id) => "s_" + id.replace(/[^a-zA-Z0-9_]/g, "_");

// 有独立 content.pack 的用自己的；没有的复用 placeholder 的（例如计时探针本）
const packOf = {};
for (const id of ids) {
  packOf[id] = existsSync(join(scriptsDir, id, "content.pack")) ? id : "placeholder";
}

const lines = [
  "/* 本文件由 tools/register.mjs 自动生成，请勿手改。",
  " * 新增剧本：把文件夹丢进 scripts/，然后跑 `node tools/register.mjs`。",
  " */",
  "",
];
for (const id of ids) {
  lines.push(`import sk_${safe(id)} from "../scripts/${id}/skeleton.json";`);
}
for (const id of [...new Set(Object.values(packOf))]) {
  lines.push(`import pk_${safe(id)} from "../scripts/${id}/content.pack";`);
}
lines.push("");
lines.push("export const SKELETON_JSON: Record<string, unknown> = {");
for (const id of ids) lines.push(`  ${JSON.stringify(id)}: sk_${safe(id)},`);
lines.push("};");
lines.push("");
lines.push("/** scriptId → 文案包原文（多个剧本可共用同一个包） */");
lines.push("export const PACK_TEXT: Record<string, string> = {");
for (const id of ids) lines.push(`  ${JSON.stringify(id)}: pk_${safe(packOf[id])} as unknown as string,`);
lines.push("};");
lines.push("");
lines.push("/** 不对玩家展示的内部剧本：测试夹具，不该出现在朋友的选本列表里。");
lines.push(" *  仍可用 /ws?room=XXXX&script=<id> 直连自测。 */");
lines.push("export const HIDDEN_SCRIPTS = new Set<string>([\"fasttest\", \"placeholder\"]);");
lines.push("");

writeFileSync(resolve(__dir, "..", "src", "registry.gen.ts"), lines.join("\n"), "utf8");

console.log("已生成 src/registry.gen.ts");
for (const id of ids) {
  const sk = JSON.parse(readFileSync(join(scriptsDir, id, "skeleton.json"), "utf8"));
  console.log(`  · ${id.padEnd(14)} ${sk.meta?.players ?? "?"}人 · ${sk.acts?.length ?? 0}幕 · 文案包=${packOf[id]}`);
}
