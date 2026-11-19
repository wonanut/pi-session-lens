/**
 * 静态检查：theme 键名是否都存在。
 *
 * 为什么需要：Node 的类型擦除只擦类型、不做类型检查，
 * `theme.ask(...)` 这种拼写错误在运行时才炸，而 plain 模式
 * 可能根本走不到那个分支 —— 用户打开会话的那一刻才白屏。
 * 这个测试把「所有 theme.xxx 引用」和 theme 实际导出的键做对账。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { theme, glyph } from "../src/ui/theme.ts";

const uiDir = join(dirname(fileURLToPath(import.meta.url)), "../src/ui");

function tsFiles(): string[] {
  return readdirSync(uiDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(uiDir, f));
}

test("theme 的所有引用键都真实存在", () => {
  const keys = new Set(Object.keys(theme));
  const missing: string[] = [];
  for (const f of tsFiles()) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\btheme\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      const k = m[1]!;
      // 排除 import 语句里的模块路径（./theme.ts）
      if (k === "ts" || k === "tsx") continue;
      if (!keys.has(k)) missing.push(`${f.split("/").pop()}: theme.${k}`);
    }
  }
  assert.deepEqual(missing, [], `不存在的 theme 键:\n${missing.join("\n")}`);
});

test("glyph 的所有引用键都真实存在", () => {
  const keys = new Set(Object.keys(glyph));
  const missing: string[] = [];
  for (const f of tsFiles()) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\bglyph\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      const k = m[1]!;
      if (!keys.has(k)) missing.push(`${f.split("/").pop()}: glyph.${k}`);
    }
  }
  assert.deepEqual(missing, [], `不存在的 glyph 键:\n${missing.join("\n")}`);
});

test("所有 theme 值都是可调用函数", () => {
  for (const [k, v] of Object.entries(theme)) {
    assert.equal(typeof v, "function", `theme.${k} 必须是 (string)=>string`);
    assert.equal(typeof v("x"), "string", `theme.${k}("x") 必须返回字符串`);
  }
});

test("所有 glyph 值都是非空字符串", () => {
  for (const [k, v] of Object.entries(glyph)) {
    assert.equal(typeof v, "string", `glyph.${k} 必须是字符串`);
    assert.ok(v.length > 0, `glyph.${k} 不能为空`);
  }
});
