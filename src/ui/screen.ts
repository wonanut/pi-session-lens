/**
 * 终端屏幕控制。
 *
 * 差分渲染：只重绘与上一帧不同的行，避免整屏闪烁。
 * 这是 TUI「手感」的关键 —— 全量重绘在慢终端（SSH）上会明显拖影。
 *
 * 使用备用屏幕（alternate screen）：退出时恢复原终端内容，
 * 不会把用户之前的 shell 输出冲掉。
 */
import { visibleWidth } from "./text.ts";

const ESC = "\x1b";

export class Screen {
  private readonly out: NodeJS.WriteStream;
  private prev: string[] = [];
  private started = false;
  private altScreen: boolean;

  constructor(out: NodeJS.WriteStream = process.stdout, altScreen = true) {
    this.out = out;
    this.altScreen = altScreen;
  }

  get width(): number {
    return Math.max(40, this.out.columns || 100);
  }

  get height(): number {
    return Math.max(10, this.out.rows || 30);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const seq: string[] = [];
    if (this.altScreen) seq.push(`${ESC}[?1049h`);
    // 隐藏光标、关闭自动换行、开启 bracketed paste
    seq.push(`${ESC}[?25l`);
    seq.push(`${ESC}[?7l`);
    seq.push(`${ESC}[?2004h`);
    seq.push(`${ESC}[2J`);
    seq.push(`${ESC}[H`);
    this.out.write(seq.join(""));
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    const seq: string[] = [];
    seq.push(`${ESC}[?2004l`);
    seq.push(`${ESC}[?7h`);
    seq.push(`${ESC}[?25h`);
    if (this.altScreen) seq.push(`${ESC}[?1049l`);
    this.out.write(seq.join(""));
  }

  /**
   * 绘制一帧。
   *
   * 逐行比较上一帧，只重绘变化的行。光标最终停在左上角，
   * 避免终端把光标留在奇怪的列导致后续输入错位。
   */
  draw(lines: string[]): void {
    if (!this.started) return;
    const h = Math.min(lines.length, this.height);
    const buf: string[] = [];
    const width = this.width;

    for (let y = 0; y < h; y++) {
      const line = lines[y] ?? "";
      const clean = visibleWidth(line) > width ? clampLine(line, width) : line;
      const prev = this.prev[y];
      if (prev === clean) continue;
      buf.push(`${ESC}[${y + 1};1H`);
      buf.push(clean);
      // 清掉该行剩余部分（防止上一帧更长的内容残留）
      buf.push(`${ESC}[K`);
      this.prev[y] = clean;
    }
    // 上一帧行数比这一帧多时，清掉多出来的行
    for (let y = h; y < this.prev.length; y++) {
      buf.push(`${ESC}[${y + 1};1H${ESC}[K`);
      this.prev[y] = "";
    }
    if (this.prev.length > h) this.prev.length = h;

    buf.push(`${ESC}[H`);
    if (buf.length > 0) this.out.write(buf.join(""));
  }

  /** 非 TTY 环境下直接打印一帧（无光标定位、无 ANSI 屏幕控制）。 */
  printOnce(lines: string[]): void {
    const width = this.width;
    const out = lines
      .slice(0, this.height)
      .map((l) => (visibleWidth(l) > width ? clampLine(l, width) : l))
      .join("\n");
    this.out.write(out + "\n");
  }

  /** 强制下一帧全量重绘（尺寸变化后用）。 */
  invalidate(): void {
    this.prev = [];
    this.out.write(`${ESC}[2J${ESC}[H`);
  }

  clear(): void {
    this.prev = [];
    this.out.write(`${ESC}[2J${ESC}[H`);
  }
}

/** 兜底裁剪：把一行压到指定显示宽度。 */
function clampLine(line: string, width: number): string {
  // 逐字符累加显示宽度，保留 ANSI
  const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/;
  let out = "";
  let i = 0;
  let w = 0;
  while (i < line.length && w < width) {
    const rest = line.slice(i);
    const m = rest.match(ANSI);
    if (m && m.index === 0) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = line.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const cw = charWidthLocal(cp);
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  out += `${ESC}[0m`;
  return out;
}

function charWidthLocal(cp: number): number {
  if (cp < 32) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}
