/**
 * 剧本骨架类型与加载。骨架里**没有任何正文**，只有结构与 key。
 */

import skeletonJson from "../scripts/placeholder/skeleton.json";
import fastTestJson from "../scripts/fasttest/skeleton.json";
import radioJson from "../scripts/radio/skeleton.json";

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

export interface Skeleton {
  scriptId: string;
  schemaVersion: number;
  meta: { titleKey: string; players: number; durationMin: number; type: string };
  characters: { id: string; nameKey: string; briefKey: string }[];
  acts: ActDef[];
  clues: ClueDef[];
  votes: VoteDef[];
  mechanics: { id: string; act: string; params: Record<string, unknown> }[];
  debrief: { segments: { id: string; contentKey: string; unlock: string }[] };
}

const registry: Record<string, Skeleton> = {
  placeholder: skeletonJson as unknown as Skeleton,
  /** 仅用于验证 DO Alarm 计时链路：幕长与提示时间被压缩到秒级 */
  fasttest: fastTestJson as unknown as Skeleton,
  radio: radioJson as unknown as Skeleton,
};

export const hasSkeleton = (scriptId: string) => scriptId in registry;

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
