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

import packText from "../scripts/placeholder/content.pack";

export interface ContentSource {
  resolve(key: string): string | null;
  resolveMany(keys: string[]): Record<string, string>;
}

class JsonContentSource implements ContentSource {
  private map: Record<string, string>;

  constructor(raw: string) {
    // 当前为明文占位包；换成加密包时在此处解密，上层无感
    this.map = JSON.parse(raw) as Record<string, string>;
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

const placeholderPack = new JsonContentSource(packText as unknown as string);

const sources: Record<string, ContentSource> = {
  placeholder: placeholderPack,
  /** 计时探针剧本复用同一套占位 key，无需单独文案包 */
  fasttest: placeholderPack,
};

export function getContent(scriptId: string): ContentSource {
  const s = sources[scriptId];
  if (!s) throw new Error("unknown content pack: " + scriptId);
  return s;
}
