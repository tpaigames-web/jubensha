/* 本文件由 tools/register.mjs 自动生成，请勿手改。
 * 新增剧本：把文件夹丢进 scripts/，然后跑 `node tools/register.mjs`。
 */

import sk_s_fasttest from "../scripts/fasttest/skeleton.json";
import sk_s_placeholder from "../scripts/placeholder/skeleton.json";
import sk_s_radio from "../scripts/radio/skeleton.json";
import sk_s_shop40 from "../scripts/shop40/skeleton.json";
import pk_s_placeholder from "../scripts/placeholder/content.pack";
import pk_s_radio from "../scripts/radio/content.pack";
import pk_s_shop40 from "../scripts/shop40/content.pack";

export const SKELETON_JSON: Record<string, unknown> = {
  "fasttest": sk_s_fasttest,
  "placeholder": sk_s_placeholder,
  "radio": sk_s_radio,
  "shop40": sk_s_shop40,
};

/** scriptId → 文案包原文（多个剧本可共用同一个包） */
export const PACK_TEXT: Record<string, string> = {
  "fasttest": pk_s_placeholder as unknown as string,
  "placeholder": pk_s_placeholder as unknown as string,
  "radio": pk_s_radio as unknown as string,
  "shop40": pk_s_shop40 as unknown as string,
};

/** 不对玩家展示的内部剧本：测试夹具，不该出现在朋友的选本列表里。
 *  仍可用 /ws?room=XXXX&script=<id> 直连自测。 */
export const HIDDEN_SCRIPTS = new Set<string>(["fasttest", "placeholder"]);
