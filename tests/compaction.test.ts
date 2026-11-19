/**
 * 压缩还原测试。
 *
 * 两个关键点必须固定住：
 *   1. 边界规则 —— 多次压缩时起点是「上次的保留边界」，
 *      若误用「上次 compaction 自身」，已保留的消息会被重复报成被吞掉。
 *   2. 漏词检测 —— 不能把普通英文词当成关键取值，否则满屏噪音。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { analyzeSessionFile } from "../src/core/analyze.ts";
import { buildCompactionDetails } from "../src/core/compaction.ts";
import { findMissingTerms } from "../src/ui/view-compaction.ts";
import type { SessionEntry } from "../src/core/types.ts";

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
  for (const p of files) {
    try {
      if (readFileSync(p, "utf8").includes('"type":"compaction"')) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const sample = pickSample();

/** 造一个最小 entry 序列，用于精确控制多次压缩的边界。 */
function mkEntry(id: string, parentId: string | null, ts: string, type = "custom"): SessionEntry {
  return { id, parentId, timestamp: ts, type } as unknown as SessionEntry;
}

function mkMsg(
  id: string,
  parentId: string | null,
  ts: string,
  role: "user" | "assistant" | "toolResult",
  text: string,
): SessionEntry {
  let message: Record<string, unknown>;
  if (role === "assistant") {
    message = { role, content: [{ type: "text", text }], timestamp: 0, stopReason: "stop" };
  } else if (role === "toolResult") {
    message = {
      role,
      toolCallId: "c1",
      toolName: "tool_x",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 0,
    };
  } else {
    message = { role, content: [{ type: "text", text }], timestamp: 0 };
  }
  return {
    id,
    parentId,
    timestamp: ts,
    type: "message",
    message,
  } as unknown as SessionEntry;
}

function mkCompaction(
  id: string,
  parentId: string | null,
  ts: string,
  summary: string,
  firstKeptEntryId: string,
  tokensBefore: number,
): SessionEntry {
  return {
    id,
    parentId,
    timestamp: ts,
    type: "compaction",
    summary,
    firstKeptEntryId,
    tokensBefore,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
  } as unknown as SessionEntry;
}

test("单次压缩：被吞范围是 [起点, firstKeptEntryId)", () => {
  const entries: SessionEntry[] = [
    mkMsg("u1", null, "2026-01-01T00:00:01Z", "user", "需求一 ADD FOO"),
    mkMsg("a1", "u1", "2026-01-01T00:00:02Z", "assistant", "好的"),
    mkMsg("u2", "a1", "2026-01-01T00:00:03Z", "user", "需求二 SET BAR"),
    mkMsg("a2", "u2", "2026-01-01T00:00:04Z", "assistant", "收到"),
    mkCompaction("c1", "a2", "2026-01-01T00:00:05Z", "摘要一", "u2", 1000),
  ];
  const map = buildCompactionDetails(entries);
  const d = map.get("c1")!;
  assert.ok(d, "应算出 c1 的详情");
  // u1, a1 被吞；u2, a2 保留
  assert.equal(d.swallowedCount, 2, `应吞 2 条，实际 ${d.swallowed.map((s) => s.entryId)}`);
  assert.deepEqual(d.swallowed.map((s) => s.entryId), ["u1", "a1"]);
  assert.equal(d.tokensBefore, 1000);
  assert.equal(d.ordinal, 1);
  assert.equal(d.usage?.output, 50);
});

test("多次压缩：第二次起点是上次保留边界，不是上次 compaction 自身", () => {
  const entries: SessionEntry[] = [
    mkMsg("u1", null, "t1", "user", "第一段需求"),
    mkMsg("a1", "u1", "t2", "assistant", "第一次回复"),
    mkMsg("u2", "a1", "t3", "user", "第二段需求"),
    mkMsg("a2", "u2", "t4", "assistant", "第二次回复"),
    mkCompaction("c1", "a2", "t5", "摘要一", "u2", 1000),
    mkMsg("u3", "c1", "t6", "user", "第三段需求"),
    mkMsg("a3", "u3", "t7", "assistant", "第三次回复"),
    mkCompaction("c2", "a3", "t8", "摘要二", "u3", 2000),
  ];
  const map = buildCompactionDetails(entries);
  const d1 = map.get("c1")!;
  const d2 = map.get("c2")!;

  assert.deepEqual(
    d1.swallowed.map((s) => s.entryId),
    ["u1", "a1"],
    "第一次应吞 u1,a1",
  );
  // 第二次：从上次保留边界 u2 开始，到 u3 之前 → u2, a2, c1
  // ⚠ 若在实现里把起点写成「上一个 compaction 的下标+1」，
  //   u2、a2 就会漏掉（它们其实已被第二次压缩吞掉）
  const ids2 = d2.swallowed.map((s) => s.entryId);
  assert.ok(ids2.includes("u2"), `第二次应包含 u2，实际 ${ids2}`);
  assert.ok(ids2.includes("a2"), `第二次应包含 a2，实际 ${ids2}`);
  assert.ok(!ids2.includes("u1"), `第二次不该重复包含 u1，实际 ${ids2}`);
  assert.equal(d2.ordinal, 2);
});

