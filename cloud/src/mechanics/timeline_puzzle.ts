/**
 * timeline_puzzle —— 时间线拼合。
 *
 * 规则：
 *   - 每个席位私有持有若干「碎片」，只有自己看得见自己手上未打出的碎片
 *   - 共享一条 N 格时间线，玩家把自己的碎片拖进空格
 *   - 服务端校验：一格只能放一个；只能放自己持有且未放置的碎片；可取回自己放的
 *   - 全部格子填满即完成，参与幕推进判定（不校验顺序对错，避免卡幕）
 *   - 投影：所有人都能看到「哪些格子还空着」，但看不到别人手里未打出的碎片
 *
 * 剧本可在 skeleton 的 mechanics[].params 里声明真实碎片：
 *   {
 *     "slots": 4,
 *     "slotLabels": ["清晨五点", "上午七点", ...],       // 每格的时间提示，可选
 *     "fragments": [ { "character": "P1", "label": "……" }, ... ]
 *   }
 * 未声明 fragments 时退回占位分配（每席位一枚），保证任何剧本都能跑。
 */

import { MechanicResult, MechanicSeat, MechanicValidator } from "./types";

interface Fragment {
  fragId: string;
  ownerSeatId: string;
  label: string;
  /** 正确格子；剧本没声明就是 -1，此时不做对错判定 */
  slot: number;
}

export interface TimelineState {
  slots: (string | null)[];
  slotLabels: string[];
  fragments: Fragment[];
  placedBy: Record<string, string>;  // fragId → seatId
}

interface FragDecl {
  character?: string;
  label?: string;
  /** 这一段在时间线上的正确位置（下标）。声明了才有对错反馈 */
  slot?: number;
}

type Action =
  | { op: "place"; fragId: string; slot: number }
  | { op: "take"; slot: number };

export const timelinePuzzle: MechanicValidator<TimelineState> = {
  id: "timeline_puzzle",

  init(params, seats: MechanicSeat[]): TimelineState {
    const slotCount = Number(params?.slots ?? 4);
    const slotLabels = Array.isArray(params?.slotLabels) ? (params.slotLabels as string[]) : [];
    const decls = Array.isArray(params?.fragments) ? (params.fragments as FragDecl[]) : [];
    const fragments: Fragment[] = [];

    if (decls.length) {
      // 剧本声明版：按角色发牌。没人扮演的角色，其碎片顺延给尚未拿到碎片的席位，
      // 保证碎片总数与格子数一致，不会因为缺人而永远拼不完。
      const byChar = new Map<string, string>();
      for (const s of seats) if (s.characterId) byChar.set(s.characterId, s.seatId);
      const spare = seats.filter((s) => !s.characterId || !decls.some((d) => d.character === s.characterId));
      let spareAt = 0;
      decls.forEach((d, i) => {
        const owner =
          (d.character && byChar.get(d.character)) ||
          spare[spareAt++ % Math.max(spare.length, 1)]?.seatId ||
          seats[i % Math.max(seats.length, 1)]?.seatId;
        if (!owner) return;
        fragments.push({
          fragId: `f${i + 1}`, ownerSeatId: owner,
          label: String(d.label ?? `碎片${i + 1}`),
          slot: Number.isInteger(d.slot as number) ? (d.slot as number) : -1,
        });
      });
    } else {
      // 占位分配：每人一枚
      seats.forEach((s, i) => {
        fragments.push({ fragId: `f${i + 1}`, ownerSeatId: s.seatId, label: `【占位-碎片${i + 1}】`, slot: -1 });
      });
    }

    return {
      slots: new Array(Math.max(slotCount, fragments.length)).fill(null),
      slotLabels,
      fragments,
      placedBy: {},
    };
  },

  onAction(state, seatId, payload): MechanicResult<TimelineState> {
    const a = payload as Action;
    const next: TimelineState = {
      slots: [...state.slots],
      slotLabels: state.slotLabels ?? [],
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
    const full = state.slots.every((s) => s !== null);
    const graded = state.fragments.length > 0 && state.fragments.every((f) => f.slot >= 0);
    // 顺序对错只在拼满后才告诉玩家，且**不影响**完成判定——顺序错了照样能推进，
    // 否则一组人卡在这里就整晚过不去了。
    const ordered = full && graded
      ? state.slots.every((fid, i) => state.fragments.find((f) => f.fragId === fid)?.slot === i)
      : null;
    return {
      ordered,
      slots: state.slots.map((fragId) => {
        if (!fragId) return null;
        const f = state.fragments.find((x) => x.fragId === fragId)!;
        return { fragId: f.fragId, label: f.label, byMe: state.placedBy[fragId] === seatId };
      }),
      /** 每格的时间提示，空格也要显示，帮助玩家判断该放哪一段 */
      slotLabels: state.slotLabels ?? [],
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
