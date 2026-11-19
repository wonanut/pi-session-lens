/**
 * 把线性 entry 序列归并成 AgentLoop turn。
 *
 * 归并规则（对应 pi 的真实行为）：
 *   - 一条 assistant 消息 = 一个 turn 的「模型响应」
 *   - 紧跟其后的 toolResult = 这个 turn 的工具执行阶段
 *   - 直到下一条 assistant 消息为止，都属于同一个 turn
 *
 * 必须按 turn 归并而不是把每条消息铺平：pi 一次 assistant 响应可能带多个
 * toolCall（真实数据里见过一次 2 个并行），拆进同一 turn 才能看出
 * 「模型一次决策了几个动作」。铺平后调用与结果会被消息顺序打散。
 */
import {
  estimateTokens,
  messageText,
  thinkingText,
  toolCalls,
  toolResultJson,
} from "./parser.ts";
import { buildCompactionDetails } from "./compaction.ts";
import type { Turn, Step } from "./model.ts";
import type {
  AssistantMessage,
  CompactionEntry,
  EntryBase,
  SessionEntry,
  ToolResultMessage,
} from "./types.ts";

export interface TurnBuildInput {
  /** 线性 entry 序列（已按分支排好）。 */
  entries: SessionEntry[];
  /** 会话开始时间（ISO），用于算 offset。 */
  sessionStart: number;
}

const isoMs = (s: string | undefined): number => {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

/** 工具类别：用于 UI 上区分来源。 */
export function toolKindOf(name: string): string {
  if (/(knowledge|spec|exp_|feature|validate|render|ask|check|plan)/.test(name)) return "mml";
  if (name === "bash" || name === "shell") return "shell";
  if (/(read|write|edit|glob|grep|ls)/.test(name)) return "fs";
  return "other";
}

/** 是否属于「向用户提问」的工具。 */
export function isAskTool(name: string): boolean {
  return /ask_(user|params)$/.test(name) || /ask_/.test(name);
}

/**
 * 从工具结果里提炼一行摘要。
 *
 * 不同工具返回结构不同，这里做通用抽取：优先 error/ok，
 * 其次找数量类字段。显式失败的返回要把 error 全文带出来 ——
 * 那正是用户要定位的东西，截断成 80 字符就没用了。
 */
export function summarizeToolResult(
  tool: string,
  raw: string,
  isError: boolean,
): { brief: string; chars: number; outcome: ToolOutcome } {
  const chars = raw.length;
  const obj = safeJson(raw);

  // 先判「语义失败」，因为它比 isError 更准确地反映了业务结果。
  // 同一个 isError=true 的返回可能是三种完全不同的东西：
  //   1. 知识库查无此命令 —— 检索无结果，是**有效结论**，不是故障
  //   2. 缺必填参数 / 参数非法 —— 需要补齐或改正
  //   3. 工具真的挂了（网络、超时、未执行）
  // 全部当成 error 会让问题面板充满噪音，把真正要看的东西淹掉。
  const semantic = classifyFailure(raw, obj);

  if (semantic === "not_found") {
    return { brief: `查无: ${notFoundDetail(obj, raw)}`, chars, outcome: "not_found" };
  }
  if (semantic === "step_gap") {
    return { brief: `步骤核对: ${stepGapDetail(obj)}`, chars, outcome: "step_gap" };
  }
  if (semantic === "missing_params") {
    return {
      brief: `缺参数: ${paramDetail(obj)}`,
      chars,
      outcome: "missing_params",
    };
  }
  if (semantic === "invalid_params") {
    return {
      brief: `参数非法: ${paramDetail(obj)}`,
      chars,
      outcome: "invalid_params",
    };
  }

  if (isError) {
    const err =
      (obj && (str(obj.error) || str(obj.message))) || raw.trim().slice(0, 300) || "(无错误信息)";
    return { brief: `ERROR: ${err}`, chars, outcome: "real_error" };
  }
  if (!obj) {
    const one = raw.trim().replace(/\s+/g, " ").slice(0, 160);
    return { brief: one || "(空返回)", chars, outcome: "ok" };
  }

  const bits: string[] = [];
  for (const k of [
    "query",
    "command_name",
    "feature_name",
    "site_type",
    "status",
    "risk_level",
    "total",
    "count",
    "valid_lines",
    "steps_count",
    "step_count",
    "param_count",
  ]) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") bits.push(`${k}=${str(v) || v}`);
  }
  for (const k of ["hits", "commands", "features", "parameters", "results", "names", "items"]) {
    const v = obj[k];
    if (Array.isArray(v)) bits.push(`${k}:${v.length}`);
  }
  if (obj.ok === true && bits.length === 0) bits.push("ok");
  const brief = bits.join("  ") || raw.trim().replace(/\s+/g, " ").slice(0, 160);
  return { brief, chars, outcome: "ok" };
}

