/**
 * SessionLoop 分段：把 turn 列表切成「一轮用户请求」为单位的段。
 *
 * 为什么需要分段而不是一条时间轴到底：
 *   1. 用户真正关心的粒度通常是「我这次问了什么 → agent 怎么做的」，
 *      一次会话里可能问了好几条完全不相干的需求。
 *   2. compaction 是硬边界 —— 压缩之后模型已经看不到之前的原文，
 *      把跨压缩的 turn 混成一串会误导定位。
 *
 * 切分规则：user 消息开启新段；compaction 单独成段（标记为断点），
 * 因为它不隶属于任何一条用户请求，但会改变后续所有请求的上下文。
 */
import type { Segment, Turn } from "./model.ts";
import { buildAgentLoops } from "./loops.ts";
import type { SegmentPrompt } from "./prompts.ts";
import type { Usage } from "./types.ts";
import { splitUserText } from "./parser.ts";

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

export interface SegmentBoundary {
  /** 这段属于哪个 turn 区间 [from, to)。 */
  fromTurn: number;
  toTurn: number;
  /** 开段的用户消息（段首无用户消息时为空，例如压缩后被截断）。 */
  prompt: SegmentPrompt | null;
  /** 起始时间。 */
  startAt: string;
  offsetMs: number;
  /** 是否由 compaction 开启。 */
  afterCompaction: boolean;
}

/** 构建结果：分段 + 每个 turn 归属的 prompt（供 UI 显示段首提问）。 */
export interface SegmentBuild {
  segments: Segment[];
  /** turnIndex → prompt（该 turn 之前的那条用户消息）。 */
  promptByTurn: Map<number, SegmentPrompt>;
}

/**
 * 主分段函数。
 *
 * @param turns   已构建的 turn 列表
 * @param prompts 用户提问（按出现顺序）
 */
export function buildSegments(turns: Turn[], prompts: SegmentPrompt[]): Segment[] {
  return buildSegmentsDetailed(turns, prompts).segments;
}

/** 同 buildSegments，额外返回 turn→prompt 映射。 */
export function buildSegmentsDetailed(
  turns: Turn[],
  prompts: SegmentPrompt[],
): SegmentBuild {
  const bounds: SegmentBoundary[] = [];

  // 每个 prompt 记录它出现在哪个 turn 之前。
  // 用户消息在 jsonl 里位于两个 turn 之间，用时间戳定位它属于哪个 turn 边界。
  const promptTurnIndex = locatePrompts(turns, prompts);

  let curFrom = 0;
  let curPrompt: SegmentPrompt | null = null;
  let afterCompaction = false;

  const flush = (to: number) => {
    if (to <= curFrom) return;
    const t0 = turns[curFrom];
    if (!t0) return;
    // 段首 prompt：优先用记录的，否则从 promptTurnIndex 里回溯最近的
    let p = curPrompt;
    if (!p) p = nearestPromptBefore(promptTurnIndex, curFrom);
    bounds.push({
      fromTurn: curFrom,
      toTurn: to,
      prompt: p,
      startAt: t0.startAt,
      offsetMs: t0.offsetMs,
      afterCompaction,
    });
  };

  // 压缩 step 所在的 turn 是一个天然边界：压缩之后重置
  const compactionTurns = new Set<number>();
  for (const t of turns) {
    if (t.steps.some((s) => s.kind === "compaction")) compactionTurns.add(t.index);
  }

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn) continue;
    const p = promptTurnIndex.get(i);

    // 有新的用户提问，且当前段已有内容 → 收口
    if (p !== undefined && (i > curFrom || curPrompt !== null)) {
      flush(i);
      curFrom = i;
      curPrompt = p;
    } else if (i === 0) {
      curPrompt = p ?? null;
    }

    // 压缩 turn 之后开启新段
    if (compactionTurns.has(i) && i + 1 < turns.length) {
      flush(i + 1);
      curFrom = i + 1;
      curPrompt = promptTurnIndex.get(i + 1) ?? null;
      afterCompaction = true;
    }
  }
  flush(turns.length);


  // 组装成 Segment
  const segs: Segment[] = bounds.map((b, idx) => {
    const turnList = turns.slice(b.fromTurn, b.toTurn);
    const usage = EMPTY_USAGE();
    let steps = 0;
    let tools = 0;
    let errors = 0;
    let asks = 0;
    let peak = 0;
    for (const t of turnList) {
      addUsage(usage, t.usage);
      steps += t.steps.length;
      peak = Math.max(peak, t.contextTokens || 0);
      for (const s of t.steps) {
        if (s.kind === "tool_call") tools++;
        if (s.kind === "ask") asks++;
        if (s.kind === "tool_call" && s.isError) errors++;
        if (s.kind === "tool_result" && s.isError) errors++;
      }
    }
    const last = turnList[turnList.length - 1];
    return {
      index: idx,
      prompt: b.prompt?.user ?? "(无用户提问 — 上下文裁切或续跑)",
      systemPromptTail: b.prompt?.system || undefined,
      startAt: b.startAt,
      endAt: last?.endAt ?? b.startAt,
      offsetMs: b.offsetMs,
      turns: turnList,
      loops: [],
      usage,
      afterCompaction: b.afterCompaction,
      peakContextTokens: peak,
      turnCount: turnList.length,
      stepCount: steps,
      toolCallCount: tools,
      errorCount: errors,
      askCount: asks,
    };
  });

  // offsetMs 归一化：以会话首个 turn 为 0
  const base = turns[0]?.offsetMs ?? 0;
  for (const s of segs) {
    s.offsetMs = s.offsetMs - base;
    for (const t of s.turns) {
      t.offsetMs = t.offsetMs - base;
      for (const st of t.steps) st.offsetMs = st.offsetMs - base;
    }
  }
  // 段与 turn 的 offset 归一化完成后再切 agent loop，
  // 这样 loop 内部的迭代序号与时间轴顺序一致
  for (const seg of segs) {
    seg.loops = buildAgentLoops(seg.turns, seg.index, seg.prompt);
  }

  return { segments: segs, promptByTurn: promptTurnIndex };
}

