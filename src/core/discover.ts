/**
 * 会话发现：找出所有可分析的 pi 会话文件。
 *
 * 支持三种来源，按顺序探测：
 *   1. CLI 显式给的文件路径 / 目录
 *   2. 环境变量 PI_LENS_SESSION_DIR（可多个，冒号分隔）
 *   3. pi 的默认位置 ~/.pi/agent/sessions/**\/*.jsonl
 *   4. 当前项目下的 var/pi_sessions（本项目这类「自带会话目录」的工程）
 *
 * 为什么需要索引缓存：真实工程里有 1000+ 会话文件，逐个全量解析要几十秒。
 * 列表页只需要「标题/时间/轮数/token/健康度」，所以按 mtime+size 做缓存，
 * 文件没变就复用上次结果。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface DiscoveredFile {
  path: string;
  mtimeMs: number;
  size: number;
  /** 所属「来源根」，用于列表分组显示。 */
  root: string;
}

/** 默认探测的会话目录（存在才算）。 */
export function defaultSessionDirs(cwd = process.cwd()): string[] {
  const out: string[] = [];
  const env = process.env.PI_LENS_SESSION_DIR;
  if (env) for (const p of env.split(":")) if (p.trim()) out.push(resolve(p.trim()));

  const piHome = join(homedir(), ".pi", "agent", "sessions");
  if (existsSync(piHome)) out.push(piHome);

  // 本工程约定：<project>/var/pi_sessions
  const local = join(cwd, "var", "pi_sessions");
  if (existsSync(local)) out.push(local);

  return [...new Set(out)];
}

/** 递归收集 .jsonl 文件。 */
export function collectJsonl(root: string, maxDepth = 4): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  if (!existsSync(root)) return out;

  const st0 = statSync(root);
  if (st0.isFile()) {
    if (root.endsWith(".jsonl")) {
      out.push({ path: root, mtimeMs: st0.mtimeMs, size: st0.size, root: resolve(root) });
    }
    return out;
  }

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (n.endsWith(".jsonl")) {
        out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size, root });
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * 解析命令行给的路径：可以是文件，也可以是目录。
 * 相对路径按 cwd 解析。
 */
export function resolveTargets(args: string[], cwd = process.cwd()): DiscoveredFile[] {
  const targets = args.length > 0 ? args : defaultSessionDirs(cwd);
  const seen = new Set<string>();
  const out: DiscoveredFile[] = [];
  for (const t of targets) {
    const abs = isAbsolute(t) ? t : resolve(cwd, t);
    for (const f of collectJsonl(abs)) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push(f);
    }
  }
  // 按修改时间倒序：最近的在最上面
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 给文件起一个便于辨认的短名（用父目录 + 文件名）。 */
export function shortLabel(f: DiscoveredFile): string {
  const parent = basename(resolve(f.path, ".."));
  return parent && parent !== "." ? `${parent}/${basename(f.path)}` : basename(f.path);
}
