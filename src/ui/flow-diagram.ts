/**
 * AgentLoop 流程图。
 *
 * 正确的层级结构（这是本文件的核心）：
 *
 *   SessionLoop（一个用户请求）
 *   └── AgentLoop（一个循环体，共享同一份意图与上下文）
 *        ├─ 迭代 1   构建请求 → 思考 → 工具 → 结果 → 判定「继续循环」
 *        ├─ 迭代 2   构建请求 → 思考 → 工具 → 结果 → 判定「继续循环」
 *        │    ⋮
 *        └─ 迭代 N   构建请求 → 思考 → 工具 → 结果 → 判定「收敛，结束」
 *
 * 之前错误地把每次模型往返画成并列的独立循环，每个都从「构建请求」开始，
 * 视觉上像跳过了构建请求 —— 实际是切分维度错了：turn 是 loop 的内部
 * 迭代，不是并列单元。实测单个用户请求内有 27 次往返，它们全属一个 loop。
 *
 * 展示策略（受终端高度限制）：
 *   - 始终画出 loop 的完整骨架（迭代链 + 回流箭头 + 出口结论）
 *   - 选中的那次迭代展开细节（思考 / 每个工具 / 结果）
 *   - 其余迭代压成一行摘要，保留「第几次、做了什么、是否出错」
 */
import type { AgentLoop, Segment, Step, Turn } from "../core/model.ts";
import { glyph, theme, toolColor } from "./theme.ts";
import { truncate, visibleWidth } from "./text.ts";
import { toolKindOf } from "../core/turns.ts";

/** 图上的可高亮节点，用于和时间轴联动。 */
export interface FlowNode {
  id: string;
  row: number;
  col: number;
  width: number;
  label: string;
}

export interface FlowDiagram {
  lines: string[];
  nodes: FlowNode[];
  active: string[];
  primary: string | null;
}

/** 选中项在循环里的位置。 */
export interface FlowFocus {
  /** 选中项落在哪个 turn（= 第几次迭代）。 */
  turnIndex: number;
  stepKey?: string;
  hasStep: boolean;
}

/**
 * 生成流程图。
 *
 * @param seg   选中项所属段
 * @param focus 选中的 turn / step
 * @param width 可用宽度
 */
export function buildFlowDiagram(seg: Segment, focus: FlowFocus, width: number): FlowDiagram {
  const loops = seg.loops ?? [];
  const turn = seg.turns.find((t) => t.index === focus.turnIndex);
  if (!turn || loops.length === 0) {
    return { lines: [], nodes: [], active: [], primary: null };
  }

  // 找到这个 turn 所属的 loop 与它的迭代序号
  const loop = loops.find((l) => l.turns.some((t) => t.index === focus.turnIndex));
  if (!loop) return { lines: [], nodes: [], active: [], primary: null };
  const iterIdx = loop.turns.findIndex((t) => t.index === focus.turnIndex);

  const lines: string[] = [];
  const nodes: FlowNode[] = [];
  const active: string[] = [];

  const add = (id: string, label: string, indent: number, text: string): number => {
    const row = lines.length;
    const prefix = " ".repeat(indent);
    lines.push(prefix + text);
    nodes.push({ id, row, col: visibleWidth(prefix), width: visibleWidth(text), label });
    // 统一在这里收集高亮：凡是渲染时带了「◀ 当前」标记的节点即为高亮节点。
    // 分散在各处手写 push 容易漏（之前就漏了，导致 active 只剩 loop）。
    if (text.includes("◀ 当前")) active.push(id);
    return row;
  };

  // ---------------------------------------------------------------------
  // 头部：Loop 汇总（回答「这个循环有多大、收敛了没有」）
  // ---------------------------------------------------------------------
  const reason = loopEndLabel(loop);
  const head =
    theme.accent(theme.bold(`AgentLoop`)) +
    theme.faint(`  ${loop.iterationCount} 次迭代 · ${loop.toolCallCount} 工具`) +
    (loop.errorCount > 0 ? theme.error(` · ${loop.errorCount} 失败`) : "") +
    "  " +
    reason;
  add("loop", "AgentLoop", 0, truncate(head, Math.max(20, width)));
  lines.push("");

  // ---------------------------------------------------------------------
  // 迭代链
  // ---------------------------------------------------------------------
  const detail = renderSelectedIteration(seg, turn, focus, iterIdx, loop, width, add, active);
  lines.push(...detail.lines);
  // ---------------------------------------------------------------------
  // 结尾：出口结论
  // ---------------------------------------------------------------------
  if (!detail.suppressedExit) {
    lines.push("");
    const exitId = "exit";
    const exitText =
      loop.converged
        ? theme.ok("■ 循环结束") + theme.faint("  模型不再需要工具，本次请求完成")
        : loop.endReason === "open"
          ? theme.warn("… 未收敛") + theme.faint("  会话在此中断（压缩/中断/未完成）")
          : theme.warn("… 异常结束") + theme.faint(`  ${loop.endReason}`);
    add(exitId, "出口", 0, truncate(exitText, Math.max(20, width)));
    if (!focus.hasStep) active.push(exitId);
  }

  if (active.length === 0) active.push("loop");

  // 统一兜底：任何一行都不许超过可用宽度（含缩进）。
  // 各处逐个算预算容易漏（曾出现 40 列下 60 列超宽），这里统一裁一刀。
  const safeLines = lines.map((l) => (visibleWidth(l) > width ? truncate(l, width, "") : l));

  return { lines: safeLines, nodes, active, primary: active[0] ?? null };
}

