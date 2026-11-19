/**
 * 两层循环的可视化模型。
 *
 * 为什么是「两层」：
 *
 *   SessionLoop —— 一个会话文件的生命周期。用户每发一条消息（或 compaction
 *                  之后重新开始），就会开启一轮。compaction 是 SessionLoop
 *                  里的「断点」：它把之前的历史压成摘要，模型从此不再看到
 *                  原始消息。定位问题时这是最关键的分界。
 *
 *   AgentLoop   —— 一轮 SessionLoop 内部，模型 ↔ 工具的往复。一次 assistant
 *                  响应 + 它触发的工具执行 = 一个 turn。turn 里有若干 step
 *                  （thinking / tool call / tool result）。
 *
 * 这样分层的原因：用户反馈「模型答错了」，原因可能完全在两层中的任一层 ——
 * SessionLoop 层可能是「压缩把关键约束丢了」，AgentLoop 层可能是「第 7 轮
 * 工具返回了错误」。只看平铺的消息列表无从区分，必须分层。
 */
import type { ParsedSession } from "./parser.ts";
import type { Usage } from "./types.ts";

// ---------------------------------------------------------------------------
// Step：最小可定位单元
// ---------------------------------------------------------------------------

export type StepKind =
  | "thinking" // 模型思考
  | "tool_call" // 工具调用（含参数）
  | "tool_result" // 工具返回（与实际 tool_call 配对）
  | "text" // 模型的最终文本输出
  | "ask" // 向用户提问（从 ask_user 类工具还原）
  | "answer" // 用户对提问的回答
  | "error" // 工具报错（独立成一个 step 便于问题面板直接跳）
  | "compaction"; // 压缩事件

export interface Step {
  /** 全局稳定 id：`<turnIndex>:<stepIndex>`，可直接作为 UI 定位键。 */
  key: string;
  kind: StepKind;
  /** 对应 jsonl entry 的 id（能直接回查原始文件）。 */
  entryId: string;
  /** ISO 时间。 */
  at: string;
  /** 相对会话开始的毫秒偏移，用于时间轴。 */
  offsetMs: number;
  /** 思考 / 文本 / 报错的正文。 */
  text?: string;
  /** 工具名。 */
  tool?: string;
  /** 工具调用参数。 */
  args?: Record<string, unknown>;
  /** 工具调用 id，用于把 call 和 result 配对。 */
  callId?: string;
  /** 工具是否报错。 */
  isError?: boolean;
  /** 工具耗时（毫秒），pi 会记录 durationMs。 */
  durationMs?: number;
  /** 工具返回的结构化摘要（前端不必再解析）。 */
  resultBrief?: string;
  /** 完整返回文本长度，用于提示「结果很大」。 */
  resultChars?: number;
  /** 估算 token（仅在无 usage 时用于判断体积）。 */
  approxTokens?: number;
  /** 关联的 issue 下标（由 analyze 填充）。 */
  issueIndexes?: number[];
  /** 压缩专用：这次压缩吞掉了哪些 entry、抹掉了多少 token。 */
  compaction?: CompactionDetail;
}

/**
 * 压缩详情。
 *
 * 为什么需要单独一块：pi 的 compaction entry 只存「摘要结果」，
 * 不存摘要请求的 prompt。但被压缩的原文仍在文件里 ——
 * 用 firstKeptEntryId 可以精确切出「哪些 entry 被吞进了摘要」，
 * 于是「模型忘了之前的要求」这类问题可以直接逐条核对：
 * 这条约束是被摘要丢了，还是压根没进入过上下文。
 */
export interface CompactionDetail {
  /** 摘要正文（pi 生成的，即压缩的「输出」）。 */
  summary: string;
  /** 压缩前上下文 token（pi 记录）。 */
  tokensBefore: number;
  /** 摘要本身的 token（由 usage.output 或估算）。 */
  summaryTokens: number;
  /** 保留原文的起点 entry id（pi 的 firstKeptEntryId）。 */
  firstKeptEntryId: string;
  /** 被吞进摘要的 entry 列表（按原顺序，已裁剪成展示用摘要）。 */
  swallowed: CompactedEntry[];
  /** 被压缩的 entry 总数。 */
  swallowedCount: number;
  /** 被压缩部分的原始字符数（衡量「丢了多少字」）。 */
  swallowedChars: number;
  /** 是第几次压缩（1 起）。 */
  ordinal: number;
  /** 生成摘要本身的模型调用 usage。 */
  usage?: { input: number; output: number; reasoning?: number };
}

