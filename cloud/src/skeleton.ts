/**
 * 剧本骨架类型与加载。骨架里**没有任何正文**，只有结构与 key。
 *
 * 唯一的例外是机制的 `solution` / `gapSlot`：答案必须由服务端持有才能判定对错。
 * 它们只存在于骨架里，绝不进入任何下发给客户端的报文（见 mechanics 的 projectFor）。
 *
 * 这里的类型同时要吃两种写法：
 *   - 引擎自带剧本的简写（location 是字符串、线索只有 contentKey、分支写 unanimous_X）
 *   - 外部正式剧本包的全写（顶层 locations 表、线索带 titleKey、分支写 4-0:sell）
 * 差异在 normalize() 里抹平，运行时只看到一种形状。
 */

import { SKELETON_JSON, HIDDEN_SCRIPTS } from "./registry.gen";

export interface Visibility {
  type: "public" | "private";
  /** private 时：允许看到的角色 id 列表。外部包写作 seats，含义相同 */
  characters?: string[];
  seats?: string[];
}

export interface ClueDef {
  id: string;
  act: string;
  /** 开幕自动下发的线索没有地点 */
  location: string | null;
  titleKey?: string;
  contentKey: string;
  visibility: Visibility;
  /** search（默认，要玩家搜）| on_act_start（开幕自动进背包） */
  grant?: "search" | "on_act_start";
}

export interface LocationDef {
  id: string;
  act?: string;
  nameKey?: string;
  descKey?: string;
}

export interface ActDef {
  id: string;
  titleKey?: string;
  indexLabel?: string;
  durationMin: number;
  openingNarrationKey: string;
  closingNarrationKey: string | null;
  scriptKeys: Record<string, string>;
  locations: string[];
  searchQuota: { perSeat: number };
  advance: {
    type: "all_ready" | "timeout" | "all_ready_or_timeout" | "mechanic_then_vote";
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
  bgmByAct?: Record<string, string>;
  bgmLobby?: string;
  bgmDebrief?: string;
}

export interface Skeleton {
  scriptId: string;
  schemaVersion: number;
  meta: {
    titleKey: string;
    /** 一句话钩子，显示在选本卡的标题下面 */
    subtitleKey?: string;
    /** 三五十字的简介，仍然只讲设定，不能剧透 */
    blurbKey?: string;
    introNarrationKey?: string;
    players: number;
    durationMin: number;
    type: string;
    /** 分类标签：新手 / 悬疑烧脑 / 欢乐 / 灵异 / 情感 / 古风 / AI创作 … */
    tags?: string[];
    /** 难度的人话描述，如「中等偏硬核」 */
    difficultyLabel?: string;
    difficulty?: Record<string, number>;
    contentRating?: string;
    contentWarnings?: string[];
    reversibleRoles?: boolean;
    /** 在制品：不进选本列表，也不能被 /api/newroom 开局 */
    draft?: boolean;
  };
  audio?: AudioDecl;
  characters: { id: string; nameKey: string; briefKey: string; tagsKey?: string }[];
  locations?: LocationDef[];
  acts: ActDef[];
  clues: ClueDef[];
  votes: VoteDef[];
  mechanics: { id: string; act: string; params: Record<string, unknown> }[];
  debrief: {
    segments: { id: string; titleKey?: string; contentKey: string; unlock?: string }[];
    epilogueKey?: string;
  };
}

/** 允许看到该线索的角色（吃 characters / seats 两种字段名） */
export const clueAudience = (c: ClueDef): string[] =>
  c.visibility.characters ?? c.visibility.seats ?? [];

/** 线索是否开幕自动下发（而不是要玩家搜） */
export const isGranted = (c: ClueDef): boolean => c.grant === "on_act_start";

/**
 * 把投票分支归一到 unanimous_<opt> / majority_<opt> / split。
 *
 * 外部包按人数比例写，如 4 人本的 `4-0:sell` / `3-1:keep` / `2-2`。
 * 这种写法绑死了人数，引擎侧统一换成与人数无关的说法：
 * 落单为 0 的是全票，其余过半的是多数，平局是 split。
 */
export function normalizeBranchMatch(match: string, players: number): string {
  if (/^(unanimous|majority)_/.test(match) || match === "split") return match;
  const m = /^(\d+)-(\d+)(?::(.+))?$/.exec(match);
  if (!m) return match;
  const [top, rest, opt] = [Number(m[1]), Number(m[2]), m[3]];
  if (!opt || top === rest) return "split";
  if (rest === 0 && top >= players) return `unanimous_${opt}`;
  return top * 2 > top + rest ? `majority_${opt}` : "split";
}

/** 推进条件归一：外部包写 `mechanic:timeline_puzzle` / `vote:vote.final` */
const normalizeRequire = (r: string): string =>
  r.startsWith("mechanic:") ? "mechanic_done" : r.startsWith("vote:") ? "vote_done" : r;

/** 把两种写法抹平成运行时唯一形状。只在加载时跑一次。 */
function normalize(s: Skeleton): Skeleton {
  for (const a of s.acts) {
    a.closingNarrationKey = a.closingNarrationKey ?? null;
    a.hints = a.hints ?? [];
    a.mechanics = a.mechanics ?? [];
    a.locations = a.locations ?? [];
    if (a.advance?.requires) a.advance.requires = a.advance.requires.map(normalizeRequire);
    // mechanic_then_vote 等价于「机制与投票都完成才推进」，超时仍然兜底
    if (a.advance?.type === "mechanic_then_vote") {
      a.advance.type = "all_ready_or_timeout";
      const req = new Set(a.advance.requires ?? []);
      req.add("mechanic_done"); req.add("vote_done");
      a.advance.requires = [...req];
    }
  }
  for (const c of s.clues) {
    if (c.location === undefined) c.location = null;
    if (c.visibility.seats && !c.visibility.characters) c.visibility.characters = c.visibility.seats;
  }
  for (const v of s.votes) {
    v.resultBranches = (v.resultBranches ?? []).map((b) => ({
      ...b,
      match: normalizeBranchMatch(b.match, s.meta.players),
    }));
  }
  return s;
}

/** 注册表由 tools/register.mjs 扫描 scripts/ 自动生成 */
const registry: Record<string, Skeleton> = {};
for (const [id, sk] of Object.entries(SKELETON_JSON as Record<string, Skeleton>)) {
  registry[id] = normalize(sk);
}

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
    subtitleKey: s.meta.subtitleKey,
    blurbKey: s.meta.blurbKey,
    tags: s.meta.tags ?? [],
    difficultyLabel: s.meta.difficultyLabel,
  }));
