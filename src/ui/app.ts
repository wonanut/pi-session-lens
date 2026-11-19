/**
 * 主应用：输入循环 + 状态流转 + 渲染调度。
 *
 * 交互模型（三屏）：
 *   列表 ──Enter──▶ 时间轴 ──Tab──▶ 问题面板 ──Enter──▶ 跳回时间轴现场
 *     ▲                 │                                    │
 *     └────── Esc ──────┴────────────── Esc ────────────────┘
 *
 * 为什么用「层级 + Esc 逐层返回」而不是侧边菜单：
 * 定位问题的动作是「下钻」——从会话 → 段 → 轮 → 步。
 * 逐层返回让用户始终知道自己站在哪一层，也不会丢失上一层的选中位置。
 */
import type { AppState, View } from "./state.ts";
import {
  applyFilter,
  buildTimelineRows,
  currentFlash,
  flash,
  initialState,
} from "./state.ts";
import { renderList } from "./view-list.ts";
import { renderTimeline } from "./view-timeline.ts";
import { renderIssues, sortedIssues } from "./view-issues.ts";
import { renderHelp } from "./view-help.ts";
import { Screen } from "./screen.ts";
import { type KeyEvent, parseKeys } from "./keys.ts";
import { visibleWidth } from "./text.ts";
import { padEnd } from "./text.ts";

import type { DiscoveredFile } from "../core/discover.ts";
import { summarizeAll, type SessionSummary } from "../core/summaries.ts";
import { analyzeSessionFile } from "../core/analyze.ts";

export interface RunOptions {
  files: DiscoveredFile[];
  /** 启动时直接打开的会话路径（`pi-lens <file>`）。 */
  initialPath?: string;
  /** 无 TTY 时输出一帧静态快照后退出（便于管道/测试）。 */
  plain?: boolean;
}

export class App {
  private state: AppState;
  private screen: Screen;
  private opts: RunOptions;
  private running = false;
  private needsRender = true;
  private escTimer: NodeJS.Timeout | null = null;
  private pendingEsc = false;

  constructor(opts: RunOptions) {
    this.opts = opts;
    this.state = initialState();
    this.screen = new Screen(process.stdout, !opts.plain);
  }

  get stateRef(): AppState {
    return this.state;
  }

  /** 加载会话列表（带进度提示）。 */
  async loadSummaries(): Promise<void> {
    this.state.loading = true;
    this.requestRender();
    const list = await summarizeAll(this.opts.files, 8);
    this.state.summaries = list;
    applyFilter(this.state);
    this.state.loading = false;
    this.requestRender();
  }

  /** 打开一个会话并分析。 */
  async openSession(path: string): Promise<void> {
    if (this.state.currentPath === path && this.state.analysis) {
      this.state.view = "timeline";
      this.requestRender();
      return;
    }
    this.state.loading = true;
    this.state.loadError = null;
    this.state.view = "timeline";
    this.requestRender();

    try {
      const analysis = await analyzeSessionFile(path);
      this.state.analysis = analysis;
      this.state.currentPath = path;
      this.state.timelineRows = buildTimelineRows(analysis);
      this.state.timelineCursor = 0;
      this.state.timelineOffset = 0;
      this.state.detailOffset = 0;
      this.state.issueCursor = 0;
      this.state.issueOffset = 0;
    } catch (err) {
      this.state.loadError = (err as Error).message;
      this.state.analysis = null;
      this.state.timelineRows = [];
    }
    this.state.loading = false;
    this.requestRender();
  }

  private requestRender(): void {
    this.needsRender = true;
  }

  async run(): Promise<void> {
    this.running = true;
    this.screen.start();
    this.installInput();

    await this.loadSummaries();

    if (this.opts.initialPath) {
      const hit = this.state.summaries.find((s) => s.path === this.opts.initialPath);
      if (hit) {
        const idx = this.state.filtered.indexOf(hit);
        if (idx >= 0) this.state.listCursor = idx;
        await this.openSession(hit.path);
      } else {
        await this.openSession(this.opts.initialPath);
      }
    }

    if (this.opts.plain) {
      this.state.width = this.screen.width;
      this.state.height = this.screen.height;
      this.screen.printOnce(this.renderFrame());
      this.screen.stop();
      this.running = false;
      return;
    }
    // 主循环：只在需要时重绘
    const tick = (): void => {
      if (!this.running) return;
      if (this.needsRender) {
        this.needsRender = false;
        this.renderOnce();
      }
      setImmediate(tick);
    };
    tick();
  }

