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
import { statSync } from "node:fs";

import type { AppState, View } from "./state.ts";
import {
  applyFilter,
  buildTimelineRows,
  currentFlash,
  flash,
  initialState,
  loopKey,
  rowKey,
  segKey,
  turnKey,
  visibleRows,
} from "./state.ts";
import { renderList } from "./view-list.ts";
import { renderTimeline } from "./view-timeline.ts";
import { renderIssues, sortedIssues } from "./view-issues.ts";
import { renderHelp } from "./view-help.ts";
import {
  findCompactionSteps,
  newCompareState,
  renderCompactionCompare,
} from "./view-compaction.ts";
import { Screen } from "./screen.ts";
import { type KeyEvent, parseKeys } from "./keys.ts";
import { visibleWidth } from "./text.ts";
import { fmtAgo } from "./text.ts";
import { padEnd } from "./text.ts";

import { resolveTargets, type DiscoveredFile } from "../core/discover.ts";
import { summarizeAll, type SessionSummary } from "../core/summaries.ts";
import { analyzeSessionFile } from "../core/analyze.ts";

export interface RunOptions {
  files: DiscoveredFile[];
  /**
   * 用户显式指定的扫描根（文件或目录）。
   * 为空表示按环境变量/默认位置探测 —— 刷新时需要用它重新扫描，
   * 否则拿不到启动后新建的会话。
   */
  roots: string[];
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
  private autoTimer: NodeJS.Timeout | null = null;
  private lastAutoRefresh = 0;
  private lastSessionReload = 0;

  constructor(opts: RunOptions) {
    this.opts = opts;
    this.state = initialState();
    this.screen = new Screen(process.stdout, !opts.plain);
  }

  get stateRef(): AppState {
    return this.state;
  }

  /** 加载会话列表（带进度提示）。 */
  /**
   * 重新扫描会话目录并刷新列表。
   *
   * 为什么要重新扫描而不是复用 opts.files：opts.files 是启动那一刻的
   * 快照，之后新建的会话文件不在里面 —— 这才是「看不到最新会话」的根因。
   * 每次刷新都要重新 collect，才能拿到新文件。
   *
   * 已有文件的摘要走磁盘缓存（mtime+size 未变直接复用），
   * 所以 1000+ 会话的增量刷新通常只需几十毫秒。
   */
  async loadSummaries(notify = false): Promise<void> {
    const s = this.state;
    s.loading = true;
    if (notify) s.refreshing = true;
    this.requestRender();

    try {
      // 重新扫描（不传路径时按 PI_LENS_SESSION_DIR / ~/.pi / ./var/pi_sessions 探测）
      const targets = this.opts.roots.length > 0 ? this.opts.roots : this.opts.files.map((f) => f.root);
      const files = resolveTargets(targets);
      this.opts.files = files;

      const list = await summarizeAll(files, 8);
      s.summaries = list;
      applyFilter(s);
      // 保持光标位置不越界
      s.listCursor = Math.min(s.listCursor, Math.max(0, s.filtered.length - 1));

      if (notify) {
        const newest = list[0];
        flash(
          s,
          `已刷新 · ${list.length} 个会话` +
            (newest ? ` · 最新 ${fmtAgo(newest.mtimeMs)}` : ""),
        );
      }
      s.lastRefreshAt = Date.now();
    } catch (err) {
      if (notify) flash(s, `刷新失败: ${(err as Error).message.slice(0, 40)}`);
    } finally {
      s.loading = false;
      s.refreshing = false;
      this.requestRender();
    }
  }

