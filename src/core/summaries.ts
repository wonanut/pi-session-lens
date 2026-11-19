/**
 * 会话列表索引：带磁盘缓存。
 *
 * 列表页只需要摘要（标题、时间、轮数、工具数、错误数、token、健康分），
 * 不需要完整 analysis。但摘要本身也要解析整个 jsonl，1000 个文件约几十秒。
 * 所以：按 (mtimeMs, size) 做缓存键，文件没变直接读缓存。
 *
 * 缓存落在 XDG_CACHE_HOME/pi-session-lens/index.json，
 * 不写进任何被分析的项目目录，避免污染。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { parseSessionFile } from "./parser.ts";
import { buildTurns } from "./turns.ts";
import { extractPrompts } from "./prompts.ts";
import { buildSegmentsDetailed } from "./segments.ts";
import { computeHealth, detectIssues } from "./issues.ts";
import type { DiscoveredFile } from "./discover.ts";

export interface SessionSummary {
  path: string;
  root: string;
  sessionId: string;
  title: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  mtimeMs: number;
  size: number;
  segments: number;
  turns: number;
  toolCalls: number;
  errors: number;
  warns: number;
  compactions: number;
  askUser: number;
  totalTokens: number;
  contextPeak: number;
  health: number;
  models: string[];
  /** 缓存键，用于判断是否过期。 */
  cacheKey: string;
}

interface CacheFile {
  version: number;
  entries: Record<string, SessionSummary>;
}

const CACHE_VERSION = 3;

function cachePath(): string {
  const base =
    process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.trim()
      ? process.env.XDG_CACHE_HOME
      : join(homedir(), ".cache");
  return join(base, "pi-session-lens", "index.json");
}

function keyOf(f: DiscoveredFile): string {
  // mtime 精度到毫秒 + size，组合已足够判断「文件变了没有」
  const h = createHash("sha1").update(`${f.path}|${f.mtimeMs}|${f.size}`).digest("hex");
  return h.slice(0, 16);
}

let memCache: CacheFile | null = null;

function loadCache(): CacheFile {
  if (memCache) return memCache;
  const p = cachePath();
  if (!existsSync(p)) {
    memCache = { version: CACHE_VERSION, entries: {} };
    return memCache;
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as CacheFile;
    if (raw.version !== CACHE_VERSION || typeof raw.entries !== "object" || !raw.entries) {
      memCache = { version: CACHE_VERSION, entries: {} };
    } else {
      memCache = raw;
    }
  } catch {
    memCache = { version: CACHE_VERSION, entries: {} };
  }
  return memCache;
}

export function saveCache(): void {
  if (!memCache) return;
  const p = cachePath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(memCache), "utf8");
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

/** 从会话里取标题：优先 /name，其次第一条用户原话首行。 */
function pickTitle(name: string | undefined, prompts: { user: string }[]): string {
  if (name && name.trim()) return name.trim();
  const first = prompts[0]?.user ?? "";
  const line = first.split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > 0 ? (t.length > 80 ? t.slice(0, 80) + "…" : t) : "(无用户消息)";
}

/** 分析单个文件生成摘要（会走缓存）。 */
export async function summarize(f: DiscoveredFile): Promise<SessionSummary> {
  const cache = loadCache();
  const key = keyOf(f);
  const hit = cache.entries[f.path];
  if (hit && hit.cacheKey === key) return hit;

  const session = await parseSessionFile(f.path);
  const sessionStart = Date.parse(session.startedAt) || 0;
  const entries = session.branch.length > 0 ? session.branch : session.entries;
  const turns = buildTurns({ entries, sessionStart });
  const prompts = extractPrompts(entries);
  const { segments } = buildSegmentsDetailed(turns, prompts);
  const issues = detectIssues({ segments, session });

  const models = [
    ...new Set(turns.map((t) => t.model).filter((m): m is string => Boolean(m))),
  ];

  const summary: SessionSummary = {
    path: f.path,
    root: f.root,
    sessionId: session.sessionId,
    title: pickTitle(session.sessionName, prompts),
    cwd: session.cwd,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    mtimeMs: f.mtimeMs,
    size: f.size,
    segments: segments.length,
    turns: turns.length,
    toolCalls: turns.reduce(
      (a, t) => a + t.steps.filter((s) => s.kind === "tool_call").length,
      0,
    ),
    errors: issues.filter((i) => i.severity === "error").length,
    warns: issues.filter((i) => i.severity === "warn").length,
    compactions: session.typeCounts["compaction"] ?? 0,
    askUser: turns.reduce((a, t) => a + t.steps.filter((s) => s.kind === "ask").length, 0),
    totalTokens: session.totalUsage.totalTokens,
    contextPeak: turns.reduce((a, t) => Math.max(a, t.contextTokens ?? 0), 0),
    health: computeHealth(issues, turns, segments),
    models,
    cacheKey: key,
  };

  cache.entries[f.path] = summary;
  return summary;
}

/** 批量生成摘要，带并发上限（避免同时打开太多文件句柄）。 */
export async function summarizeAll(
  files: DiscoveredFile[],
  concurrency = 8,
  onProgress?: (done: number, total: number) => void,
): Promise<SessionSummary[]> {
  const out: SessionSummary[] = new Array(files.length);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const f = files[i];
      if (!f) return;
      try {
        out[i] = await summarize(f);
      } catch (err) {
        // 单个坏文件不能搞挂整个列表
        out[i] = brokenSummary(f, err as Error);
      }
      done++;
      onProgress?.(done, files.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  saveCache();
  return out.filter(Boolean);
}

function brokenSummary(f: DiscoveredFile, err: Error): SessionSummary {
  return {
    path: f.path,
    root: f.root,
    sessionId: f.path,
    title: `(解析失败) ${err.message.slice(0, 60)}`,
    cwd: "",
    startedAt: "",
    endedAt: "",
    mtimeMs: f.mtimeMs,
    size: f.size,
    segments: 0,
    turns: 0,
    toolCalls: 0,
    errors: 0,
    warns: 0,
    compactions: 0,
    askUser: 0,
    totalTokens: 0,
    contextPeak: 0,
    health: 0,
    models: [],
    cacheKey: keyOf(f),
  };
}
