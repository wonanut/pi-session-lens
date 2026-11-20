/**
 * 视图二：两层循环时间轴。
 *
 * 这是本项目的主视图。三层缩进直接对应两层循环：
 *
 *   ▣ SessionLoop  #3  18:22  «用户需求»
 *     ├─ AgentLoop #12  deepseek  12.4k ctx  4 步
 *     │    ◇ 思考   「先查知识库…」
 *     │    ▸ mml_knowledge_search  hits:10   230ms
 *     │    ▪ 输出   「已生成 18 条命令」
 *     └─ AgentLoop #13  …已完成
 *
 * 为什么用缩进而不是分屏：定位问题时人是「顺着时间往下看」的，
 * 分屏会打断这个顺序；缩进能在一屏里同时看到层级和先后。
 */
import type { AppState, TimelineRow } from "./state.ts";
import type { AgentLoop, Issue, Segment, Step, Turn } from "../core/model.ts";
import { buildTimelineRows, countHidden, rowKey, visibleRows } from "./state.ts";
import { buildFlowDiagram } from "./flow-diagram.ts";
import { drawPanel, divider, Viewport } from "./render.ts";
import { fmtDuration, fmtTimeSec, fmtTokens, padEnd, padStart, truncate, visibleWidth, wrap } from "./text.ts";
import { glyph, severityColor, theme, toolColor } from "./theme.ts";
import { toolKindOf } from "../core/turns.ts";

/** 行首缩进：段 0 / turn 2 / step 4。 */
function indentOf(depth: number): string {
  // 0=段 1=loop 2=迭代 3=step，每层缩进 2 列
  return " ".repeat(Math.max(0, depth) * 2);
}

/** 连接线：按层级画树。 */
function connector(row: TimelineRow, isLast: boolean): string {
  if (row.depth === 0) return "";
  // 每一层用 2 列：父层留竖线，本层画 ├/└
  const guides = "  ".repeat(Math.max(0, row.depth - 1));
  const branch = isLast ? glyph.corner : glyph.tee;
  return theme.border(guides + branch + " ");
}

export function renderTimeline(state: AppState): string[] {
  const { width, height } = state;
  const a = state.analysis;
  if (!a) return renderEmpty(state);

  // 左侧时间轴 | 右侧详情
  const leftW = Math.max(48, Math.min(Math.floor(width * 0.58), width - 40));
  const rightW = width - leftW - 1;
  const bodyH = Math.max(3, height - 1);

  const left = renderTimelinePanel(state, a, leftW, bodyH);
  const right = renderDetailPanel(state, a, rightW, bodyH);

  // 拼接：左边 leftW 列 + 1 空格 + 右边
  const out: string[] = [];
  for (let i = 0; i < bodyH; i++) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    out.push(padEnd(l, leftW) + " " + r);
  }
  out.push(renderFooterLine(state));
  return out;
}

function renderEmpty(state: AppState): string[] {
  const lines = [""];
  if (state.loading) {
    lines.push(theme.info("  正在解析会话…"));
  } else if (state.loadError) {
    lines.push(theme.error("  解析失败: " + state.loadError));
  } else {
    lines.push(theme.muted("  没有选中会话"));
  }
  while (lines.length < state.height - 1) lines.push("");
  lines.push(renderFooterLine(state));
  return lines;
}

// ---------------------------------------------------------------------------
// 左侧：时间轴
// ---------------------------------------------------------------------------

function renderTimelinePanel(
  state: AppState,
  a: { segments: Segment[]; issues: Issue[] },
  width: number,
  height: number,
): string[] {
  // 折叠：渲染只看可见行，光标索引也基于可见行
  const rows = visibleRows(state.timelineRows, state.collapsed);
  const bodyH = height - 2;
  const vp = new Viewport();
  vp.cursor = state.timelineCursor;
  vp.offset = state.timelineOffset;
  vp.sync(rows.length, bodyH);
  state.timelineCursor = vp.cursor;
  state.timelineOffset = vp.offset;

  const [from, to] = vp.window(rows.length, bodyH);
  const innerW = width - 2;
  const body: string[] = [];

  for (let i = from; i < to; i++) {
    const row = rows[i];
    if (!row) continue;
    const next = rows[i + 1];
    // 同级里是否为最后一个：下一个行缩进更浅或已到末尾
    const isLast = !next || next.depth < row.depth;
    body.push(renderRow(state, row, innerW, i === vp.cursor, rows[i + 1], isLast));
  }

  const seg = a.segments.length;
  const hint = `${vp.cursor + 1}/${rows.length} · ${seg} 段`;

  const lines = drawPanel(
    { x: 0, y: 0, width, height },
    "SessionLoop ▸ AgentLoop",
    hint,
    body,
    true,
  );
  return lines.slice(0, height);
}

