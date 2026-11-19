/**
 * 用户提问提取。
 *
 * 单独一个模块的理由：user 消息里混着「用户原话」和「系统追加说明」
 * （本项目用 "---" 分隔），而且 pi 的 bashExecution / custom 消息也可能
 * 被转成 user 角色发给模型 —— 那些不是真正的用户提问，不能当段首。
 */
import { messageText, splitUserText } from "./parser.ts";
import type { SessionEntry } from "./types.ts";

export interface SegmentPrompt {
  /** 用户原话（已剥离系统说明）。 */
  user: string;
  /** "---" 之后的系统说明。 */
  system: string;
  at: string;
  atMs: number;
}

/** 哪些 user 消息要当作「真正的用户提问」。 */
export function isRealUserPrompt(role: string, text: string): boolean {
  if (role !== "user") return false;
  const t = text.trim();
  if (!t) return false;
  // 工具结果转成 user 文本时会带明显前缀；这里保守地只看非空
  return true;
}

/** 从 entry 列表里抽出全部用户提问（按时间顺序）。 */
export function extractPrompts(entries: SessionEntry[]): SegmentPrompt[] {
  const out: SegmentPrompt[] = [];
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = (e as { message?: Record<string, unknown> }).message;
    if (!m || typeof m !== "object") continue;
    const role = typeof m.role === "string" ? m.role : "";
    if (role !== "user") continue;
    const raw = messageText(m.content);
    if (!isRealUserPrompt(role, raw)) continue;
    const iso = typeof (e as { timestamp?: unknown }).timestamp === "string"
      ? ((e as { timestamp: string }).timestamp)
      : "";
    const { user, system } = splitUserText(raw);
    out.push({
      user: user || raw.trim(),
      system,
      at: iso,
      atMs: Date.parse(iso) || 0,
    });
  }
  return out;
}