test("retain-none：firstKeptEntryId 指向自身时不保留任何前置", () => {
  const entries: SessionEntry[] = [
    mkMsg("u1", null, "t1", "user", "需求一"),
    mkMsg("a1", "u1", "t2", "assistant", "回复一"),
    mkCompaction("c1", "a1", "t3", "摘要", "c1", 500),
  ];
  const map = buildCompactionDetails(entries);
  const d = map.get("c1")!;
  assert.equal(d.swallowedCount, 2, "retain-none 应吞掉所有前置");
});

test("真实会话：压缩详情自洽（条数/字符/摘要长度）", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const steps = a.segments
    .flatMap((s) => s.turns)
    .flatMap((t) => t.steps)
    .filter((s) => s.kind === "compaction" && s.compaction);

  assert.ok(steps.length > 0, "样本应有压缩");
  for (const st of steps) {
    const d = st.compaction!;
    assert.equal(d.swallowedCount, d.swallowed.length, "条数应与数组长度一致");
    assert.ok(d.tokensBefore > 0, "tokensBefore 应 > 0");
    assert.ok(d.summary.length > 0, "摘要不应为空");
    assert.ok(d.swallowedChars > 0, "被吞字符数应 > 0");
    // 摘要应当远小于原文（否则说明边界算错，把保留内容也算进去了）
    assert.ok(
      d.summary.length < d.swallowedChars,
      `摘要 ${d.summary.length} 应小于原文 ${d.swallowedChars}`,
    );
    // 每条被吞条目都要有 id 和非空文本
    for (const e of d.swallowed) {
      assert.ok(e.entryId.length > 0, "entryId 不能为空");
      assert.ok(e.text.length > 0, "text 不能为空");
      assert.ok(e.role.length > 0, "role 不能为空");
    }
  }
});

test("真实会话：压缩只吞对话内容，不吞 session/model_change 等元数据", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const step = a.segments
    .flatMap((s) => s.turns)
    .flatMap((t) => t.steps)
    .find((s) => s.kind === "compaction" && s.compaction);
  const roles = new Set(step!.compaction!.swallowed.map((e) => e.role));
  for (const r of roles) {
    assert.ok(
      ["user", "assistant", "toolResult", "system", "custom"].includes(r),
      `不应出现元数据类型 role=${r}`,
    );
  }
});

test("漏词检测：不把普通英文词当取值", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const step = a.segments
    .flatMap((s) => s.turns)
    .flatMap((t) => t.steps)
    .find((s) => s.kind === "compaction" && s.compaction);
  const missing = findMissingTerms(step!.compaction!);
  for (const m of missing) {
    assert.ok(
      !/^(SMF-based|mapping\.?|Feature|Session)$/i.test(m.term),
      `普通英文词不应入选: ${m.term}`,
    );
    assert.ok(!/[.,;:]$/.test(m.term), `不应带尾部标点: ${m.term}`);
  }
  // 噪音上限：一份摘要漏词超过 60 个说明正则太宽
  assert.ok(missing.length <= 60, `漏词数量 ${missing.length} 过多，疑似噪音`);
});

test("漏词检测：摘要里已有的取值不应报告为缺失", { skip: !sample }, async () => {
  const a = await analyzeSessionFile(sample!);
  const step = a.segments
    .flatMap((s) => s.turns)
    .flatMap((t) => t.steps)
    .find((s) => s.kind === "compaction" && s.compaction);
  const d = step!.compaction!;
  const missing = findMissingTerms(d);
  const summaryLower = d.summary.toLowerCase();
  for (const m of missing) {
    assert.ok(
      !summaryLower.includes(m.term.toLowerCase()),
      `${m.term} 其实在摘要里出现过，不该报缺失`,
    );
  }
});
