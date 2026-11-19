/**
 * 终端文本宽度与裁剪。
 *
 * 这是 TUI 正确性的地基：pi 的会话是**中文**为主，全角字符占 2 列。
 * 如果按 `str.length` 算宽度，所有对齐、边框、截断都会错位，
 * 表现为「表格线歪了」「文字溢出到下一行」。
 *
 * 实现上优先复用 pi-tui 的 visibleWidth / truncateToWidth（它依赖
 * get-east-asian-width，CJK 覆盖完整），拿不到时退回到本地实现，
 * 保证降级模式（--plain）也能正常排版。
 */

let piVisibleWidth: ((s: string) => number) | null = null;
let piTruncate: ((s: string, w: number, ellipsis?: string) => string) | null = null;
let piWrap: ((s: string, w: number) => string[]) | null = null;

/** 由启动流程注入 pi-tui 的实现（避免本模块强依赖 pi-tui）。 */
export function setWidthImpl(impl: {
  visibleWidth?: (s: string) => number;
  truncateToWidth?: (s: string, w: number, ellipsis?: string) => string;
  wrapTextWithAnsi?: (s: string, w: number) => string[];
}): void {
  piVisibleWidth = impl.visibleWidth ?? null;
  piTruncate = impl.truncateToWidth ?? null;
  piWrap = impl.wrapTextWithAnsi ?? null;
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * 字符宽度（本地兜底实现）。
 *
 * 覆盖范围：CJK 统一表意文字、假名、谚文、全角标点、emoji。
 * 不做组合字符的精细处理 —— pi-tui 在场时不会走到这里。
 */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // 组合附加符号
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 + 标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名、注音、兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(s: string): number {
  if (piVisibleWidth) return piVisibleWidth(s);
  const t = stripAnsi(s);
  let w = 0;
  for (const ch of t) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

export function padEnd(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : " ".repeat(width - w) + s;
}

/** 按显示宽度截断，默认加省略号。 */
export function truncate(s: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (piTruncate) return piTruncate(s, width, ellipsis);
  if (visibleWidth(s) <= width) return s;

  const ellW = visibleWidth(ellipsis);
  const budget = Math.max(0, width - ellW);
  let out = "";
  let w = 0;
  // 逐字符前进，但保留 ANSI 序列（不能简单按 code unit 切）
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const m = rest.match(/^\x1b\[[0-9;]*[a-zA-Z]/);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + ellipsis;
}

/** 按显示宽度换行；保留 ANSI 序列。 */
export function wrap(s: string, width: number): string[] {
  if (width <= 0) return [s];
  if (piWrap) return piWrap(s, width);
  const lines: string[] = [];
  for (const rawLine of s.split("\n")) {
    if (visibleWidth(rawLine) <= width) {
      lines.push(rawLine);
      continue;
    }
    let cur = "";
    let w = 0;
    let i = 0;
    while (i < rawLine.length) {
      const rest = rawLine.slice(i);
      const m = rest.match(/^\x1b\[[0-9;]*[a-zA-Z]/);
      if (m) {
        cur += m[0];
        i += m[0].length;
        continue;
      }
      const cp = rawLine.codePointAt(i) ?? 0;
      const ch = String.fromCodePoint(cp);
      const cw = charWidth(cp);
      if (w + cw > width) {
        lines.push(cur);
        cur = "";
        w = 0;
      }
      cur += ch;
      w += cw;
      i += ch.length;
    }
    if (cur) lines.push(cur);
  }
  return lines.length > 0 ? lines : [""];
}

/** 人类可读的 token 数。 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

/** 人类可读的耗时。 */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/** 人类可读的文件大小。 */
export function fmtBytes(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + "G";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + "M";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + "K";
  return `${n}B`;
}

/** ISO 时间 → 本地 `MM-DD HH:mm`。 */
export function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ISO 时间 → 本地 `MM-DD HH:mm:ss`。 */
export function fmtTimeSec(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 相对时间（`3小时前`）。 */
export function fmtAgo(ms: number, now = Date.now()): string {
  if (!ms) return "—";
  const d = now - ms;
  if (d < 0) return "刚刚";
  const min = Math.floor(d / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day}天前`;
  return `${Math.floor(day / 30)}个月前`;
}
