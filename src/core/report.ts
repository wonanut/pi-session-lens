/**
 * 非交互输出：文本报告与列表表格。
 *
 * 用途：
 *   - CI 里跑一遍，把「有问题的会话」打出来
 *   - 贴到群里/工单里做说明
 *   - 无 TTY 环境下也能验证解析结果
 *
 * 刻意保持纯文本 + 可选颜色，不依赖终端能力。
 */
import { analyzeSessionFile } from "./analyze.ts";
import type { SessionAnalysis } from "./model.ts";
import type { SessionSummary } from "./summaries.ts";
import { sortedIssues } from "../ui/view-issues.ts";
import { fmtAgo, fmtBytes, fmtDuration, fmtTimeSec, fmtTokens, padEnd, padStart, truncate } from "../ui/text.ts";
import { theme } from "../ui/theme.ts";

/** 会话列表 → 对齐表格。 */
export function formatTable(list: SessionSummary[], width = 120): string {
  const lines: string[] = [];
  const head = [
    padEnd("健康", 5),
    padEnd("时间", 10),
    padStart("轮", 4),
    padStart("工具", 5),
    padStart("错", 3),
    padStart("压", 3),
    padStart("ctx", 7),
    "标题",
  ].join(" ");
  lines.push(theme.muted(head));
  lines.push(theme.border("─".repeat(Math.min(width, 160))));
  for (const s of list) {
    const titleW = Math.max(20, width - 44);
    lines.push(
      [
        (s.health >= 85 ? theme.ok : s.health >= 65 ? theme.warn : theme.error)(
          padEnd(String(s.health), 5),
        ),
        theme.faint(padEnd(fmtAgo(s.mtimeMs), 10)),
        theme.bright(padStart(String(s.turns), 4)),
        theme.muted(padStart(String(s.toolCalls), 5)),
        s.errors > 0 ? theme.error(padStart(String(s.errors), 3)) : theme.faint(padStart("·", 3)),
        s.compactions > 0 ? theme.compaction(padStart(String(s.compactions), 3)) : theme.faint(padStart("·", 3)),
        theme.muted(padStart(fmtTokens(s.contextPeak), 7)),
        truncate(s.title.replace(/\s+/g, " "), titleW),
      ].join(" "),
    );
  }
  return lines.join("\n") + "\n";
}

/** 单会话 → 完整文本报告。 */
export async function buildTextReport(path: string, width = 100): Promise<string> {
  const a = await analyzeSessionFile(path);
  return formatReport(a, width);
}

