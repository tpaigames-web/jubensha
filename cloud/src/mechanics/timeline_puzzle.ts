/**
 * timeline_puzzle —— 时间线拼合。
 *
 * 玩法：每人私有持有若干「记忆碎片」，共享一条按时刻排开的时间线。
 * 把碎片摆到它该在的时刻，全部摆对即完成。
 *
 * 【本机制的讨论驱动力】
 * 碎片全文**只有持有者能读**，其他人只看得到一行摘要。想让别人帮你判断该放哪一格，
 * 你必须把细节念出来。这不是可选的美化——放宽成「全场可见全文」，玩家闷头拖拽就能
 * 拼完，整幕就废了。projectFor 是这条规则的唯一执行点。
 *
 * 【答案的保管】
 * solution / gapSlot 只存在于骨架（打进 Worker 包体），既不进房间状态，也不进任何
 * 投影。前端永远只知道「对了几个」，不知道哪几个对。
 *
 * skeleton 的 mechanics[].params：
 *   {
 *     "slots":    [{ "id":"s1", "labelKey":"tl.slot.s1", "order":1 }, ...],
 *     "fragments":[{ "id":"f1", "owner":"P1", "contentKey":"tl.frag.f1.full",
 *                    "summaryKey":"tl.frag.f1.summary" }, ...],
 *     "solution": { "f1":"s3", "f2":"s7", ... },   // 干扰项不出现在这里
 *     "gapSlot":  "s5",                            // 无人目睹的时段，必须留空
 *     "discardZone": { "enabled": true, "labelKey": "tl.discard.label" },
 *     "feedback": { "mode":"count_only", "cooldownSec":30 },
 *     "placement": { "who":"any_seat" }
 *   }
 * 老写法（slotLabels 字符串数组 + fragments 带 label/slot/character）继续支持。
 */

import { MechanicResult, MechanicSeat, MechanicValidator } from "./types";

interface Fragment {
  fragId: string;
  ownerSeatId: string;
  /** 全文的 content key（新写法）或直接的文本（老写法） */
  contentKey?: string;
  summaryKey?: string;
  label?: string;
  /** 正确槽位；干扰项为 null，老写法无解时为 undefined */
  solution?: string | null;
}

interface Slot {
  slotId: string;
  labelKey?: string;
  label?: string;
}

export interface TimelineState {
  slots: Slot[];
  /** slotId → fragId */
  placed: Record<string, string>;
  /** 被丢进弃牌区的 fragId */
  discarded: string[];
  fragments: Fragment[];
  placedBy: Record<string, string>;   // fragId → seatId
  gapSlot: string | null;
  discardEnabled: boolean;
  discardLabelKey?: string;
  /** 已提交校对的次数与上次时间，用于冷却 */
  checks: number;
  lastCheckAt: number;
  /** 上次校对「对了几个」。只有数量，永远不记哪几个 */
  lastCorrect: number | null;
  cooldownSec: number;
  /** 提示效果：被锁定（判定为正确且不可移动）的槽位、已被点破的干扰项 */
  lockedSlots: string[];
  revealedDecoys: string[];
  /**
   * 已经上过盘的碎片。上盘之前只有持有者能打出（别人根本看不见它，
   * 也就无从谈起「拖动」）；一旦上过盘，谁都可以重排——这才是
   * placement.who = any_seat 的实际含义。
   */
  played: string[];
}

type Action =
  | { op: "place"; fragId: string; slot: string }
  | { op: "take"; slot: string }
  | { op: "discard"; fragId: string }
  | { op: "undiscard"; fragId: string }
  | { op: "check" };

const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** 已摆到位、且答案确实是这一格的数量 */
function correctCount(s: TimelineState): number {
  let n = 0;
  for (const [slotId, fragId] of Object.entries(s.placed)) {
    const f = s.fragments.find((x) => x.fragId === fragId);
    if (f && f.solution === slotId) n++;
  }
  return n;
}

