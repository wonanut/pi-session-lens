/**
 * 压缩对比视图：摘要 ⟷ 被压缩的原文。
 *
 * 这是「模型忘了之前的要求」这类问题的唯一可靠查法。
 * pi 不保存摘要请求的 prompt，但被压缩的原文仍在文件里 ——
 * 左右并排就能逐条核对：这条约束是被摘要弄丢了，还是本来就没进来。
 *
 * 交互：
 *   ← →   列表与摘要之间切焦点（左栏原文 / 右栏摘要）
 *   ↑ ↓   在当前栏内移动
 *   Tab   在「摘要 / 原文 / 核对」三种右栏之间切换
 *   /     只显示「原文有、摘要没有」的关键词（漏词检测）
 */
import type { AppState } from "./state.ts";
import type { CompactedEntry, CompactionDetail, Step } from "../core/model.ts";
import { drawPanel, Viewport } from "./render.ts";
import { fmtTimeSec, fmtTokens, padEnd, padStart, truncate, visibleWidth, wrap } from "./text.ts";
import { glyph, theme } from "./theme.ts";

/** 右栏模式。 */
export type CompareMode = "summary" | "swallowed" | "missing";

export interface CompareState {
  mode: CompareMode;
  /** 被压缩条目列表的光标。 */
  cursor: number;
  offset: number;
  /** 右栏滚动。 */
  rightOffset: number;
}

export function newCompareState(): CompareState {
  return { mode: "summary", cursor: 0, offset: 0, rightOffset: 0 };
}

/** 找出当前会话里的压缩 step。 */
export function findCompactionSteps(state: AppState): { step: Step; label: string }[] {
  const out: { step: Step; label: string }[] = [];
  if (!state.analysis) return out;
  for (const seg of state.analysis.segments) {
    for (const turn of seg.turns) {
      for (const st of turn.steps) {
        if (st.kind === "compaction" && st.compaction) {
          out.push({ step: st, label: `#${st.compaction.ordinal} ${st.at.slice(11, 19)}` });
        }
      }
    }
  }
  return out;
}

export function renderCompactionCompare(
  state: AppState,
  cmp: CompareState,
  detail: CompactionDetail,
  titleExtra: string,
): string[] {
  const { width, height } = state;
  const bodyH = Math.max(3, height - 1);
  const leftW = Math.max(52, Math.floor(width * 0.52));
  const rightW = width - leftW - 1;

  const left = renderLeft(cmp, detail, leftW, bodyH);
  const right = renderRight(cmp, detail, rightW, bodyH);

  const out: string[] = [];
  for (let i = 0; i < bodyH; i++) {
    out.push(padEnd(left[i] ?? "", leftW) + " " + (right[i] ?? ""));
  }
  out.push(footer(state, cmp, titleExtra));
  return out;
}

// ---------------------------------------------------------------------------
// 左栏：被压缩的原文
// ---------------------------------------------------------------------------

function renderLeft(
  cmp: CompareState,
  d: CompactionDetail,
  width: number,
  height: number,
): string[] {
  const bodyH = height - 2;
  const rows = d.swallowed;
  const vp = new Viewport();
  vp.cursor = cmp.cursor;
  vp.offset = cmp.offset;
  vp.sync(rows.length, bodyH);
  cmp.cursor = vp.cursor;
  cmp.offset = vp.offset;

  const [from, to] = vp.window(rows.length, bodyH);
  const innerW = width - 2;
  const body: string[] = [];

  for (let i = from; i < to; i++) {
    const e = rows[i]!;
    body.push(renderEntryLine(e, innerW, i === vp.cursor));
  }
  if (rows.length === 0) {
    body.push(theme.faint("  (没有可展示的被压缩条目)"));
  }

  const hint = `${rows.length} 条 · ${fmtTokens(estTokens(d.swallowedChars))} 字符`;
  return drawPanel(
    { x: 0, y: 0, width, height },
    "被压缩的原文",
    hint,
    body,
    true,
  );
}

function renderEntryLine(e: CompactedEntry, width: number, selected: boolean): string {
  const roleColor =
    e.role === "user" ? theme.accent
    : e.role === "assistant" ? theme.ok
    : e.role === "toolResult" ? theme.muted
    : theme.faint;
  const roleW = 11;
  const role = roleColor(padEnd(e.role, roleW));
  const size = theme.faint(padStart(fmtChars(e.chars), 8));
  const errMark = e.isError ? theme.error(" ✖") : "  ";
  const textW = Math.max(6, width - roleW - 8 - 4);
  const oneLine = e.text.replace(/\s+/g, " ");
  const text = e.isError ? theme.error(truncate(oneLine, textW)) : truncate(oneLine, textW);

  const head = selected ? theme.accentStrong(glyph.cursor) + " " : "  ";
  const line = head + role + size + errMark + " " + text;
  return selected ? theme.selBg(padEnd(line, width)) : padEnd(line, width);
}

