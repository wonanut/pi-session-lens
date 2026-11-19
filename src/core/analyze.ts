/**
 * 会话分析入口：parser → turns → segments → issues → 汇总。
 *
 * 这一层是「一个函数拿到全部可视图数据」的地方。UI 只消费 SessionAnalysis，
 * 不直接碰 entry —— 这样换 UI（TUI/Web/导出 HTML）都不用重写分析逻辑。
 */
import { parseSessionFile, type ParsedSession } from "./parser.ts";
import { buildTurns } from "./turns.ts";
import { buildSegmentsDetailed } from "./segments.ts";
import { extractPrompts, type SegmentPrompt } from "./prompts.ts";
import { computeHealth, detectIssues } from "./issues.ts";
import type { Issue, SessionAnalysis, Segment, Step, Turn } from "./model.ts";

export async function analyzeSessionFile(path: string): Promise<SessionAnalysis> {
  const session = await parseSessionFile(path);
  return analyzeParsed(session);
}

/** 对已解析的会话做分析（便于复用解析结果做多次分析）。 */
export function analyzeParsed(session: ParsedSession): SessionAnalysis {
  const sessionStart = Date.parse(session.startedAt) || firstEntryMs(session);
  const entries = session.branch.length > 0 ? session.branch : session.entries;

  const turns = buildTurns({ entries, sessionStart });
  const prompts = extractPrompts(entries);
  const built = buildSegmentsDetailed(turns, prompts);
  const segments = built.segments;

  // 段首缺 prompt 时，用 promptByTurn 补一次（压缩段尤其需要）
  fillSegmentPrompts(segments, built.promptByTurn);

  const issues = detectIssues({ segments, session });
  attachIssuesToSteps(segments, issues);

  const notes: string[] = [];
  if (session.leafCount > 1) {
    notes.push(
      `会话有 ${session.leafCount} 个分支叶子：本工具只展开最后一条（当前）分支，其它分支已忽略。`,
    );
  }
  if (session.badLines > 0) notes.push(`有 ${session.badLines} 行无法解析，已跳过。`);
  if (session.typeCounts["context_edit"]) {
    notes.push(
      `含 ${session.typeCounts["context_edit"]} 条 context_edit（后续请求看不到被编辑掉的原文）。`,
    );
  }
  if (session.typeCounts["branch_summary"]) {
    notes.push(`含 ${session.typeCounts["branch_summary"]} 条分支摘要（发生过 /tree 切换）。`);
  }

  const totals = {
    segments: segments.length,
    turns: turns.length,
    steps: turns.reduce((a, t) => a + t.steps.length, 0),
    toolCalls: turns.reduce(
      (a, t) => a + t.steps.filter((s) => s.kind === "tool_call").length,
      0,
    ),
    errors: issues.filter((i) => i.severity === "error").length,
    // 压缩次数取真实 compaction entry 数，不能用「afterCompaction 的段数」
    // —— 一次压缩会把后面所有段都标记为 true，那样统计会严重虚高
    compactions: session.typeCounts["compaction"] ?? 0,
    askUser: turns.reduce((a, t) => a + t.steps.filter((s) => s.kind === "ask").length, 0),
    durationMs: computeDuration(session),
    promptTokens: turns.reduce((a, t) => a + (t.usage?.input ?? 0), 0),
    completionTokens: turns.reduce((a, t) => a + (t.usage?.output ?? 0), 0),
    contextPeak: turns.reduce((a, t) => Math.max(a, t.contextTokens ?? 0), 0),
  };

  return {
    session,
    segments,
    issues,
    totals,
    health: computeHealth(issues, turns, segments),
    toolHistogram: buildHistogram(turns),
    notes,
  };
}

function firstEntryMs(s: ParsedSession): number {
  const e = s.entries[0] as { timestamp?: string } | undefined;
  return Date.parse(e?.timestamp ?? "") || 0;
}

function computeDuration(s: ParsedSession): number {
  const a = Date.parse(s.startedAt);
  const b = Date.parse(s.endedAt);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0;
}

/** 段首 prompt 兜底填充。 */
function fillSegmentPrompts(
  segments: Segment[],
  promptByTurn: Map<number, SegmentPrompt>,
): void {
  for (const seg of segments) {
    if (seg.prompt && !seg.prompt.startsWith("(无用户提问")) continue;
    const firstTurn = seg.turns[0];
    if (!firstTurn) continue;
    const p = promptByTurn.get(firstTurn.index);
    if (p) {
      seg.prompt = p.user;
      seg.systemPromptTail = p.system || undefined;
      continue;
    }
    // 往回找最近的 prompt —— 压缩段的提问在压缩之前
    let best: SegmentPrompt | undefined;
    let bestIdx = -Infinity;
    for (const [idx, v] of promptByTurn) {
      if (idx <= firstTurn.index && idx > bestIdx) {
        best = v;
        bestIdx = idx;
      }
    }
    if (best) {
      seg.prompt = best.user;
      seg.systemPromptTail = best.system || undefined;
    }
  }
}

/** 把 issue 挂到对应 step 上，UI 显示 step 时能直接标红。 */
function attachIssuesToSteps(segments: Segment[], issues: Issue[]): void {
  const byStep = new Map<string, number[]>();
  for (const i of issues) {
    if (!i.stepKey) continue;
    const arr = byStep.get(i.stepKey) ?? [];
    arr.push(i.index);
    byStep.set(i.stepKey, arr);
  }
  if (byStep.size === 0) return;
  for (const seg of segments) {
    for (const t of seg.turns) {
      for (const s of t.steps) {
        const hit = byStep.get(s.key);
        if (hit) s.issueIndexes = hit;
      }
    }
  }
}

function buildHistogram(turns: Turn[]): { tool: string; count: number; errors: number }[] {
  const m = new Map<string, { count: number; errors: number }>();
  for (const t of turns) {
    for (const s of t.steps) {
      if (s.kind !== "tool_call" || !s.tool) continue;
      const cur = m.get(s.tool) ?? { count: 0, errors: 0 };
      cur.count++;
      if (s.isError) cur.errors++;
      m.set(s.tool, cur);
    }
  }
  return [...m.entries()]
    .map(([tool, v]) => ({ tool, ...v }))
    .sort((a, b) => b.count - a.count);
}

/** 便于外部按 key 找到 step。 */
export function findStep(
  analysis: SessionAnalysis,
  stepKey: string,
): { segment: Segment; turn: Turn; step: Step } | null {
  for (const seg of analysis.segments) {
    for (const t of seg.turns) {
      for (const s of t.steps) {
        if (s.key === stepKey) return { segment: seg, turn: t, step: s };
      }
    }
  }
  return null;
}