/** 需要摆对的碎片总数（干扰项不算） */
const solvableCount = (s: TimelineState): number =>
  s.fragments.filter((f) => f.solution).length;

function isSolved(s: TimelineState): boolean {
  const need = solvableCount(s);
  if (need === 0) {
    // 剧本没给答案（老写法）：摆满即完成
    return s.slots.every((sl) => s.placed[sl.slotId]);
  }
  if (correctCount(s) !== need) return false;
  // 缺口格必须留空——那一段本来就没人目睹
  if (s.gapSlot && s.placed[s.gapSlot]) return false;
  // 干扰项必须被丢掉，不能赖在盘上
  return s.fragments.every((f) => f.solution || !Object.values(s.placed).includes(f.fragId));
}

export const timelinePuzzle: MechanicValidator<TimelineState> = {
  id: "timeline_puzzle",

  init(params, seats: MechanicSeat[]): TimelineState {
    const byChar = new Map<string, string>();
    for (const s of seats) if (s.characterId) byChar.set(s.characterId, s.seatId);
    const pickOwner = (who: string | undefined, i: number) =>
      (who && byChar.get(who)) || seats[i % Math.max(seats.length, 1)]?.seatId || "";

    // ---- 槽位 ----
    let slots: Slot[] = [];
    const rawSlots = params?.slots;
    if (Array.isArray(rawSlots) && typeof rawSlots[0] === "object") {
      slots = asArray<{ id: string; labelKey?: string; order?: number }>(rawSlots)
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((s) => ({ slotId: s.id, labelKey: s.labelKey }));
    } else {
      const labels = asArray<string>(params?.slotLabels);
      const n = typeof rawSlots === "number" ? rawSlots : labels.length;
      slots = Array.from({ length: Math.max(n, labels.length) }, (_, i) => ({
        slotId: `s${i + 1}`,
        label: labels[i],
      }));
    }

    // ---- 碎片 ----
    const solution = (params?.solution && typeof params.solution === "object"
      ? (params.solution as Record<string, string>)
      : null);
    const decls = asArray<Record<string, unknown>>(params?.fragments);
    const fragments: Fragment[] = decls.length
      ? decls.map((d, i) => {
          const fragId = String(d.id ?? `f${i + 1}`);
          // 新写法从 solution 表取答案；老写法直接写在 fragment 上的 slot 下标
          let sol: string | null | undefined;
          if (solution) sol = solution[fragId] ?? null;
          else if (Number.isInteger(d.slot as number)) sol = slots[d.slot as number]?.slotId ?? null;
          return {
            fragId,
            ownerSeatId: pickOwner((d.owner ?? d.character) as string | undefined, i),
            contentKey: d.contentKey as string | undefined,
            summaryKey: d.summaryKey as string | undefined,
            label: d.label as string | undefined,
            solution: sol,
          };
        })
      : seats.map((s, i) => ({
          fragId: `f${i + 1}`,
          ownerSeatId: s.seatId,
          label: `【占位-碎片${i + 1}】`,
          solution: undefined,
        }));

    const dz = (params?.discardZone ?? {}) as { enabled?: boolean; labelKey?: string };
    const fb = (params?.feedback ?? {}) as { cooldownSec?: number };

    return {
      slots: slots.length ? slots : fragments.map((_, i) => ({ slotId: `s${i + 1}` })),
      placed: {},
      discarded: [],
      fragments,
      placedBy: {},
      gapSlot: typeof params?.gapSlot === "string" && params.gapSlot !== "SEALED"
        ? params.gapSlot : null,
      discardEnabled: dz.enabled === true,
      discardLabelKey: dz.labelKey,
      checks: 0,
      lastCheckAt: 0,
      lastCorrect: null,
      cooldownSec: Number(fb.cooldownSec ?? 0),
      lockedSlots: [],
      revealedDecoys: [],
      played: [],
    };
  },

  onAction(state, seatId, payload): MechanicResult<TimelineState> {
    const a = payload as Action;
    const next: TimelineState = {
      ...state,
      placed: { ...state.placed },
      placedBy: { ...state.placedBy },
      discarded: [...state.discarded],
      lockedSlots: [...state.lockedSlots],
      revealedDecoys: [...state.revealedDecoys],
      played: [...(state.played ?? [])],
    };
    const frag = (id: string) => next.fragments.find((f) => f.fragId === id);
    const onBoard = (id: string) => Object.values(next.placed).includes(id);
    // 槽位既接受 slotId，也接受下标——简写剧本里格子没有名字，用下标最自然
    const slotIdOf = (v: unknown): string | null =>
      typeof v === "number" ? next.slots[v]?.slotId ?? null : String(v ?? "");

    if (a?.op === "place") {
      const slot = next.slots.find((s) => s.slotId === slotIdOf(a.slot));
      if (!slot) return { nextState: state, events: [], reject: "格子不存在" };
      if (next.lockedSlots.includes(slot.slotId)) {
        return { nextState: state, events: [], reject: "这一格已经确认过了，不能再动" };
      }
      const f = frag(a.fragId);
      if (!f) return { nextState: state, events: [], reject: "碎片不存在" };
      if (onBoard(f.fragId)) return { nextState: state, events: [], reject: "该碎片已在盘上" };
      if (next.placed[slot.slotId]) return { nextState: state, events: [], reject: "这一格已经有碎片了" };
      // 还没打出过的碎片只有持有者能打——别人连它的存在都看不到
      if (!next.played.includes(f.fragId) && f.ownerSeatId !== seatId) {
        return { nextState: state, events: [], reject: "这不是你的碎片" };
      }

      next.discarded = next.discarded.filter((x) => x !== f.fragId);
      next.placed[slot.slotId] = f.fragId;
      next.placedBy[f.fragId] = seatId;
      if (!next.played.includes(f.fragId)) next.played.push(f.fragId);
      return { nextState: next, events: [] };
    }

    if (a?.op === "take") {
      const sid = slotIdOf(a.slot);
      if (!sid) return { nextState: state, events: [], reject: "格子不存在" };
      if (next.lockedSlots.includes(sid)) {
        return { nextState: state, events: [], reject: "这一格已经确认过了，不能再动" };
      }
      const fragId = next.placed[sid];
      if (!fragId) return { nextState: state, events: [], reject: "这一格是空的" };
      delete next.placed[sid];
      delete next.placedBy[fragId];
      return { nextState: next, events: [] };
    }

    if (a?.op === "discard") {
      if (!next.discardEnabled) return { nextState: state, events: [], reject: "本局没有弃牌区" };
      const f = frag(a.fragId);
      if (!f) return { nextState: state, events: [], reject: "碎片不存在" };
      for (const [slotId, id] of Object.entries(next.placed)) {
        if (id !== f.fragId) continue;
        if (next.lockedSlots.includes(slotId)) {
          return { nextState: state, events: [], reject: "这一格已经确认过了，不能再动" };
        }
        delete next.placed[slotId];
        delete next.placedBy[f.fragId];
      }
      if (!next.discarded.includes(f.fragId)) next.discarded.push(f.fragId);
      return { nextState: next, events: [] };
    }

    if (a?.op === "undiscard") {
      next.discarded = next.discarded.filter((x) => x !== a.fragId);
      return { nextState: next, events: [] };
    }

    if (a?.op === "check") {
      const waited = (Date.now() - next.lastCheckAt) / 1000;
      if (next.cooldownSec > 0 && next.lastCheckAt > 0 && waited < next.cooldownSec) {
        return {
          nextState: state, events: [],
          reject: `再等 ${Math.ceil(next.cooldownSec - waited)} 秒才能再校对一次`,
        };
      }
      next.checks += 1;
      next.lastCheckAt = Date.now();
      const n = correctCount(next);
      next.lastCorrect = n;
      // 只报数量，绝不报哪一个——这是这个机制的核心约束
      return {
        nextState: next,
        events: [{ narrationText: `校对结果：${n} 个碎片在正确的位置上。`, payload: { correct: n } }],
      };
    }

    return { nextState: state, events: [], reject: "未知操作" };
  },

  projectFor(state, seatId) {
    const mine = (f: Fragment) => f.ownerSeatId === seatId;
    /**
     * 别人的碎片只给摘要 key，全文 key 只出现在持有者自己的投影里——
     * 这是本机制不可放宽的一条。
     *
     * 例外是老写法的剧本：它们没有摘要，全文就写在 label 上，
     * 沿用原来的「打出即全场可见」。要收紧的话，给碎片补上 summaryKey 即可。
     */
    const view = (f: Fragment) => {
      const sealed = !!f.summaryKey && !mine(f);
      return {
        fragId: f.fragId,
        mine: mine(f),
        textKey: mine(f) ? (f.contentKey ?? undefined) : (f.summaryKey ?? undefined),
        label: sealed ? undefined : f.label,
        summaryOnly: sealed,
        revealedDecoy: state.revealedDecoys.includes(f.fragId),
      };
    };

    const onBoard = new Set(Object.values(state.placed));
    return {
      slots: state.slots.map((s) => ({
        slotId: s.slotId,
        labelKey: s.labelKey,
        label: s.label,
        locked: state.lockedSlots.includes(s.slotId),
        frag: state.placed[s.slotId]
          ? view(state.fragments.find((f) => f.fragId === state.placed[s.slotId])!)
          : null,
      })),
      /** 手上还没打出去的：自己的，加上被人从盘上取下来的公共碎片 */
      myFragments: state.fragments
        .filter((f) => !onBoard.has(f.fragId) && !state.discarded.includes(f.fragId))
        .filter((f) => mine(f) || (state.played ?? []).includes(f.fragId))
        .map(view),
      /** 别人手上还没打出来的：只给数量，不给内容 */
      othersHolding: state.fragments.filter(
        (f) => !mine(f) && !onBoard.has(f.fragId) && !state.discarded.includes(f.fragId)
              && !(state.played ?? []).includes(f.fragId)
      ).length,
      discardEnabled: state.discardEnabled,
      discardLabelKey: state.discardLabelKey,
      discarded: state.discarded.map((id) => view(state.fragments.find((f) => f.fragId === id)!)),
      emptySlots: state.slots.filter((s) => !state.placed[s.slotId]).map((s) => s.slotId),
      checks: state.checks,
      /** 上次校对对了几个。永远不说是哪几个 */
      lastCorrect: state.lastCorrect,
      needCorrect: solvableCount(state),
      cooldownSec: state.cooldownSec,
      nextCheckAt: state.lastCheckAt ? state.lastCheckAt + state.cooldownSec * 1000 : 0,
      /** 该摆的都摆上了（但未必摆对）——界面据此提示可以校对了 */
      filled: state.fragments.every(
        (f) => Object.values(state.placed).includes(f.fragId) || state.discarded.includes(f.fragId)
      ),
      graded: solvableCount(state) > 0,
      complete: isSolved(state),
    };
  },

  isComplete: isSolved,
};

/** 提示效果：锁定一个已经摆对的格子。没有摆对的就不锁，避免误锁死错误答案。 */
export function lockOneCorrect(state: TimelineState): TimelineState {
  for (const [slotId, fragId] of Object.entries(state.placed)) {
    if (state.lockedSlots.includes(slotId)) continue;
    const f = state.fragments.find((x) => x.fragId === fragId);
    if (f && f.solution === slotId) {
      return { ...state, lockedSlots: [...state.lockedSlots, slotId] };
    }
  }
  return state;
}

/** 提示效果：点破一个干扰项（solution 为 null 的碎片） */
export function revealDecoy(state: TimelineState): TimelineState {
  const decoy = state.fragments.find(
    (f) => f.solution === null && !state.revealedDecoys.includes(f.fragId)
  );
  return decoy
    ? { ...state, revealedDecoys: [...state.revealedDecoys, decoy.fragId] }
    : state;
}
