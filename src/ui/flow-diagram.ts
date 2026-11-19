/**
 * AgentLoop 循环流程图。
 *
 * 为什么需要一张图：时间轴是「按时间排的清单」，能看清先后，但看不清
 * **循环结构** —— 用户最常问的是「它为什么又绕回来了 / 卡在第几步」，
 * 这需要看到 turn 内的闭环：模型思考 → 决策工具 → 执行 → 回填结果 →
 * 再思考，直到模型给出文本（收敛）或撞上错误/上限。
 *
 * pi 的真实循环（docs/how-pi-works.md）：
 *   构建请求(system+分支+工具) → provider 流式响应 → 记录 assistant
 *   → 执行每个 toolCall → 记录 toolResult → 若还有工具结果需要下一轮
 *   就再请求，否则结束本次 run。
 *
 * 画法：左侧一列是循环体（思考 / 工具 / 结果），右侧是出口判定
 * （收敛 / 出错 / 压缩 / 截断），用 ↑ 回流箭头表示下一轮回到思考。
 *
 * 高亮联动：选中时间轴任意行 → 算出它落在哪个 turn、turn 内第几个动作 →
 * 把对应节点标记为 ◀ 当前。这样「选中一个过程，图上就亮起对应节点」。
 */
import type { Segment, Step, Turn } from "../core/model.ts";
import { glyph, theme, toolColor } from "./theme.ts";
import { padEnd, truncate, visibleWidth } from "./text.ts";
import { toolKindOf } from "../core/turns.ts";

/** 图上的一个可高亮节点。 */
export interface FlowNode {
  /** 节点稳定 id，用于和时间轴联动。 */
  id: string;
  /** 节点在图中占的行号（相对图顶）。 */
  row: number;
  /** 节点文本宽度起点（列）。 */
  col: number;
  /** 节点文本宽度。 */
  width: number;
  /** 节点标签，便于测试断言。 */
  label: string;
}

export interface FlowDiagram {
  /** 图的行（已着色，不含外部边框）。 */
  lines: string[];
  /** 图上所有可高亮节点。 */
  nodes: FlowNode[];
  /** 当前高亮的节点 id 列表（可能同 turn 多个，如调用 + 结果）。 */
  active: string[];
  /** 高亮的 node id（选中项直接对应的那个）。 */
  primary: string | null;
}

/** 从选中行反推「关心的 turn + 该 turn 内的 step」。 */
export interface FlowFocus {
  turnIndex: number;
  stepKey?: string;
  stepKind?: string;
  /** 只选中了 turn / 段时，没有具体 step。 */
  hasStep: boolean;
}

/**
 * 生成流程图。
 *
 * @param seg    选中项所属的分段
 * @param focus  选中的 turn / step
 * @param width  可用宽度
 */