/** 工具返回的语义结果。 */
export type ToolOutcome =
  | "ok"
  | "not_found" // 知识库查无此命令/特性：检索无结果，属正常业务结论
  | "step_gap" // 步骤核对发现漏步骤：业务结论
  | "missing_params" // 缺必填参数
  | "invalid_params" // 参数取值非法
  | "real_error"; // 工具真的执行失败

/** 哪些 outcome 属于「需要人工干预的问题」。 */
export function outcomeIsProblem(o: ToolOutcome): boolean {
  return o === "real_error" || o === "missing_params" || o === "invalid_params";
}

function classifyFailure(raw: string, obj: Record<string, unknown> | null): ToolOutcome | null {
  const errText = obj ? `${str(obj.error)} ${str(obj.hint)} ${str(obj.message)}` : "";
  const hay = `${errText} ${raw.slice(0, 2000)}`;

  // 1. 知识库查无此命令/特性。这类返回形如
  //    {"ok":false,"error":"知识库中没有命令 ADD SESSION（站点 UEG-S）"}
  //    {"ok":false,"error":"不支持的命令: ADD L7FILTER","supported":[...]}
  if (
    /知识库里?没有(命令|特性)|知识库中没有命令|不支持的命令|不支持的特性|没有找到该命令/.test(
      hay,
    ) ||
    (obj && obj.ok === false && Array.isArray(obj.supported))
  ) {
    return "not_found";
  }

  // 2. 步骤核对：feature_steps 传 produced 后返回 missing 列表，
  //    ok=false 表示「有步骤没覆盖」，这是业务核对结论，不是工具故障。
  if (obj && Array.isArray(obj.missing) && Array.isArray(obj.covered)) {
    return "step_gap";
  }

  // 3. 参数问题。
  // ⚠ 必须判断「字段是否非空」：成功的返回里也会带
  //   "missing_required": [] / "errors": [] 这类空数组字段，
  //   只按字段名匹配会把成功当成失败（实测误报 4 条）。
  if (hasNonEmptyList(obj, "missing_required")) {
    return "missing_params";
  }
  if (hasNonEmptyList(obj, "param_errors") || /param_errors"\s*:\s*\[\s*\{/.test(raw)) {
    return "invalid_params";
  }
  if (
    /RENDER_FAILED|渲染失败/.test(hay) ||
    (obj && typeof obj.invalid === "number" && obj.invalid > 0) ||
    (obj && typeof obj.failed === "number" && obj.failed > 0)
  ) {
    return "invalid_params";
  }
  // 批量渲染里某一项失败：results[].ok === false
  if (obj && Array.isArray(obj.results)) {
    const bad = obj.results.filter(
      (r) => r && typeof r === "object" && (r as Record<string, unknown>).ok === false,
    );
    if (bad.length > 0) {
      const anyMissing = bad.some((r) =>
        hasNonEmptyList(r as Record<string, unknown>, "missing_required"),
      );
      return anyMissing ? "missing_params" : "invalid_params";
    }
  }

  return null;
}

/** 字段存在且是非空数组。 */
function hasNonEmptyList(o: Record<string, unknown> | null, key: string): boolean {
  if (!o) return false;
  const v = o[key];
  return Array.isArray(v) && v.length > 0;
}

/** 从「查无」返回里取出关键信息：查的是什么。 */
function notFoundDetail(obj: Record<string, unknown> | null, raw: string): string {
  if (!obj) return raw.trim().replace(/\s+/g, " ").slice(0, 120);
  const target =
    str(obj.command_name) || str(obj.feature_name) || extractQuoted(str(obj.error)) || "";
  const site = str(obj.site_type);
  const err = str(obj.error) || "查无结果";
  return `${target ? target + " " : ""}${site ? `(${site}) ` : ""}${err}`.trim();
}

/** 步骤核对结论：漏了哪几步。 */
function stepGapDetail(obj: Record<string, unknown> | null): string {
  if (!obj) return "步骤核对未通过";
  const total = obj.total_steps ?? obj.step_count ?? "?";
  const covered = Array.isArray(obj.covered) ? obj.covered.length : "?";
  const missing = Array.isArray(obj.missing) ? obj.missing : [];
  const names = missing
    .slice(0, 4)
    .map((m) => {
      const o = m as Record<string, unknown>;
      return `${str(o.step)}${o.title ? " " + str(o.title) : ""}`;
    })
    .join("、");
  return `${covered}/${total} 步已覆盖${names ? `，缺 ${names}` : ""}`;
}