// ---------------------------------------------------------------------------
// 右栏
// ---------------------------------------------------------------------------

function renderRight(
  cmp: CompareState,
  d: CompactionDetail,
  width: number,
  height: number,
): string[] {
  const innerW = width - 2;
  const bodyH = height - 2;

  let body: string[] = [];
  let title = "摘要";
  if (cmp.mode === "summary") {
    body = summaryBody(d, innerW);
    title = `摘要（压缩输出）`;
  } else if (cmp.mode === "swallowed") {
    body = selectedEntryBody(d, cmp, innerW);
    title = "选中条目全文";
  } else {
    body = missingBody(d, innerW);
    title = "原文有、摘要没有";
  }

  const maxOff = Math.max(0, body.length - bodyH);
  cmp.rightOffset = Math.min(Math.max(0, cmp.rightOffset), maxOff);
  const shown = body.slice(cmp.rightOffset, cmp.rightOffset + bodyH);
  const hint =
    body.length > bodyH
      ? `${cmp.rightOffset + 1}-${Math.min(body.length, cmp.rightOffset + bodyH)}/${body.length}`
      : "";
  return drawPanel({ x: 0, y: 0, width, height }, title, hint, shown, false);
}

function summaryBody(d: CompactionDetail, width: number): string[] {
  const out: string[] = [];

  // 压缩比一目了然
  const before = d.tokensBefore;
  const after = d.summaryTokens;
  const ratio = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  out.push(
    theme.muted("压缩比 ") +
      theme.error(fmtTokens(before)) +
      theme.faint(" → ") +
      theme.ok(fmtTokens(after)) +
      theme.faint(`  省 ${ratio}%`),
  );
  out.push(
    theme.faint(
      `${d.swallowedCount} 条原文 / ${fmtTokens(estTokens(d.swallowedChars))} 字符 → 摘要 ${d.summary.length} 字符`,
    ),
  );
  if (d.usage) {
    out.push(
      theme.faint(
        `摘要调用: 输入 ${fmtTokens(d.usage.input)} tok, 输出 ${d.usage.output} tok` +
          (d.usage.reasoning ? ` (推理 ${d.usage.reasoning})` : ""),
      ),
    );
  }
  out.push(theme.faint("⚠ pi 不保存摘要请求的 prompt，「完整压缩输入」无法还原"));
  out.push(theme.border("─".repeat(Math.max(0, width))));

  for (const l of d.summary.split("\n")) {
    if (!l.trim()) {
      out.push("");
      continue;
    }
    // markdown 标题加亮，便于跳读
    if (/^#{1,6}\s/.test(l)) {
      out.push(theme.accentStrong(theme.bold(l)));
      continue;
    }
    if (/^\s*[-*]\s/.test(l)) {
      for (const w of wrap(l, width)) out.push(theme.bright(w));
      continue;
    }
    for (const w of wrap(l, width)) out.push(theme.bright(w));
  }
  return out;
}

function selectedEntryBody(d: CompactionDetail, cmp: CompareState, width: number): string[] {
  const e = d.swallowed[cmp.cursor];
  if (!e) return [theme.faint("  没有选中条目")];
  const out: string[] = [];
  out.push(
    theme.muted("类型 ") +
      theme.bright(e.role) +
      theme.faint(`  entry ${e.entryId}  ${e.chars} 字符`) +
      (e.isError ? theme.error("  ✖ 报错") : ""),
  );
  out.push(theme.border("─".repeat(Math.max(0, width))));
  out.push("");
  for (const l of e.text.split("\n")) {
    for (const w of wrap(l, width)) out.push(theme.bright(w));
  }
  out.push("");
  out.push(theme.faint("按 Tab 切到「原文有、摘要没有」看漏词核对"));
  return out;
}

// ---------------------------------------------------------------------------
// 漏词检测：原文里出现、摘要里没有的关键工件
// ---------------------------------------------------------------------------

export interface MissingTerm {
  term: string;
  /** 出现在哪些原文条目里（下标）。 */
  inEntries: number[];
  /** 出现次数。 */
  hits: number;
  kind: string;
}

/**
 * 提取「值得核对」的关键工件。
 *
 * 为什么限定这几类：压缩摘要是自然语言改写，几乎所有普通词都会「不匹配」，
 * 全量 diff 只会得到满屏噪音。真正要命的是**具体取值**——
 * 命令名、IP、对象名、KV 参数，丢一个就会生成错命令。
 * 这也符合用户的一贯要求：定位问题时看的是取值是否丢失。
 */