/** 渲染单行时间轴。 */
function renderRow(
  state: AppState,
  row: TimelineRow,
  width: number,
  selected: boolean,
  next: TimelineRow | undefined,
  isLast: boolean,
): string {
  const a = state.analysis;
  if (!a) return "";
  const seg = a.segments[row.segmentIndex];
  if (!seg) return "";

  // 行首固定占 2 列（光标 + 空格 / 两个空格），内容预算在此统一扣除
  const lead = 2;
  const contentW = Math.max(4, width - lead);
  let content = "";
  if (row.kind === "segment") {
    content = renderSegmentHeader(seg, contentW);
  } else if (row.kind === "loop") {
    const loop = (seg.loops ?? []).find((l) => l.index === row.loopIndex);
    if (loop) content = renderLoopLine(loop, row, isLast, contentW);
  } else if (row.kind === "turn") {
    const turn = seg.turns.find((t) => t.index === row.turnIndex);
    if (turn) content = renderTurnLine(turn, row, isLast, contentW);
  } else if (row.kind === "step" && row.stepKey) {
    const step = findStep(seg, row.stepKey);
    if (step) content = renderStepLine(step, row, isLast, contentW);
  }

  const clipped = visibleWidth(content) > contentW ? truncate(content, contentW, "") : content;

  // 折叠标记：可折叠的行前面加 ▾/▸，折叠时附上「藏了多少行」。
  // 选中态的行也保留折叠标记（用光标代替 ▾，但仍显示隐藏计数），
  // 否则选中时就看不到自己折叠了多少。
  const key = rowKey(row);
  const collapsible = key !== null;
  const isCollapsed = collapsible && state.collapsed.has(key!);
  let hiddenNote = "";
  if (collapsible && isCollapsed) {
    const n = countHidden(state.timelineRows, key!);
    if (n > 0) hiddenNote = theme.warn(`  ⋯${n}`);
  }

  const marker = selected
    ? theme.accentStrong(glyph.cursor) + " "
    : collapsible
      ? isCollapsed
        ? theme.warn("▸ ")
        : theme.faint("▾ ")
      : "  ";

  const text = padEnd(truncate(clipped, contentW - 2, "") + hiddenNote, contentW - 2);
  const line = marker + text;
  return selected ? theme.selBg(padEnd(line, width)) : padEnd(line, width);
}

/**
 * 渲染 loop 行（第三层）。
 *
 * 这一行是之前缺失的层级：它让「一个用户请求 = 一个循环体」变得可见，
 * 下面的 T1/T2/... 是循环内部的迭代，而不是并列的独立单元。
 */
function renderLoopLine(
  loop: AgentLoop,
  row: TimelineRow,
  isLast: boolean,
  width: number,
): string {
  const conn = connector(row, isLast);
  const badge = theme.accentStrong(theme.bold(`↻ LOOP ${loop.index + 1}`));
  const stat =
    theme.faint(`  ${loop.iterationCount} 次迭代`) +
    theme.faint(` · ${loop.toolCallCount} 工具`) +
    (loop.errorCount > 0 ? theme.error(` · ${loop.errorCount} 失败`) : "");
  const end = loop.converged
    ? theme.ok(`  ${glyph.ok}已收敛`)
    : theme.warn(`  ${glyph.warn}未收敛`);

  const line = conn + badge + stat + end;
  return visibleWidth(line) > width ? truncate(line, width, "") : line;
}