/** 参数问题的具体条目。 */
function paramDetail(obj: Record<string, unknown> | null): string {
  if (!obj) return "参数不完整";
  const list: string[] = [];
  if (Array.isArray(obj.missing_required)) {
    list.push(...obj.missing_required.map((x) => str(x)).filter(Boolean));
  }
  if (Array.isArray(obj.param_errors)) {
    for (const e of obj.param_errors.slice(0, 4)) {
      const o = e as Record<string, unknown>;
      list.push(`${str(o.param) || str(o.name) || "?"}: ${str(o.message) || str(o.error) || ""}`);
    }
  }
  if (Array.isArray(obj.results)) {
    for (const r of obj.results) {
      const o = r as Record<string, unknown>;
      if (o.ok === false) {
        const mr = Array.isArray(o.missing_required) ? o.missing_required.map(str) : [];
        if (mr.length) list.push(`${str(o.command_name)} 缺 ${mr.join(",")}`);
        else if (str(o.error)) list.push(`${str(o.command_name)}: ${str(o.error)}`);
      }
    }
  }
  const uniq = [...new Set(list)].slice(0, 20);
  return uniq.length ? uniq.join("; ") : str(obj.error) || "参数不合法";
}

/** 从「知识库中没有命令 ADD SESSION（站点 UEG-S）」里取出 ADD SESSION。 */
function extractQuoted(s: string): string {
  const m = s.match(/(?:命令|特性)\s*[:：]?\s*([A-Z][A-Z0-9 ]+[A-Z0-9])/);
  return m ? m[1]!.trim() : "";
}