  /**
   * 重新解析「当前已打开的会话」，保留用户当前的位置。
   *
   * 为什么单独一个函数而不是复用 openSession：
   *   1. openSession 开头有短路（已打开就直接返回），刷新会被它挡掉
   *   2. openSession 会把光标重置到 0，刷新时用户会丢失当前位置
   *
   * 会话在别的终端继续跑时，文件会增长 —— 这里重新读一遍就能看到新内容。
   * 用 mtime 判断是否真的变了，避免无谓的重绘和「已是最新」的误报。
   */
  async reloadCurrentSession(notify = false): Promise<void> {
    const s = this.state;
    const path = s.currentPath;
    if (!path) return;

    s.loading = true;
    this.requestRender();

    try {
      // 记住当前位置，刷新后尽量停留原处
      const prevCursor = s.timelineCursor;
      const prevVisible = visibleRows(s.timelineRows, s.collapsed);
      const prevRow = prevVisible[prevCursor];
      const prevCollapsed = new Set(s.collapsed);

      const before = s.analysis;
      const analysis = await analyzeSessionFile(path);
      const beforeCount = before ? countSteps(before) : 0;
      const afterCount = countSteps(analysis);
      const grew = afterCount - beforeCount;

      s.analysis = analysis;
      s.timelineRows = buildTimelineRows(analysis);
      s.collapsed = prevCollapsed;

      // 恢复光标：按「原来那行是哪一行」重新定位，而不是死守索引
      // （新内容插在前面时索引会漂移）
      if (prevRow) {
        const vis = visibleRows(s.timelineRows, s.collapsed);
        const idx = vis.findIndex(
          (r) =>
            r.kind === prevRow.kind &&
            r.segmentIndex === prevRow.segmentIndex &&
            r.turnIndex === prevRow.turnIndex &&
            r.loopIndex === prevRow.loopIndex &&
            r.stepKey === prevRow.stepKey,
        );
        s.timelineCursor = idx >= 0 ? idx : Math.min(prevCursor, Math.max(0, vis.length - 1));
      } else {
        s.timelineCursor = 0;
      }

      if (notify) {
        flash(
          s,
          grew > 0 ? `已刷新 · 新增 ${grew} 步` : grew < 0 ? "已刷新 · 内容变化" : "已刷新 · 无新增",
        );
      }
      s.lastSessionReloadAt = Date.now();
      this.markSessionFresh();
    } catch (err) {
      if (notify) flash(s, `刷新失败: ${(err as Error).message.slice(0, 40)}`);
    } finally {
      s.loading = false;
      this.requestRender();
    }
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
      this.markSessionFresh();
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

    this.startAutoRefresh();
  }

  /**
   * 自动刷新定时器。
   *
   * 两种刷新，按当前视图选择：
   *   - 列表页：重新扫描目录（发现新会话）
   *   - 会话内：重新解析当前会话文件（看到别处继续跑产生的新内容）
   *
   * 会话内刷新用文件 mtime 做前置判断：文件没变就完全跳过，
   * 这样 10 秒一次的轮询对正在读的长会话几乎没有开销。
   */
  private startAutoRefresh(): void {
    if (this.autoTimer) return;
    // 每 2 秒醒来检查一次，真正决定刷不刷的是 autoRefreshMs 间隔。
    // 这样「切换间隔」不必重建定时器。
    this.autoTimer = setInterval(() => {
      const s = this.state;
      if (!this.running) return;
      if (s.autoRefreshMs <= 0) return;
      if (s.loading || s.searching) return; // 正在加载/搜索时不打断

      const due = this.lastAutoRefresh + s.autoRefreshMs;
      if (Date.now() < due) return;

      if (s.view === "list") {
        this.lastAutoRefresh = Date.now();
        void this.loadSummaries(false);
        return;
      }

      // 会话内：只在文件真的变了才重载
      if (s.currentPath && this.sessionFileChanged()) {
        this.lastAutoRefresh = Date.now();
        this.lastSessionReload = Date.now();
        void this.reloadCurrentSession(false);
      }
    }, 2000);
    // 定时器不应阻止进程退出
    this.autoTimer.unref?.();
  }

  /**
   * 当前会话文件是否比上次加载时更新了。
   *
   * 用 mtime+size 双判：只比 mtime 在某些文件系统上精度不够，
   * 只比 size 又漏掉「内容被替换但大小不变」的情况。
   */
  private sessionFileChanged(): boolean {
    const s = this.state;
    if (!s.currentPath) return false;
    try {
      const st = statSync(s.currentPath);
      if (s.sessionMtimeMs === 0) return false;
      return st.mtimeMs !== s.sessionMtimeMs || st.size !== s.sessionSize;
    } catch {
      return false;
    }
  }

  /** 记录当前会话文件的 mtime/size，作为下次判断变化的基准。 */
  private markSessionFresh(): void {
    const s = this.state;
    if (!s.currentPath) return;
    try {
      const st = statSync(s.currentPath);
      s.sessionMtimeMs = st.mtimeMs;
      s.sessionSize = st.size;
    } catch {
      /* 读不到就算了，下次刷新会重试 */
    }
  }