/** 被压缩掉的一条 entry（展示用，保留可核对的关键信息）。 */
export interface CompactedEntry {
  entryId: string;
  /** user / assistant / toolResult / system / thinking 等。 */
  role: string;
  /** 正文（工具调用已压成一行命令名 + 参数摘要）。 */
  text: string;
  /** 原始字符数。 */
  chars: number;
  /** 该条工具的报错标记。 */
  isError?: boolean;
}


// ---------------------------------------------------------------------------
// Turn：AgentLoop 的一步
// ---------------------------------------------------------------------------

export interface Turn {
  index: number;
  /** 该 turn 的 assistant 模型。 */
  model?: string;
  provider?: string;
  /** 本次调用的 usage（模型输出 + 上下文）。 */
  usage?: Usage;
  /** 上下文总 token（input + cacheRead）—— 判断「离压缩还有多远」。 */
  contextTokens?: number;
  stopReason?: string;
  /** 模型本轮给的思考等级。 */
  thinkingLevel?: string;
  /** 本 turn 的 step 列表。 */
  steps: Step[];
  startAt: string;
  endAt: string;
  offsetMs: number;
  durationMs: number;
  /** 本轮是否触发了工具错误。 */
  hasError: boolean;
  /** 本轮的模型耗时。 */
  modelDurationMs?: number;
}

// ---------------------------------------------------------------------------
// Segment：SessionLoop 的一轮
// ---------------------------------------------------------------------------

export interface Segment {
  index: number;
  /** 用户这轮的原话（或压缩后重新开始时的第一句）。 */
  prompt: string;
  /** 用户原话里的系统指令部分（"---" 之后），用于排查 prompt 注入问题。 */
  systemPromptTail?: string;
  startAt: string;
  endAt: string;
  offsetMs: number;
  turns: Turn[];
  /** 本轮的总 usage。 */
  usage: Usage;
  /** 本轮起始时是否由 compaction 开启。 */
  afterCompaction: boolean;
  /** 本轮的峰值上下文 token。 */
  peakContextTokens: number;
  turnCount: number;
  stepCount: number;
  toolCallCount: number;
  errorCount: number;
  /** 用户在轮中通过 ask 回答的次数。 */
  askCount: number;
}

// ---------------------------------------------------------------------------
// Issue：问题信号
// ---------------------------------------------------------------------------

export type IssueSeverity = "error" | "warn" | "info";

export type IssueCategory =
  | "tool_error" // 工具返回 isError
  | "business_blocked" // 工具成功但业务 ok=false（知识库没有命令等）
  | "render_failed" // 渲染失败
  | "compaction" // 发生压缩（上下文断点）
  | "truncation" // 模型输出被 length 截断
  | "retry_loop" // 同参数重复调用，疑似发散
  | "aborted" // 用户中断
  | "empty_output" // 模型返回空
  | "big_result" // 单次工具返回体积过大（挤占上下文）
  | "unknown_entry"; // 遇到未知 entry 类型

export interface Issue {
  index: number;
  severity: IssueSeverity;
  category: IssueCategory;
  /** 一句话结论。 */
  title: string;
  /** 详细说明（含原文片段）。 */
  detail: string;
  /** 定位信息。 */
  segmentIndex: number;
  turnIndex: number;
  stepKey?: string;
  entryId?: string;
  at: string;
  tool?: string;
}

// ---------------------------------------------------------------------------
// 会话分析结果
// ---------------------------------------------------------------------------

export interface SessionAnalysis {
  session: ParsedSession;
  segments: Segment[];
  issues: Issue[];
  totals: {
    segments: number;
    turns: number;
    steps: number;
    toolCalls: number;
    errors: number;
    compactions: number;
    askUser: number;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    contextPeak: number;
  };
  /** 健康分 0-100，越高越干净。 */
  health: number;
  /** 工具使用分布，便于一眼看出「这个会话主要在查什么」。 */
  toolHistogram: { tool: string; count: number; errors: number }[];
  /** 解析期的告警（如分支被裁剪）。 */
  notes: string[];
}