function renderSegmentHeader(seg: Segment, width: number): string {
  const badgeTxt = ` SEG ${seg.index + 1} `;
  const badge = theme.compaction(theme.bold(badgeTxt));
  const time = theme.faint(fmtTimeSec(seg.startAt).slice(6));
  const stats =
    theme.faint(`  ${seg.turnCount}轮 · ${seg.toolCallCount}工具`) +
    (seg.errorCount > 0 ? theme.error(`  ${seg.errorCount}错`) : "") +
    (seg.askCount > 0 ? theme.warn(`  ${seg.askCount}问`) : "");

  const compMark = seg.afterCompaction ? theme.compaction(" " + glyph.compaction + "压缩后") : "";

  const promptRaw = seg.prompt.replace(/\s+/g, " ");
  const used = visibleWidth(badgeTxt) + 1 + 8 + visibleWidth(stats) + 20;
  const avail = Math.max(10, width - used);
  const prompt = truncate(promptRaw, avail);
  const promptSt = seg.afterCompaction ? theme.bright(prompt) : theme.white(theme.bold(prompt));

  return badge + " " + time + compMark + "  " + promptSt + stats;
}

function renderTurnLine(
  turn: Turn,
  row: TimelineRow,
  isLast: boolean,
  _width: number,
): string {
  const conn = connector(row, isLast);
  const badgeTxt = ` ▸${turn.index + 1} `;
  const badge = turn.hasError ? theme.error(theme.bold(badgeTxt)) : theme.accent(badgeTxt);
  const model = turn.model ? theme.muted(turn.model.replace(/^deepseek-/, "ds-")) : "";
  const ctx = turn.contextTokens
    ? theme.faint(`${fmtTokens(turn.contextTokens)} ctx`)
    : "";
  const dur = turn.durationMs ? theme.faint(fmtDuration(turn.durationMs)) : "";
  const nSteps = turn.steps.length;
  const stepsTxt = theme.faint(`${nSteps}步`);
  const stop = turn.stopReason && turn.stopReason !== "toolUse" && turn.stopReason !== "stop"
    ? theme.warn(` ${turn.stopReason}`)
    : "";

  const parts = [badge, model, ctx, dur, stepsTxt].filter(Boolean).join(theme.faint(" · "));
  return conn + parts + stop;
}

function renderStepLine(
  step: Step,
  row: TimelineRow,
  isLast: boolean,
  width: number,
): string {
  const conn = connector(row, isLast);
  const hasIssue = step.issueIndexes && step.issueIndexes.length > 0;

  let icon = "";
  let main = "";
  let tail = "";

  switch (step.kind) {
    case "compaction": {
      icon = theme.compaction(glyph.compaction);
      main = theme.compaction("上下文压缩");
      tail = theme.faint(`约 ${fmtTokens(step.approxTokens ?? 0)} 摘要`);
      break;
    }
    case "thinking": {
      icon = theme.purple(glyph.thinking);
      const first = (step.text ?? "").split("\n").find((l) => l.trim()) ?? "";
      main = theme.muted("思考") + " " + theme.dim(truncate(first, Math.max(10, width - 32)));
      tail = fmtTokens(step.approxTokens ?? 0) + "tok";
      break;
    }
    case "tool_call": {
      const kind = toolKindOf(step.tool ?? "");
      const c = toolColor(kind);
      // 只有「需干预的失败」才标红。查无此命令 / 步骤核对是正常业务结论，
      // 用灰色问号区分，避免把有效检索结果看成故障。
      const notFound = step.outcome === "not_found";
      const stepGap = step.outcome === "step_gap";
      icon = step.isError
        ? theme.error(glyph.error)
        : notFound
          ? theme.faint(glyph.ask)
          : stepGap
            ? theme.info(glyph.dot)
            : c(glyph.tool);
      main = c(step.tool ?? "?") + theme.faint("  " + truncate(step.resultBrief ?? "", Math.max(8, width - 40)));
      tail =
        (step.durationMs ? theme.faint(fmtDuration(step.durationMs)) : "") +
        (step.isError ? theme.error(" 失败") : "");
      break;
    }
    case "tool_result": {
      icon = step.isError ? theme.error(glyph.error) : theme.faint(glyph.tool);
      main = theme.muted((step.tool ?? "?") + " 结果") + theme.faint(" " + truncate(step.resultBrief ?? "", 40));
      break;
    }
    case "text": {
      icon = theme.ok(glyph.text);
      const first = (step.text ?? "").split("\n").find((l) => l.trim()) ?? "";
      main = theme.ok("输出") + " " + theme.dim(truncate(first, Math.max(10, width - 32)));
      tail = fmtTokens(step.approxTokens ?? 0) + "tok";
      break;
    }
    case "ask": {
      icon = theme.warn(glyph.ask);
      main = theme.warn("提问") + " " + theme.dim(truncate((step.text ?? "").replace(/\s+/g, " "), Math.max(10, width - 32)));
      break;
    }
    case "answer": {
      icon = theme.info(glyph.answer);
      main = theme.info("用户答") + " " + theme.dim(truncate((step.text ?? "").replace(/\s+/g, " "), Math.max(10, width - 32)));
      break;
    }
    case "error": {
      icon = theme.error(glyph.error);
      main = theme.error((step.tool ?? "") + " 报错");
      break;
    }
    default: {
      icon = theme.muted(glyph.dot);
      main = theme.muted(String(step.kind));
    }
  }

  // width 已是「内容可用宽度」（renderRow 已扣掉行首），直接用
  const usable = Math.max(6, width);
  const prefix = conn + icon + " ";
  const tailStr = tail ? theme.faint(tail) : "";
  const tailW = tailStr ? visibleWidth(tailStr) + 2 : 0;
  const prefixW = visibleWidth(prefix);
  const avail = Math.max(6, usable - prefixW - tailW);
  // main 可能已带 ANSI；先按可见宽度截断到 avail
  const mainClipped = truncate(main, avail);
  const used = prefixW + visibleWidth(mainClipped);
  const gap = tailStr ? Math.max(1, usable - used - visibleWidth(tailStr)) : 0;
  const line = prefix + mainClipped + (tailStr ? " ".repeat(gap) + tailStr : "");
  // 兜底：任何情况下都不能超过可用宽度
  return visibleWidth(line) > usable ? truncate(line, usable, "") : line;
}

