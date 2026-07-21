/* 本文件由 tools/register.mjs 自动生成，请勿手改。
 * 新增剧本：把文件夹丢进 scripts/，然后跑 `node tools/register.mjs`。
 */

import sk_s_fasttest from "../scripts/fasttest/skeleton.json";
import sk_s_gallery from "../scripts/gallery/skeleton.json";
import sk_s_huihun from "../scripts/huihun/skeleton.json";
import sk_s_inn from "../scripts/inn/skeleton.json";
import sk_s_lighthouse from "../scripts/lighthouse/skeleton.json";
import sk_s_oldshop from "../scripts/oldshop/skeleton.json";
import sk_s_party from "../scripts/party/skeleton.json";
import sk_s_placeholder from "../scripts/placeholder/skeleton.json";
import sk_s_radio from "../scripts/radio/skeleton.json";
import sk_s_shop40 from "../scripts/shop40/skeleton.json";
import sk_s_temple from "../scripts/temple/skeleton.json";
import sk_s_typhoon from "../scripts/typhoon/skeleton.json";
import sk_s_xianmen from "../scripts/xianmen/skeleton.json";
import pk_s_placeholder from "../scripts/placeholder/content.pack";
import pk_s_gallery from "../scripts/gallery/content.pack";
import pk_s_huihun from "../scripts/huihun/content.pack";
import pk_s_inn from "../scripts/inn/content.pack";
import pk_s_lighthouse from "../scripts/lighthouse/content.pack";
import pk_s_oldshop from "../scripts/oldshop/content.pack";
import pk_s_party from "../scripts/party/content.pack";
import pk_s_radio from "../scripts/radio/content.pack";
import pk_s_shop40 from "../scripts/shop40/content.pack";
import pk_s_temple from "../scripts/temple/content.pack";
import pk_s_typhoon from "../scripts/typhoon/content.pack";
import pk_s_xianmen from "../scripts/xianmen/content.pack";

export const SKELETON_JSON: Record<string, unknown> = {
  "fasttest": sk_s_fasttest,
  "gallery": sk_s_gallery,
  "huihun": sk_s_huihun,
  "inn": sk_s_inn,
  "lighthouse": sk_s_lighthouse,
  "oldshop": sk_s_oldshop,
  "party": sk_s_party,
  "placeholder": sk_s_placeholder,
  "radio": sk_s_radio,
  "shop40": sk_s_shop40,
  "temple": sk_s_temple,
  "typhoon": sk_s_typhoon,
  "xianmen": sk_s_xianmen,
};

/** scriptId → 文案包原文（多个剧本可共用同一个包） */
export const PACK_TEXT: Record<string, string> = {
  "fasttest": pk_s_placeholder as unknown as string,
  "gallery": pk_s_gallery as unknown as string,
  "huihun": pk_s_huihun as unknown as string,
  "inn": pk_s_inn as unknown as string,
  "lighthouse": pk_s_lighthouse as unknown as string,
  "oldshop": pk_s_oldshop as unknown as string,
  "party": pk_s_party as unknown as string,
  "placeholder": pk_s_placeholder as unknown as string,
  "radio": pk_s_radio as unknown as string,
  "shop40": pk_s_shop40 as unknown as string,
  "temple": pk_s_temple as unknown as string,
  "typhoon": pk_s_typhoon as unknown as string,
  "xianmen": pk_s_xianmen as unknown as string,
};

/** 不对玩家展示的剧本：测试夹具 + meta.draft 的在制品。
 *  仍可用 /ws?room=XXXX&script=<id> 直连自测。 */
export const HIDDEN_SCRIPTS = new Set<string>(["fasttest","placeholder"]);
