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

  /** 临时状态栏消息（会自动消失）。 */
  flash: string | null;
  flashAt: number;

  /** 终端尺寸。 */
  width: number;
  height: number;
}

/** 时间轴上的可选中行。 */
export interface TimelineRow {
  kind: "segment" | "turn" | "step" | "note";
  segmentIndex: number;
  turnIndex: number;
  stepKey?: string;
  /** 缩进层级：0=段 1=turn 2=step。 */
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

/** 从当前分析结果生成时间轴行。 */
export function buildTimelineRows(analysis: SessionAnalysis): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const seg of analysis.segments) {
    rows.push({
      kind: "segment",
      segmentIndex: seg.index,
      turnIndex: seg.turns[0]?.index ?? 0,
      depth: 0,
    });
    for (const turn of seg.turns) {
      rows.push({
        kind: "turn",
        segmentIndex: seg.index,
        turnIndex: turn.index,
        depth: 1,
      });
      for (const step of turn.steps) {
        rows.push({
          kind: "step",
          segmentIndex: seg.index,
          turnIndex: turn.index,
          stepKey: step.key,
          depth: 2,
        });
      }
    }
  }
  return rows;
}
