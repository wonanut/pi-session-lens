/**
 * 把 pi-tui 解析到「实际可用的 ESM 入口」。
 *
 * 为什么需要这一步：pi-tui 是 pi 的运行时依赖，用户机器上不一定单独装过。
 * 但 pi 一定装过（否则不会有会话记录），所以我们按优先级找：
 *   1. 本项目 node_modules（用户显式装了）
 *   2. PI_LENS_PI_TUI 环境变量（用户指定路径）
 *   3. 全局 node_modules 里 pi-coding-agent 自带的嵌套副本
 * 找到后统一用它的 dist/index.js —— 保证和生成这些会话的 pi 是同一版本 UI 库。
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const PKG = "@earendil-works/pi-tui";

export class PiTuiNotFoundError extends Error {
  constructor(tried: string[]) {
    super(
      [
        "找不到 @earendil-works/pi-tui。",
        "已尝试以下位置：",
        ...tried.map((t) => `  - ${t}`),
        "",
        "解决办法（任选其一）：",
        "  1. 在项目里安装：npm i @earendil-works/pi-tui",
        "  2. 指定路径：export PI_LENS_PI_TUI=/path/to/pi-tui",
        "  3. 先安装 pi（本项目会复用它的副本）：npm i -g @earendil-works/pi-coding-agent",
      ].join("\n"),
    );
    this.name = "PiTuiNotFoundError";
  }
}

function candidates(): string[] {
  const out: string[] = [];

  const env = process.env.PI_LENS_PI_TUI;
  if (env) out.push(resolve(env));

  // 项目本地
  out.push(join(process.cwd(), "node_modules", ...PKG.split("/")));

  // 从自身位置向上找 node_modules
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    out.push(join(dir, "node_modules", ...PKG.split("/")));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // require.resolve（能解析到就会成功）
  try {
    out.push(dirname(require.resolve(`${PKG}/package.json`)));
  } catch {
    /* ignore */
  }

  // 全局 npm 根：pi 的嵌套副本
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (root) {
      out.push(
        join(root, "@earendil-works", "pi-coding-agent", "node_modules", ...PKG.split("/")),
      );
      out.push(join(root, ...PKG.split("/")));
    }
  } catch {
    /* npm 不可用就算了 */
  }

  return [...new Set(out)];
}

function entryOf(pkgDir: string): string | null {
  const dist = join(pkgDir, "dist", "index.js");
  if (existsSync(dist)) return dist;
  const main = join(pkgDir, "index.js");
  if (existsSync(main)) return main;
  return null;
}

let cached: { mod: Record<string, unknown>; path: string } | null = null;

export async function loadPiTui(): Promise<{ mod: Record<string, unknown>; path: string }> {
  if (cached) return cached;
  const tried = candidates();
  for (const dir of tried) {
    const entry = entryOf(dir);
    if (!entry) continue;
    const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    cached = { mod, path: entry };
    return cached;
  }
  throw new PiTuiNotFoundError(tried);
}

/** 同步版探测：用于启动时决定是否降级（不真正 import）。 */
export function findPiTuiPath(): string | null {
  for (const dir of candidates()) {
    const entry = entryOf(dir);
    if (entry) return entry;
  }
  return null;
}