export function buildFlowDiagram(seg: Segment, focus: FlowFocus, width: number): FlowDiagram {
  const turn = seg.turns.find((t) => t.index === focus.turnIndex);
  if (!turn) return { lines: [], nodes: [], active: [], primary: null };

  const lines: string[] = [];
  const nodes: FlowNode[] = [];

  // 本 turn 的各阶段是否发生
  const thinking = turn.steps.filter((s) => s.kind === "thinking");
  const calls = turn.steps.filter((s) => s.kind === "tool_call");
  const results = turn.steps.filter((s) => s.kind === "tool_result");
  const compaction = turn.steps.find((s) => s.kind === "compaction");
  const asks = turn.steps.filter((s) => s.kind === "ask");
  const texts = turn.steps.filter((s) => s.kind === "text");
  const errored = turn.steps.filter((s) => s.isError);

  // 当前聚焦的 step（可能为空，表示只选中了 turn）
  const focusStep = focus.hasStep
    ? turn.steps.find((s) => s.key === focus.stepKey)
    : undefined;

  /** 判断某阶段是否应高亮。 */
  const isActive = (kinds: string[]): boolean =>
    Boolean(focusStep && kinds.includes(focusStep.kind));

  const active: string[] = [];
  const addNode = (id: string, label: string, indent: number, text: string): number => {
    const row = lines.length;
    const prefix = " ".repeat(indent);
    lines.push(prefix + text);
    nodes.push({
      id,
      row,
      col: visibleWidth(prefix),
      width: visibleWidth(text),
      label,
    });
    return row;
  };

  const bar = (w: number): string => theme.border(glyph.hline.repeat(Math.max(0, w)));

  // ---- 头部：turn 概要 ----
  const ctxTxt = turn.contextTokens ? ` · ${fmtK(turn.contextTokens)} ctx` : "";
  const durTxt = turn.durationMs ? ` · ${turn.durationMs}ms` : "";
  const turnActive = !focus.hasStep;
  const turnMark = turnActive ? "  ◀ 当前轮" : "";
  const headBudget = Math.max(6, width - 2 - visibleWidth(turnMark) - 2);
  addNode(
    "turn",
    `T${turn.index + 1}`,
    0,
    theme.accent(theme.bold(`T${turn.index + 1}`)) +
      theme.faint(truncate(` ${turn.model ?? "?"}${ctxTxt}${durTxt}`, headBudget)) +
      (turnMark ? "  " + theme.accentStrong(turnMark.trim()) : ""),
  );
  lines.push("");

  // ---- 阶段 1：构建请求 ----
  const row1 = addNode(
    "request",
    "构建请求",
    0,
    theme.muted("① 构建请求") +
      theme.faint(`  system + 分支 ${turn.steps.length} 步 + 工具`),
  );
  lines.push(" ".repeat(0) + theme.border("  │"));

  // ---- 阶段 2：思考 ----
  const thinkActive = isActive(["thinking"]);
  const thinkMark = thinkActive ? theme.purple("◀ 当前") : "";
  const row2 = addNode(
    "thinking",
    "思考",
    0,
    (thinkActive ? theme.purple(theme.bold("② 思考")) : theme.muted("② 思考")) +
      (thinking.length > 0
        ? theme.faint(`  ${thinking.length} 段 · ${sumTok(thinking)}tok`)
        : theme.faint("  （无思考）")) +
      (thinkMark ? "  " + thinkMark : ""),
  );
  if (thinkActive) markRow(lines, row2, "thinking");
  lines.push(theme.border("  │"));

  // ---- 阶段 3：工具决策 ----
  if (calls.length > 0) {
    lines.push(theme.border("  ├─ ") + theme.muted("③ 决定调用工具"));
    calls.forEach((c, i) => {
      const on = isActive(["tool_call"]) && c.key === focusStep?.key;
      const c2 = on ? theme.accentStrong : theme.muted;
      const name = c.tool ?? "?";
      const briefLen = Math.max(6, Math.min(30, width - 34 - (on ? 9 : 0)));
      const brief = c.resultBrief ? theme.faint("  " + truncate(c.resultBrief, briefLen)) : "";
      const mark = on ? "  " + theme.accentStrong("◀ 当前") : "";
      addNode(
        `call:${c.key}`,
        `调用 ${name}`,
        i === calls.length - 1 ? 6 : 6,
        theme.border(i === calls.length - 1 ? "└ " : "├ ") +
          (on ? c2(theme.bold(name)) : toolColor(toolKindOf(name))(name)) +
          brief +
          mark,
      );
    });
  } else {
    addNode("no-tools", "无工具", 0, theme.faint("③ 本轮无工具调用"));
  }
  lines.push(theme.border("  │"));

  // ---- 阶段 4：执行结果 ----
  if (results.length > 0 || calls.length > 0) {
    const errN = errored.length;
    const on = isActive(["tool_result"]);
    addNode(
      "results",
      "执行结果",
      0,
      (on ? theme.accentStrong(theme.bold("④ 执行工具")) : theme.muted("④ 执行工具")) +
        theme.faint(`  ${calls.length} 个`) +
        (errN > 0 ? theme.error(`  ${errN} 报错`) : theme.ok("  ✓")) +
        (on ? "  " + theme.accentStrong("◀ 当前") : ""),
    );
    // 逐条结果（错误要单独亮出来）
    const resLen = Math.max(8, Math.min(40, width - 22 - (isActive(["tool_result"]) ? 9 : 0)));
    for (const r of results) {
      const onR = isActive(["tool_result"]) && r.key === focusStep?.key;
      const bad = r.isError;
      const icon = bad ? theme.error(glyph.error) : theme.ok(glyph.ok);
      addNode(
        `result:${r.key}`,
        `结果 ${r.tool ?? ""}`,
        4,
        theme.border("  ") +
          icon +
          " " +
          (bad
            ? theme.error(truncate(r.resultBrief ?? "", resLen))
            : theme.faint(truncate(r.resultBrief ?? "", resLen))) +
          (onR ? "  " + theme.accentStrong("◀ 当前") : ""),
      );
    }
  }
  lines.push(theme.border("  │"));

  // ---- 阶段 5：出口判定 ----
  const exitKind = decideExit(turn);
  const exitOn = isActive(["text", "compaction"]) ||
    (!focus.hasStep && exitKind.kind !== "loop");
  addNode(
    "exit",
    "出口判定",
    0,
    (exitOn ? theme.accentStrong(theme.bold("⑤ 出口判定")) : theme.muted("⑤ 出口判定")) +
      "  " +
      exitLabel(exitKind) +
      (exitOn ? "  " + theme.accentStrong("◀ 当前") : ""),
  );

  // 文本输出（收敛出口）
  if (texts.length > 0) {
    for (const t of texts) {
      const on = isActive(["text"]) && t.key === focusStep?.key;
      addNode(
        `text:${t.key}`,
        "输出",
        4,
        theme.border("  ") +
          theme.ok(glyph.text) +
          " " +
          theme.dim(truncate((t.text ?? "").replace(/\s+/g, " "), Math.max(10, width - 18 - (on ? 9 : 0)))) +
          (on ? "  " + theme.accentStrong("◀ 当前") : ""),
      );
    }
  }
  if (compaction) {
    const on = focusStep?.kind === "compaction";
    addNode(
      "compaction",
      "压缩",
      4,
      theme.border("  ") +
        theme.compaction(glyph.compaction) +
        " " +
        theme.compaction("上下文压缩，下一轮从摘要开始") +
        (on ? "  " + theme.accentStrong("◀ 当前") : ""),
    );
  }
  if (asks.length > 0) {
    for (const q of asks) {
      const on = isActive(["ask"]);
      addNode(
        `ask:${q.key}`,
        "提问",
        4,
        theme.border("  ") +
          theme.warn(glyph.ask) +
          " " +
          theme.warn("等待用户回答（循环暂停）") +
          (on ? "  " + theme.accentStrong("◀ 当前") : ""),
      );
    }
  }

  // ---- 回流箭头 ----
  lines.push("");
  if (exitKind.kind === "loop") {
    const nextT = seg.turns.find((t) => t.index === turn.index + 1);
    lines.push(
      theme.accent("  ↑ 回流") +
        (width > 56 ? theme.faint("  工具结果进入上下文 → 回到 ② 思考（下一轮）") : "") +
        (nextT ? theme.faint(`  → T${nextT.index + 1}`) : ""),
    );
  } else {
    lines.push(theme.ok("  ■ 结束") + (width > 50 ? theme.faint("  本次 run 收敛，不再发起新请求") : ""));
  }

  // 记录实际高亮的 id
  for (const n of nodes) {
    if (focus.hasStep && focus.stepKey) {
      if (n.id === `call:${focus.stepKey}` || n.id === `result:${focus.stepKey}` ||
          n.id === `text:${focus.stepKey}` || n.id === `ask:${focus.stepKey}` ||
          (focusStep?.kind === "compaction" && n.id === "compaction")) {
        active.push(n.id);
      }
    }
  }
  if (active.length === 0) {
    if (focusStep?.kind === "thinking") active.push("thinking");
    else if (focusStep?.kind === "tool_call") active.push("results");
    else if (focusStep?.kind === "tool_result") active.push("results");
    else if (focusStep?.kind === "text") active.push("exit");
    else if (focusStep?.kind === "compaction") active.push("compaction");
    else active.push("turn");
  }

  return {
    lines,
    nodes,
    active,
    primary: active[0] ?? null,
  };
}

