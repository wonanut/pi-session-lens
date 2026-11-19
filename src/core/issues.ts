/**
 * 问题信号检测。
 *
 * 目标：用户打开一个会话，不需要从头读到尾，就能看到「哪里出了问题」。
 *
 * 判定原则：
 *   - 只报有证据的：每个 issue 必须指回具体 step / entry id，能一键跳转。
 *   - 区分严重度：工具真的抛错 vs 业务层拒绝 vs 只是提示信息。
 *   - 不做价值判断：比如「压缩」本身不算错，但它是上下文断点，
 *     定位「模型忘了之前的要求」时必须先看这里，所以列为 info/warn。
 */
import type { Issue, IssueCategory, IssueSeverity, Segment, Step, Turn } from "./model.ts";
import type { ParsedSession } from "./parser.ts";

interface Ctx {
  segments: Segment[];
  session: ParsedSession;
}

const HOUR = 3_600_000;

/** 主入口：扫描全部分段产出 issue 列表。 */
export function detectIssues({ segments, session }: Ctx): Issue[] {
  const issues: Issue[] = [];
  let n = 0;
  const push = (i: Omit<Issue, "index">): void => {
    issues.push({ ...i, index: n++ });
  };

  for (const seg of segments) {
    for (const turn of seg.turns) {
      for (const step of turn.steps) {
        // ---- 压缩：上下文断点 ----
        if (step.kind === "compaction") {
          push({
            severity: "warn",
            category: "compaction",
            title: "上下文压缩发生在此处",
            detail:
              `压缩前上下文约 ${fmtTok(step.approxTokens ?? 0)}（估算）；` +
              `压缩后模型只能看到摘要 + 最近保留的消息，更早的原文不再进入上下文。\n` +
              `如果你觉得「模型忘了之前的要求」，先看这一步的摘要是否丢了关键约束。`,
            segmentIndex: seg.index,
            turnIndex: turn.index,
            stepKey: step.key,
            entryId: step.entryId,
            at: step.at,
          });
          continue;
        }

        // ---- 工具错误 ----
        if ((step.kind === "tool_call" || step.kind === "tool_result") && step.isError) {
          const brief = step.resultBrief || "(无返回)";
          const blocked = brief.startsWith("BLOCKED:");
          push({
            severity: blocked ? "warn" : "error",
            category: blocked ? "business_blocked" : "tool_error",
            title: blocked
              ? `${step.tool} 被拒绝（业务层 ok=false）`
              : `${step.tool} 执行报错`,
            detail: brief + (step.args ? `\n参数：${clip(JSON.stringify(step.args), 400)}` : ""),
            segmentIndex: seg.index,
            turnIndex: turn.index,
            stepKey: step.key,
            entryId: step.entryId,
            at: step.at,
            tool: step.tool,
          });
          if (/RENDER_FAILED/.test(brief)) {
            push({
              severity: "error",
              category: "render_failed",
              title: `${step.tool} 渲染失败`,
              detail: brief,
              segmentIndex: seg.index,
              turnIndex: turn.index,
              stepKey: step.key,
              entryId: step.entryId,
              at: step.at,
              tool: step.tool,
            });
          }
        }

        // ---- 返回体积过大：挤占上下文的隐形杀手 ----
        if (
          (step.kind === "tool_call" || step.kind === "tool_result") &&
          (step.resultChars ?? 0) > 20_000
        ) {
          push({
            severity: "info",
            category: "big_result",
            title: `${step.tool} 返回 ${fmtChars(step.resultChars ?? 0)}，体积偏大`,
            detail:
              `单次工具返回 ${step.resultChars} 字符（约 ${fmtTok(step.approxTokens ?? 0)}）。\n` +
              `大返回会挤占后续所有请求的上下文预算，是促成压缩的主因之一。`,
            segmentIndex: seg.index,
            turnIndex: turn.index,
            stepKey: step.key,
            entryId: step.entryId,
            at: step.at,
            tool: step.tool,
          });
        }
      }

      // ---- turn 级：输出被截断 / 中断 / 空响应 ----
      if (turn.stopReason === "length") {
        const first = turn.steps[0];
        push({
          severity: "warn",
          category: "truncation",
          title: "模型输出被 length 截断",
          detail:
            "stopReason=length：模型达到输出上限被截断，这一轮的回答可能不完整。" +
            (turn.steps.some((s) => s.kind === "tool_call")
              ? "\n注意：本轮仍带工具调用，pi 会保留「失败的工具结果」并继续调度。"
              : ""),
          segmentIndex: seg.index,
          turnIndex: turn.index,
          stepKey: first?.key,
          entryId: first?.entryId,
          at: turn.endAt,
        });
      }
      if (turn.stopReason === "aborted") {
        push({
          severity: "info",
          category: "aborted",
          title: "本轮被中断",
          detail: "stopReason=aborted：用户中断了这一轮。后续轮次可能带着不完整的历史继续。",
          segmentIndex: seg.index,
          turnIndex: turn.index,
          at: turn.endAt,
        });
      }
      if (
        turn.steps.length === 0 &&
        (turn.stopReason === "stop" || turn.stopReason === "error")
      ) {
        push({
          severity: turn.stopReason === "error" ? "error" : "info",
          category: "empty_output",
          title: turn.stopReason === "error" ? "模型调用失败" : "模型返回空响应",
          detail: `stopReason=${turn.stopReason}，本轮没有任何 thinking / 文本 / 工具调用。`,
          segmentIndex: seg.index,
          turnIndex: turn.index,
          at: turn.endAt,
        });
      }

      // ---- 发散检测：同一 turn 内重复调用完全相同参数 ----
      const seen = new Map<string, Step>();
      for (const s of turn.steps) {
        if (s.kind !== "tool_call" || !s.tool) continue;
        const key = s.tool + "|" + stableJson(s.args ?? {});
        const prev = seen.get(key);
        if (prev) {
          push({
            severity: "warn",
            category: "retry_loop",
            title: `${s.tool} 在同一步重复相同调用`,
            detail:
              "同一 turn 内出现参数完全相同的重复调用，通常是模型在自我重复。" +
              `\n参数：${clip(JSON.stringify(s.args ?? {}), 300)}`,
            segmentIndex: seg.index,
            turnIndex: turn.index,
            stepKey: s.key,
            entryId: s.entryId,
            at: s.at,
            tool: s.tool,
          });
        } else {
          seen.set(key, s);
        }
      }
    }
  }

  // ---- 跨段发散：整段都在同一工具上空转 ----
  for (const seg of segments) {
    if (seg.turnCount < 6) continue;
    const hist = new Map<string, number>();
    for (const t of seg.turns) {
      for (const s of t.steps) {
        if (s.kind === "tool_call" && s.tool) hist.set(s.tool, (hist.get(s.tool) || 0) + 1);
      }
    }
    const total = [...hist.values()].reduce((a, b) => a + b, 0);
    if (total < 10) continue;
    for (const [tool, c] of hist) {
      if (c / total < 0.6) continue;
      push({
        severity: "info",
        category: "retry_loop",
        title: `本段 ${Math.round((c / total) * 100)}% 的工具调用都是 ${tool}`,
        detail:
          `本段共 ${total} 次工具调用，其中 ${c} 次是 ${tool}。\n` +
          `高集中度可能是正常的信息收集，也可能是反复查同一个东西 —— 结合错误数判断。`,
        segmentIndex: seg.index,
        turnIndex: seg.turns[0]?.index ?? 0,
        at: seg.startAt,
        tool,
      });
      break;
    }
  }

  // ---- 解析层问题 ----
  const unknownTypes = Object.keys(session.typeCounts).filter(
    (t) =>
      ![
        "session",
        "message",
        "model_change",
        "thinking_level_change",
        "usage",
        "compaction",
        "context_edit",
        "branch_summary",
        "custom",
        "custom_message",
        "label",
        "session_info",
      ].includes(t),
  );
  for (const t of unknownTypes) {
    push({
      severity: "info",
      category: "unknown_entry",
      title: `出现未知 entry 类型：${t}`,
      detail:
        `文件里有 ${session.typeCounts[t]} 条 type="${t}" 的 entry，本工具按「不参与对话」处理。\n` +
        `如果是新版本 pi 引入的类型，可能需要在 parser 里补支持。`,
      segmentIndex: 0,
      turnIndex: 0,
      at: session.startedAt,
    });
  }

  return issues;
}

/** 健康分：从 100 扣分，error 扣得多。 */
export function computeHealth(
  issues: Issue[],
  turns: Turn[],
  segments: Segment[],
): number {
  let score = 100;
  const errs = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warn").length;
  const compactions = segments.filter((s) => s.afterCompaction).length;
  score -= Math.min(40, errs * 5);
  score -= Math.min(25, warns * 2);
  score -= Math.min(15, compactions * 5);

  // 空转惩罚：turn 很多但几乎没有文本输出，说明一直在打转没收敛
  const textTurns = turns.filter((t) => t.steps.some((s) => s.kind === "text")).length;
  if (turns.length >= 10) {
    const ratio = textTurns / turns.length;
    if (ratio < 0.1) score -= 10;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ---------------------------------------------------------------------------

function stableJson(o: Record<string, unknown>): string {
  try {
    const keys = Object.keys(o).sort();
    return JSON.stringify(keys.map((k) => [k, o[k]]));
  } catch {
    return "";
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function fmtChars(n: number): string {
  return fmtTok(n) + " 字符";
}
