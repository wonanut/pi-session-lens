/**
 * AgentLoop 归组测试。
 *
 * 核心断言：**一个用户请求 = 一个 agent loop**，内部的模型往返是迭代而不是
 * 并列的独立循环。这是本项目最容易搞错的地方 —— 之前把每次 assistant
 * 响应当成独立 turn，导致流程图每个 T 都从「构建请求」开始，
 * 看起来像跳过了构建请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { analyzeSessionFile } from "../src/core/analyze.ts";
import { buildAgentLoops } from "../src/core/loops.ts";
import type { Segment, Turn } from "../src/core/model.ts";

const DIR = "/home/tyao/文档/code/config-generation-design-agent/var/pi_sessions";

function pickSample(): string | null {
  const roots = [process.env.PI_LENS_SESSION_DIR, DIR].filter(Boolean) as string[];
  const files: string[] = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    try {
      for (const f of readdirSync(r)) if (f.endsWith(".jsonl")) files.push(join(r, f));
    } catch {
      /* ignore */
    }
    if (files.length) break;
  }
  // 优先挑「一个请求里有多次模型往返」的会话，最能验证归组
  for (const p of files) {
    try {
      const txt = readFileSync(p, "utf8");
      const assistants = (txt.match(/"role":"assistant"/g) ?? []).length;
      const users = (txt.match(/"role":"user"/g) ?? []).length;
      if (users > 0 && assistants >= users * 3) return p;
    } catch {
      /* ignore */
    }
  }
  return files[0] ?? null;
}

const sample = pickSample();

/** 造一个 turn，用于精确控制循环边界。 */
function mkTurn(index: number, opts: {
  toolCalls?: number;
  text?: boolean;
  stopReason?: string;
  isError?: boolean;
}): Turn {
  const steps: Turn["steps"] = [];
  if (opts.text) {
    steps.push({
      key: `${index}:0`,
      kind: "text",
      entryId: `e${index}`,
      at: "2026-01-01T00:00:00Z",
      offsetMs: index * 1000,
      text: "完成",
    });
  }
  for (let i = 0; i < (opts.toolCalls ?? 0); i++) {
    steps.push({
      key: `${index}:${steps.length}`,
      kind: "tool_call",
      entryId: `e${index}`,
      at: "2026-01-01T00:00:00Z",
      offsetMs: index * 1000,
      tool: `tool${i}`,
      isError: opts.isError && i === 0,
    });
  }
  return {
    index,
    steps,
    startAt: "2026-01-01T00:00:00Z",
    endAt: "2026-01-01T00:00:01Z",
    offsetMs: index * 1000,
    durationMs: 1000,
    hasError: Boolean(opts.isError),
    stopReason: opts.stopReason ?? (opts.toolCalls ? "toolUse" : "stop"),
  };
}

test("多个工具往返归入同一个 loop（不是并列的多个 loop）", () => {
  // 模拟真实结构：3 次带工具的往返 + 1 次最终文本
  const turns = [
    mkTurn(0, { toolCalls: 2 }),
    mkTurn(1, { toolCalls: 1 }),
    mkTurn(2, { toolCalls: 3 }),
    mkTurn(3, { text: true }),
  ];
  const loops = buildAgentLoops(turns, 0, "用户请求");
  assert.equal(loops.length, 1, `应只有 1 个 loop，实际 ${loops.length}`);
  assert.equal(loops[0]!.iterationCount, 4, "该 loop 应有 4 次迭代");
  assert.equal(loops[0]!.toolCallCount, 6, "工具调用数应为 2+1+3=6");
  assert.equal(loops[0]!.converged, true, "最后一轮无工具调用应判为收敛");
});

test("循环在模型不再调工具时收口", () => {
  const turns = [
    mkTurn(0, { toolCalls: 1 }),
    mkTurn(1, { text: true }), // 收敛
    mkTurn(2, { toolCalls: 1 }), // 新循环
    mkTurn(3, { text: true }),
  ];
  const loops = buildAgentLoops(turns, 0, "请求");
  assert.equal(loops.length, 2, `应收口成 2 个 loop，实际 ${loops.length}`);
  assert.equal(loops[0]!.iterationCount, 2);
  assert.equal(loops[1]!.iterationCount, 2);
  assert.ok(loops[0]!.converged && loops[1]!.converged);
});

