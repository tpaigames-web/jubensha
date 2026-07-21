/**
 * 文案解析层 —— 防剧透规约的技术落点。
 *
 * 规约：
 *  1. 引擎全程只传递 key（如 "clue.a1.03"），不接触正文。
 *  2. 正文只在「确认某席位此刻有权看到」之后、下发的那一瞬间才解析。
 *  3. 文案包打进 Worker 包体，不放 public/，因此无法被公开下载。
 *  4. 未来换成加密包时，只需替换 decode()，上层引擎代码零改动。
 *
 * 【重要】任何人（包括开发者与 AI）都不应打印、日志化或批量导出这里的解析结果。
 * resolveMany 只服务于「已通过可见性裁决的 key 列表」。
 */

import { PACK_TEXT } from "./registry.gen";

export interface ContentSource {
  resolve(key: string): string | null;
  resolveMany(keys: string[]): Record<string, string>;
}

/**
 * 密封包解码。
 *
 * 文案包有两种形态：明文 JSON（引擎自带剧本），和 base64 密封（正式剧本包）。
 * 密封不是为了防破解——包体本来就打进 Worker、外部下载不到——
 * 而是为了防「在编辑器里手滑翻到正文」。委托人要作为玩家游玩，这一条比加密强度重要。
 *
 * 只做 base64、不做 gzip：resolve() 是同步的，而 Workers 里解 gzip 只有异步的
 * DecompressionStream，为了几十 KB 的压缩率把整条解析链改成异步不划算。
 */
function decode(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("{")) return s;                       // 明文包
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);                // 中文必须按 UTF-8 还原
}

class JsonContentSource implements ContentSource {
  private map: Record<string, string>;

  constructor(raw: string) {
    this.map = JSON.parse(decode(raw)) as Record<string, string>;
  }

  resolve(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.map, key) ? this.map[key] : null;
  }

  resolveMany(keys: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = this.resolve(k);
      if (v !== null) out[k] = v;
    }
    return out;
  }
}

/** 由 tools/register.mjs 生成：scriptId → 文案包原文（多剧本可共用一个包） */
const sources: Record<string, ContentSource> = {};
const cacheByText = new Map<string, ContentSource>();
for (const [id, text] of Object.entries(PACK_TEXT)) {
  let src = cacheByText.get(text);
  if (!src) { src = new JsonContentSource(text); cacheByText.set(text, src); }
  sources[id] = src;
}

export function getContent(scriptId: string): ContentSource {
  const s = sources[scriptId];
  if (!s) throw new Error("unknown content pack: " + scriptId);
  return s;
}
