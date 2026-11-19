/**
 * 键盘输入解析。
 *
 * 不用 readline 的 keypress：它吞掉 Escape、不区分 Ctrl 组合、
 * 也不提供「裸 ESC 键 vs 转义序列开头」的区分 —— 而 ESC 是 TUI 的
 * 「返回」键，必须可靠。
 *
 * 这里自己读原始字节并解析成具名 key。pi-tui 的 matchesKey 也能用，
 * 但它绑定它的 TUI 实例与 kitty 协议协商；本应用只要基础能力，
 * 自解析更可控，也更容易在 SSH/老终端上稳定工作。
 */

export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "escape"
  | "tab"
  | "backtab"
  | "backspace"
  | "delete"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "space"
  | "unknown";

export type KeyEvent =
  | { type: "key"; name: KeyName }
  | { type: "ctrl"; char: string }
  | { type: "char"; char: string }
  | { type: "paste"; text: string }
  | { type: "resize" };

const ESC = "\x1b";

/**
 * 把一段 stdin 数据切成多个 key 事件。
 *
 * 注意：裸 ESC 与转义序列前缀都是 0x1b，无法从单次数据判断。
 * 调用方需要做「ESC 延迟判定」：收到 0x1b 后等一小会儿，
 * 没有后续字节才当作 ESC 键。见 Keyboard 类。
 */
export function parseKeys(data: string): KeyEvent[] {
  const out: KeyEvent[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;

    if (ch === ESC) {
      // 转义序列
      const rest = data.slice(i);
      const m = matchSequence(rest);
      if (m) {
        out.push(m.event);
        i += m.length;
        continue;
      }
      // 单独 ESC
      out.push({ type: "key", name: "escape" });
      i += 1;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      out.push({ type: "key", name: "enter" });
      i += 1;
      continue;
    }
    if (ch === "\t") {
      out.push({ type: "key", name: "tab" });
      i += 1;
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      out.push({ type: "key", name: "backspace" });
      i += 1;
      continue;
    }
    if (ch === " ") {
      out.push({ type: "key", name: "space" });
      i += 1;
      continue;
    }

    const code = ch.codePointAt(0) ?? 0;
    // Ctrl 组合：0x01-0x1a（排除已处理的 \t \r \n）
    if (code >= 1 && code <= 26) {
      out.push({ type: "ctrl", char: String.fromCharCode(code + 96) });
      i += 1;
      continue;
    }

    // 普通字符（含多字节）
    const cp = data.codePointAt(i) ?? 0;
    const s = String.fromCodePoint(cp);
    out.push({ type: "char", char: s });
    i += s.length;
  }
  return out;
}

function matchSequence(s: string): { event: KeyEvent; length: number } | null {
  const table: [RegExp, KeyName][] = [
    [/^\x1b\[A/, "up"],
    [/^\x1b\[B/, "down"],
    [/^\x1b\[C/, "right"],
    [/^\x1b\[D/, "left"],
    [/^\x1bOA/, "up"],
    [/^\x1bOB/, "down"],
    [/^\x1bOC/, "right"],
    [/^\x1bOD/, "left"],
    [/^\x1b\[H/, "home"],
    [/^\x1b\[F/, "end"],
    [/^\x1b\[1~/, "home"],
    [/^\x1b\[4~/, "end"],
    [/^\x1b\[7~/, "home"],
    [/^\x1b\[8~/, "end"],
    [/^\x1b\[3~/, "delete"],
    [/^\x1b\[5~/, "pageup"],
    [/^\x1b\[6~/, "pagedown"],
    [/^\x1b\[Z/, "backtab"],
    // 带修饰键的移动（如 ctrl+up），统一按方向处理
    [/^\x1b\[1;[0-9]+A/, "up"],
    [/^\x1b\[1;[0-9]+B/, "down"],
    [/^\x1b\[1;[0-9]+C/, "right"],
    [/^\x1b\[1;[0-9]+D/, "left"],
    [/^\x1b\[1;[0-9]+H/, "home"],
    [/^\x1b\[1;[0-9]+F/, "end"],
  ];
  for (const [re, name] of table) {
    const m = s.match(re);
    if (m) return { event: { type: "key", name }, length: m[0].length };
  }
  return null;
}

/** 便于人类阅读的按键说明（用于帮助页）。 */
export const KEY_HELP: [string, string][] = [
  ["↑ / ↓", "在列表 / 时间轴 / 问题之间移动"],
  ["→ / ←", "时间轴：进入下一个元素 / 回到上一层"],
  ["Enter", "打开会话 / 跳到问题现场"],
  ["Tab", "切换 时间轴 ⇄ 问题面板（压缩视图内切右栏视角）"],
  ["c", "查看上下文压缩：摘要 ⟷ 被压缩原文 ⟷ 漏词核对"],
  ["/", "搜索会话（Esc 取消）"],
  ["空格", "列表页：只看有问题的会话"],
  ["j / k", "滚动详情面板"],
  ["g / G", "跳到首 / 尾"],
  ["n / N", "跳到下一个 / 上一个问题（压缩视图内切第N次压缩）"],
  ["r", "重新加载当前会话"],
  ["?", "显示 / 隐藏本帮助"],
  ["q", "退出（Esc 也退出当前层）"],
];
