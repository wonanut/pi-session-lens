/**
 * 布局正确性测试。
 *
 * TUI 最常见、也最难靠肉眼发现的 bug 是「某一行比终端宽」：
 * 表现是边框错位、文字折到下一行、整屏逐步右移。终端尺寸一旦变化
 * 就会复现，所以必须用自动化在多种尺寸下逐一校验每一行的可见宽度。
 *
 * 这里直接渲染真实数据生成的 screen buffer，逐行断言：
 *   visibleWidth(line) === expectedWidth
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  applyFilter,
  buildTimelineRows,
  initialState,
  loopKey,
  segKey,
  turnKey,
} from "../src/ui/state.ts";
import { renderList } from "../src/ui/view-list.ts";
import { renderTimeline } from "../src/ui/view-timeline.ts";
import { renderIssues } from "../src/ui/view-issues.ts";
import {
  findCompactionSteps,
  newCompareState,
  renderCompactionCompare,
} from "../src/ui/view-compaction.ts";
import { visibleWidth } from "../src/ui/text.ts";
import { analyzeSessionFile } from "../src/core/analyze.ts";
import { summarizeAll } from "../src/core/summaries.ts";
import { resolveTargets } from "../src/core/discover.ts";

const SAMPLES = [
  "/home/tyao/文档/code/config-generation-design-agent/var/pi_sessions",
];

function firstSample(): string | null {
  for (const d of SAMPLES) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(d, f);
      try {
        if (statSync(p).size > 50_000) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function assertRect(lines: string[], width: number, height: number, label: string): void {
  assert.equal(lines.length, height, `${label}: 行数应为 ${height}，实际 ${lines.length}`);
  lines.forEach((l, i) => {
    const w = visibleWidth(l);
    assert.equal(w, width, `${label}: 第 ${i} 行宽度 ${w} ≠ ${width}\n${JSON.stringify(l)}`);
  });
}

const sample = firstSample();

test("会话列表：多尺寸下每行宽度精确", { skip: !sample }, async () => {
  const st = initialState();
  const files = resolveTargets([SAMPLES[0]!]);
  st.summaries = await summarizeAll(files.slice(0, 30), 4);
  applyFilter(st);

  for (const [w, h] of [
    [80, 24],
    [100, 30],
    [120, 24],
    [150, 40],
    [200, 50],
  ] as const) {
    st.width = w;
    st.height = h;
    const lines = renderList(st);
    assertRect(lines, w, h, `list ${w}x${h}`);
  }
});

test("时间轴：多尺寸下每行宽度精确", { skip: !sample }, async () => {
  const st = initialState();
  st.analysis = await analyzeSessionFile(sample!);
  st.timelineRows = buildTimelineRows(st.analysis);
  assert.ok(st.timelineRows.length > 0, "时间轴应有行");

  for (const [w, h] of [
    [80, 24],
    [100, 30],
    [120, 24],
    [150, 40],
    [200, 50],
  ] as const) {
    for (const cursor of [0, 1, 2, 5, st.timelineRows.length - 1]) {
      st.width = w;
      st.height = h;
      st.timelineCursor = cursor;
      const lines = renderTimeline(st);
      assertRect(lines, w, h, `timeline ${w}x${h} cursor=${cursor}`);
    }
  }
});

test("问题面板：多尺寸下每行宽度精确", { skip: !sample }, async () => {
  const st = initialState();
  st.analysis = await analyzeSessionFile(sample!);
  st.timelineRows = buildTimelineRows(st.analysis);

  for (const [w, h] of [
    [80, 24],
    [120, 30],
    [160, 40],
  ] as const) {
    st.width = w;
    st.height = h;
    const lines = renderIssues(st);
    assertRect(lines, w, h, `issues ${w}x${h}`);
  }
});

test("时间轴：每个 step 都能在详情里渲染且不超宽", { skip: !sample }, async () => {
  const st = initialState();
  st.analysis = await analyzeSessionFile(sample!);
  st.timelineRows = buildTimelineRows(st.analysis);
  st.width = 120;
  st.height = 30;

  const stepRows = st.timelineRows.filter((r) => r.kind === "step");
  assert.ok(stepRows.length > 0);
  // 抽样校验（全量 200+ 行也很快，但留余量）
  const picks = [0, 1, Math.floor(stepRows.length / 2), stepRows.length - 1];
  for (const i of picks) {
    const row = stepRows[i];
    if (!row) continue;
    const idx = st.timelineRows.indexOf(row);
    st.timelineCursor = idx;
    st.detailOffset = 0;
    const lines = renderTimeline(st);
    assertRect(lines, 120, 30, `detail step@${idx}`);
  }
});

test("压缩对比视图：多尺寸 × 三种视角每行宽度精确", { skip: !sample }, async () => {
  const st = initialState();
  st.analysis = await analyzeSessionFile(sample!);
  const items = findCompactionSteps(st);
  if (items.length === 0) return; // 样本无压缩则跳过

  for (const [w, h] of [
    [80, 24],
    [100, 30],
    [120, 24],
    [160, 40],
  ] as const) {
    for (const mode of ["summary", "swallowed", "missing"] as const) {
      st.width = w;
      st.height = h;
      const cmp = newCompareState();
      cmp.mode = mode;
      const lines = renderCompactionCompare(st, cmp, items[0]!.step.compaction!, "test");
      assertRect(lines, w, h, `compaction ${mode} ${w}x${h}`);
    }
  }
});

test("时间轴折叠状态：多尺寸下每行宽度精确", { skip: !sample }, async () => {
  const st = initialState();
  st.analysis = await analyzeSessionFile(sample!);
  st.timelineRows = buildTimelineRows(st.analysis);

  // 三种折叠状态：全折叠到段 / 折叠 loop / 折叠迭代
  const segKeys = st.timelineRows.filter((r) => r.kind === "segment").map((r) => segKey(r.segmentIndex));
  const loopRow = st.timelineRows.find((r) => r.kind === "loop");
  const turnRow = st.timelineRows.find((r) => r.kind === "turn");

  const states: [string, Set<string>][] = [
    ["全部折叠到段", new Set(segKeys)],
    [
      "折叠单个 loop",
      new Set(loopRow ? [loopKey(loopRow.segmentIndex, loopRow.loopIndex ?? 0)] : []),
    ],
    [
      "折叠单个迭代",
      new Set(turnRow ? [turnKey(turnRow.segmentIndex, turnRow.loopIndex ?? 0, turnRow.turnIndex)] : []),
    ],
  ];

  for (const [label, collapsed] of states) {
    for (const [w, h] of [
      [80, 24],
      [120, 30],
      [160, 40],
    ] as const) {
      st.width = w;
      st.height = h;
      st.collapsed = new Set(collapsed);
      st.timelineCursor = 0;
      st.detailOffset = 0;
      const lines = renderTimeline(st);
      assertRect(lines, w, h, `fold(${label}) ${w}x${h}`);
    }
  }
});
