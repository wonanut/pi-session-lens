/**
 * 解析 + 两层建模的核心行为测试。
 *
 * 用真实会话文件跑，而不是造假数据：格式细节（timestamp 单位、parentId、
 * compaction 的 firstKeptEntryId）只有真实数据能验证。测试会在找不到
 * 样本会话时自动跳过，保证换机器也能跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  estimateTokens,
  parseSessionFile,
  sessionIdFromFilename,
  splitUserText,
  toolCalls,
  thinkingText,
} from "../src/core/parser.ts";
import { buildTurns, outcomeIsProblem, summarizeToolResult } from "../src/core/turns.ts";
import { extractPrompts } from "../src/core/prompts.ts";
import { buildSegmentsDetailed } from "../src/core/segments.ts";
import { analyzeSessionFile } from "../src/core/analyze.ts";
import { detectIssues, computeHealth } from "../src/core/issues.ts";

/** 找一个可用的真实会话文件；找不到返回 null（测试跳过）。 */
function findSampleSession(preferCompaction = true): string | null {
  const roots = [
    process.env.PI_LENS_SESSION_DIR,
    "/home/tyao/文档/code/config-generation-design-agent/var/pi_sessions",
    join(homedir(), ".pi", "agent", "sessions"),
  ].filter(Boolean) as string[];

  const files: string[] = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return;
      let ents: string[] = [];
      try {
        ents = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of ents) {
        const p = join(dir, e);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(p, depth + 1);
        else if (e.endsWith(".jsonl")) files.push(p);
      }
    };
    walk(r, 0);
    if (files.length > 0) break;
  }
  if (files.length === 0) return null;

  if (!preferCompaction) {
    files.sort((a, b) => statSync(a).size - statSync(b).size);
    return files[0] ?? null;
  }
  // 优先找含 compaction 的会话（能验证压缩信号）
  for (const f of files) {
    try {
      const txt = readFileSync(f, "utf8");
      if (txt.includes('"type":"compaction"')) return f;
    } catch {
      /* ignore */
    }
  }
  return files[0] ?? null;
}

test("splitUserText 把用户原话与系统说明分开", () => {
  const { user, system } = splitUserText("帮我生成命令\n---\n你是 MML 专家，只输出命令");
  assert.equal(user, "帮我生成命令");
  assert.match(system, /MML 专家/);
});

test("estimateTokens 对中文给非零且单调", () => {
  const a = estimateTokens("你好");
  const b = estimateTokens("你好世界你好世界");
  assert.ok(a > 0);
  assert.ok(b > a);
  assert.equal(estimateTokens(""), 0);
});

test("sessionIdFromFilename 解析 <ts>_<id>.jsonl", () => {
  assert.equal(
    sessionIdFromFilename("/x/2026-11-16T12-31-01-607Z_94ad0bd565034928.jsonl"),
    "94ad0bd565034928",
  );
  assert.equal(sessionIdFromFilename("/x/plain.jsonl"), "plain");
});

test("summarizeToolResult 把「知识库查无此命令」识别为 not_found（非故障）", () => {
  const r = summarizeToolResult(
    "mml_command_spec",
    '{"ok": false, "error": "知识库中没有命令 ADD SESSION（站点 UEG-S）"}',
    true,
  );
  assert.equal(r.outcome, "not_found", "查无此命令应归为 not_found 而不是错误");
  assert.equal(outcomeIsProblem(r.outcome), false, "not_found 不应算作需要干预的问题");
  assert.match(r.brief, /ADD SESSION/);
});

test("summarizeToolResult：不支持的命令 + supported 列表也算 not_found", () => {
  const r = summarizeToolResult(
    "mml_exp_names",
    '{"ok": false, "error": "不支持的命令: ADD L7FILTER", "supported": ["ADD FILTER"]}',
    true,
  );
  assert.equal(r.outcome, "not_found");
  assert.equal(outcomeIsProblem(r.outcome), false);
});

test("summarizeToolResult：成功返回带空 missing_required 不算缺参数", () => {
  const okBody = JSON.stringify({
    ok: true,
    status: "RENDERED",
    command_name: "ADD L3VPNINST",
    missing_required: [],
    errors: [],
  });
  const r = summarizeToolResult("mml_render_mml", okBody, false);
  assert.equal(r.outcome, "ok", "空 missing_required 不应被判成缺参数");
});

test("summarizeToolResult：真正缺必填参数归为 missing_params", () => {
  const body = JSON.stringify({
    ok: false,
    results: [{ ok: false, command_name: "ADD APN", missing_required: ["APN", "IPVERSION"] }],
  });
  const r = summarizeToolResult("mml_render_batch", body, true);
  assert.equal(r.outcome, "missing_params");
  assert.equal(outcomeIsProblem(r.outcome), true);
});

test("summarizeToolResult：真正的执行失败仍是 real_error", () => {
  const r = summarizeToolResult("bash", "Connection timed out", true);
  assert.equal(r.outcome, "real_error");
  assert.equal(outcomeIsProblem(r.outcome), true);
  assert.match(r.brief, /^ERROR: /);
});

test("summarizeToolResult：步骤核对结论归为 step_gap", () => {
  const body = JSON.stringify({
    ok: false,
    total_steps: 10,
    covered: ["1", "2"],
    missing: [{ step: "3", title: "配置X" }],
  });
  const r = summarizeToolResult("mml_feature_steps", body, true);
  assert.equal(r.outcome, "step_gap");
  assert.equal(outcomeIsProblem(r.outcome), false);
});

