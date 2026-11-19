/**
 * pi session JSONL 解析：通用能力层。
 *
 * 设计原则：
 * 1. 不猜、不编 —— 每条数据都能指回 jsonl 里的某一行（entry id / index）。
 * 2. 容错 —— 未知 entry 类型、坏行、扩展 role 一律跳过而不抛错。
 *    pi 升级新增类型时，本工具不应该直接崩。
 * 3. 只做「还原」不做「判断」 —— 语义分析在 analyze 层，
 *    这样解析器可以独立复用到其它地方（比如导出、统计、CI 检查）。
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import type {
  AgentMessage,
  AssistantMessage,
  CompactionEntry,
  ContentBlock,
  EntryBase,
  SessionEntry,
  SessionHeader,
  ToolResultMessage,
  Usage,
} from "./types.ts";

/** 解析后的完整会话。 */
export interface ParsedSession {
  /** 文件绝对路径。 */
  path: string;
  /** 从文件名 `<timestamp>_<id>.jsonl` 解析出的 id。 */
  sessionId: string;
  /** header 里的 id 可能与文件名不同（fork/clone）。 */
  headerId: string;
  version: number;
  cwd: string;
  parentSession?: string;
  /** header 的 ISO 时间。 */
  startedAt: string;
  /** 最后一条 entry 的时间。 */
  endedAt: string;
  /** 按文件顺序的全部 entry（含 header 之外的变更类 entry）。 */
  entries: SessionEntry[];
  /** entryId → entry，便于按 id 跳转。 */
  byId: Map<string, SessionEntry>;
  /**
   * 线性化后的「当前分支」entry 序列。
   *
   * pi 的 entry 是树（id/parentId）。绝大多数会话是链，但我们不能假设：
   * 这里从叶子回溯到根，得到真正参与模型的路径。
   * 若检测到多根/分叉，额外记录 branchCount 让 UI 提示。
   */
  branch: SessionEntry[];
  /** 树上出现的叶子数（>1 表示有分叉被裁剪）。 */
  leafCount: number;
  /** 文件里出现的全部 entry 类型及次数，用于「未知类型」提示。 */
  typeCounts: Record<string, number>;
  /** 坏行数（非 JSON 或解析失败）。 */
  badLines: number;
  /** 文件字节数。 */
  bytes: number;
  /** 会话级累计 usage（assistant + compaction summary + usage entries）。 */
  totalUsage: Usage;
  /** 会话改名（/name）。 */
  sessionName?: string;
  /** fork 自哪个会话文件（header.parentSession）。 */
  forkedFrom?: string;
}

const EMPTY_USAGE = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function addUsage(into: Usage, u?: Usage): void {
  if (!u) return;
  into.input += u.input || 0;
  into.output += u.output || 0;
  into.cacheRead += u.cacheRead || 0;
  into.cacheWrite += u.cacheWrite || 0;
  into.reasoning = (into.reasoning || 0) + (u.reasoning || 0);
  into.totalTokens += u.totalTokens || 0;
  if (u.cost && into.cost) {
    into.cost.input += u.cost.input || 0;
    into.cost.output += u.cost.output || 0;
    into.cost.cacheRead += u.cost.cacheRead || 0;
    into.cost.cacheWrite += u.cost.cacheWrite || 0;
    into.cost.total += u.cost.total || 0;
  }
}

/** 从文件名取 session id：`<ts>_<id>.jsonl`。 */
export function sessionIdFromFilename(path: string): string {
  const stem = basename(path).replace(/\.jsonl$/i, "");
  const i = stem.indexOf("_");
  return i >= 0 ? stem.slice(i + 1) : stem;
}

/**
 * 流式读取 jsonl，逐行回调。
 *
 * 用流而不是 readFileSync：单个会话可达数百 MB（真实数据里见过 900KB，
 * 但 pi 支持长会话），整读会一次性把内存打满。
 */
export async function readJsonlLines(
  path: string,
  onLine: (line: string, lineNo: number) => void,
): Promise<number> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  let n = 0;
  for await (const line of rl) {
    n++;
    onLine(line, n);
  }
  rl.close();
  return n;
}