  private renderOnce(): void {
    this.state.width = this.screen.width;
    this.state.height = this.screen.height;
    this.screen.draw(this.renderFrame());
  }

  private renderFrame(): string[] {
    const s = this.state;
    if (s.view === "help") return renderHelp(s);
    if (s.view === "timeline") return renderTimeline(s);
    if (s.view === "issue") return renderIssues(s);
    return renderList(s);
  }

  // -------------------------------------------------------------------------
  // 输入
  // -------------------------------------------------------------------------

  private installInput(): void {
    // 不能用 isTTY 判断：在 pty 测试、ssh 转发、某些容器里 stdin 是管道
    // 但仍然应当接受按键。只要 stdin 可读就尝试进入 raw 模式，
    // setRawMode 在非 TTY 上不存在，用可选调用兜底。
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (data: string) => {
      this.handleRaw(data);
    });

    process.stdout.on("resize", () => {
      this.screen.invalidate();
      this.requestRender();
    });
  }

  /**
   * 原始输入处理。
   *
   * ESC 需要在「无后续字节」时才成立：方向键也是 0x1b 开头。
   * 这里延迟 25ms 判定 —— 短于人的连续按键间隔，长于终端的
   * 转义序列拆分间隔。
   */
  private handleRaw(data: string): void {
    if (this.pendingEsc) {
      // ESC 之后又来了数据 → 是转义序列，不是 ESC 键
      this.pendingEsc = false;
      if (this.escTimer) {
        clearTimeout(this.escTimer);
        this.escTimer = null;
      }
    }
    if (data === "\x1b") {
      this.pendingEsc = true;
      this.escTimer = setTimeout(() => {
        this.pendingEsc = false;
        this.escTimer = null;
        this.handleEvents([{ type: "key", name: "escape" }]);
      }, 25);
      return;
    }
    this.handleEvents(parseKeys(data));
  }

  private handleEvents(events: KeyEvent[]): void {
    let dirty = false;
    for (const ev of events) {
      if (this.handleEvent(ev)) dirty = true;
      if (!this.running) return;
    }
    if (dirty) this.requestRender();
  }

  /** 返回是否改变了状态。 */
  private handleEvent(ev: KeyEvent): boolean {
    const s = this.state;

    // 全局：退出
    if (ev.type === "ctrl" && ev.char === "c") {
      this.quit();
      return false;
    }
    if (ev.type === "key" && ev.name === "escape" && s.view === "list" && !s.searching) {
      // 列表页按 Esc 视为退出（与 pi 一致）
      this.quit();
      return false;
    }

    // 搜索输入模式：吞掉大部分按键
    if (s.searching) {
      return this.handleSearchInput(ev);
    }

    if (ev.type === "ctrl") return false;
    if (ev.type !== "key" && ev.type !== "char") return false;

    const name = ev.type === "key" ? ev.name : "";
    const ch = ev.type === "char" ? ev.char : "";

    // 全局键
    if (name === "escape") return this.goBack();
    if (ch === "q") {
      this.quit();
      return false;
    }
    if (ch === "?") {
      if (s.view === "help") s.view = this.prevView ?? "list";
      else {
        this.prevView = s.view;
        s.view = "help";
      }
      return true;
    }
    if (ch === "r") {
      if (s.view === "timeline" && s.currentPath) {
        void this.openSession(s.currentPath).then(() => flash(s, "已重新加载"));
      }
      return true;
    }
    if (name === "tab") {
      if (s.view === "timeline") {
        s.view = "issue";
        return true;
      }
      if (s.view === "issue") {
        s.view = "timeline";
        return true;
      }
    }

    switch (s.view) {
      case "list":
        return this.handleListKey(ev, name, ch);
      case "timeline":
        return this.handleTimelineKey(ev, name, ch);
      case "issue":
        return this.handleIssueKey(ev, name, ch);
      default:
        return false;
    }
  }

  private prevView: View | null = null;

  private handleSearchInput(ev: KeyEvent): boolean {
    const s = this.state;
    if (ev.type === "key") {
      if (ev.name === "escape") {
        s.searching = false;
        s.query = "";
        applyFilter(s);
        s.listCursor = 0;
        return true;
      }
      if (ev.name === "enter") {
        s.searching = false;
        return true;
      }
      if (ev.name === "backspace") {
        s.query = s.query.slice(0, -1);
        applyFilter(s);
        s.listCursor = 0;
        return true;
      }
      return false;
    }
    if (ev.type === "char") {
      s.query += ev.char;
      applyFilter(s);
      s.listCursor = 0;
      return true;
    }
    return false;
  }

  private handleListKey(ev: KeyEvent, name: string, ch: string): boolean {
    const s = this.state;
    const total = s.filtered.length;
    const page = Math.max(1, Math.floor((s.height - 6) * 0.8));

    if (name === "up" || ch === "k") {
      s.listCursor = Math.max(0, s.listCursor - 1);
      return true;
    }
    if (name === "down" || ch === "j") {
      s.listCursor = Math.min(Math.max(0, total - 1), s.listCursor + 1);
      return true;
    }
    if (name === "pageup") {
      s.listCursor = Math.max(0, s.listCursor - page);
      return true;
    }
    if (name === "pagedown") {
      s.listCursor = Math.min(Math.max(0, total - 1), s.listCursor + page);
      return true;
    }
    if (ch === "g") {
      s.listCursor = 0;
      return true;
    }
    if (ch === "G") {
      s.listCursor = Math.max(0, total - 1);
      return true;
    }
    if (name === "enter") {
      const hit = s.filtered[s.listCursor];
      if (hit) void this.openSession(hit.path);
      return true;
    }
    if (ch === "/") {
      s.searching = true;
      s.query = "";
      applyFilter(s);
      return true;
    }
    if (name === "space") {
      s.onlyProblems = !s.onlyProblems;
      applyFilter(s);
      s.listCursor = 0;
      flash(s, s.onlyProblems ? "只看有问题的会话" : "显示全部会话");
      return true;
    }
    return false;
  }

  private handleTimelineKey(ev: KeyEvent, name: string, ch: string): boolean {
    const s = this.state;
    const rows = s.timelineRows;
    const total = rows.length;
    if (total === 0) return false;

    const bodyH = Math.max(3, s.height - 3);
    const page = Math.max(1, bodyH - 1);

    if (name === "up" || ch === "k") {
      // k 留给详情滚动，↑ 走行
      if (name === "up") {
        s.timelineCursor = Math.max(0, s.timelineCursor - 1);
        s.detailOffset = 0;
        return true;
      }
      s.detailOffset = Math.max(0, s.detailOffset - 1);
      return true;
    }
    if (name === "down") {
      s.timelineCursor = Math.min(total - 1, s.timelineCursor + 1);
      s.detailOffset = 0;
      return true;
    }
    if (ch === "j") {
      s.detailOffset += 1;
      return true;
    }
    if (name === "pageup") {
      s.timelineCursor = Math.max(0, s.timelineCursor - page);
      s.detailOffset = 0;
      return true;
    }
    if (name === "pagedown") {
      s.timelineCursor = Math.min(total - 1, s.timelineCursor + page);
      s.detailOffset = 0;
      return true;
    }
    if (ch === "g") {
      s.timelineCursor = 0;
      s.detailOffset = 0;
      return true;
    }
    if (ch === "G") {
      s.timelineCursor = total - 1;
      s.detailOffset = 0;
      return true;
    }
    if (name === "right") {
      return this.drillDown();
    }
    if (name === "left") {
      return this.goUp();
    }
    if (name === "enter") {
      s.view = "issue";
      return true;
    }
    if (ch === "n") {
      return this.jumpToIssue(1);
    }
    if (ch === "N") {
      return this.jumpToIssue(-1);
    }
    return false;
  }

  /** 时间轴：进入更细的层级（段→turn→step）。 */
  private drillDown(): boolean {
    const s = this.state;
    const rows = s.timelineRows;
    const cur = rows[s.timelineCursor];
    if (!cur) return false;
    // 找下一个更深的行
    for (let i = s.timelineCursor + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
      if (r.depth > cur.depth) {
        s.timelineCursor = i;
        s.detailOffset = 0;
        return true;
      }
      if (r.depth <= cur.depth && r.kind !== "segment") break;
    }
    return false;
  }

  /** 时间轴：回到上一层。 */
  private goUp(): boolean {
    const s = this.state;
    const rows = s.timelineRows;
    const cur = rows[s.timelineCursor];
    if (!cur || cur.depth === 0) return false;
    for (let i = s.timelineCursor - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r) continue;
      if (r.depth < cur.depth) {
        s.timelineCursor = i;
        s.detailOffset = 0;
        return true;
      }
    }
    return false;
  }

  /** 跳到下一个/上一个有 issue 的 step。 */
  private jumpToIssue(dir: number): boolean {
    const s = this.state;
    if (!s.analysis) return false;
    const stepIdx: number[] = [];
    s.timelineRows.forEach((r, i) => {
      if (r.kind !== "step") return;
      const seg = s.analysis!.segments[r.segmentIndex];
      for (const t of seg?.turns ?? []) {
        for (const st of t.steps) {
          if (st.key === r.stepKey && st.issueIndexes?.length) stepIdx.push(i);
        }
      }
    });
    if (stepIdx.length === 0) {
      flash(s, "该会话没有检测到问题");
      return true;
    }
    if (dir > 0) {
      const next = stepIdx.find((i) => i > s.timelineCursor) ?? stepIdx[0]!;
      s.timelineCursor = next;
    } else {
      const prev = [...stepIdx].reverse().find((i) => i < s.timelineCursor) ?? stepIdx[stepIdx.length - 1]!;
      s.timelineCursor = prev;
    }
    s.detailOffset = 0;
    return true;
  }

  private handleIssueKey(ev: KeyEvent, name: string, ch: string): boolean {
    const s = this.state;
    if (!s.analysis) return false;
    const issues = sortedIssues(s.analysis.issues);
    const total = issues.length;
    if (total === 0) return false;

    if (name === "up" || ch === "k") {
      s.issueCursor = Math.max(0, s.issueCursor - 1);
      return true;
    }
    if (name === "down" || ch === "j") {
      s.issueCursor = Math.min(total - 1, s.issueCursor + 1);
      return true;
    }
    if (ch === "g") {
      s.issueCursor = 0;
      return true;
    }
    if (ch === "G") {
      s.issueCursor = total - 1;
      return true;
    }
    if (name === "enter") {
      const iss = issues[s.issueCursor];
      if (!iss) return false;
      this.jumpToIssueLocation(iss.stepKey, iss.turnIndex, iss.segmentIndex);
      s.view = "timeline";
      return true;
    }
    return false;
  }

  /** 按 issue 的定位信息把时间轴光标移过去。 */
  private jumpToIssueLocation(stepKey: string | undefined, turnIndex: number, segmentIndex: number): void {
    const s = this.state;
    const rows = s.timelineRows;
    let target = -1;
    if (stepKey) {
      target = rows.findIndex((r) => r.stepKey === stepKey);
    }
    if (target < 0) {
      target = rows.findIndex((r) => r.kind === "turn" && r.turnIndex === turnIndex);
    }
    if (target < 0) {
      target = rows.findIndex((r) => r.kind === "segment" && r.segmentIndex === segmentIndex);
    }
    if (target >= 0) {
      s.timelineCursor = target;
      s.detailOffset = 0;
    }
  }

  private goBack(): boolean {
    const s = this.state;
    if (s.view === "help") {
      s.view = this.prevView ?? "list";
      return true;
    }
    if (s.view === "issue") {
      s.view = "timeline";
      return true;
    }
    if (s.view === "timeline") {
      s.view = "list";
      return true;
    }
    this.quit();
    return false;
  }

  private quit(): void {
    if (!this.running) return;
    this.running = false;
    if (this.escTimer) clearTimeout(this.escTimer);
    this.screen.stop();
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.exit(0);
  }
}

/** 供 `--plain` 与测试使用：渲染单帧到字符串。 */
export function renderSnapshot(state: AppState): string {
  let lines: string[];
  if (state.view === "timeline") lines = renderTimeline(state);
  else if (state.view === "issue") lines = renderIssues(state);
  else if (state.view === "help") lines = renderHelp(state);
  else lines = renderList(state);
  return lines.map((l) => padEnd(l, state.width)).join("\n");
}

/** 便于外部构造摘要列表（导出/CI 用）。 */
export type { SessionSummary };
