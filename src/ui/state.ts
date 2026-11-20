/**
 * 状态：应用运行期的全部可交互数据。
 *
 * 集中管理的目的：TUI 每个视图都要读会话、读分析结果、读选中位置，
 * 如果各视图自己持有状态，返回上一级时选中项会丢。
 */
import type { SessionAnalysis } from "../core/model.ts";
import type { SessionSummary } from "../core/summaries.ts";

export type View = "list" | "timeline" | "issue" | "help" | "compaction";

export interface AppState {
  view: View;
  /** 全部会话摘要（列表页数据源）。 */
  summaries: SessionSummary[];
  /** 过滤后的摘要（随搜索词变化）。 */
  filtered: SessionSummary[];
  /** 搜索词。 */
  query: string;
  /** 是否处于搜索输入模式。 */
  searching: boolean;
  /** 列表光标。 */
  listCursor: number;
  /** 列表滚动偏移。 */
  listOffset: number;

  /** 当前打开的会话分析结果（懒加载）。 */
  analysis: SessionAnalysis | null;
  /** 打开会话时的加载状态。 */
  loading: boolean;
  loadError: string | null;
  /** 当前会话路径，用于判断是否需要重新加载。 */
  currentPath: string | null;

  /**
   * 时间轴视图：把两层循环摊平成可选中行。
   * 行类型决定渲染样式与是否可展开。
   */
  timelineRows: TimelineRow[];
  timelineCursor: number;
  timelineOffset: number;

  /** 详情面板滚动（针对选中的 step 内容）。 */
  detailOffset: number;

  /** 问题面板光标。 */
  issueCursor: number;
  issueOffset: number;

  /** 压缩对比视图状态（懒创建）。 */
  compare: import("./view-compaction.ts").CompareState | null;
  /** 当前查看第几次压缩（对应 findCompactionSteps 的下标）。 */
  compareIndex: number;

  /** 布局过滤：只看有问题的会话。 */
  onlyProblems: boolean;

  /**
   * 已折叠的节点（用节点 key 表示）。
   *
   * key 形如 `s1`（段）、`s1l0`（loop）、`s1l0t3`（迭代）。
   * 折叠只影响「行是否生成」，不改动底层数据 —— 编号和定位保持稳定。
   */
  collapsed: Set<string>;
  /** 折叠粒度：按段 / 按 loop / 按迭代（决定折叠键的层级）。 */
  collapseLevel: "segment" | "loop" | "turn";

  /** 是否正在刷新（与首次 loading 区分，避免闪烁）。 */
  refreshing: boolean;
  /** 上次刷新完成的时间戳，用于底栏显示「N 秒前」。 */
  lastRefreshAt: number;
  /** 上次重新加载当前会话的时间戳（时间轴底栏用）。 */
  lastSessionReloadAt: number;
  /**
   * 当前会话文件的 mtime 与 size。
   *
   * 用于判断「文件是否被外部改动」——会话在别的终端继续跑时文件会增长，
   * 靠这两个值就能以极低成本发现变化，不必每次重解析整份 jsonl。
   */
  sessionMtimeMs: number;
  sessionSize: number;
  /** 自动刷新开关与间隔（毫秒）。0 表示关闭。 */
  autoRefreshMs: number;

  /** 临时状态栏消息（会自动消失）。 */
  flash: string | null;
  flashAt: number;

  /** 终端尺寸。 */
  width: number;
  height: number;
}

/** 时间轴上的可选中行。 */
export interface TimelineRow {
  kind: "segment" | "loop" | "turn" | "step" | "note";
  segmentIndex: number;
  turnIndex: number;
  stepKey?: string;
  /** loop 在该段内的序号（仅 kind==="loop" 时有效）。 */
  loopIndex?: number;
  /** 缩进层级：0=段 1=loop 2=迭代(turn) 3=step。 */
  depth: number;
}

export function initialState(): AppState {
  return {
    view: "list",
    summaries: [],
    filtered: [],
    query: "",
    searching: false,
    listCursor: 0,
    listOffset: 0,
    analysis: null,
    loading: false,
    loadError: null,
    currentPath: null,
    timelineRows: [],
    timelineCursor: 0,
    timelineOffset: 0,
    detailOffset: 0,
    issueCursor: 0,
    issueOffset: 0,
    compare: null,
    compareIndex: 0,
    onlyProblems: false,
    collapsed: new Set<string>(),
    collapseLevel: "turn",
    refreshing: false,
    lastRefreshAt: 0,
    lastSessionReloadAt: 0,
    sessionMtimeMs: 0,
    sessionSize: 0,
    // 默认开启自动刷新：用户把 pi 跑在另一个终端，回来就能看到新会话。
    // 10 秒间隔对 1000+ 会话的增量扫描（走缓存）几乎无感。
    autoRefreshMs: 10_000,
    flash: null,
    flashAt: 0,
    width: 100,
    height: 30,
  };
}