function safeJson(raw: string): Record<string, unknown> | null {
  const t = raw.trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const o = JSON.parse(t.slice(s, e + 1)) as unknown;
    if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/**
 * 主构建函数：entry[] → Turn[]。
 *
 * 同时维护 callId → 已发起的 tool_call step 映射，等 toolResult 到来时
 * 回填结果到同一个 step 上。这样 UI 上一个工具就是「一行」，
 * 点开看参数和结果，而不是拆成两条互不相干的消息。
 */
export function buildTurns({ entries, sessionStart }: TurnBuildInput): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  // callId → { turn, step }
  const pending = new Map<string, { turn: Turn; step: Step }>();
  let turnIdx = 0;

  // 压缩详情：一次性算出所有 compaction 吞掉的范围（避免每处重复推导）
  const compactionDetails = buildCompactionDetails(entries);

  const newTurn = (at: number, iso: string): Turn => {
    const t: Turn = {
      index: turnIdx++,
      steps: [],
      startAt: iso,
      endAt: iso,
      offsetMs: at ? at - sessionStart : 0,
      durationMs: 0,
      hasError: false,
    };
    turns.push(t);
    return t;
  };

  const pushStep = (turn: Turn, s: Step): Step => {
    turn.steps.push(s);
    return s;
  };

  for (const e of entries) {
    const base = e as EntryBase;
    const iso = typeof base.timestamp === "string" ? base.timestamp : "";
    const at = isoMs(iso);
    const entryId = typeof base.id === "string" ? base.id : "";

    if (e.type === "compaction") {
      const c = e as CompactionEntry;
      const turn = cur ?? newTurn(at, iso);
      const step: Step = {
        key: `${turn.index}:${turn.steps.length}`,
        kind: "compaction",
        entryId,
        at: iso,
        offsetMs: at ? at - sessionStart : 0,
        text: c.summary,
        approxTokens: estimateTokens(c.summary),
        compaction: compactionDetails.get(entryId),
      };
      pushStep(turn, step);
      turn.endAt = iso;
      turn.durationMs = at - isoMs(turn.startAt);
      cur = null; // 压缩后必然由下一条 user 开启新一轮
      continue;
    }

    if (e.type !== "message") continue;
    const m = (e as { message?: Record<string, unknown> }).message;
    if (!m || typeof m !== "object") continue;
    const role = str(m.role);

    // ---- assistant：新 turn ----
    if (role === "assistant") {
      const am = m as unknown as AssistantMessage;
      const turn = newTurn(at, iso);
      cur = turn;
      turn.model = am.model;
      turn.provider = am.provider;
      turn.usage = am.usage;
      turn.stopReason = am.stopReason;
      turn.thinkingLevel = am.thinkingLevel;
      turn.modelDurationMs = am.durationMs;
      if (am.usage) {
        turn.contextTokens = (am.usage.input || 0) + (am.usage.cacheRead || 0);
      }

      const th = thinkingText(am.content).trim();
      if (th) {
        pushStep(turn, {
          key: `${turn.index}:${turn.steps.length}`,
          kind: "thinking",
          entryId,
          at: iso,
          offsetMs: at ? at - sessionStart : 0,
          text: th,
          approxTokens: estimateTokens(th),
        });
      }

      for (const call of toolCalls(am.content)) {
        const step: Step = {
          key: `${turn.index}:${turn.steps.length}`,
          kind: "tool_call",
          entryId,
          at: iso,
          offsetMs: at ? at - sessionStart : 0,
          tool: call.name,
          args: call.args,
          callId: call.id,
          approxTokens: estimateTokens(JSON.stringify(call.args ?? {})),
        };
        pushStep(turn, step);
        if (call.id) pending.set(call.id, { turn, step });
        if (isAskTool(call.name)) {
          const q = str(call.args?.question) || str(call.args?.intro) || str(call.args?.title) || "";
          if (q) {
            pushStep(turn, {
              key: `${turn.index}:${turn.steps.length}`,
              kind: "ask",
              entryId,
              at: iso,
              offsetMs: at ? at - sessionStart : 0,
              text: q,
              tool: call.name,
              callId: call.id,
            });
          }
        }
      }

      const pureText = Array.isArray(am.content)
        ? am.content
            .filter((b) => (b as { type?: string }).type === "text")
            .map((b) => str((b as { text?: unknown }).text))
            .join("\n")
            .trim()
        : str(m.content).trim();
      if (pureText) {
        pushStep(turn, {
          key: `${turn.index}:${turn.steps.length}`,
          kind: "text",
          entryId,
          at: iso,
          offsetMs: at ? at - sessionStart : 0,
          text: pureText,
          approxTokens: estimateTokens(pureText),
        });
      }
      continue;
    }

    // ---- toolResult：回填到对应的 tool_call ----
    if (role === "toolResult") {
      const tr = m as unknown as ToolResultMessage;
      const raw = messageText(tr.content);
      const found = tr.toolCallId ? pending.get(tr.toolCallId) : undefined;
      const toolName = tr.toolName || found?.step.tool || "(未知工具)";
      const sum = summarizeToolResult(toolName, raw, Boolean(tr.isError));

      if (found) {
        found.step.outcome = sum.outcome;
        // isError 只表示「需要干预」的失败；查无此命令不算
        found.step.isError = outcomeIsProblem(sum.outcome);
        found.step.durationMs = tr.durationMs;
        found.step.resultBrief = sum.brief;
        found.step.resultChars = sum.chars;
        found.step.approxTokens = (found.step.approxTokens || 0) + estimateTokens(raw);
        if (found.step.isError) found.turn.hasError = true;
        pending.delete(tr.toolCallId);
      } else {
        // 找不到配对的调用（会话被裁剪/上下文编辑），单独成 step 保留证据
        const turn = cur ?? newTurn(at, iso);
        const step: Step = {
          key: `${turn.index}:${turn.steps.length}`,
          kind: "tool_result",
          entryId,
          at: iso,
          offsetMs: at ? at - sessionStart : 0,
          tool: toolName,
          isError: outcomeIsProblem(sum.outcome),
          outcome: sum.outcome,
          resultBrief: sum.brief,
          resultChars: sum.chars,
          approxTokens: estimateTokens(raw),
        };
        pushStep(turn, step);
        if (step.isError) turn.hasError = true;
      }

      // 用户对提问的回答藏在 ask_user 的 toolResult 里
      if (isAskTool(toolName)) {
        const ans = extractAnswer(raw);
        if (ans) {
          const turn = found?.turn ?? cur;
          if (turn) {
            pushStep(turn, {
              key: `${turn.index}:${turn.steps.length}`,
              kind: "answer",
              entryId,
              at: iso,
              offsetMs: at ? at - sessionStart : 0,
              text: ans,
              tool: toolName,
              callId: tr.toolCallId,
            });
          }
        }
      }

      if (cur) {
        cur.endAt = iso;
        cur.durationMs = at - isoMs(cur.startAt);
      }
      continue;
    }
  }

  // 收尾：修正 endAt / duration
  for (const t of turns) {
    if (!t.endAt) t.endAt = t.startAt;
    t.durationMs = Math.max(0, isoMs(t.endAt) - isoMs(t.startAt));
  }
  return turns;
}

/** 从 ask 类工具的返回里取用户答案。 */
function extractAnswer(raw: string): string {
  const obj = safeJson(raw);
  if (obj) {
    if (obj.cancelled) return "(用户取消)";
    const a = obj.answer ?? obj.values;
    if (typeof a === "string" && a.trim()) return a.trim();
    if (a && typeof a === "object") {
      const kv = Object.entries(a as Record<string, unknown>)
        .map(([k, v]) => `${k}=${str(v)}`)
        .join(", ");
      if (kv) return kv;
    }
    if (isfalse(obj)) return "";
  }
  return raw.trim().slice(0, 200);
}

const isfalse = (o: Record<string, unknown>): boolean => o.ok === false;
