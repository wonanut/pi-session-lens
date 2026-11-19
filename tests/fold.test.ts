/**
 * 折叠功能测试。
 *
 * 折叠最容易出两类 bug：
 *   1. 折叠了但子行还在（过滤没生效）
 *   2. 折叠后光标越界（原来指向的行被隐藏了）
 * 两者在界面上都表现为「按键没反应」，很难凭肉眼排查，必须自动断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { analyzeSessionFile } from "../src/core/analyze.ts";
import {
  buildTimelineRows,
  countHidden,
  isRowHidden,
  loopKey,
  rowKey,
  segKey,
  turnKey,
  visibleRows,
} from "../src/ui/state.ts";
import type { TimelineRow } from "../src/ui/state.ts";

const DIR = "/home/tyao/文档/code/config-generation-design-agent/var/pi_sessions";

function pickSample(): string | null {
  const roots = [process.env.PI_LENS_SESSION_DIR, DIR].filter(Boolean) as string[];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const files = readdirSync(r).filter((f) => f.endsWith(".jsonl")).map((f) => join(r, f));
    files.sort((a, b) => {
      try {
        return require("node:fs").statSync(b).size - require("node:fs").statSync(a).size;
      } catch {
        return 0;
      }
    });
    // 挑段落最多的，折叠场景才有代表性
    for (const f of files.slice(0, 20)) {
      try {
        const txt = require("node:fs").readFileSync(f, "utf8") as string;
        if ((txt.match(/"role":"assistant"/g) ?? []).length > 30) return f;
      } catch {
        /* ignore */
      }
    }
    return files[0] ?? null;
  }
  return null;
}

const sample = pickSample();

let cacheRows: TimelineRow[] | null = null;
async function rows(): Promise<TimelineRow[]> {
  if (cacheRows) return cacheRows;
  const a = await analyzeSessionFile(sample!);
  cacheRows = buildTimelineRows(a);
  return cacheRows;
}

test("折叠段：只保留段行，段内全部隐藏", { skip: !sample }, async () => {
  const all = await rows();
  const segCount = all.filter((r) => r.kind === "segment").length;
  const collapsed = new Set([segKey(0)]);
  const vis = visibleRows(all, collapsed);

  assert.equal(vis.length, all.length - countHidden(all, segKey(0)), "可见行数应等于总数减隐藏数");
  // 段 0 的所有子行都不在可见列表里
  const seg0Children = vis.filter((r) => r.segmentIndex === 0 && r.kind !== "segment");
  assert.equal(seg0Children.length, 0, `段 0 的子行应全部隐藏，实际还有 ${seg0Children.length}`);
  // 段 0 自己仍然可见
  assert.ok(vis.some((r) => r.kind === "segment" && r.segmentIndex === 0), "段本身应可见");
  // 其它段不受影响
  if (segCount > 1) {
    const seg1Loop = vis.filter((r) => r.segmentIndex === 1 && r.kind === "loop");
    assert.ok(seg1Loop.length > 0, "折叠段 0 不应影响段 1");
  }
});

test("折叠 loop：隐藏它下面的迭代与 step，但保留 loop 行", { skip: !sample }, async () => {
  const all = await rows();
  const loop = all.find((r) => r.kind === "loop");
  assert.ok(loop, "样本应有 loop 行");
  const key = loopKey(loop!.segmentIndex, loop!.loopIndex ?? 0);
  const vis = visibleRows(all, new Set([key]));

  assert.ok(
    vis.some((r) => r.kind === "loop" && r.loopIndex === loop!.loopIndex && r.segmentIndex === loop!.segmentIndex),
    "loop 行本身应保留",
  );
  const children = vis.filter(
    (r) => r.segmentIndex === loop!.segmentIndex && r.loopIndex === loop!.loopIndex && r.depth > 1,
  );
  assert.equal(children.length, 0, `loop 下的迭代/step 应全部隐藏，实际 ${children.length}`);
});

test("折叠迭代：只隐藏该迭代的 step，其它迭代不受影响", { skip: !sample }, async () => {
  const all = await rows();
  const seg = all[0]!;
  const turns = all.filter((r) => r.kind === "turn" && r.segmentIndex === seg.segmentIndex);
  assert.ok(turns.length >= 2, "需要至少两次迭代来验证隔离性");
  const t0 = turns[0]!;
  const key = turnKey(t0.segmentIndex, t0.loopIndex ?? 0, t0.turnIndex);
  const vis = visibleRows(all, new Set([key]));

  assert.ok(vis.some((r) => r.kind === "turn" && r.turnIndex === t0.turnIndex), "迭代行本身应保留");
  const t0Steps = vis.filter((r) => r.kind === "step" && r.turnIndex === t0.turnIndex);
  assert.equal(t0Steps.length, 0, "被折叠迭代的 step 应全部隐藏");
  // 其它迭代的 step 仍在
  const t1 = turns[1]!;
  const t1Steps = vis.filter((r) => r.kind === "step" && r.turnIndex === t1.turnIndex);
  assert.ok(t1Steps.length > 0, "其它迭代的 step 不应受影响");
});

test("多层折叠叠加：段折叠优先级高于内部折叠", { skip: !sample }, async () => {
  const all = await rows();
  const loop = all.find((r) => r.kind === "loop")!;
  const collapsed = new Set([
    segKey(loop.segmentIndex),
    loopKey(loop.segmentIndex, loop.loopIndex ?? 0),
  ]);
  const vis = visibleRows(all, collapsed);
  const children = vis.filter((r) => r.segmentIndex === loop.segmentIndex && r.depth > 0);
  assert.equal(children.length, 0, "段折叠后内部一切折叠都不该让行漏出");
});

test("全部折叠：可见行只剩段", { skip: !sample }, async () => {
  const all = await rows();
  const collapsed = new Set<string>();
  for (const r of all) if (r.kind === "segment") collapsed.add(segKey(r.segmentIndex));
  const vis = visibleRows(all, collapsed);
  assert.ok(vis.every((r) => r.kind === "segment"), "全部折叠后应只剩段行");
  assert.equal(vis.length, all.filter((r) => r.kind === "segment").length);
});

test("countHidden 统计的数量与实际隐藏数一致", { skip: !sample }, async () => {
  const all = await rows();
  const loop = all.find((r) => r.kind === "loop")!;
  const key = loopKey(loop.segmentIndex, loop.loopIndex ?? 0);
  const manual = all.filter((r) => {
    if (r.segmentIndex !== loop.segmentIndex) return false;
    if (r.loopIndex !== loop.loopIndex) return false;
    return r.depth > 1;
  }).length;
  // countHidden 返回的是「隐藏行数」（已扣掉节点自身）
  assert.equal(countHidden(all, key), manual, "隐藏计数应与实际子行数一致");
});

test("step 不可折叠（rowKey 为 null）", { skip: !sample }, async () => {
  const all = await rows();
  const step = all.find((r) => r.kind === "step");
  if (!step) return;
  assert.equal(rowKey(step), null, "step 不应有折叠键");
});

test("折叠不影响行内容本身（数据层未被修改）", { skip: !sample }, async () => {
  const all = await rows();
  const before = all.length;
  visibleRows(all, new Set([segKey(0)]));
  assert.equal(all.length, before, "过滤不应修改原数组");
});

test("isRowHidden：未折叠时一切可见", { skip: !sample }, async () => {
  const all = await rows();
  for (const r of all.slice(0, 30)) {
    assert.equal(isRowHidden(r, new Set()), false);
  }
});