test("末尾仍在调工具：判为未收敛而不是丢弃", () => {
  const turns = [mkTurn(0, { toolCalls: 1 }), mkTurn(1, { toolCalls: 2 })];
  const loops = buildAgentLoops(turns, 0, "请求");
  assert.equal(loops.length, 1);
  assert.equal(loops[0]!.converged, false, "末尾还有工具调用应判未收敛");
  assert.equal(loops[0]!.endReason, "open");
});

test("截断 / 中断会终止循环", () => {
  for (const reason of ["length", "aborted", "error"]) {
    const turns = [mkTurn(0, { toolCalls: 1 }), mkTurn(1, { toolCalls: 1, stopReason: reason })];
    const loops = buildAgentLoops(turns, 0, "请求");
    assert.equal(loops.length, 1, `${reason} 不应切出新 loop`);
    assert.equal(loops[0]!.converged, false, `${reason} 不应判为收敛`);
  }
});

test("真实会话：段与 loop 一一对应，迭代总数守恒", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  assert.ok(a.segments.length > 0);
  for (const seg of a.segments) {
    assert.ok((seg.loops ?? []).length > 0, `段 ${seg.index} 应有 loop`);
    // 所有 turn 都被某个 loop 覆盖，且不重复
    const covered = seg.loops.flatMap((l) => l.turns.map((t) => t.index));
    assert.equal(covered.length, seg.turns.length, "loop 覆盖的 turn 数应等于段内 turn 数");
    assert.equal(new Set(covered).size, covered.length, "turn 不应被重复归组");
    assert.deepEqual(
      [...covered].sort((x, y) => x - y),
      seg.turns.map((t) => t.index).sort((x, y) => x - y),
      "loop 覆盖的 turn 应完整",
    );
  }
});

test("真实会话：单次请求确实包含多次迭代（证明确实该归组）", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const maxIter = Math.max(...a.segments.map((s) => Math.max(...(s.loops ?? []).map((l) => l.iterationCount))));
  assert.ok(
    maxIter > 1,
    `样本中至少应有一个 loop 含多次迭代（实际最大 ${maxIter}）—— ` +
      "若为 1，说明数据不支持归组，测试样本选错了",
  );
});

test("真实会话：loop 的收敛状态与最后一轮一致", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  for (const seg of a.segments) {
    for (const loop of seg.loops ?? []) {
      const last = loop.turns[loop.turns.length - 1];
      assert.ok(last, "loop 必须有 turn");
      const hasTool = last.steps.some((s) => s.kind === "tool_call");
      const badStop = ["length", "aborted", "error"].includes(last.stopReason ?? "");
      const expectedConverged = !hasTool && !badStop;
      assert.equal(
        loop.converged,
        expectedConverged,
        `loop#${loop.index} 收敛状态应与最后一轮一致（有工具=${hasTool}, stop=${last.stopReason}）`,
      );
    }
  }
});

test("时间轴行包含 loop 层级且层级递进", { skip: !sample }, async () => {
  const { buildTimelineRows } = await import("../src/ui/state.ts");
  const a = await analyzeSessionFile(sample!);
  const rows = buildTimelineRows(a);
  const kinds = new Set(rows.map((r) => r.kind));
  assert.ok(kinds.has("segment"), "应有段行");
  assert.ok(kinds.has("loop"), "应有 loop 行");
  assert.ok(kinds.has("turn"), "应有迭代行");
  assert.ok(kinds.has("step"), "应有 step 行");
  // 深度应逐级递增：seg(0) < loop(1) < turn(2) < step(3)
  const depthOf = (k: string): number => rows.find((r) => r.kind === k)!.depth;
  assert.ok(depthOf("segment") < depthOf("loop"));
  assert.ok(depthOf("loop") < depthOf("turn"));
  assert.ok(depthOf("turn") < depthOf("step"));
});
