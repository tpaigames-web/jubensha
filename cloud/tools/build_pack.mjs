/**
 * 把 content/ 下的创作产物合成一个扁平的 { key: value } 文案包，
 * 再 base64 密封后写进 scripts/shop40/content.pack。
 *
 * 用法: node tools/build_pack.mjs
 *
 * 【为什么只 base64、没有 gzip】
 * 指令书写的是 gzip+base64，目的是「防手滑瞄到，不是防黑客」。
 * 但引擎的文案解析层 content.resolve() 是同步的，而 Workers 里解 gzip 只有
 * DecompressionStream 这一条路，是异步的——为了压缩率把整条解析链改成异步不划算。
 * base64 已经完全达到「编辑器里打开是一堆乱码、手滑瞄不到」的目的，
 * 包体也只有几十 KB，压不压无所谓。所以这里只做 base64。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./pack_source.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");

const pack = assemble();
const json = JSON.stringify(pack);
const sealed = Buffer.from(json, "utf8").toString("base64");

writeFileSync(join(root, "scripts/shop40/content.pack"), sealed, "utf8");

console.log("已写入 scripts/shop40/content.pack");
console.log(`  键 ${Object.keys(pack).length} 个 · 明文 ${(json.length / 1024).toFixed(1)} KB · 密封后 ${(sealed.length / 1024).toFixed(1)} KB`);
