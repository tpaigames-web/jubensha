/**
 * 可插拔机制组件框架（阶段 5）。
 *
 * 约定（对应说明书 8.2）：
 *   服务端 validator 必须实现 init / onAction / projectFor / isComplete
 *   前端组件只渲染服务端投影下来的 state，自身不做任何权限判断
 *
 * 引擎按 skeleton 里声明的 mechanic id 加载对应 validator，
 * 参数原样透传，引擎不理解机制内部语义。
 */

export interface MechanicSeat {
  seatId: string;
  characterId: string | null;
}

export interface MechanicEvent {
  /** 广播给全体的提示（可选） */
  narrationText?: string;
  /** 仅推给某席位 */
  toSeatId?: string;
  payload?: unknown;
}

export interface MechanicResult<S> {
  nextState: S;
  events: MechanicEvent[];
  /** 非法操作时给出原因，引擎据此回错误给操作者 */
  reject?: string;
}

export interface MechanicValidator<S = unknown> {
  id: string;
  init(params: Record<string, unknown>, seats: MechanicSeat[]): S;
  onAction(state: S, seatId: string, payload: unknown): MechanicResult<S>;
  /** 按席位视角过滤：他无权看到的部分必须在这里剥掉 */
  projectFor(state: S, seatId: string): unknown;
  /** 是否完成，用于参与幕推进判定 */
  isComplete(state: S): boolean;
}