export function formatReport(a: SessionAnalysis, width = 100): string {
  const out: string[] = [];
  const rule = (): string => theme.border("─".repeat(Math.min(width, 100)));

  out.push(theme.accentStrong(theme.bold("pi 会话分析报告")));
  out.push(rule());
  out.push(theme.faint("文件 ") + a.session.path);
  out.push(theme.faint("会话 ") + a.session.sessionId + theme.faint("  大小 ") + fmtBytes(a.session.bytes));
  out.push(theme.faint("目录 ") + (a.session.cwd || "—"));
  out.push(
    theme.faint("时间 ") +
      fmtTimeSec(a.session.startedAt) +
      theme.faint(" → ") +
      fmtTimeSec(a.session.endedAt) +
      theme.faint("  时长 ") +
      fmtDuration(a.totals.durationMs),
  );
  out.push(rule());

  const healthColor = a.health >= 85 ? theme.ok : a.health >= 65 ? theme.warn : theme.error;
  out.push(
    theme.muted("健康分 ") +
      healthColor(theme.bold(String(a.health))) +
      theme.faint("/100   ") +
      theme.muted("段 ") + String(a.totals.segments) +
      theme.muted("  轮 ") + String(a.totals.turns) +
      theme.muted("  步 ") + String(a.totals.steps) +
      theme.muted("  工具 ") + String(a.totals.toolCalls) +
      theme.muted("  错误 ") + (a.totals.errors > 0 ? theme.error(String(a.totals.errors)) : "0") +
      theme.muted("  压缩 ") + String(a.totals.compactions),
  );
  out.push(
    theme.muted("Token  ") +
      theme.faint(`峰值上下文 ${fmtTokens(a.totals.contextPeak)}  ·  输入 ${fmtTokens(a.totals.promptTokens)}  ·  输出 ${fmtTokens(a.totals.completionTokens)}`),
  );

  if (a.notes.length > 0) {
    out.push("");
    out.push(theme.warn("注意"));
    for (const n of a.notes) out.push(theme.dim("  · " + n));
  }

  // 工具分布
  if (a.toolHistogram.length > 0) {
    out.push("");
    out.push(theme.muted("工具使用分布"));
    const max = a.toolHistogram[0]?.count ?? 1;
    for (const h of a.toolHistogram.slice(0, 12)) {
      const barW = 24;
      const filled = Math.max(1, Math.round((h.count / max) * barW));
      out.push(
        "  " +
          padEnd(h.tool, 24) +
          theme.accent("█".repeat(filled)) +
          theme.faint("░".repeat(barW - filled)) +
          " " +
          padStart(String(h.count), 4) +
          (h.errors > 0 ? theme.error(`  ${h.errors} 错`) : ""),
      );
    }
  }

  // 问题
  out.push("");
  const issues = sortedIssues(a.issues);
  if (issues.length === 0) {
    out.push(theme.ok("✔ 未检测到问题信号"));
  } else {
    out.push(theme.muted(`问题清单（${issues.length} 条）`));
    for (const i of issues) {
      const c = i.severity === "error" ? theme.error : i.severity === "warn" ? theme.warn : theme.info;
      const tag = i.severity === "error" ? "ERR " : i.severity === "warn" ? "WARN" : "INFO";
      out.push(
        "  " +
          c(tag) +
          " " +
          theme.faint(`S${i.segmentIndex + 1}/T${i.turnIndex + 1} `) +
          c(i.title),
      );
      for (const l of i.detail.split("\n")) {
        out.push(theme.dim("       " + truncate(l, width - 8)));
      }
    }
  }

  // 两层循环大纲
  out.push("");
  out.push(theme.muted("两层循环大纲"));
  for (const seg of a.segments) {
    out.push(
      "  " +
        theme.compaction(`SEG${seg.index + 1}`) +
        (seg.afterCompaction ? theme.warn(" ▣压缩后") : "") +
        " " +
        theme.faint(`${seg.turnCount}轮 ${seg.toolCallCount}工具`) +
        (seg.errorCount ? theme.error(` ${seg.errorCount}错`) : "") +
        "  " +
        truncate(seg.prompt.replace(/\s+/g, " "), Math.max(20, width - 50)),
    );
    for (const t of seg.turns) {
      const err = t.hasError ? theme.error(" ✖") : "";
      out.push(
        "    " +
          theme.accent(`T${t.index + 1}`) +
          theme.faint(` ${t.steps.length}步 ${fmtTokens(t.contextTokens ?? 0)}ctx`) +
          err,
      );
      for (const st of t.steps) {
        const label =
          st.kind === "tool_call" ? `${st.tool} ${st.resultBrief ?? ""}`
          : st.kind === "thinking" ? "思考 " + (st.text ?? "").replace(/\s+/g, " ").slice(0, 50)
          : st.kind === "compaction" ? "上下文压缩"
          : st.kind === "text" ? "输出 " + (st.text ?? "").replace(/\s+/g, " ").slice(0, 50)
          : st.kind === "ask" ? "提问 " + (st.text ?? "").slice(0, 40)
          : st.kind === "answer" ? "回答 " + (st.text ?? "").slice(0, 40)
          : st.kind;
        const mark = st.isError ? theme.error("✖ ") : "";
        out.push("      " + mark + theme.faint(truncate(label, width - 10)));
      }
    }
  }

  return out.join("\n") + "\n";
}
