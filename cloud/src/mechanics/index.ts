/**
 * 机制注册表。引擎按 skeleton 声明的 id 加载，新增机制只需在此登记，
 * 无需改动引擎本体（阶段 5 的目的）。
 */

import { MechanicValidator } from "./types";
import { timelinePuzzle } from "./timeline_puzzle";

const registry: Record<string, MechanicValidator<any>> = {
  [timelinePuzzle.id]: timelinePuzzle,
};

export function getMechanic(id: string): MechanicValidator<any> | null {
  return registry[id] ?? null;
}

export * from "./types";