  private stopAutoRefresh(): void {
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
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
    if (s.view === "compaction") {
      const items = findCompactionSteps(s);
      const hit = items[Math.min(s.compareIndex, items.length - 1)];
      if (!hit || !hit.step.compaction) {
        return renderList(s);
      }
      if (!s.compare) s.compare = newCompareState();
      return renderCompactionCompare(s, s.compare, hit.step.compaction, hit.label);
    }
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
    if (ch === "r" || ch === "R") {
      // 列表页：重新扫描目录（拿到新建的会话）
      if (s.view === "list") {
        this.lastAutoRefresh = Date.now();
        void this.loadSummaries(true);
        return true;
      }
      // 会话内：重新解析当前会话（看到别处继续跑产生的新内容）
      if (s.view === "timeline" || s.view === "issue" || s.view === "compaction") {
        this.lastSessionReload = Date.now();
        void this.reloadCurrentSession(true);
        return true;
      }
      return true;
    }
    // a：切换自动刷新
    if (ch === "a" && s.view === "list") {
      if (s.autoRefreshMs > 0) {
        s.autoRefreshMs = 0;
        flash(s, "自动刷新已关闭（a 重新开启）");
      } else {
        s.autoRefreshMs = 10_000;
        this.lastAutoRefresh = Date.now();
        flash(s, "自动刷新已开启（每 10 秒）");
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
      if (s.view === "compaction") {
        // 在「摘要 / 条目全文 / 漏词核对」之间循环
        if (!s.compare) s.compare = newCompareState();
        const order: ("summary" | "swallowed" | "missing")[] = ["summary", "swallowed", "missing"];
        const i = order.indexOf(s.compare.mode);
        s.compare.mode = order[(i + 1) % order.length]!;
        s.compare.rightOffset = 0;
        return true;
      }
    }

    // c：查看上下文压缩（有压缩才有意义）
    if (ch === "c" && (s.view === "timeline" || s.view === "issue")) {
      const items = findCompactionSteps(s);
      if (items.length === 0) {
        flash(s, "该会话没有发生上下文压缩");
        return true;
      }
      s.compareIndex = 0;
      s.compare = newCompareState();
      s.view = "compaction";
      return true;
    }

    switch (s.view) {
      case "list":
        return this.handleListKey(ev, name, ch);
      case "timeline":
        return this.handleTimelineKey(ev, name, ch);
      case "issue":
        return this.handleIssueKey(ev, name, ch);
      case "compaction":
        return this.handleCompactionKey(ev, name, ch);
      default:
        return false;
    }
  }

  /** 压缩对比视图的按键。 */
  private handleCompactionKey(ev: KeyEvent, name: string, ch: string): boolean {
    const s = this.state;
    if (!s.compare) s.compare = newCompareState();
    const cmp = s.compare;
    const items = findCompactionSteps(s);
    const cur = items[Math.min(s.compareIndex, items.length - 1)];
    const detail = cur?.step.compaction;
    if (!detail) return false;

    const total = detail.swallowed.length;
    if (name === "up") {
      cmp.cursor = Math.max(0, cmp.cursor - 1);
      return true;
    }
    if (name === "down") {
      cmp.cursor = Math.min(Math.max(0, total - 1), cmp.cursor + 1);
      return true;
    }
    if (ch === "k") {
      cmp.rightOffset = Math.max(0, cmp.rightOffset - 1);
      return true;
    }
    if (ch === "j") {
      cmp.rightOffset += 1;
      return true;
    }
    if (name === "pageup") {
      cmp.cursor = Math.max(0, cmp.cursor - 10);
      return true;
    }
    if (name === "pagedown") {
      cmp.cursor = Math.min(Math.max(0, total - 1), cmp.cursor + 10);
      return true;
    }
    if (ch === "g") {
      cmp.cursor = 0;
      return true;
    }
    if (ch === "G") {
      cmp.cursor = Math.max(0, total - 1);
      return true;
    }
    // n / N：在多次压缩之间切换
    if (ch === "n" && items.length > 1) {
      s.compareIndex = (s.compareIndex + 1) % items.length;
      s.compare = newCompareState();
      return true;
    }
    if (ch === "N" && items.length > 1) {
      s.compareIndex = (s.compareIndex - 1 + items.length) % items.length;
      s.compare = newCompareState();
      return true;
    }
    return false;
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
    // 折叠：Z 全部折叠 / E 全部展开 / z 按粒度折叠（段/循环/迭代循环切换）
    if (ch === "Z") return this.collapseAll("all");
    if (ch === "E") return this.collapseAll("none");
    if (ch === "z") {
      const order = ["turn", "loop", "segment"] as const;
      const i = order.indexOf(s.collapseLevel);
      s.collapseLevel = order[(i + 1) % order.length]!;
      return this.collapseAll("level");
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

  /** 时间轴：进入更细的层级（段→loop→turn→step）。 */
  private drillDown(): boolean {
    const s = this.state;
    const rows = visibleRows(s.timelineRows, s.collapsed);
    const cur = rows[s.timelineCursor];
    if (!cur) return false;

    // 折叠状态下的 → 优先展开当前节点，而不是往下跳
    const key = rowKey(cur);
    if (key && s.collapsed.has(key)) {
      s.collapsed.delete(key);
      flash(s, "已展开");
      return true;
    }

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

  /** 时间轴：回到上一层（折叠状态下的 ← 优先折叠当前节点）。 */
  private goUp(): boolean {
    const s = this.state;
    const rows = visibleRows(s.timelineRows, s.collapsed);
    const cur = rows[s.timelineCursor];
    if (!cur) return false;

    // 当前节点有子节点且未折叠 → ← 折叠它（与树形浏览器的习惯一致）
    const key = rowKey(cur);
    if (key && !s.collapsed.has(key) && this.hasChildren(cur)) {
      s.collapsed.add(key);
      flash(s, "已折叠");
      return true;
    }

    if (cur.depth === 0) return false;
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

  /** 该行在完整行树里是否有子行。 */
  private hasChildren(row: TimelineRow): boolean {
    const all = this.state.timelineRows;
    const idx = all.findIndex(
      (r) =>
        r.kind === row.kind &&
        r.segmentIndex === row.segmentIndex &&
        r.turnIndex === row.turnIndex &&
        r.loopIndex === row.loopIndex &&
        r.stepKey === row.stepKey,
    );
    if (idx < 0) return false;
    const next = all[idx + 1];
    return Boolean(next && next.depth > row.depth);
  }

  /**
   * 折叠/展开的批量操作。
   *
   * @param mode "all" 全部折叠到顶层 / "none" 全部展开 /
   *             "level" 按当前粒度折叠（段 / loop / 迭代）
   */
  private collapseAll(mode: "all" | "none" | "level"): boolean {
    const s = this.state;
    const all = s.timelineRows;
    if (all.length === 0) return false;

    if (mode === "none") {
      s.collapsed.clear();
      flash(s, "已全部展开");
    } else if (mode === "all") {
      // 只折叠到顶层：段保持可见，段内全折叠
      s.collapsed.clear();
      for (const r of all) {
        if (r.kind === "segment") s.collapsed.add(segKey(r.segmentIndex));
      }
      flash(s, "已折叠到段（只剩 SEG 行）");
    } else {
      // 按当前粒度：保持「每一层都折叠」，便于总览
      s.collapsed.clear();
      const level = s.collapseLevel;
      for (const r of all) {
        if (level === "segment" && r.kind === "segment") s.collapsed.add(segKey(r.segmentIndex));
        if (level === "loop" && r.kind === "loop") {
          s.collapsed.add(loopKey(r.segmentIndex, r.loopIndex ?? 0));
        }
        if (level === "turn" && r.kind === "turn") {
          s.collapsed.add(turnKey(r.segmentIndex, r.loopIndex ?? 0, r.turnIndex));
        }
      }
      flash(s, `已按${level === "segment" ? "段" : level === "loop" ? "循环" : "迭代"}折叠`);
    }

    // 折叠后光标可能越界，收敛到可见范围
    const vis = visibleRows(s.timelineRows, s.collapsed);
    s.timelineCursor = Math.min(s.timelineCursor, Math.max(0, vis.length - 1));
    s.detailOffset = 0;
    return true;
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

  /**
   * 展开某条 turn 的所有祖先。
   *
   * 跳转前必须做这一步：如果目标藏在折叠节点里，它在可见行里不存在，
   * 光标会落空 —— 表现为「按了回车但什么都没发生」，很难排查。
   */
  private expandAncestorsOf(segmentIndex: number, turnIndex: number): void {
    const s = this.state;
    if (s.collapsed.size === 0) return;
    s.collapsed.delete(segKey(segmentIndex));
    // 找到这个 turn 属于哪个 loop
    const seg = s.analysis?.segments[segmentIndex];
    if (!seg) return;
    for (const loop of seg.loops ?? []) {
      if (!loop.turns.some((t) => t.index === turnIndex)) continue;
      s.collapsed.delete(loopKey(segmentIndex, loop.index));
      s.collapsed.delete(turnKey(segmentIndex, loop.index, turnIndex));
      break;
    }
  }

  private jumpToIssueLocation(stepKey: string | undefined, turnIndex: number, segmentIndex: number): void {
    const s = this.state;
    // 关键：跳转前先展开目标所在的所有祖先，否则行是隐藏的，光标会落空
    this.expandAncestorsOf(segmentIndex, turnIndex);
    const rows = visibleRows(s.timelineRows, s.collapsed);
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
    if (s.view === "compaction") {
      s.view = "timeline";
      return true;
    }
    if (s.view === "issue") {
      s.view = "timeline";
      return true;
    }
    if (s.view === "timeline") {
      s.view = "list";
      // 回到列表时补一次刷新：离开期间可能有新会话产生，
      // 而自动刷新在非列表页是暂停的。
      if (s.autoRefreshMs > 0) {
        this.lastAutoRefresh = Date.now();
        void this.loadSummaries(false);
      }
      return true;
    }
    this.quit();
    return false;
  }

  private quit(): void {
    if (!this.running) return;
    this.running = false;
    this.stopAutoRefresh();
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

/** 统计一个分析结果里的 step 总数（用于判断刷新后是否新增了内容）。 */
function countSteps(a: { segments: { turns: { steps: unknown[] }[] }[] }): number {
  let n = 0;
  for (const seg of a.segments) for (const t of seg.turns) n += t.steps.length;
  return n;
}
