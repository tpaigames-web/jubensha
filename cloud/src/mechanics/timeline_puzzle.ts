/**
 * timeline_puzzle —— 占位实现（阶段 5 用于验证框架可用性）。
 *
 * 规则（占位版，正式规则随剧本包提供）：
 *   - 每个席位私有持有若干「碎片」，只有自己看得见自己的碎片内容
 *   - 共享一条 N 格时间线，玩家把自己的碎片拖进空格
 *   - 服务端校验：一格只能放一个；只能放自己持有且未放置的碎片；可取回自己放的
 *   - 全部格子填满即完成，参与幕推进判定
 *   - 投影：所有人都能看到「哪些格子还空着」，但看不到别人手里未打出的碎片
 */

import { MechanicResult, MechanicSeat, MechanicValidator } from "./types";

interface Fragment {
  fragId: string;
  ownerSeatId: string;
  /** 占位标签；正式剧本里应改为 contentKey，由文案层解析 */
  label: string;
}

export interface TimelineState {
  slots: (string | null)[];          // 每格放置的 fragId
  fragments: Fragment[];
  placedBy: Record<string, string>;  // fragId → seatId
}

type Action =
  | { op: "place"; fragId: string; slot: number }
  | { op: "take"; slot: number };

export const timelinePuzzle: MechanicValidator<TimelineState> = {
  id: "timeline_puzzle",

  init(params, seats: MechanicSeat[]): TimelineState {
    const slotCount = Number(params?.slots ?? 4);
    const fragments: Fragment[] = [];
    // 每人分到一枚碎片（占位分配；正式版由剧本参数指定）
    seats.forEach((s, i) => {
      fragments.push({
        fragId: `f${i + 1}`,
        ownerSeatId: s.seatId,
        label: `【占位-碎片${i + 1}】`,
      });
    });
    return {
      slots: new Array(Math.max(slotCount, seats.length)).fill(null),
      fragments,
      placedBy: {},
    };
  },

  onAction(state, seatId, payload): MechanicResult<TimelineState> {
    const a = payload as Action;
    const next: TimelineState = {
      slots: [...state.slots],
      fragments: state.fragments,
      placedBy: { ...state.placedBy },
    };

    if (a?.op === "place") {
      const slot = Number(a.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= next.slots.length) {
        return { nextState: state, events: [], reject: "格子不存在" };
      }
      const frag = next.fragments.find((f) => f.fragId === a.fragId);
      if (!frag) return { nextState: state, events: [], reject: "碎片不存在" };
      if (frag.ownerSeatId !== seatId) return { nextState: state, events: [], reject: "这不是你的碎片" };
      if (next.placedBy[frag.fragId]) return { nextState: state, events: [], reject: "该碎片已放置" };
      if (next.slots[slot]) return { nextState: state, events: [], reject: "这一格已经有碎片了" };

      next.slots[slot] = frag.fragId;
      next.placedBy[frag.fragId] = seatId;
      return { nextState: next, events: [] };
    }

    if (a?.op === "take") {
      const slot = Number(a.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= next.slots.length) {
        return { nextState: state, events: [], reject: "格子不存在" };
      }
      const fragId = next.slots[slot];
      if (!fragId) return { nextState: state, events: [], reject: "这一格是空的" };
      if (next.placedBy[fragId] !== seatId) {
        return { nextState: state, events: [], reject: "只能取回自己放的碎片" };
      }
      next.slots[slot] = null;
      delete next.placedBy[fragId];
      return { nextState: next, events: [] };
    }

    return { nextState: state, events: [], reject: "未知操作" };
  },

  projectFor(state, seatId) {
    // 已放置的碎片对全体可见；未放置的只有持有者本人能看到
    const placed = new Set(Object.keys(state.placedBy));
    return {
      slots: state.slots.map((fragId) => {
        if (!fragId) return null;
        const f = state.fragments.find((x) => x.fragId === fragId)!;
        return { fragId: f.fragId, label: f.label, byMe: state.placedBy[fragId] === seatId };
      }),
      /** 缺口位置：投影给所有人（说明书 8.3 要求） */
      emptySlots: state.slots.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0),
      myFragments: state.fragments
        .filter((f) => f.ownerSeatId === seatId && !placed.has(f.fragId))
        .map((f) => ({ fragId: f.fragId, label: f.label })),
      /** 只暴露数量，不暴露别人手里的具体内容 */
      othersHolding: state.fragments.filter(
        (f) => f.ownerSeatId !== seatId && !placed.has(f.fragId)
      ).length,
      complete: state.slots.every((s) => s !== null),
    };
  },

  isComplete(state) {
    return state.slots.every((s) => s !== null);
  },
};