function findStep(seg: Segment, key: string): Step | null {
  for (const t of seg.turns) {
    for (const s of t.steps) if (s.key === key) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 右侧：详情
// ---------------------------------------------------------------------------

function renderDetailPanel(
  state: AppState,
  a: { segments: Segment[]; issues: Issue[]; totals: Record<string, number>; health: number; notes: string[]; toolHistogram: { tool: string; count: number; errors: number }[]; session: { path: string; cwd: string; startedAt: string; endedAt: string; bytes: number } },
  width: number,
  height: number,
): string[] {
  const visible = visibleRows(state.timelineRows, state.collapsed);
  const row = visible[state.timelineCursor];
  const innerW = width - 2;
  let body: string[] = [];
  let title = "详情";

  if (!row) {
    body = detailOverview(state, a, innerW);
    title = "概览";
  } else if (row.kind === "segment") {
    const seg = a.segments[row.segmentIndex];
    if (seg) {
      body = detailSegment(seg, innerW);
      title = `段落 ${seg.index + 1}`;
    }
  } else if (row.kind === "turn") {
    const seg = a.segments[row.segmentIndex];
    const turn = seg?.turns.find((t) => t.index === row.turnIndex);
    if (turn) {
      body = detailTurn(turn, innerW);
      // 用「迭代」而非 T，与 loop 内部迭代的语义保持一致
      const loopIdx = (seg?.loops ?? []).findIndex((l) => l.turns.some((t) => t.index === turn.index));
      const iterNo = loopIdx >= 0 ? (seg.loops[loopIdx]!.turns.findIndex((t) => t.index === turn.index) + 1) : 0;
      title = iterNo > 0 ? `迭代 ${iterNo}` : `迭代`;
    }
  } else if (row.kind === "step" && row.stepKey) {
    const seg = a.segments[row.segmentIndex];
    const step = seg ? findStep(seg, row.stepKey) : null;
    if (step) {
      body = detailStep(step, a.issues, innerW);
      title = stepTitle(step);
    }
  }

  // 上半：AgentLoop 流程图（跟随选中项高亮）；下半：该项详细内容
  const flow = renderFlowBlock(state, a, row, innerW);
  const flowH = flow.lines.length;
  const detailH = Math.max(3, height - 2 - flowH - (flowH > 0 ? 1 : 0));

  const maxOff = Math.max(0, body.length - detailH);
  state.detailOffset = Math.min(Math.max(0, state.detailOffset), maxOff);
  const shown = body.slice(state.detailOffset, state.detailOffset + detailH);

  const hint = body.length > detailH
    ? `${state.detailOffset + 1}-${Math.min(body.length, state.detailOffset + detailH)}/${body.length}`
    : "";

  const lines = drawPanel({ x: 0, y: 0, width, height }, title, hint, [], false);

  // 手动填充内容区：流程图 + 分隔线 + 详情
  const contentLines: string[] = [];
  if (flowH > 0) {
    contentLines.push(...flow.lines);
    contentLines.push(theme.border("─".repeat(innerW)));
  }
  contentLines.push(...shown);

  const borderStyle = theme.border;
  for (let i = 0; i < height - 2; i++) {
    const raw = contentLines[i] ?? "";
    const t = truncate(raw, innerW, "");
    lines[i + 1] = borderStyle("│") + padEnd(t, innerW) + borderStyle("│");
  }
  // 兜底：内容超宽时逐行压回面板宽度（流程图在窄屏下可能挤爆）
  const maxW = width;
  return lines.map((l) => (visibleWidth(l) > maxW ? truncate(l, maxW, "") : l)).slice(0, height);
}

/**
 * 生成流程图区块。
 *
 * 选中段（segment）时不在本段内定位 turn，改为显示该段第一轮的循环结构 ——
 * 段的粒度本身不落在循环体里，但它下面的 turn 一定是循环。
 */
function renderFlowBlock(
  state: AppState,
  a: { segments: Segment[] },
  row: AppState["timelineRows"][number] | undefined,
  innerW: number,
): { lines: string[]; active: string[] } {
  if (!row) return { lines: [], active: [] };
  const seg = a.segments[row.segmentIndex];
  if (!seg) return { lines: [], active: [] };

  // 段行 → 用段内第一轮；turn/step 行 → 用该轮
  const turnIndex = row.turnIndex;
  const stepKey = row.kind === "step" ? row.stepKey : undefined;

  const d = buildFlowDiagram(
    seg,
    {
      turnIndex,
      stepKey,
      hasStep: Boolean(stepKey),
    },
    innerW,
  );
  if (d.lines.length === 0) return { lines: [], active: [] };
  return { lines: d.lines, active: d.active };
}



function stepTitle(step: Step): string {
  switch (step.kind) {
    case "thinking": return "思考内容";
    case "tool_call": return `工具 · ${step.tool ?? ""}`;
    case "tool_result": return `结果 · ${step.tool ?? ""}`;
    case "text": return "模型输出";
    case "compaction": return "上下文压缩";
    case "ask": return "向用户提问";
    case "answer": return "用户回答";
    default: return "详情";
  }
}

function detailOverview(
  state: AppState,
  a: { totals: Record<string, number>; health: number; notes: string[]; toolHistogram: { tool: string; count: number; errors: number }[]; session: { path: string; cwd: string; startedAt: string; endedAt: string; bytes: number } },
  width: number,
): string[] {
  const t = a.totals;
  const out: string[] = [];
  const kv = (k: string, v: string): string =>
    theme.faint(padEnd(k, 10)) + v;
  out.push(theme.muted("会话概览"));
  out.push(divider(width));
  out.push(kv("健康分", healthBar(a.health) + " " + String(a.health)));
  out.push(kv("路径", theme.faint(truncate(a.session.path, width - 12))));
  out.push(kv("工作目录", theme.faint(truncate(a.session.cwd || "—", width - 12))));
  out.push(kv("时间", theme.bright(`${fmtTimeSec(a.session.startedAt)} → ${fmtTimeSec(a.session.endedAt)}`)));
  out.push(kv("规模", `${t.segments ?? 0} 段 / ${t.turns ?? 0} 轮 / ${t.steps ?? 0} 步`));
  out.push(kv("工具", `${t.toolCalls ?? 0} 次 · 错误 ${t.errors ?? 0}`));
  out.push(kv("压缩", `${t.compactions ?? 0} 次`));
  out.push(kv("Token", `峰值上下文 ${fmtTokens(t.contextPeak ?? 0)}`));
  out.push("");

  if (a.notes.length > 0) {
    out.push(theme.warn("注意"));
    for (const n of a.notes) out.push(theme.dim("  " + glyph.bullet + " " + truncate(n, width - 4)));
    out.push("");
  }

  if (a.toolHistogram.length > 0) {
    out.push(theme.muted("工具分布"));
    const max = a.toolHistogram[0]?.count ?? 1;
    for (const h of a.toolHistogram.slice(0, 10)) {
      const c = toolColor(toolKindOf(h.tool));
      const barW = Math.max(6, Math.floor(width * 0.3));
      const filled = Math.round((h.count / max) * barW);
      const barStr = c("█".repeat(filled)) + theme.faint("░".repeat(barW - filled));
      out.push(
        "  " + c(padEnd(h.tool, 22)) + " " + barStr +
        theme.bright(padStart(String(h.count), 4)) +
        (h.errors > 0 ? theme.error(` ${h.errors}错`) : ""),
      );
    }
  }
  out.push("");
  out.push(theme.faint("← → 在时间轴上进出层级；tab 查看问题列表"));
  return out;
}

function detailSegment(seg: Segment, width: number): string[] {
  const out: string[] = [];
  out.push(theme.compaction(theme.bold(`SessionLoop #${seg.index + 1}`)) + (seg.afterCompaction ? theme.warn("  (压缩后)") : ""));
  out.push(divider(width));
  out.push("");
  out.push(theme.muted("用户需求"));
  for (const l of wrap(seg.prompt, width)) out.push(theme.white(l));
  out.push("");
  if (seg.systemPromptTail) {
    out.push(theme.muted("附加系统指令（" + seg.systemPromptTail.length + " 字符）"));
    for (const l of wrap(truncate(seg.systemPromptTail, 1200), width)) out.push(theme.faint(l));
    out.push("");
  }
  out.push(theme.muted("本段统计"));
  out.push(theme.faint("  轮次 ") + theme.bright(String(seg.turnCount)));
  out.push(theme.faint("  工具 ") + theme.bright(String(seg.toolCallCount)) + (seg.errorCount ? theme.error(`  (${seg.errorCount} 错)`) : ""));
  out.push(theme.faint("  提问 ") + theme.bright(String(seg.askCount)));
  out.push(theme.faint("  峰值上下文 ") + theme.bright(fmtTokens(seg.peakContextTokens)));
  out.push(theme.faint("  耗时 ") + theme.bright(fmtDuration(Date.parse(seg.endAt) - Date.parse(seg.startAt))));
  out.push("");
  out.push(theme.faint("↓ 展开下方 turn 查看每一步"));
  return out;
}

function detailTurn(turn: Turn, width: number): string[] {
  const out: string[] = [];
  out.push(theme.accent(theme.bold(`AgentLoop T${turn.index + 1}`)) + (turn.hasError ? theme.error("  ⚠ 本轮有错误") : ""));
  out.push(divider(width));
  out.push("");
  const kv = (k: string, v: string): void => {
    out.push(theme.faint(padEnd("  " + k, 14)) + v);
  };
  kv("模型", theme.bright(`${turn.provider ?? "?"}/${turn.model ?? "?"}`));
  if (turn.thinkingLevel) kv("思考等级", theme.bright(turn.thinkingLevel));
  kv("stopReason", turn.stopReason === "toolUse" ? theme.ok(turn.stopReason) : theme.warn(turn.stopReason ?? "—"));
  if (turn.contextTokens) kv("上下文", theme.bright(fmtTokens(turn.contextTokens)));
  if (turn.usage) {
    const u = turn.usage;
    kv("输入", `${u.input} (cache ${u.cacheRead})`);
    kv("输出", `${u.output}` + (u.reasoning ? ` (推理 ${u.reasoning})` : ""));
  }
  kv("耗时", fmtDuration(turn.durationMs));
  out.push("");
  out.push(theme.muted("步骤"));
  for (const s of turn.steps) {
    const hasIssue = s.issueIndexes?.length;
    const icon =
      s.kind === "thinking" ? theme.purple(glyph.thinking)
      : s.kind === "tool_call" ? (hasIssue ? theme.error(glyph.error) : toolColor(toolKindOf(s.tool ?? ""))(glyph.tool))
      : s.kind === "text" ? theme.ok(glyph.text)
      : s.kind === "ask" ? theme.warn(glyph.ask)
      : s.kind === "answer" ? theme.info(glyph.answer)
      : s.kind === "compaction" ? theme.compaction(glyph.compaction)
      : theme.muted(glyph.dot);
    const label =
      s.kind === "tool_call" || s.kind === "tool_result"
        ? (s.tool ?? "")
        : s.kind === "thinking" ? "思考"
        : s.kind === "text" ? "输出"
        : s.kind === "ask" ? "提问"
        : s.kind === "answer" ? "回答"
        : s.kind === "compaction" ? "压缩"
        : String(s.kind);
    out.push("  " + icon + " " + theme.bright(padEnd(label, 24)) + theme.faint(truncate(s.resultBrief ?? (s.text ?? "").replace(/\s+/g, " "), Math.max(8, width - 30))));
  }
  return out;
}

function detailStep(step: Step, issues: Issue[], width: number): string[] {
  const out: string[] = [];
  const kindLabel =
    step.kind === "thinking" ? theme.purple("思考")
    : step.kind === "tool_call" ? theme.accent("工具调用")
    : step.kind === "text" ? theme.ok("模型输出")
    : step.kind === "compaction" ? theme.compaction("上下文压缩")
    : step.kind === "ask" ? theme.warn("向用户提问")
    : step.kind === "answer" ? theme.info("用户回答")
    : step.kind === "tool_result" ? theme.muted("工具结果")
    : theme.muted(step.kind);

  out.push(kindLabel + (step.tool ? " " + toolColor(toolKindOf(step.tool))(theme.bold(step.tool)) : ""));
  out.push(theme.faint(`${fmtTimeSec(step.at)}  ·  entry ${step.entryId}`));
  out.push(divider(width));
  out.push("");

  // 关联 issue
  if (step.issueIndexes?.length) {
    for (const idx of step.issueIndexes) {
      const iss = issues[idx];
      if (!iss) continue;
      out.push(severityColor(iss.severity)(`${glyph[iss.severity === "error" ? "error" : iss.severity === "warn" ? "warn" : "info"]} ${iss.title}`));
      for (const l of wrap(iss.detail, width - 2)) out.push(theme.dim("  " + l));
      out.push("");
    }
  }

  if (step.args && Object.keys(step.args).length > 0) {
    out.push(theme.muted("参数"));
    for (const l of wrap(JSON.stringify(step.args, null, 2), width - 2)) {
      out.push(theme.bright("  " + l));
    }
    out.push("");
  }

  if (step.resultBrief) {
    out.push(theme.muted("结果摘要"));
    for (const l of wrap(step.resultBrief, width - 2)) out.push(theme.bright("  " + l));
    if (step.resultChars) out.push(theme.faint(`  (共 ${step.resultChars} 字符)`));
    out.push("");
  }

  if (step.text) {
    out.push(theme.muted(step.kind === "compaction" ? "压缩摘要" : "内容"));
    for (const l of wrap(step.text, width)) out.push(theme.bright(l));
  }

  return out;
}

function healthBar(health: number): string {
  const w = 12;
  const filled = Math.round((health / 100) * w);
  const c = health >= 85 ? theme.ok : health >= 65 ? theme.warn : theme.error;
  return c("█".repeat(filled)) + theme.faint("░".repeat(w - filled));
}

function renderFooterLine(state: AppState): string {
  // 会话内也自动刷新（文件变了就重解析），把「多久前刷的」显示出来，
  // 否则用户不知道界面上的数据是不是最新的。
  const reloadTag =
    state.lastSessionReloadAt > 0 && !state.flash
      ? theme.faint(`${fmtAgo(state.lastSessionReloadAt)}同步`)
      : "";
  const tail = state.flash ? theme.warn(state.flash) : reloadTag;
  const keys: [string, string][] = [
    ["↑↓", "行"],
    ["→←", "层级/折叠"],
    ["Z/E", "全折叠/展开"],
    ["z", "按层折叠"],
    ["j/k", "详情"],
    ["tab", "问题"],
    ["esc", "返回"],
  ];

  // flash 优先：提示是用户刚触发动作的反馈，必须看得见；
  // 按键提示是常驻参考，空间不够时可以让位（否则新加的折叠键
  // 会把 flash 挤出屏幕，表现为「按了键没反应」）。
  const hint = keys.map(([k, d]) => theme.accent(k) + theme.faint(" " + d)).join(theme.faint(" · "));
  // tail 自身宽度 + 它与 hint 之间的 2 空格分隔，统一由这里算，别在字符串里预埋空格
  const tailW = tail ? visibleWidth(tail) + 2 : 0;
  const room = Math.max(0, state.width - tailW);
  const hintClipped = visibleWidth(hint) > room ? truncate(hint, room, "…") : hint;
  const line = hintClipped + (tail ? "  " + tail : "");
  return padEnd(truncate(line, state.width, ""), state.width);
}