/** 解析一个 jsonl 会话文件。 */
export async function parseSessionFile(path: string): Promise<ParsedSession> {
  const { statSync } = await import("node:fs");
  const bytes = statSync(path).size;

  let header: SessionHeader | null = null;
  const entries: SessionEntry[] = [];
  const typeCounts: Record<string, number> = {};
  let badLines = 0;
  const totalUsage = EMPTY_USAGE();

  await readJsonlLines(path, (line) => {
    const t = line.trim();
    if (!t) return;
    if (!t.startsWith("{")) {
      badLines++;
      return;
    }
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(t) as Record<string, unknown>;
    } catch {
      badLines++;
      return;
    }
    const type = typeof rec.type === "string" ? rec.type : "";
    if (!type) {
      badLines++;
      return;
    }
    typeCounts[type] = (typeCounts[type] || 0) + 1;

    if (type === "session") {
      header = rec as unknown as SessionHeader;
      return;
    }
    const e = rec as unknown as SessionEntry;
    // 没有 id 的 entry 无法进树，但仍保留在 entries 里（线性展示用）
    entries.push(e);

    if (type === "message") {
      const m = (e as { message?: AgentMessage }).message;
      if (m && typeof m === "object" && (m as AssistantMessage).role === "assistant") {
        addUsage(totalUsage, (m as AssistantMessage).usage);
      }
    } else if (type === "compaction") {
      addUsage(totalUsage, (e as CompactionEntry).usage);
    } else if (type === "usage") {
      addUsage(totalUsage, (e as { usage?: Usage }).usage);
    } else if (type === "branch_summary") {
      addUsage(totalUsage, (e as { usage?: Usage }).usage);
    }
  });

  // ---- 建树 ----
  const byId = new Map<string, SessionEntry>();
  const childCount = new Map<string, number>();
  for (const e of entries) {
    const id = (e as EntryBase).id;
    if (typeof id === "string" && id) byId.set(id, e);
  }
  for (const e of entries) {
    const pid = (e as EntryBase).parentId;
    if (typeof pid === "string" && pid) childCount.set(pid, (childCount.get(pid) || 0) + 1);
  }

  const leafExists = new Set<string>();
  for (const e of entries) {
    const id = (e as EntryBase).id;
    if (typeof id === "string" && id) leafExists.add(id);
  }
  const leaves = entries.filter((e) => {
    const id = (e as EntryBase).id;
    if (typeof id !== "string" || !id) return true;
    return !childCount.has(id);
  });
  const leafCount = Math.max(1, leaves.length);

  // 从最后一个叶子回溯到根，得到当前分支
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  let cur: SessionEntry | undefined = leaves[leaves.length - 1];
  while (cur) {
    const id = (cur as EntryBase).id;
    if (typeof id === "string") {
      if (seen.has(id)) break; // 环保护
      seen.add(id);
    }
    branch.push(cur);
    const pid = (cur as EntryBase).parentId;
    cur = typeof pid === "string" && pid ? byId.get(pid) : undefined;
  }
  branch.reverse();

  // ---- header 派生信息 ----
  const headerId = header?.id ?? "";
  const msgEntries = entries.filter((e) => e.type === "message");
  let sessionName: string | undefined;
  for (const e of entries) {
    if (e.type === "session_info") {
      const nm = (e as { name?: string }).name;
      if (nm) sessionName = nm;
    }
  }
  const firstTs = header?.timestamp ?? (entries[0] as EntryBase | undefined)?.timestamp ?? "";
  const lastTs =
    (branch[branch.length - 1] as EntryBase | undefined)?.timestamp ?? firstTs;

  return {
    path,
    sessionId: sessionIdFromFilename(path),
    headerId,
    version: header?.version ?? 1,
    cwd: header?.cwd ?? "",
    parentSession: header?.parentSession,
    startedAt: firstTs,
    endedAt: lastTs,
    entries,
    byId,
    branch,
    leafCount,
    typeCounts,
    badLines,
    bytes,
    totalUsage,
    sessionName,
    forkedFrom: header?.parentSession,
    ...(msgEntries.length === 0 ? {} : {}),
  };
}

// ---------------------------------------------------------------------------
// 内容提取工具
// ---------------------------------------------------------------------------

/** 把 content（string 或 block 数组）抽成纯文本。 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as ContentBlock[]) {
    if (typeof b === "string") {
      parts.push(b);
      continue;
    }
    if (!b || typeof b !== "object") continue;
    const bb = b as Record<string, unknown>;
    if (bb.type === "text" && typeof bb.text === "string") parts.push(bb.text);
    else if (bb.type === "thinking" && typeof bb.thinking === "string") parts.push(bb.thinking);
  }
  return parts.join("\n");
}

/** 取 assistant 消息里的 thinking 全文。 */
export function thinkingText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as ContentBlock[]) {
    const bb = b as Record<string, unknown>;
    if (bb && bb.type === "thinking" && typeof bb.thinking === "string") parts.push(bb.thinking);
  }
  return parts.join("\n\n");
}

/** 取 assistant 消息里的 toolCall blocks。 */
export function toolCalls(content: unknown): { id: string; name: string; args: Record<string, unknown> }[] {
  if (!Array.isArray(content)) return [];
  const out: { id: string; name: string; args: Record<string, unknown> }[] = [];
  for (const b of content as ContentBlock[]) {
    const bb = b as Record<string, unknown>;
    if (!bb || bb.type !== "toolCall") continue;
    out.push({
      id: typeof bb.id === "string" ? bb.id : "",
      name: typeof bb.name === "string" ? bb.name : "(未命名工具)",
      args: (bb.arguments && typeof bb.arguments === "object"
        ? bb.arguments
        : {}) as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * pi 会在 user 消息里追加系统说明（本项目用 "---" 分隔）。
 * 历史展示应该只给用户原话。这一段抽成独立函数方便复用。
 */
export function splitUserText(text: string): { user: string; system: string } {
  for (const mk of ["\n---\n", "\n---"]) {
    const i = text.indexOf(mk);
    if (i >= 0) {
      return { user: text.slice(0, i).trim(), system: text.slice(i + mk.length).trim() };
    }
  }
  return { user: text.trim(), system: "" };
}

/**
 * 从 toolResult 内容里取结构化对象。
 *
 * 很多 pi 工具把 JSON 塞进 text block。这里尝试解析，
 * 解析不出来就返回 null（调用方按纯文本处理）。
 */
export function toolResultJson(m: ToolResultMessage): Record<string, unknown> | null {
  const txt = messageText(m.content).trim();
  if (!txt) return null;
  // 有些工具返回前后夹带说明文字，取第一个 { 到最后一个 }
  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const candidate = txt.slice(start, end + 1);
  try {
    const o = JSON.parse(candidate) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 粗略 token 估算（CJK 感知）。
 *
 * 只用于「无法从 usage 得到时」的兜底显示，不作为度量依据。
 * 中文约 1 字 ≈ 0.6 token，英文约 4 字符 ≈ 1 token。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK 统一表意文字 + 全角标点
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.round(cjk * 0.65 + other / 3.6);
}