test("summarizeToolResult 正常返回提炼数量字段", () => {
  const r = summarizeToolResult("mml_knowledge_search", '{"ok":true,"hits":[1,2,3]}', false);
  assert.match(r.brief, /hits:3/);
  assert.equal(r.outcome, "ok");
});

const sample = findSampleSession();

test("解析真实会话：entries/branch/usage 自洽", { skip: !sample }, async () => {
  const s = await parseSessionFile(sample!);
  assert.ok(s.sessionId.length > 0);
  assert.ok(s.entries.length > 0);
  assert.ok(s.branch.length > 0);
  assert.equal(s.badLines, 0, "真实会话不应有坏行");
  assert.ok(s.totalUsage.totalTokens >= 0);
  // branch 不应比 entries 多（分支会被裁剪）
  assert.ok(s.branch.length <= s.entries.length);
});

test("buildTurns：每个 assistant 消息开启一个 turn", { skip: !sample }, async () => {
  const s = await parseSessionFile(sample!);
  const turns = buildTurns({ entries: s.branch, sessionStart: Date.parse(s.startedAt) });
  assert.ok(turns.length > 0);
  const assistantCount = s.branch.filter((e) => {
    if (e.type !== "message") return false;
    const m = (e as { message?: { role?: string } }).message;
    return m?.role === "assistant";
  }).length;
  assert.equal(turns.length, assistantCount, "turn 数应等于 assistant 消息数");
  // 每个 turn 的 step key 唯一
  const keys = new Set<string>();
  for (const t of turns) {
    for (const st of t.steps) {
      assert.ok(!keys.has(st.key), `step key 重复: ${st.key}`);
      keys.add(st.key);
    }
  }
});

test("buildTurns：toolResult 回填到对应 tool_call（不产生孤立 step）", { skip: !sample }, async () => {
  const s = await parseSessionFile(sample!);
  const turns = buildTurns({ entries: s.branch, sessionStart: Date.parse(s.startedAt) });
  const orphan = turns.flatMap((t) => t.steps).filter((st) => st.kind === "tool_result");
  // 孤立结果只应出现在「调用被裁掉」的情况，正常会话应为 0
  assert.equal(orphan.length, 0, `不应有孤立 tool_result，实际 ${orphan.length}`);
  // 每个 tool_call 都应该拿到 resultBrief
  const calls = turns.flatMap((t) => t.steps).filter((st) => st.kind === "tool_call");
  const withBrief = calls.filter((c) => c.resultBrief !== undefined);
  assert.ok(withBrief.length / calls.length > 0.9, "绝大多数调用应有返回摘要");
});

test("分段：段数 >= 1 且首段有 prompt", { skip: !sample }, async () => {
  const s = await parseSessionFile(sample!);
  const turns = buildTurns({ entries: s.branch, sessionStart: Date.parse(s.startedAt) });
  const prompts = extractPrompts(s.branch);
  const { segments } = buildSegmentsDetailed(turns, prompts);
  assert.ok(segments.length >= 1);
  assert.ok(prompts.length >= 1);
  assert.ok(segments[0]!.prompt.length > 0);
  // 所有 turn 都应被覆盖且不重复
  const covered = segments.flatMap((g) => g.turns.map((t) => t.index));
  assert.equal(covered.length, turns.length);
  assert.equal(new Set(covered).size, turns.length);
});

test("压缩会话：compaction 变成 step 且被计为一次压缩", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const compSteps = a.segments
    .flatMap((g) => g.turns)
    .flatMap((t) => t.steps)
    .filter((s) => s.kind === "compaction");
  const declared = a.session.typeCounts["compaction"] ?? 0;
  assert.equal(compSteps.length, declared, "compaction step 数应等于 entry 数");
  assert.equal(a.totals.compactions, declared, "统计的压缩次数不应虚高");
});

test("问题检测：错误 step 一定入选 issue", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const errSteps = a.segments
    .flatMap((g) => g.turns)
    .flatMap((t) => t.steps)
    .filter((s) => s.isError);
  for (const s of errSteps) {
    const hit = a.issues.some((i) => i.stepKey === s.key);
    assert.ok(hit, `出错的 step ${s.key} (${s.tool}) 未进入 issue 列表`);
  }
});

test("问题检测：每个 issue 都能定位到 step 或 turn", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  for (const i of a.issues) {
    assert.ok(Number.isInteger(i.segmentIndex));
    const seg = a.segments[i.segmentIndex];
    assert.ok(seg, `issue ${i.index} 的 segmentIndex 越界`);
    if (i.stepKey) {
      const has = seg.turns.some((t) => t.steps.some((s) => s.key === i.stepKey));
      assert.ok(has, `issue ${i.index} 指向的 step ${i.stepKey} 不在该段内`);
    }
  }
});

test("健康分在 0-100 之间", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  assert.ok(a.health >= 0 && a.health <= 100);
});

test("detectIssues 对空会话不抛错", () => {
  const fake = {
    path: "",
    sessionId: "x",
    headerId: "x",
    version: 3,
    cwd: "",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    entries: [],
    byId: new Map(),
    branch: [],
    leafCount: 1,
    typeCounts: {},
    badLines: 0,
    bytes: 0,
    totalUsage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const issues = detectIssues({ segments: [], session: fake as never });
  assert.deepEqual(issues, []);
  assert.equal(computeHealth([], [], []), 100);
});