interface DetailResult {
  lines: string[];
  suppressedExit: boolean;
}

/**
 * 渲染「选中迭代的细节 + 迭代链」。
 *
 * 布局：把选中迭代前后各压一行，选中那行展开成
 *   构建请求 → 思考 → 工具 → 结果 → 判定
 */
function renderSelectedIteration(
  seg: Segment,
  turn: Turn,
  focus: FlowFocus,
  iterIdx: number,
  loop: AgentLoop,
  width: number,
  add: (id: string, label: string, indent: number, text: string) => number,
  active: string[],
): DetailResult {
  const lines: string[] = [];
  const budget = Math.max(6, width);

  const focusStep = focus.hasStep ? turn.steps.find((s) => s.key === focus.stepKey) : undefined;
  const isActive = (kinds: string[]): boolean =>
    Boolean(focusStep && kinds.includes(focusStep.kind));

  const thinking = turn.steps.filter((s) => s.kind === "thinking");
  const calls = turn.steps.filter((s) => s.kind === "tool_call");
  const compaction = turn.steps.find((s) => s.kind === "compaction");
  const asks = turn.steps.filter((s) => s.kind === "ask");
  const texts = turn.steps.filter((s) => s.kind === "text");
  const errored = turn.steps.filter((s) => s.isError);

  // ---- 前序迭代压成一行 ----
  if (iterIdx > 0) {
    const prev = loop.turns.slice(0, iterIdx);
    const compact = compressIterations(prev, budget);
    lines.push(theme.faint(`  ↑ 前 ${prev.length} 次迭代：${compact}`));
    lines.push(theme.border("  │"));
  }

  // ---- 当前迭代：完整五阶段 ----
  const iterBadge = theme.accentStrong(theme.bold(`迭代 ${iterIdx + 1}`));
  add(
    "iter",
    `迭代${iterIdx + 1}`,
    0,
    truncate(
      iterBadge +
        theme.faint(` / 共 ${loop.iterationCount}`) +
        (turn.contextTokens ? theme.faint(`  ${fmtK(turn.contextTokens)} ctx`) : "") +
        (turn.durationMs ? theme.faint(`  ${turn.durationMs}ms`) : "") +
        // 只选中了迭代（没选具体 step）→ 高亮这一行
        (!focus.hasStep ? "  " + theme.accentStrong("◀ 当前") : ""),
      budget,
    ),
  );

  // ① 构建请求
  add(
    "request",
    "构建请求",
    0,
    theme.muted("① 构建请求") +
      theme.faint(
        `  system + 上下文 ${turn.contextTokens ? fmtK(turn.contextTokens) : "?"} + 工具`,
      ),
  );
  lines.push(theme.border("  │"));

  // ② 思考
  const thinkOn = isActive(["thinking"]);
  add(
    "thinking",
    "思考",
    0,
    (thinkOn ? theme.purple(theme.bold("② 思考")) : theme.muted("② 思考")) +
      (thinking.length > 0
        ? theme.faint(`  ${thinking.length} 段 · ${sumTok(thinking)}tok`)
        : theme.faint("  （无思考）")) +
      (thinkOn ? "  " + theme.accentStrong("◀ 当前") : ""),
  );
  lines.push(theme.border("  │"));

  // ③ 决定调用工具
  if (calls.length > 0) {
    add("tools", "决定调用工具", 0, theme.muted("③ 决定调用工具") + theme.faint(`  ${calls.length} 个`));
    calls.forEach((c, i) => {
      const on = isActive(["tool_call"]) && c.key === focusStep?.key;
      const name = c.tool ?? "?";
      const last = i === calls.length - 1;
      const head = theme.border(last ? "  └ " : "  ├ ") + "  ";
      const mark = on ? "  " + theme.accentStrong("◀ 当前") : "";
      // 预算要扣掉：缩进 6 + 连接线 4 + 标记 9
      const room = Math.max(4, width - 6 - 4 - visibleWidth(mark) - 2);
      add(
        `call:${c.key}`,
        `调用 ${name}`,
        6,
        theme.border(last ? "  └ " : "  ├ ") +
          (on ? theme.accentStrong(theme.bold(name)) : toolColor(toolKindOf(name))(name)) +
          theme.faint("  " + truncate(c.resultBrief ?? "", room)) +
          mark,
      );
    });
  } else {
    add("no-tools", "无工具", 0, theme.faint("③ 无工具调用（模型直接作答）"));
  }
  lines.push(theme.border("  │"));

  // ④ 执行工具
  if (calls.length > 0) {
    const resOn = isActive(["tool_result"]);
    add(
      "results",
      "执行工具",
      0,
      (resOn ? theme.accentStrong(theme.bold("④ 执行工具")) : theme.muted("④ 执行工具")) +
        theme.faint(`  ${calls.length} 个`) +
        (errored.length > 0 ? theme.error(`  ${errored.length} 失败`) : theme.ok("  ✓")) +
        (resOn ? "  " + theme.accentStrong("◀ 当前") : ""),
    );
    lines.push(theme.border("  │"));
  }

  // ⑤ 出口判定：这是 loop 的循环条件
  const exitKind = decideExit(turn);
  const shouldExitDev =
    focusStep?.kind === "text" || (focusStep?.kind === "thinking" && exitKind === "converge");
  const exitOn = isActive(["text"]) || shouldExitDev;
  add(
    "iterExit",
    "出口判定",
    0,
    (exitOn ? theme.accentStrong(theme.bold("⑤ 出口判定")) : theme.muted("⑤ 出口判定")) +
      "  " +
      exitLabel(exitKind) +
      (exitOn ? "  " + theme.accentStrong("◀ 当前") : ""),
  );

  // 文本输出 / 压缩 / 提问：作为出口分支列出
  for (const t of texts) {
    const on = isActive(["text"]) && t.key === focusStep?.key;
    add(
      `text:${t.key}`,
      "输出",
      4,
      theme.border("  ") +
        theme.ok(glyph.text) +
        " " +
        theme.dim(truncate((t.text ?? "").replace(/\s+/g, " "), Math.max(10, width - 18))) +
        (on ? "  " + theme.accentStrong("◀ 当前") : ""),
    );
  }
  if (compaction) {
    const on = focusStep?.kind === "compaction";
    add(
      "compaction",
      "压缩",
      4,
      theme.border("  ") +
        theme.compaction(glyph.compaction) +
        " " +
        theme.compaction("上下文压缩，循环在此中断") +
        (on ? "  " + theme.accentStrong("◀ 当前") : ""),
    );
  }
  for (const q of asks) {
    const on = isActive(["ask"]);
    add(
      `ask:${q.key}`,
      "提问",
      4,
      theme.border("  ") +
        theme.warn(glyph.ask) +
        " " +
        theme.warn("等待用户回答，循环暂停") +
        (on ? "  " + theme.accentStrong("◀ 当前") : ""),
    );
  }

  // 回流箭头：loop 未收敛时显示
  if (exitKind === "loop") {
    lines.push("");
    const nextIter = iterIdx + 1 < loop.iterationCount ? `迭代 ${iterIdx + 2}` : "下一轮";
    add(
      "backflow",
      "回流",
      0,
      truncate(
        theme.accent("  ↺ 回流") +
          (width > 52 ? theme.faint("  工具结果进入上下文 → 回到 ① 构建请求继续循环") : "") +
          theme.faint(`  → ${nextIter}`),
        budget,
      ),
    );
  }

  // ---- 后续迭代压成一行 ----
  if (iterIdx < loop.iterationCount - 1) {
    const rest = loop.turns.slice(iterIdx + 1);
    if (exitKind === "loop") lines.push(theme.faint(`  │ 后续 ${rest.length} 次迭代`));
    const compact = compressIterations(rest, budget);
    lines.push(theme.faint(`  ⋮ ${compact}`));
  }

  return { lines, suppressedExit: exitKind === "loop" };
}

