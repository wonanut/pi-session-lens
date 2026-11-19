/**
 * 极简 ANSI 着色工具。
 *
 * 为什么不依赖 chalk：本项目希望「零安装即可跑」（只用 Node 内置 + 复用
 * pi 自带的 pi-tui）。颜色只需要真彩色 hex，不需要 chalk 的链式 API。
 *
 * 同时负责检测 NO_COLOR / 非 TTY，自动降级为无样式，
 * 保证重定向到文件或管道时不输出乱码转义序列。
 */

const SUPPORTS_COLOR = (() => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "") return true;
  return Boolean(process.stdout.isTTY);
})();

export type Style = (s: string) => string;

const identity: Style = (s) => s;

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 前景色。 */
export function fg(hex: string): Style {
  if (!SUPPORTS_COLOR) return identity;
  const [r, g, b] = hexToRgb(hex);
  const open = `\x1b[38;2;${r};${g};${b}m`;
  return (s) => `${open}${s}\x1b[39m`;
}

/** 背景色。 */
export function bg(hex: string): Style {
  if (!SUPPORTS_COLOR) return identity;
  const [r, g, b] = hexToRgb(hex);
  const open = `\x1b[48;2;${r};${g};${b}m`;
  return (s) => `${open}${s}\x1b[49m`;
}

/** 组合前景 + 背景 + 属性。 */
export function style(opts: {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}): Style {
  if (!SUPPORTS_COLOR) return identity;
  const codes: string[] = [];
  if (opts.bold) codes.push("1");
  if (opts.dim) codes.push("2");
  if (opts.italic) codes.push("3");
  if (opts.underline) codes.push("4");
  if (opts.fg) {
    const [r, g, b] = hexToRgb(opts.fg);
    codes.push(`38;2;${r};${g};${b}`);
  }
  if (opts.bg) {
    const [r, g, b] = hexToRgb(opts.bg);
    codes.push(`48;2;${r};${g};${b}`);
  }
  if (codes.length === 0) return identity;
  const open = `\x1b[${codes.join(";")}m`;
  return (s) => `${open}${s}\x1b[0m`;
}

export const bold: Style = SUPPORTS_COLOR ? (s) => `\x1b[1m${s}\x1b[22m` : identity;
export const dim: Style = SUPPORTS_COLOR ? (s) => `\x1b[2m${s}\x1b[22m` : identity;
export const italic: Style = SUPPORTS_COLOR ? (s) => `\x1b[3m${s}\x1b[23m` : identity;
export const underline: Style = SUPPORTS_COLOR ? (s) => `\x1b[4m${s}\x1b[24m` : identity;
export const reverse: Style = SUPPORTS_COLOR ? (s) => `\x1b[7m${s}\x1b[27m` : identity;

export const colorSupported = SUPPORTS_COLOR;
