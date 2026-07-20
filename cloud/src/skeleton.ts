/**
 * 剧本骨架类型与加载。骨架里**没有任何正文**，只有结构与 key。
 */

import { SKELETON_JSON, HIDDEN_SCRIPTS } from "./registry.gen";

export interface Visibility {
  type: "public" | "private";
  /** private 时：允许看到的角色 id 列表 */
  characters?: string[];
}

export interface ClueDef {
  id: string;
  act: string;
  location: string;
  contentKey: string;
  visibility: Visibility;
}

export interface ActDef {
  id: string;
  durationMin: number;
  openingNarrationKey: string;
  closingNarrationKey: string;
  scriptKeys: Record<string, string>;
  locations: string[];
  searchQuota: { perSeat: number };
  advance: {
    type: "all_ready" | "timeout" | "all_ready_or_timeout";
    requires?: string[];
    timeoutMin: number;
  };
  mechanics: string[];
  hints: { afterMin: number; narrationKey: string }[];
}

export interface VoteDef {
  id: string;
  act: string;
  mode: "single_public" | "single_anonymous" | "ranked" | "multi";
  promptKey: string;
  options: { id: string; labelKey: string }[];
  resultBranches: { match: string; narrationKey: string }[];
}

/**
 * 可选音频声明。文件放 public/audio/ 下，这里写相对该目录的路径。
 * 没有声明或文件不存在时，前端静默跳过，不影响游戏。
 */
export interface AudioDecl {
  /** 幕 id → 背景音乐文件，如 { "act1": "radio/act1.mp3" } */
  bgmByAct?: Record<string, string>;
  /** 大厅/阅读阶段的背景音乐 */
  bgmLobby?: string;
  /** 复盘阶段的背景音乐 */
  bgmDebrief?: string;
}

export interface Skeleton {
  scriptId: string;
  schemaVersion: number;
  meta: { titleKey: string; players: number; durationMin: number; type: string };
  audio?: AudioDecl;
  characters: { id: string; nameKey: string; briefKey: string }[];
  acts: ActDef[];
  clues: ClueDef[];
  votes: VoteDef[];
  mechanics: { id: string; act: string; params: Record<string, unknown> }[];
  debrief: { segments: { id: string; contentKey: string; unlock: string }[] };
}

/** 注册表由 tools/register.mjs 扫描 scripts/ 自动生成 */
const registry: Record<string, Skeleton> = SKELETON_JSON as Record<string, Skeleton>;

export const hasSkeleton = (scriptId: string) => scriptId in registry;
export { HIDDEN_SCRIPTS };

export function getSkeleton(scriptId: string): Skeleton {
  const s = registry[scriptId];
  if (!s) throw new Error("unknown skeleton: " + scriptId);
  return s;
}

export const listScripts = () =>
  Object.values(registry).map((s) => ({
    scriptId: s.scriptId,
    players: s.meta.players,
    durationMin: s.meta.durationMin,
    titleKey: s.meta.titleKey,
  }));
