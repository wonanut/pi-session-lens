/**
 * 视图一：会话列表。
 *
 * 这一屏要回答的问题：「我该看哪个会话？」
 * 所以每行必须一眼给出：什么时候、谁问的什么、有多少轮/工具/错误/压缩、健康分。
 * 健康分放最左边 ── 用户的核心诉求是「快速定位问题」，
 * 扫一眼就能挑出最该看的那个，不用逐个打开。
 */
import type { AppState } from "./state.ts";
import type { SessionSummary } from "../core/summaries.ts";
import { drawPanel, Viewport } from "./render.ts";
import { fmtAgo, fmtBytes, fmtTokens, padEnd, padStart, truncate, visibleWidth } from "./text.ts";
import { glyph, healthColor, theme } from "./theme.ts";

/** 列宽预算（在 renderList 里按可用宽度动态调整）。 */
interface Cols {
  health: number;
  time: number;
  turns: number;
  tools: number;
  err: number;
  comp: number;
  ctx: number;
  title: number;
}

function planCols(width: number): Cols {
  // 固定列占位：健康(4) 空格 + 时间(11) + turns(5) + tools(5) + err(4) + comp(4) + ctx(6)
  const fixed = 4 + 1 + 11 + 1 + 5 + 1 + 5 + 1 + 4 + 1 + 4 + 1 + 6 + 1;
  const title = Math.max(12, width - fixed - 2);
  return { health: 4, time: 11, turns: 5, tools: 5, err: 4, comp: 4, ctx: 6, title };
}

function headerLine(width: number): string {
  const c = planCols(width);
  const parts = [
    padEnd("健康", c.health),
    padEnd("时间", c.time),
    padStart("轮", c.turns),
    padStart("工具", c.tools),
    padStart("错", c.err),
    padStart("压", c.comp),
    padStart("ctx", c.ctx),
    padEnd("需求 / 标题", c.title),
  ];
  return theme.muted(parts.join(" "));
}

function rowLine(s: SessionSummary, width: number, selected: boolean): string {
  const c = planCols(width);
  const hCol = healthColor(s.health);
  const health = hCol(padStart(`${s.health}`, c.health));
  const time = theme.faint(padEnd(fmtAgo(s.mtimeMs), c.time));
  const turns = theme.bright(padStart(String(s.turns), c.turns));
  const tools = theme.muted(padStart(String(s.toolCalls), c.tools));
  const err =
    s.errors > 0
      ? theme.error(padStart(String(s.errors), c.err))
      : theme.faint(padStart("·", c.err));
  const comp =
    s.compactions > 0
      ? theme.compaction(padStart(String(s.compactions), c.comp))
      : theme.faint(padStart("·", c.comp));
  const ctx =
    s.contextPeak > 0
      ? theme.muted(padStart(fmtTokens(s.contextPeak), c.ctx))
      : theme.faint(padStart("—", c.ctx));

  const titleRaw = s.title.replace(/\s+/g, " ");
  const marker = selected ? theme.accentStrong(glyph.cursor + " ") : "  ";
  const avail = Math.max(4, width - 2 - (c.health + c.time + c.turns + c.tools + c.err + c.comp + c.ctx + 7));
  const title = truncate(titleRaw, avail);
  const titleStyled = selected ? theme.white(theme.bold(title)) : theme.bright(title);

  const line =
    marker +
    [
      health,
      time,
      turns,
      tools,
      err,
      comp,
      ctx,
    ].join(" ") +
    " " +
    padEnd(titleStyled, avail);

  if (selected) {
    // 整行反白（用 selBg 而非 reverse，避免前景色被反转后看不清）
    return theme.selBg(padEnd(line, width));
  }
  return line;
}

