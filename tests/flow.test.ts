/**
 * 流程图与时间轴联动测试。
 *
 * 核心诉求：「选中会话里的一个过程，就高亮对应的 loop 节点」。
 * 这里逐类 step 验证映射正确 —— 选错节点比没有高亮更糟，
 * 会让人误判是另一步出了问题。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { analyzeSessionFile } from "../src/core/analyze.ts";
import { buildFlowDiagram } from "../src/ui/flow-diagram.ts";
import { visibleWidth } from "../src/ui/text.ts";
import { buildTimelineRows } from "../src/ui/state.ts";

const DIR = "/home/tyao/文档/code/config-generation-design-agent/var/pi_sessions";

function pickSample(): string | null {
  const roots = [
    process.env.PI_LENS_SESSION_DIR,
    DIR,
    join(process.env.HOME ?? "~", ".pi", "agent", "sessions"),
  ].filter(Boolean) as string[];

  const files: string[] = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    try {
      for (const f of readdirSync(r)) {
        if (f.endsWith(".jsonl")) files.push(join(r, f));
      }
    } catch {
      /* ignore */
    }
    if (files.length > 0) break;
  }
  if (files.length === 0) return null;

  // 优先挑含 compaction 的（覆盖压缩节点），其次任意一个
  for (const p of files) {
    try {
      if (readFileSync(p, "utf8").includes('"type":"compaction"')) return p;
    } catch {
      /* ignore */
    }
  }
  return files[0] ?? null;
}

const sample = pickSample();

test("流程图：选中 turn 时高亮 turn 节点", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const seg = a.segments[0]!;
  const turn = seg.turns[0]!;
  const d = buildFlowDiagram(seg, { turnIndex: turn.index, hasStep: false }, 90);
  assert.ok(d.lines.length > 0, "应产出流程图");
  assert.ok(d.active.includes("turn"), `应高亮 turn，实际 ${JSON.stringify(d.active)}`);
  assert.equal(d.primary, "turn");
});

test("流程图：选中 thinking 时高亮思考节点", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  for (const seg of a.segments) {
    for (const turn of seg.turns) {
      const st = turn.steps.find((s) => s.kind === "thinking");
      if (!st) continue;
      const d = buildFlowDiagram(seg, { turnIndex: turn.index, stepKey: st.key, hasStep: true }, 90);
      assert.ok(d.active.includes("thinking"), `thinking 应高亮思考节点，实际 ${JSON.stringify(d.active)}`);
      return;
    }
  }
  assert.fail("样本里没有 thinking step");
});

test("流程图：选中 tool_call 时精确高亮到那一次调用", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  for (const seg of a.segments) {
    for (const turn of seg.turns) {
      const calls = turn.steps.filter((s) => s.kind === "tool_call");
      if (calls.length < 2) continue;
      // 选第二个调用，验证不会误高亮第一个
      const target = calls[1]!;
      const d = buildFlowDiagram(seg, { turnIndex: turn.index, stepKey: target.key, hasStep: true }, 90);
      assert.ok(
        d.active.includes(`call:${target.key}`),
        `应高亮 ${target.key}，实际 ${JSON.stringify(d.active)}`,
      );
      assert.ok(
        !d.active.includes(`call:${calls[0]!.key}`),
        `不应高亮第一个调用，实际 ${JSON.stringify(d.active)}`,
      );
      // 图上应只有一个 ◀ 当前 标记（除了阶段标题）
      const marks = d.lines.filter((l) => l.includes("◀ 当前")).length;
      assert.ok(marks >= 1, "应至少有一处当前标记");
      return;
    }
  }
  assert.fail("样本里没有多调用的 turn");
});

test("流程图：选中 text 时高亮出口", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const d2: string[] = [];
  for (const seg of a.segments) {
    for (const turn of seg.turns) {
      const st = turn.steps.find((s) => s.kind === "text");
      if (!st) continue;
      const d = buildFlowDiagram(seg, { turnIndex: turn.index, stepKey: st.key, hasStep: true }, 90);
      assert.ok(
        d.active.includes(`text:${st.key}`) || d.active.includes("exit"),
        `text 应高亮出口或自身，实际 ${JSON.stringify(d.active)}`,
      );
      d2.push("ok");
    }
  }
  assert.ok(d2.length > 0, "样本里没有 text step");
});

test("流程图：选中 compaction 时高亮压缩节点", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  for (const seg of a.segments) {
    for (const turn of seg.turns) {
      const st = turn.steps.find((s) => s.kind === "compaction");
      if (!st) continue;
      const d = buildFlowDiagram(seg, { turnIndex: turn.index, stepKey: st.key, hasStep: true }, 90);
      assert.ok(
        d.active.includes("compaction"),
        `compaction 应高亮压缩节点，实际 ${JSON.stringify(d.active)}`,
      );
      return;
    }
  }
  assert.fail("样本里没有 compaction step");
});

test("流程图：多宽度下不超宽", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const seg = a.segments[0]!;
  for (const w of [40, 60, 80, 100, 130, 200]) {
    for (const turn of seg.turns.slice(0, 5)) {
      const d = buildFlowDiagram(seg, { turnIndex: turn.index, hasStep: false }, w);
      d.lines.forEach((l, i) => {
        const vw = visibleWidth(l);
        assert.ok(vw <= w + 4, `宽度 ${w} 下第 ${i} 行 ${vw} 列超宽: ${JSON.stringify(l)}`);
      });
    }
  }
});

test("流程图：每个节点 id 唯一且能被 active 引用", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const seg = a.segments[0]!;
  for (const turn of seg.turns.slice(0, 8)) {
    const d = buildFlowDiagram(seg, { turnIndex: turn.index, hasStep: false }, 90);
    const ids = d.nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, `turn ${turn.index} 节点 id 重复: ${ids}`);
    for (const act of d.active) {
      assert.ok(ids.includes(act), `active ${act} 不在节点列表里: ${ids}`);
    }
  }
});

test("时间轴行 → 流程图：每类行都能渲染出图", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const rows = buildTimelineRows(a);
  let rendered = 0;
  for (const row of rows.slice(0, 40)) {
    const seg = a.segments[row.segmentIndex]!;
    const d = buildFlowDiagram(
      seg,
      { turnIndex: row.turnIndex, stepKey: row.kind === "step" ? row.stepKey : undefined, hasStep: row.kind === "step" },
      90,
    );
    assert.ok(d.lines.length > 0, `行 ${row.kind}@${row.turnIndex} 未产出流程图`);
    rendered++;
  }
  assert.ok(rendered >= 20, `应渲染至少 20 行，实际 ${rendered}`);
});