export function findMissingTerms(d: CompactionDetail): MissingTerm[] {
  const summary = d.summary;
  const found = new Map<string, MissingTerm>();

  const patterns: [RegExp, string][] = [
    // MML 命令名：ADD XXX / SET XXX / RMV XXX（后面必须跟结束或分隔，避免吃掉整句）
    [/\b(?:ADD|SET|RMV|DEL|MOD|LST|DSP)\s+[A-Z][A-Z0-9]{2,}(?![a-z])/g, "命令"],
    // IP / 掩码 / 前缀
    [/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2}|:\d{1,5})?\b/g, "IP"],
    // MML 参数名（KEY=VALUE 的左侧）
    [/\b[A-Z][A-Z0-9_]{2,}(?==)/g, "参数"],
    // 带点/下划线/斜杠的对象名。要求至少含一个分隔符或是已知前缀，
    // 否则整句英文词（SMF-based、mapping）都会被当成对象名。
    [/\b(?:vpn|apn|tunnel|pool|map|smf|amf|upf|laf|cmnet|CMNBIOT)[\w.\-]*[._\-][\w.*\-]+/gi, "对象"],
  ];

  // 收集原文里的工件
  for (let i = 0; i < d.swallowed.length; i++) {
    const e = d.swallowed[i]!;
    for (const [re, kind] of patterns) {
      re.lastIndex = 0;
      for (const m of e.text.matchAll(re)) {
        // 去掉尾部标点：正则会把句号/逗号一起吃进来（APNADDRESSATTR. 这类）
        const term = m[0].trim().replace(/[.,;:、，。；：]+$/, "");
        if (term.length < 3) continue;
        if (!/[\w\u4e00-\u9fff]/.test(term)) continue;
        // 对象名要求含数字（tunnel10294 / smfm004 / 173.16.0.0）或通配符，
        // 过滤 SMF-based / apn-name 这类普通英文词组
        if (kind === "对象" && !/[0-9*]/.test(term)) continue;
        const cur = found.get(term);
        if (cur) {
          cur.hits++;
          if (!cur.inEntries.includes(i)) cur.inEntries.push(i);
        } else {
          found.set(term, { term, inEntries: [i], hits: 1, kind });
        }
      }
    }
  }

  // 摘要里出现过的就不算漏（大小写不敏感比较）
  const lowerSummary = summary.toLowerCase();
  const missing = [...found.values()].filter((t) => !lowerSummary.includes(t.term.toLowerCase()));
  // 出现次数多的优先：重复出现却没进摘要，往往是关键约束
  missing.sort((a, b) => b.hits - a.hits || a.term.localeCompare(b.term));
  return missing;
}

function missingBody(d: CompactionDetail, width: number): string[] {
  const out: string[] = [];
  const missing = findMissingTerms(d);

  out.push(theme.muted("核对思路"));
  for (const l of wrap(
    "下面这些是原文里出现过、摘要里找不到的具体取值。丢命令名会生成错命令，" +
      "丢 IP/对象名会导致配错对象，丢参数名会漏填参数 —— 逐条确认是否还能接受。",
    width,
  )) {
    out.push(theme.dim(l));
  }
  out.push("");

  if (missing.length === 0) {
    out.push(theme.ok("✔ 摘要覆盖了原文中所有命令名/地址/对象名/参数名"));
    return out;
  }

  out.push(theme.warn(`共 ${missing.length} 个取值在摘要中缺失（按出现次数排序）`));
  out.push(theme.border("─".repeat(Math.max(0, width))));

  const kindColor = (k: string): ((s: string) => string) =>
    k === "命令" ? theme.accent
    : k === "IP" ? theme.info
    : k === "对象" ? theme.toolMml
    : theme.warn;

  for (const t of missing) {
    const c = kindColor(t.kind);
    out.push(
      " " +
        c(glyph.bullet) +
        " " +
        c(padEnd(t.term, Math.min(34, Math.max(12, width - 22)))) +
        theme.faint(padStart(`${t.hits}次`, 5)) +
        theme.faint(` ${t.kind}`),
    );
  }
  out.push("");
  out.push(theme.faint("按 ↑↓ 在左栏定位到相关原文，右栏切回「选中条目全文」看上下文"));
  return out;
}

// ---------------------------------------------------------------------------

function footer(state: AppState, cmp: CompareState, extra: string): string {
  const modeName =
    cmp.mode === "summary" ? "摘要" : cmp.mode === "swallowed" ? "条目全文" : "漏词核对";
  const keys: [string, string][] = [
    ["↑↓", "移动"],
    ["tab", "右栏: " + modeName],
    ["j/k", "右栏滚动"],
    ["esc", "返回"],
  ];
  const parts = keys.map(([k, d]) => theme.accent(k) + theme.faint(" " + d));
  const tail = extra ? theme.warn("  " + extra) : "";
  const line = parts.join(theme.faint(" · ")) + tail;
  return padEnd(truncate(line, state.width, ""), state.width);
}

function fmtChars(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function estTokens(chars: number): number {
  // 粗估：中文 1 字 ≈ 0.65 token，这里只用于展示量级
  return Math.round(chars * 0.6);
}