export function flash(state: AppState, msg: string): void {
  state.flash = msg;
  state.flashAt = Date.now();
}

export function currentFlash(state: AppState): string | null {
  if (!state.flash) return null;
  if (Date.now() - state.flashAt > 4000) {
    state.flash = null;
    return null;
  }
  return state.flash;
}

/** 按搜索词过滤会话列表。 */
export function applyFilter(state: AppState): void {
  const q = state.query.trim().toLowerCase();
  let list = state.summaries;
  if (state.onlyProblems) {
    list = list.filter((s) => s.errors > 0 || s.compactions > 0);
  }
  if (!q) {
    state.filtered = list;
    return;
  }
  // 分词：多个关键词都要命中（空格分隔）
  const terms = q.split(/\s+/).filter(Boolean);
  state.filtered = list.filter((s) => {
    const hay = [
      s.title,
      s.cwd,
      s.models.join(" "),
      s.sessionId,
      s.path,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** 折叠键：段 / loop / 迭代 各自唯一。 */
export function segKey(segmentIndex: number): string {
  return `s${segmentIndex}`;
}
export function loopKey(segmentIndex: number, loopIndex: number): string {
  return `s${segmentIndex}l${loopIndex}`;
}
export function turnKey(segmentIndex: number, loopIndex: number, turnIndex: number): string {
  return `s${segmentIndex}l${loopIndex}t${turnIndex}`;
}

/** 某一行的折叠键（note 行没有）。 */
export function rowKey(row: TimelineRow): string | null {
  if (row.kind === "segment") return segKey(row.segmentIndex);
  if (row.kind === "loop") return loopKey(row.segmentIndex, row.loopIndex ?? 0);
  if (row.kind === "turn") return turnKey(row.segmentIndex, row.loopIndex ?? 0, row.turnIndex);
  return null; // step 不可折叠
}

/**
 * 该行是否处于「已折叠」状态（即它的子行应当被隐藏）。
 *
 * 注意判定的不是「这一行被标折叠了」，而是「它自己或任一祖先被折叠」——
 * 这样折叠一个段，它内部所有 loop/turn 都会消失。
 */
export function isRowHidden(row: TimelineRow, collapsed: Set<string>): boolean {
  if (collapsed.size === 0) return false;
  const s = segKey(row.segmentIndex);
  if (collapsed.has(s)) return row.kind !== "segment";
  if (row.kind === "segment") return false;
  const l = loopKey(row.segmentIndex, row.loopIndex ?? 0);
  if (collapsed.has(l)) return row.kind !== "loop";
  if (row.kind === "loop") return false;
  const t = turnKey(row.segmentIndex, row.loopIndex ?? 0, row.turnIndex);
  if (collapsed.has(t)) return row.kind !== "turn";
  return false;
}

/**
 * 统计某个折叠节点下面藏了多少行（不含节点自身）。
 *
 * 界面上显示的 `⋯N` 就是它 —— 之前这里多减了 1，
 * 导致「折叠后显示 ⋯100，实际藏了 101 行」这种对不上的情况。
 */
export function countHidden(all: TimelineRow[], key: string): number {
  return all.filter((r) => isRowHidden(r, new Set([key]))).length;
}

/** 生成完整行树（未折叠）；渲染时再按 collapsed 过滤。 */
export function buildTimelineRows(analysis: SessionAnalysis): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const seg of analysis.segments) {
    rows.push({
      kind: "segment",
      segmentIndex: seg.index,
      turnIndex: seg.turns[0]?.index ?? 0,
      depth: 0,
    });
    // 第三层：agent loop（一个用户请求内的完整循环体）
    for (const loop of seg.loops ?? []) {
      rows.push({
        kind: "loop",
        segmentIndex: seg.index,
        turnIndex: loop.turns[0]?.index ?? 0,
        loopIndex: loop.index,
        depth: 1,
      });
      // 第四层：迭代（每次模型往返）
      for (const turn of loop.turns) {
        rows.push({
          kind: "turn",
          segmentIndex: seg.index,
          turnIndex: turn.index,
          loopIndex: loop.index,
          depth: 2,
        });
        // 第五层：step
        for (const step of turn.steps) {
          rows.push({
            kind: "step",
            segmentIndex: seg.index,
            turnIndex: turn.index,
            stepKey: step.key,
            loopIndex: loop.index,
            depth: 3,
          });
        }
      }
    }
  }
  return rows;
}

/** 按折叠状态过滤出可见行。 */
export function visibleRows(all: TimelineRow[], collapsed: Set<string>): TimelineRow[] {
  if (collapsed.size === 0) return all;
  return all.filter((r) => !isRowHidden(r, collapsed));
}
