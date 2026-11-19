/**
 * pi session JSONL 的类型定义。
 *
 * 权威来源：pi-coding-agent/docs/session-format.md + message-types.md。
 * 这里只覆盖「可视化分析」需要的字段，其余原样保留在 raw 里，
 * 这样 pi 升级新增 entry 类型时不会直接崩掉。
 */

/** 所有 entry 的公共基字段（SessionHeader 除外）。 */
export interface EntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd?: string;
  parentSession?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface TextBlock {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  namespace?: string;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ThinkingBlock
  | ToolCallBlock
  | { type: string; [key: string]: unknown };

export interface SystemMessage {
  role: "system";
  content: string | TextBlock[];
  sections?: Record<string, string | null>;
  toolsAdded?: ToolDefinition[];
  toolsRemoved?: { name: string }[];
  timestamp: number;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
  timestamp: number;
}

export type StopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  responseId?: string;
  thinkingLevel?: string;
  usage?: Usage;
  stopReason?: StopReason;
  errorMessage?: string;
  rawStopReason?: string;
  durationMs?: number;
  timestamp: number;
}

export interface NestedToolCallRecord {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  error?: string;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  details?: unknown;
  usage?: Usage;
  nestedCalls?: { calls: NestedToolCallRecord[]; complete: boolean };
  isError: boolean;
  durationMs?: number;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | ContentBlock[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

/** 未知/扩展 role —— pi 允许应用通过声明合并增加 role，不能硬失败。 */
export interface UnknownMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | UnknownMessage;

export interface MessageEntry extends EntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface UsageEntry extends EntryBase {
  type: "usage";
  kind: string;
  provider?: string;
  model?: string;
  usage: Usage;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  systemMessage?: SystemMessage;
  usage?: Usage;
  details?: unknown;
  fromHook?: boolean;
}

export interface ContextEditEntry extends EntryBase {
  type: "context_edit";
  targetId: string;
  replacement: null | string | ContentBlock[];
}

export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  fromId: string | null;
  summary: string;
  usage?: Usage;
  details?: unknown;
  fromHook?: boolean;
}

export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends EntryBase {
  type: "custom_message";
  customType: string;
  content: string | ContentBlock[];
  display?: boolean;
  details?: unknown;
}

export interface LabelEntry extends EntryBase {
  type: "label";
  targetId: string;
  label?: string;
}

export interface SessionInfoEntry extends EntryBase {
  type: "session_info";
  name: string;
}

export type SessionEntry =
  | MessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | UsageEntry
  | CompactionEntry
  | ContextEditEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry
  | EntryBase;
