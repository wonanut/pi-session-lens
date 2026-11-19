#!/usr/bin/env node
/**
 * CLI 入口。
 *
 * 零依赖设计：只用 Node 内置模块 + 运行时类型擦除（Node >= 22.6 原生支持 .ts）。
 * 所以 `git clone && node bin/pi-lens.ts` 就能跑，不需要 npm install。
 *
 * --plain 模式不进入 raw mode，直接把一帧渲染结果打到 stdout，
 * 便于在无 TTY 环境（CI、管道、截图脚本）里验证。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `pi-session-lens — pi-agent 会话可视化分析（TUI）

用法
  pi-lens [选项] [会话文件或目录 ...]

不给路径时按顺序探测：
  1. 环境变量 PI_LENS_SESSION_DIR（多个用 : 分隔）
  2. ~/.pi/agent/sessions
  3. 当前目录下的 var/pi_sessions

选项
  -h, --help          显示本帮助
  -v, --version       显示版本
  --plain             输出一帧静态快照后退出（无 TTY 时自动启用）
  --list              只打印会话列表（表格，便于 grep）
  --analyze <file>    分析单个会话并输出文本报告（无交互）
  --width <n>         plain 模式下的宽度（默认 120）
  --height <n>        plain 模式下的高度（默认 40）
  --no-color          关闭颜色

示例
  pi-lens                                   # 探测默认目录，进入 TUI
  pi-lens ./var/pi_sessions                 # 指定目录
  pi-lens ./var/pi_sessions/xxx.jsonl       # 直接打开某个会话
  pi-lens --analyze ./var/pi_sessions/xxx.jsonl
`;

function readVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface Args {
  help: boolean;
  version: boolean;
  plain: boolean;
  list: boolean;
  analyze: string | null;
  width: number;
  height: number;
  noColor: boolean;
  paths: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    help: false,
    version: false,
    plain: false,
    list: false,
    analyze: null,
    width: 120,
    height: 40,
    noColor: false,
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    switch (v) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-v":
      case "--version":
        a.version = true;
        break;
      case "--plain":
        a.plain = true;
        break;
      case "--list":
        a.list = true;
        break;
      case "--analyze":
        a.analyze = argv[++i] ?? null;
        break;
      case "--width":
        a.width = Number.parseInt(argv[++i] ?? "120", 10) || 120;
        break;
      case "--height":
        a.height = Number.parseInt(argv[++i] ?? "40", 10) || 40;
        break;
      case "--no-color":
        a.noColor = true;
        break;
      default:
        if (v.startsWith("-")) {
          process.stderr.write(`未知选项: ${v}\n\n${USAGE}`);
          process.exit(2);
        }
        a.paths.push(v);
    }
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.version) {
    process.stdout.write(`pi-session-lens ${readVersion()}\n`);
    return;
  }
  if (args.noColor) process.env.NO_COLOR = "1";

  const { findPiTuiPath } = await import("../src/ui/pi-tui-loader.ts");
  const { setWidthImpl } = await import("../src/ui/text.ts");
  const { resolveTargets } = await import("../src/core/discover.ts");

  // 注入 pi-tui 的宽度实现（找不到就用内置兜底，不影响基本可用）
  const tuiPath = findPiTuiPath();
  if (tuiPath) {
    try {
      const m = (await import(tuiPath)) as {
        visibleWidth?: (s: string) => number;
        truncateToWidth?: (s: string, w: number, e?: string) => string;
        wrapTextWithAnsi?: (s: string, w: number) => string[];
      };
      setWidthImpl({
        visibleWidth: m.visibleWidth,
        truncateToWidth: m.truncateToWidth,
        wrapTextWithAnsi: m.wrapTextWithAnsi,
      });
    } catch {
      /* 注入失败就退回内置实现 */
    }
  }

  // --analyze：单会话文本报告
  if (args.analyze) {
    const p = resolve(args.analyze);
    if (!existsSync(p)) {
      process.stderr.write(`文件不存在: ${p}\n`);
      process.exit(2);
    }
    const { buildTextReport } = await import("../src/core/report.ts");
    process.stdout.write(await buildTextReport(p, args.width));
    return;
  }

  const files = resolveTargets(args.paths);
  if (files.length === 0) {
    process.stderr.write(
      "没有找到任何 pi 会话文件。\n" +
        "请指定目录，或设置 PI_LENS_SESSION_DIR：\n" +
        "  pi-lens /path/to/pi_sessions\n",
    );
    process.exit(1);
  }

  // --list：纯文本列表
  if (args.list) {
    const { summarizeAll } = await import("../src/core/summaries.ts");
    const { formatTable } = await import("../src/core/report.ts");
    const list = await summarizeAll(files, 8);
    process.stdout.write(formatTable(list, args.width));
    return;
  }

  // 单文件时直接打开该会话
  const initialPath = files.length === 1 ? files[0]?.path : undefined;

  const { App } = await import("../src/ui/app.ts");
  const plain = args.plain || !process.stdout.isTTY;
  // roots 保留用户原始输入，刷新时用它重新扫描（拿得到启动后新建的会话）
  const app = new App({ files, roots: args.paths, initialPath, plain });

  // plain 模式下设置固定尺寸
  if (plain) {
    Object.defineProperty(process.stdout, "columns", { value: args.width, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: args.height, configurable: true });
  }

  process.on("uncaughtException", (err) => {
    app["state"]?.width; // 确保实例可访问
    process.stderr.write(`\n运行出错: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });

  await app.run();
}

main().catch((err) => {
  process.stderr.write(`启动失败: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
