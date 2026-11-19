/**
 * 配色与图标。
 *
 * 设计取向：暗色优先、低饱和 + 高对比，关键状态用色相区分
 * （错误红、警告黄、压缩紫、成功绿）。
 *
 * 为什么集中一处：颜色散落在各组件会导致「同一状态两种颜色」，
 * 用户会以为含义不同。所有语义色只从这里取。
 */
import { bg, bold, dim, fg, italic, type Style, underline } from "./ansi.ts";

export const theme = {
  error: fg("#ff5f5f"),
  warn: fg("#ffb454"),
  info: fg("#7fb3ff"),
  ok: fg("#4ec9a0"),
  compaction: fg("#b48ead"),
  muted: fg("#7c8794"),
  faint: fg("#4b5563"),
  bright: fg("#e5e7eb"),
  white: fg("#f9fafb"),
  accent: fg("#7dd3fc"),
  accentStrong: fg("#38bdf8"),
  purple: fg("#c4b5fd"),

  toolMml: fg("#a5b4fc"),
  toolShell: fg("#fbbf24"),
  toolFs: fg("#6ee7b7"),
  toolOther: fg("#94a3b8"),

  border: fg("#3b4757"),
  borderFocus: fg("#38bdf8"),
  selBg: bg("#1e3a5f"),
  headerBg: bg("#151b24"),
  panelBg: bg("#0f141b"),

  bold,
  dim,
  italic,
  underline,
} as const;

export type Severity = "error" | "warn" | "info" | "ok";

export function severityColor(s: Severity): Style {
  switch (s) {
    case "error":
      return theme.error;
    case "warn":
      return theme.warn;
    case "info":
      return theme.info;
    case "ok":
      return theme.ok;
  }
}

export function healthColor(health: number): Style {
  if (health >= 85) return theme.ok;
  if (health >= 65) return theme.warn;
  return theme.error;
}

/** 工具类别 → 颜色。 */
export function toolColor(kind: string): Style {
  switch (kind) {
    case "mml":
      return theme.toolMml;
    case "shell":
      return theme.toolShell;
    case "fs":
      return theme.toolFs;
    default:
      return theme.toolOther;
  }
}

/** 单宽字符图标（避免 emoji 在部分终端宽度算错）。 */
export const glyph = {
  error: "✖",
  warn: "▲",
  info: "●",
  ok: "✔",
  compaction: "▣",
  thinking: "◇",
  text: "▪",
  ask: "?",
  answer: "→",
  tool: "▸",
  bullet: "·",
  arrow: "→",
  cursor: "❯",
  vline: "│",
  tee: "├",
  corner: "└",
  hline: "─",
  dot: "•",
} as const;
