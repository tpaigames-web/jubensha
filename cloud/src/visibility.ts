/**
 * 服务端权威的可见性裁决 —— 阶段 3 的核心。
 *
 * 唯一真相来源：给定「房间此刻的状态 + 某个席位」，算出该席位**有权解析**的
 * content key 集合。任何下发路径都必须先过这里，禁止旁路。
 *
 * 硬性规则（对应说明书第 6 章）：
 *   1. 剧本正文按幕下发：未解锁幕的 scriptKey 绝不进入任何响应
 *   2. 线索三元组校验：(seatId/角色, clueId, currentActIndex)
 *   3. 私有线索只给对应角色
 *   4. phase !== debrief 时，复盘 key 一律不下发
 */

import { ClueDef, Skeleton } from "./skeleton";
import { Phase } from "./types";

export interface VisibilityCtx {
  phase: Phase;
  /** 当前幕下标；lobby 阶段为 -1 */
  actIndex: number;
  /** 该席位的角色 id；未选角为 null */
  characterId: string | null;
  /** 房间已解锁的线索 id */
  unlockedClueIds: string[];
  /** 已解锁的复盘段 id */
  debriefUnlocked: string[];
}

/** 已开放到第几幕（含）。lobby 未开放任何幕正文 */
export function unlockedActCount(ctx: VisibilityCtx): number {
  if (ctx.phase === "lobby") return 0;
  if (ctx.phase === "reading") return 1; // 只放第一幕
  if (ctx.phase === "playing") return ctx.actIndex + 1;
  // debrief / ended：全部幕已经历
  return Number.MAX_SAFE_INTEGER;
}

/** 该线索是否对这个角色可见（不含「是否已解锁」的判断） */
export function clueVisibleToCharacter(clue: ClueDef, characterId: string | null): boolean {
  if (clue.visibility.type === "public") return true;
  if (!characterId) return false;
  return (clue.visibility.characters ?? []).includes(characterId);
}

/** 线索所属幕是否已开放 */
export function clueActUnlocked(sk: Skeleton, clue: ClueDef, ctx: VisibilityCtx): boolean {
  const idx = sk.acts.findIndex((a) => a.id === clue.act);
  if (idx < 0) return false;
  return idx < unlockedActCount(ctx);
}

/**
 * 三元组校验：该席位此刻能否看到这条已解锁的线索。
 * 必须同时满足：所属幕已开放 + 已被解锁 + 角色可见性允许。
 */
export function canSeeClue(sk: Skeleton, clue: ClueDef, ctx: VisibilityCtx): boolean {
  return (
    clueActUnlocked(sk, clue, ctx) &&
    ctx.unlockedClueIds.includes(clue.id) &&
    clueVisibleToCharacter(clue, ctx.characterId)
  );
}

/** 该席位此刻可见的线索列表 */
export function visibleClues(sk: Skeleton, ctx: VisibilityCtx): ClueDef[] {
  return sk.clues.filter((c) => canSeeClue(sk, c, ctx));
}

/**
 * 搜证候选：当前幕、指定地点、尚未被解锁、且对该角色可见的线索。
 * 注意「对该角色可见」也纳入候选筛选——避免玩家搜出一条自己无权看的线索
 * 而白白消耗次数，同时也不泄露它的存在。
 */
export function searchCandidates(
  sk: Skeleton,
  ctx: VisibilityCtx,
  location: string
): ClueDef[] {
  if (ctx.phase !== "playing" || ctx.actIndex < 0) return [];
  const act = sk.acts[ctx.actIndex];
  if (!act || !act.locations.includes(location)) return [];
  return sk.clues.filter(
    (c) =>
      c.act === act.id &&
      c.location === location &&
      !ctx.unlockedClueIds.includes(c.id) &&
      clueVisibleToCharacter(c, ctx.characterId)
  );
}

/**
 * 该席位此刻**有权解析**的全部 content key。
 * 这是防剧透的总闸：不在这个集合里的 key，任何路径都不得解析下发。
 */
export function entitledKeys(sk: Skeleton, ctx: VisibilityCtx): Set<string> {
  const keys = new Set<string>();

  // 公开信息：标题、角色公开名与简介、地点名
  keys.add(sk.meta.titleKey);
  for (const c of sk.characters) {
    keys.add(c.nameKey);
    keys.add(c.briefKey);
  }
  const actCount = unlockedActCount(ctx);
  for (let i = 0; i < Math.min(actCount, sk.acts.length); i++) {
    for (const loc of sk.acts[i].locations) keys.add(loc);
  }

  // 自己的剧本正文：仅已开放的幕，且仅自己的角色
  if (ctx.characterId) {
    for (let i = 0; i < Math.min(actCount, sk.acts.length); i++) {
      const k = sk.acts[i].scriptKeys[ctx.characterId];
      if (k) keys.add(k);
    }
  }

  // 线索：过三元组校验的才给
  for (const c of visibleClues(sk, ctx)) keys.add(c.contentKey);

  // 投票：所属幕已开放才给问题与选项
  for (const v of sk.votes) {
    const idx = sk.acts.findIndex((a) => a.id === v.act);
    if (idx >= 0 && idx < actCount) {
      keys.add(v.promptKey);
      for (const o of v.options) keys.add(o.labelKey);
    }
  }

  // 复盘：仅 debrief 阶段，且仅已解锁的段
  if (ctx.phase === "debrief" || ctx.phase === "ended") {
    for (const seg of sk.debrief.segments) {
      if (ctx.debriefUnlocked.includes(seg.id)) keys.add(seg.contentKey);
    }
  }

  return keys;
}

/** 断言：把要下发的 key 过一遍闸门，越权的直接丢弃（并可由调用方记日志） */
export function filterEntitled(keys: string[], allowed: Set<string>): string[] {
  return keys.filter((k) => allowed.has(k));
}