/** 把一串迭代压成一行摘要：`工具A→工具B · 工具C→工具D`。 */
function compressIterations(turns: Turn[], budget: number): string {
  const parts: string[] = [];
  for (const t of turns) {
    const calls = t.steps.filter((s) => s.kind === "tool_call");
    const bad = t.steps.filter((s) => s.isError).length;
    const names = calls.map((c) => c.tool ?? "?").join("+");
    parts.push(names + (bad ? `✖${bad}` : ""));
  }
  const joined = parts.join(" → ");
  return truncate(joined || "(无工具)", Math.max(8, budget - 6), "…");
}

/** 判断一次迭代之后是否还要继续循环。 */
function decideExit(turn: Turn): "loop" | "converge" | "error" | "length" | "aborted" | "cut" {
  if (turn.stopReason === "length") return "length";
  if (turn.stopReason === "aborted") return "aborted";
  if (turn.stopReason === "error") return "error";
  const hasCall = turn.steps.some((s) => s.kind === "tool_call");
  if (turn.steps.some((s) => s.kind === "compaction")) return "cut";
  if (hasCall) return "loop";
  return "converge";
}

function exitLabel(k: ReturnType<typeof decideExit>): string {
  switch (k) {
    case "loop":
      return theme.accent(glyph.arrow + " 有工具结果 → 继续循环");
    case "converge":
      return theme.ok(glyph.ok + " 模型给出结论 → 循环结束");
    case "error":
      return theme.error(glyph.error + " 模型调用失败");
    case "length":
      return theme.warn(glyph.warn + " 输出被 length 截断");
    case "aborted":
      return theme.warn(glyph.warn + " 用户中断");
    case "cut":
      return theme.compaction(glyph.compaction + " 压缩打断，循环未完成");
  }
}

function loopEndLabel(loop: AgentLoop): string {
  switch (loop.endReason) {
    case "converge":
      return theme.ok(glyph.ok + " 已收敛");
    case "open":
      return theme.warn(glyph.warn + " 未收敛");
    case "length":
      return theme.warn(glyph.warn + " 截断");
    case "aborted":
      return theme.warn(glyph.warn + " 中断");
    case "error":
      return theme.error(glyph.error + " 失败");
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