/** 渲染列表视图，返回整屏行。 */
export function renderList(state: AppState): string[] {
  const { width, height } = state;
  const out: string[] = [];

  // 顶部可用的内容高度：面板占 height-3 行（搜索行 + 统计行 + 底栏各占 1 行）
  const bodyH = Math.max(3, height - 3);
  const vp = new Viewport();
  vp.cursor = state.listCursor;
  vp.offset = state.listOffset;
  const total = state.filtered.length;
  vp.sync(total, bodyH - 2); // 减去表头 + 分隔线
  state.listCursor = vp.cursor;
  state.listOffset = vp.offset;

  const [from, to] = vp.window(total, bodyH - 2);

  const body: string[] = [];
  body.push(headerLine(width - 2));
  body.push(theme.border("─".repeat(Math.max(0, width - 2))));

  if (total === 0) {
    body.push("");
    body.push(
      theme.muted(
        state.summaries.length === 0
          ? "  没有找到任何 pi 会话文件。"
          : "  没有匹配的会话（按 Esc 清空搜索）",
      ),
    );
    if (state.summaries.length === 0) {
      body.push("");
      body.push(theme.faint("  试试：pi-lens <会话目录>"));
      body.push(theme.faint("  或：export PI_LENS_SESSION_DIR=/path/to/sessions"));
    }
  } else {
    for (let i = from; i < to; i++) {
      const s = state.filtered[i];
      if (!s) continue;
      body.push(rowLine(s, width - 2, i === vp.cursor));
    }
  }

  // 顶部状态行
  const right = `${from + 1}-${to}/${total}`;
  out.push(...drawPanel({ x: 0, y: 0, width, height: bodyH }, "pi 会话列表", right, body, true));

  // 搜索框 + 摘要统计
  const searchLine = state.searching
    ? theme.accentStrong("搜索: ") + theme.white(state.query) + theme.accentStrong("█")
    : state.query
      ? theme.accentStrong("搜索: ") + theme.bright(state.query) + theme.faint("  (Esc 清空)")
      : theme.faint("按 / 搜索   空格 只看有问题   r 刷新   a 自动   回车 打开");

  const sum = summarizeFiltered(state.filtered);
  const refreshStage =
    state.refreshing
      ? theme.info("  刷新中…")
      : state.lastRefreshAt > 0
        ? theme.faint(`  ${fmtAgo(state.lastRefreshAt)}刷新`)
        : "";
  const autoTag =
    state.autoRefreshMs > 0 ? theme.ok("  自动") : theme.faint("  手动");

  const statsLine =
    theme.faint("共 ") +
    theme.white(String(state.summaries.length)) +
    theme.faint(" 个会话 · ") +
    theme.error(`${sum.errors} 错误`) +
    theme.faint(" · ") +
    theme.compaction(`${sum.compactions} 压缩`) +
    theme.faint(" · ") +
    theme.muted(`${fmtBytes(sum.bytes)}`) +
    refreshStage +
    autoTag +
    (state.onlyProblems ? theme.warn("  [已过滤: 有问题]") : "");

  out.push(padEnd(truncate(searchLine, width, ""), width));
  out.push(padEnd(truncate(statsLine, width, ""), width));

  // 底栏
  out.push(renderFooter(state));
  return out;
}

function summarizeFiltered(list: SessionSummary[]): {
  errors: number;
  compactions: number;
  bytes: number;
} {
  let errors = 0;
  let compactions = 0;
  let bytes = 0;
  for (const s of list) {
    errors += s.errors;
    compactions += s.compactions;
    bytes += s.size;
  }
  return { errors, compactions, bytes };
}

export function renderFooter(state: AppState): string {
  const keys: [string, string][] =
    state.view === "list"
      ? [
          ["↑↓", "移动"],
          ["↵", "打开"],
          ["/", "搜索"],
          ["空格", "只看有问题"],
          ["q", "退出"],
        ]
      : state.view === "timeline"
        ? [
            ["↑↓", "移动"],
            ["→←", "进出层级"],
            ["tab", "问题"],
            ["esc", "返回"],
            ["q", "退出"],
          ]
        : [
            ["↑↓", "移动"],
            ["↵", "跳到该处"],
            ["esc", "返回"],
            ["q", "退出"],
          ];

  const parts = keys.map(
    ([k, d]) => theme.accent(k) + theme.faint(" " + d),
  );
  const nav = parts.join(theme.faint("  ·  "));

  const flashMsg = state.flash ? theme.warn("  " + state.flash) : "";
  const loading = state.loading ? theme.info("  载入中…") : "";
  const line = nav + loading + flashMsg;

  const plain = nav.replace(/\x1b\[[0-9;]*m/g, "");
  const full = visibleWidth(plain) < state.width ? line : truncate(line, state.width, "");
  return padEnd(full, state.width);
}
