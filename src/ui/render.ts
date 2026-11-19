/**
 * 面板渲染的基础件：边框、标题栏、可滚动视口。
 *
 * 不直接用 pi-tui 的 Box/ScrollView 的原因：
 * pi-tui 的滚动视图绑定 TUI 实例与 alt-screen 布局，而本应用是
 * 「多面板 + 键盘驱动 + 自己管焦点」的结构，自己实现视口更可控，
 * 也更容易做「跟随选中项滚动」「百分比滚动条」这类交互。
 *
 * 但仍然复用 pi-tui 的 visibleWidth / truncateToWidth（见 text.ts），
 * 保证 CJK 宽度和 ANSI 序列处理正确。
 */
import { padEnd, truncate, visibleWidth, wrap } from "./text.ts";
import { theme } from "./theme.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 画一个带标题的面板边框。
 *
 * 输出 height 行、每行 width 列。标题嵌在上边框里，
 * 右侧可放一小段状态（如 `12/30`）。
 */
export function drawPanel(
  rect: Rect,
  title: string,
  rightHint: string,
  body: string[],
  focused: boolean,
): string[] {
  const { width, height } = rect;
  if (width < 4 || height < 2) return body.slice(0, Math.max(0, height));

  const borderStyle = focused ? theme.borderFocus : theme.border;
  const innerW = width - 2;
  const lines: string[] = [];

  // 上边框：╭─ 标题 ───── 右提示 ─╮
  const titleText = title ? ` ${title} ` : "";
  const hintText = rightHint ? ` ${rightHint} ` : "";
  const fillW = Math.max(0, innerW - visibleWidth(titleText) - visibleWidth(hintText));
  lines.push(
    borderStyle("╭") +
      (titleText ? (focused ? theme.accentStrong(titleText) : theme.muted(titleText)) : "") +
      borderStyle("─".repeat(fillW)) +
      (hintText ? theme.faint(hintText) : "") +
      borderStyle("╮"),
  );

  // 内容区
  const bodyH = height - 2;
  for (let i = 0; i < bodyH; i++) {
    const raw = body[i] ?? "";
    const t = truncate(raw, innerW, "");
    lines.push(borderStyle("│") + padEnd(t, innerW) + borderStyle("│"));
  }

  // 下边框
  lines.push(borderStyle("╰") + borderStyle("─".repeat(innerW)) + borderStyle("╯"));
  return lines;
}

/**
 * 垂直滚动视图：给定内容行、选中行、可视高度，产出要渲染的行。
 *
 * 关键行为（决定「手感」好不好）：
 *   - 选中项永远可见（必要时把视口推过去）
 *   - 尽量保持视口稳定，不因为选中相邻项就跳
 *   - 内容比视口短时不滚动
 */
export class Viewport {
  /** 当前视口顶部在内容里的行号。 */
  offset = 0;
  /** 选中行（内容坐标）。 */
  cursor = 0;
  /** 高度不够时是否优先保证光标可见。 */
  private readonly followCursor: boolean;

  constructor(followCursor = true) {
    this.followCursor = followCursor;
  }

  /** 内容或视口变化后调用，修正 offset。 */
  sync(total: number, height: number): void {
    this.cursor = clamp(this.cursor, 0, Math.max(0, total - 1));
    if (!this.followCursor) {
      this.offset = clamp(this.offset, 0, Math.max(0, total - height));
      return;
    }
    const h = Math.max(1, height);
    if (this.cursor < this.offset) this.offset = this.cursor;
    else if (this.cursor >= this.offset + h) this.offset = this.cursor - h + 1;
    this.offset = clamp(this.offset, 0, Math.max(0, total - h));
  }

  /** 移动光标。 */
  move(delta: number, total: number, height: number): boolean {
    const next = clamp(this.cursor + delta, 0, Math.max(0, total - 1));
    const changed = next !== this.cursor;
    this.cursor = next;
    this.sync(total, height);
    return changed || delta !== 0;
  }

  /** 直接定位。 */
  goto(index: number, total: number, height: number): void {
    this.cursor = clamp(index, 0, Math.max(0, total - 1));
    this.sync(total, height);
  }

  /** 当前可见范围的 [from, to)。 */
  window(total: number, height: number): [number, number] {
    const h = Math.max(0, height);
    const from = clamp(this.offset, 0, Math.max(0, total - h));
    return [from, Math.min(total, from + h)];
  }

  /** 页容量（PageUp/PageDown 步长）。 */
  pageSize(height: number): number {
    return Math.max(1, height - 1);
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 把长文本按宽度换行并对齐到面板内边距。
 * 用于详情面板这类「一段话折行展示」的场景。
 */
export function padLines(text: string, width: number, indent = 0): string[] {
  const pre = " ".repeat(indent);
  const w = Math.max(1, width - indent);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    for (const l of wrap(para, w)) out.push(pre + l);
  }
  return out;
}

/** 横向分隔线。 */
export function divider(width: number, style = theme.border): string {
  return style("─".repeat(Math.max(0, width)));
}

/**
 * 迷你柱状图（用于工具分布）。
 * 用块字符而不是 ASCII，视觉密度更高。
 */
export function bar(value: number, max: number, width: number): string {
  if (max <= 0 || width <= 0) return "";
  const ratio = Math.min(1, value / max);
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}
