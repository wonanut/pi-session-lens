/**
 * 还原「这次压缩到底吞掉了哪些内容」。
 *
 * 数据事实（已对真实会话核实）：
 *   - pi 的 compaction entry 只存摘要结果（summary）+ firstKeptEntryId
 *     + tokensBefore + usage，**不存**摘要请求的 prompt。
 *     所以「完整的压缩输入」在磁盘上不存在，无法还原。
 *   - 但被压缩的原文**仍在同一个 jsonl 文件里**，只是不再进入后续上下文。
 *     用 firstKeptEntryId 可以精确切出范围，逐条列出被吞掉的内容。
 *
 * 边界规则（依据 pi 的 compaction.md）：
 *   - 被压缩范围 = [起点, firstKeptEntryId)
 *   - 起点：上一次压缩的保留边界；若无上次压缩，则是分支起点
 *     ⚠ 重复压缩时起点不是「上次 compaction entry 本身」，
 *       而是上次的 firstKeptEntryId —— 用错会把已经保留下来的消息
 *       误报成「这次被压掉了」。
 *   - retain-none：firstKeptEntryId 等于自身 id，此时不保留任何前置内容
 */
import {
  estimateTokens,
  messageText,
  thinkingText,
  toolCalls,
  toolResultJson,
} from "./parser.ts";
import type { CompactedEntry, CompactionDetail } from "./model.ts";
import type {
  AssistantMessage,
  CompactionEntry,
  EntryBase,
  SessionEntry,
  ToolResultMessage,
} from "./types.ts";

/** 单条被压缩 entry 的正文上限：够核对，又不至于把 UI 撑爆。 */
const TEXT_LIMIT = 1200;

/**
 * 计算每次压缩吞掉的范围。
 *
 * @param entries 线性分支（已按时间排好）
 * @returns entryId → 压缩详情（挂在对应的 compaction step 上）
 */
export function buildCompactionDetails(
  entries: SessionEntry[],
): Map<string, CompactionDetail> {
  const out = new Map<string, CompactionDetail>();

  // id → 下标，便于按 firstKeptEntryId 定位
  const indexOf = new Map<string, number>();
  entries.forEach((e, i) => {
    const id = (e as EntryBase).id;
    if (typeof id === "string" && id) indexOf.set(id, i);
  });

  /** 上一次压缩之后应当作为起点的下标。 */
  let prevBoundary = 0;
  let ordinal = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type !== "compaction") continue;
    const c = e as CompactionEntry;
    ordinal++;

    const keptIdx = indexOf.get(c.firstKeptEntryId);
    // retain-none：firstKeptEntryId 指向自己 → 不保留任何前置
    const isRetainNone = c.firstKeptEntryId === (e as EntryBase).id;

    let swallowedFrom = prevBoundary;
    let swallowedTo: number;
    if (isRetainNone) {
      swallowedTo = i; // 到 compaction 之前全部吞掉
    } else if (keptIdx === undefined) {
      // 找不到保留点时保守处理：只报告到压缩前，并留标记
      swallowedTo = i;
    } else {
      swallowedTo = Math.min(keptIdx, i);
    }

    const range = entries.slice(swallowedFrom, swallowedTo);
    const swallowed: CompactedEntry[] = [];
    let chars = 0;
    for (const r of range) {
      const item = toCompactedEntry(r);
      if (!item) continue;
      chars += item.chars;
      swallowed.push(item);
    }

    const summary = typeof c.summary === "string" ? c.summary : "";
    const summaryTokens = c.usage?.output
      ? c.usage.output
      : estimateTokens(summary);

    out.set((e as EntryBase).id, {
      summary,
      tokensBefore: c.tokensBefore ?? 0,
      summaryTokens,
      firstKeptEntryId: c.firstKeptEntryId ?? "",
      swallowed,
      swallowedCount: swallowed.length,
      swallowedChars: chars,
      ordinal,
      usage: c.usage
        ? {
            input: c.usage.input ?? 0,
            output: c.usage.output ?? 0,
            reasoning: c.usage.reasoning,
          }
        : undefined,
    });

    // ⚠ 下一次压缩的起点是「本次保留边界」，不是本次 compaction 自身。
    // 否则已保留下来的消息会被重复算进下一次的「被吞掉」里。
    prevBoundary = isRetainNone ? i + 1 : swallowedTo;
  }
  return out;
}

/** 把一条 entry 转成「可核对的一行」。 */
function toCompactedEntry(e: SessionEntry): CompactedEntry | null {
  const base = e as EntryBase;
  const entryId = typeof base.id === "string" ? base.id : "";

  if (e.type !== "message") {
    // 非消息类 entry 不参与对话，跳过（否则列表全是 model_change 噪音）
    return null;
  }

  const m = (e as { message?: Record<string, unknown> }).message;
  if (!m || typeof m !== "object") return null;
  const role = typeof m.role === "string" ? m.role : "unknown";

  if (role === "user") {
    const raw = messageText(m.content);
    return { entryId, role: "user", text: clip(raw), chars: raw.length };
  }

  if (role === "toolResult") {
    const tr = m as unknown as ToolResultMessage;
    const raw = messageText(tr.content);
    const obj = toolResultJson(tr);
    // 只留能核对的关键信息，不整段塞进去
    const brief =
      (obj && (str(obj.error) || str(obj.query) || str(obj.command_name))) ||
      raw.replace(/\s+/g, " ").slice(0, 160);
    return {
      entryId,
      role: "toolResult",
      text: `${tr.toolName || "(工具)"}: ${brief}`,
      chars: raw.length,
      isError: Boolean(tr.isError) || obj?.ok === false,
    };
  }

  if (role === "assistant") {
    const am = m as unknown as AssistantMessage;
    const parts: string[] = [];
    const th = thinkingText(am.content).trim();
    if (th) parts.push(`[思考] ${th.replace(/\s+/g, " ").slice(0, 200)}`);
    for (const call of toolCalls(am.content)) {
      parts.push(`[调用] ${call.name}(${clip(JSON.stringify(call.args ?? {}), 200)})`);
    }
    const text = Array.isArray(am.content)
      ? am.content
          .filter((b) => (b as { type?: string }).type === "text")
          .map((b) => str((b as { text?: unknown }).text))
          .join("\n")
          .trim()
      : str(m.content).trim();
    if (text) parts.push(text);
    const joined = parts.join("\n") || "(空响应)";
    return { entryId, role: "assistant", text: clip(joined), chars: joined.length };
  }

  const raw = messageText(m.content);
  if (!raw.trim()) return null;
  return { entryId, role, text: clip(raw), chars: raw.length };
}

function clip(s: string, limit = TEXT_LIMIT): string {
  const t = s.trim();
  return t.length > limit ? t.slice(0, limit) + "…" : t;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
