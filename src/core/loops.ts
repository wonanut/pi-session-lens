/**
 * 把 turn 归组成 agent loop。
 *
 * 为什么需要这一层：
 *
 * pi 的一次用户请求内部，模型会反复「思考 → 调工具 → 拿结果 → 再思考」。
 * 真实数据里单个请求内有 27 次模型往返、47 次工具调用。这些往返共享
 * 同一份用户意图和同一段上下文，**属于同一个 agent loop 的不同迭代**。
 *
 * 之前把每次往返当成并列的 turn，导致流程图上每个 T 都从「①构建请求」
 * 开始，看起来像跳过了构建请求 —— 实际是切分维度错了：turn 是 loop 的
 * 内部迭代，不是并列的独立单元。
 *
 * 归组规则：
 *   - 一个 turn 结束后如果还有工具调用（stopReason=toolUse），
 *     说明模型要再来一轮 → 同属当前 loop
 *   - turn 给出最终文本 / 正常结束 / 出错 / 被中断 → loop 收口
 *   - 遇到 ask_user 打断：loop 暂停，用户回答后继续算同一个 loop
 *     （实测数据结构里 ask 的答案是 toolResult，紧跟在 toolCall 之后，
 *      所以天然还在同一个 turn 序列里）
 */
import type { AgentLoop, Segment, Turn } from "./model.ts";

/** 判断一个 turn 之后是否还需要继续循环。 */
function needsAnotherIteration(turn: Turn): boolean {
  const hasToolCall = turn.steps.some((s) => s.kind === "tool_call");
  if (!hasToolCall) return false; // 没调工具 → 模型已给出结论
  if (turn.stopReason === "length") return false;
  if (turn.stopReason === "aborted") return false;
  if (turn.stopReason === "error") return false;
  // 有工具调用且正常结束 → 工具结果还要交给模型，继续循环
  return true;
}

/** 一个 turn 的结束原因。 */
function endReasonOf(turn: Turn): AgentLoop["endReason"] {
  if (turn.stopReason === "length") return "length";
  if (turn.stopReason === "aborted") return "aborted";
  if (turn.stopReason === "error") return "error";
  if (needsAnotherIteration(turn)) return "open";
  return "converge";
}

/**
 * 把一个段内的 turn 序列切成 agent loop。
 *
 * @param turns       段内所有 turn（已按时间排序）
 * @param segmentIndex 所属段序号
 * @param prompt      该段对应的用户意图
 */
export function buildAgentLoops(
  turns: Turn[],
  segmentIndex: number,
  prompt: string,
): AgentLoop[] {
  const loops: AgentLoop[] = [];
  if (turns.length === 0) return loops;

  let current: Turn[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    const reason = endReasonOf(last);
    const toolCalls = current.reduce(
      (a, t) => a + t.steps.filter((s) => s.kind === "tool_call").length,
      0,
    );
    const errors = current.reduce(
      (a, t) => a + t.steps.filter((s) => s.isError).length,
      0,
    );
    loops.push({
      index: loops.length,
      segmentIndex,
      prompt,
      startAt: first.startAt,
      endAt: last.endAt,
      offsetMs: first.offsetMs,
      turns: current,
      iterationCount: current.length,
      converged: reason === "converge",
      endReason: reason,
      toolCallCount: toolCalls,
      errorCount: errors,
    });
    current = [];
  };

  for (const turn of turns) {
    current.push(turn);
    // 这个 turn 不再需要下一次迭代 → 循环收口
    if (!needsAnotherIteration(turn)) flush();
  }
  // 尾部的 turn 都还在「待续」状态（会话被截断/仍在跑）
  flush();

  return loops;
}

/** 给段补上 loops（供 segments.ts 调用）。 */
export function attachLoops(segment: Segment): Segment {
  segment.loops = buildAgentLoops(segment.turns, segment.index, segment.prompt);
  return segment;
}