/** 用高亮条标记整行（选中节点的行加背景）。 */
function markRow(lines: string[], row: number, _id: string): void {
  const l = lines[row];
  if (l !== undefined) lines[row] = theme.selBg(padEnd(l, visibleWidth(l) + 2));
}

// ---------------------------------------------------------------------------

type ExitKind = "loop" | "converge" | "error" | "length" | "aborted";

function decideExit(turn: Turn): { kind: ExitKind; reason: string } {
  if (turn.stopReason === "length") return { kind: "length", reason: "" };
  if (turn.stopReason === "aborted") return { kind: "aborted", reason: "" };
  if (turn.stopReason === "error") return { kind: "error", reason: "" };
  const hasCall = turn.steps.some((s) => s.kind === "tool_call");
  if (hasCall) {
    if (turn.steps.some((s) => s.kind === "ask")) return { kind: "loop", reason: "wait" };
    return { kind: "loop", reason: "" };
  }
  return { kind: "converge", reason: "" };
}

function exitLabel(e: { kind: ExitKind; reason: string }): string {
  switch (e.kind) {
    case "loop":
      return theme.accent(glyph.arrow + " 有工具结果 → 再来一轮");
    case "converge":
      return theme.ok(glyph.ok + " 模型给出文本 → 本轮结束");
    case "error":
      return theme.error(glyph.error + " 模型调用失败");
    case "length":
      return theme.warn(glyph.warn + " 输出被 length 截断");
    case "aborted":
      return theme.warn(glyph.warn + " 用户中断");
  }
}

function sumTok(steps: Step[]): number {
  return steps.reduce((a, s) => a + (s.approxTokens ?? 0), 0);
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
