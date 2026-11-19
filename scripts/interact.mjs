#!/usr/bin/env node
/**
 * 交互验收入口：用真实的 pty 驱动 TUI。
 *
 * 为什么必须用 pty：Node 的 child_process 管道里 stdin 不是 TTY，
 * 内核会按行缓冲输入（输入 `\r` 才提交），按键驱动的 TUI 根本无法
 * 收到单个字符。只有分配 pty 才能真实模拟用户敲键盘。
 *
 * 本文件只负责启动 python 侧的 pty 驱动并转发结果，
 * 屏幕还原逻辑在 scripts/pty_driver.py。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const target =
  process.argv[2] ??
  "/home/tyao/文档/code/config-generation-design-agent/var/pi_sessions";

const proc = spawn(
  "python3",
  [join(here, "pty_driver.py"), join(root, "bin/pi-lens.ts"), target],
  { cwd: root, stdio: "inherit", env: { ...process.env, FORCE_COLOR: "1" } },
);

proc.on("exit", (code) => process.exit(code ?? 0));