/** 找 <= turnIndex 的最近一条 prompt。 */
function nearestPromptBefore(
  map: Map<number, SegmentPrompt>,
  turnIndex: number,
): SegmentPrompt | null {
  let best: SegmentPrompt | null = null;
  let bestIdx = -Infinity;
  for (const [idx, p] of map) {
    if (idx <= turnIndex && idx > bestIdx) {
      best = p;
      bestIdx = idx;
    }
  }
  return best;
}


/**
 * 把用户提问定位到「它之后第一个 turn」的下标。
 *
 * jsonl 里 user 消息有 timestamp，turn 也有 startAt。这里用时间戳比较，
 * 而不是依赖「user 一定紧邻 assistant」——上下文编辑/裁剪后未必紧邻。
 *
 * 边界约定：prompt 时间 <= turn.startAt 时归到该 turn。
 * 压缩后第一条用户消息可能早于新 turn 的 startAt（因为压缩条目本身
 * 占了时间），所以用 <= 而不是 <，否则会错归到前一段。
 */
function locatePrompts(turns: Turn[], prompts: SegmentPrompt[]): Map<number, SegmentPrompt> {
  const out = new Map<number, SegmentPrompt>();
  if (turns.length === 0) return out;
  for (const p of prompts) {
    const pt = p.atMs;
    let idx = -1;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (!t) continue;
      const tt = Date.parse(t.startAt);
      if (Number.isFinite(tt) && tt >= pt) {
        idx = i;
        break;
      }
    }
    if (idx < 0) idx = turns.length - 1;
    // 同一 turn 有多个 prompt 时保留最后一个（后续提问更重要）
    out.set(idx, p);
  }
  return out;
}


/** 从 user 消息文本构造 prompt。 */
export function makePrompt(raw: string, atIso: string): SegmentPrompt {
  const { user, system } = splitUserText(raw);
  return {
    user: user || raw.trim(),
    system,
    at: atIso,
    atMs: Date.parse(atIso) || 0,
  };
}
