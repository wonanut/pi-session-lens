# pi-session-lens

pi-agent 会话可视化分析 —— **两层循环**终端界面，用来快速定位 agent 跑偏的原因。

读的是 pi 自己写的 jsonl 会话记录（`~/.pi/agent/sessions/**` 或工程内的
`var/pi_sessions`），不改动原始文件，纯只读分析。

```
╭ SessionLoop ▸ AgentLoop ───────────────── 4/38 · 1 段 ╮ ╭ 工具 · mml_knowledge_search ──╮
│   SEG 1  23:09:55  对网元 `H…  9轮 · 14工具  1问      │ │工具调用 mml_knowledge_search  │
│  ├  T1  · ds-flash · 10.5k ctx · 12ms · 3步           │ │23:09:55  ·  entry cc1cb6c7    │
│  ├ ▸ mml_require_check  ok                         3ms│ │───────────────────────────────│
│❯ ├ ▸ mml_knowledge_search  query=高铁扩…           8ms│ │参数                           │
│  └ ▪ 输出 I'll start by checki…                 29tok│ │  { "query": "高铁扩展…" }     │
╰───────────────────────────────────────────────────────╯ ╰───────────────────────────────╯
```

## 为什么是「两层」

pi 的会话文件是一行一条记录的平铺 JSONL，但真实运行是嵌套的：

| 层 | 含义 | 定位问题时看什么 |
|---|---|---|
| **SessionLoop** | 一段用户请求的生命周期 | 用户到底要什么；压缩前后是否丢了约束 |
| **AgentLoop** | 模型 ↔ 工具的一次往复（一个 turn） | 这一轮模型想干什么、调了什么、拿到什么 |
| **step** | 思考 / 工具调用 / 工具结果 / 输出 | 具体哪一步出错，参数错在哪 |

`compaction`（上下文压缩）是硬边界：压缩后模型只看到摘要，更早的原文
不再进入上下文。所以「模型忘了之前的要求」这类问题必须在 SessionLoop
层查，而不是在具体某一步里找。

## AgentLoop 流程图（与时间轴联动）

时间轴右上方固定显示**当前选中轮的循环结构**，并在时间轴上移动光标时
实时高亮对应节点（`◀ 当前`）：

```
T1 deepseek-flash · 9.3k ctx · 45ms

① 构建请求  system + 分支 3 步 + 工具
  │
② 思考  1 段 · 168tok            ◀ 当前     ← 选中 thinking 时亮这里
  │
  ├─ ③ 决定调用工具
      ├ mml_knowledge_search  query=创建L3VPN实例 ipv4u…  ◀ 当前
      └ mml_knowledge_search  query=GRE隧道 创建  hits:10
  │
④ 执行工具  2 个  ✓
  │
⑤ 出口判定  → 有工具结果 → 再来一轮

  ↑ 回流  工具结果进入上下文 → 回到 ② 思考（下一轮）  → T2
```

**联动规则**（选中什么，就亮什么）：

| 时间轴选中 | 图上高亮 |
|---|---|
| 段（SEG） | 该段第一轮，整体 |
| 轮（T1） | 头部 `T1 … ◀ 当前轮` |
| 思考 | `② 思考` |
| 某次工具调用 | 该次调用那一行（同轮多次调用也能精确区分） |
| 工具结果 | `④ 执行工具` 及对应结果行（错误标红） |
| 输出文本 | `⑤ 出口判定` / 输出行 |
| 压缩 | `▣ 上下文压缩` 节点 |

出口判定会区分四种结局：有工具结果 → **回流**再来一轮；给出文本 →
**收敛**结束；`stopReason=length` → 输出被截断；`aborted` → 用户中断。

## 快速开始

零依赖，不需要 `npm install`（要求 Node >= 22.6，用原生类型擦除跑 `.ts`）：

```bash
node bin/pi-lens.ts                                  # 自动探测会话目录
node bin/pi-lens.ts ./var/pi_sessions                # 指定目录
node bin/pi-lens.ts ./var/pi_sessions/xxx.jsonl      # 直接打开某个会话
```

放到 PATH 里当命令用：

```bash
npm link              # 之后可用 `pi-lens`
# 或
alias pi-lens="node $PWD/bin/pi-lens.ts"
```

### 会话目录探测顺序

1. `PI_LENS_SESSION_DIR`（多个用 `:` 分隔）
2. `~/.pi/agent/sessions`（pi 默认位置）
3. `./var/pi_sessions`（工程内自带会话目录的约定）

## 键盘

| 键 | 作用 |
|---|---|
| `↑` `↓` | 移动（列表 / 时间轴 / 问题） |
| `→` `←` | 时间轴：进入更细层级 / 回到上一层 |
| `Enter` | 打开会话 / 从问题跳到现场 |
| `Tab` | 时间轴 ⇄ 问题面板 |
| `/` | 搜索会话（`Esc` 取消） |
| `空格` | 列表页：只看有问题的会话 |
| `j` `k` | 滚动右侧详情 |
| `g` `G` | 跳到首 / 尾 |
| `n` `N` | 跳到下一个 / 上一个问题 |
| `r` | 重新加载当前会话 |
| `?` | 帮助（含两层循环的解释） |
| `q` `Esc` | 退出 / 返回上一层 |

## 问题信号

问题面板会自动检出这些信号，每条都能回车跳到现场：

| 信号 | 判定 | 为什么重要 |
|---|---|---|
| 工具错误 | `isError=true` | 工具真的失败了 |
| 业务拒绝 | `ok=false` | 工具跑通但被业务层否决（如知识库无此命令）——最容易被忽略的「假成功」 |
| 渲染失败 | `RENDER_FAILED` | 参数取值不合法 |
| 压缩 | `compaction` entry | 上下文断点，排查「忘记之前要求」的必经之处 |
| 截断 | `stopReason=length` | 输出被上限截断，结果可能不完整 |
| 发散 | 同参数重复调用 | 模型在原地打转 |
| 大返回 | 单次结果 > 20k 字符 | 推高上下文占用，是促成压缩的诱因 |

健康分 0-100：从 100 起按错误数、警告数、压缩次数扣分，并惩罚
「turn 很多但几乎没有文本输出」（说明一直在打转没收敛）。

## 非交互用法

```bash
node bin/pi-lens.ts --list ./var/pi_sessions        # 会话表格（适合 grep）
node bin/pi-lens.ts --analyze xxx.jsonl             # 单会话完整文本报告
node bin/pi-lens.ts --plain --width 120 xxx.jsonl   # 渲染一帧快照（CI 用）
```

`--analyze` 的输出包含：会话概览、工具使用分布、问题清单（带参数原文）、
两层循环大纲。

## 把解析能力当库用

`src/core` 与 UI 完全独立，可以在自己的脚本里直接 import：

```ts
import { parseSessionFile } from "./src/core/parser.ts";
import { analyzeSessionFile } from "./src/core/analyze.ts";

// 原始层：entries / 当前分支 / 累计 usage / 坏行数
const s = await parseSessionFile("/path/to/session.jsonl");
console.log(s.branch.length, s.typeCounts, s.totalUsage);

// 分析层：两层模型 + 问题列表 + 健康分
const a = await analyzeSessionFile("/path/to/session.jsonl");
for (const seg of a.segments) {
  console.log(`段 ${seg.index}: ${seg.prompt.slice(0, 40)}`);
  for (const turn of seg.turns) {
    console.log(`  T${turn.index} ${turn.steps.length} 步, ctx=${turn.contextTokens}`);
  }
}
for (const iss of a.issues) {
  console.log(`[${iss.severity}] ${iss.title} @ ${iss.stepKey}`);
}
```

## 设计要点

**容错优先**。pi 会持续演进 entry 类型；解析器遇到未知类型只计数、不抛错，
并在 UI 里提示（而不是白屏）。坏行、扩展 role、残缺 JSON 同样跳过。

**中文宽度**。会话以中文为主，全角字符占 2 列。所有布局都走
`visibleWidth` / `truncateToWidth`（优先复用 pi 自带的 pi-tui 实现，
找不到时用内置兜底），并有 5 种终端尺寸 × 每行宽度的自动化断言 ——
宽度错一列就会让整个 TUI 逐行错位，这是最难靠肉眼发现的一类 bug。

**差分渲染**。只重绘变化的行，SSH 下不拖影。终端不支持颜色时
（`NO_COLOR` / 管道）自动降级为纯文本。

**归并而非平铺**。一次 assistant 响应可能带多个 toolCall，
按 turn 归并才能看出「模型一次决策了几个动作」；toolResult 会回填到
对应的 tool_call 上，而不是拆成两条互不相干的消息。

## 验证

```bash
bash scripts/verify.sh          # 单元 + 布局 + 主题 + CLI 冒烟（约 3 秒）
bash scripts/verify.sh --full   # 额外跑 7 个 pty 交互场景（约 40 秒）
```

交互验收用真实 pty 驱动：Node 的管道 stdin 会被内核行缓冲，
按键驱动的 TUI 在管道里根本收不到单字符 —— 必须分配 pty 才能真实验证。

## 目录

```
bin/pi-lens.ts              CLI 入口（参数解析、模式选择）
src/core/                   与 UI 无关的分析能力
  types.ts                  pi session 格式的类型定义（对应官方 doc）
  parser.ts                 jsonl 解析、建树、内容提取、token 估算
  model.ts                  两层循环的数据模型（Segment/Turn/Step/Issue）
  turns.ts                  entry → AgentLoop turn 归并
  segments.ts               turn → SessionLoop 分段（含压缩边界）
  prompts.ts                用户提问提取（剥离系统说明）
  issues.ts                 问题信号检测 + 健康分
  analyze.ts                分析入口（组合以上各层）
  discover.ts               会话文件发现
  summaries.ts              会话摘要 + 磁盘索引缓存
  report.ts                 文本报告 / 表格输出
src/ui/
  app.ts                    输入循环、状态流转、视图调度
  state.ts                  运行时状态与时间轴行展开
  view-list.ts              会话列表
  view-timeline.ts          两层循环时间轴 + 流程图 + 详情
  flow-diagram.ts           AgentLoop 循环流程图（含节点高亮映射）
  view-issues.ts            问题面板
  view-help.ts              帮助（解释两层循环概念）
  render.ts                 面板边框、滚动视口
  text.ts                   宽度 / 截断 / 换行 / 格式化
  theme.ts                  语义色与图标（单一来源）
  ansi.ts                   ANSI 着色（零依赖）
  keys.ts                   原始键盘解析
  screen.ts                 备用屏幕 + 差分渲染
  pi-tui-loader.ts          复用 pi 自带 pi-tui 的定位逻辑
tests/                      单元 / 布局 / 主题 / 流程图联动测试
scripts/                    verify.sh（按需验证）、interact.mjs+pty_driver.py（交互验收）
```

## 与 config-generation-design-agent 的关系

本项目是配套的可视化分析工具：它读那边的 `var/pi_sessions/*.jsonl`，
但不 import 那边的任何代码，也不回写任何文件。解析逻辑完全按
pi 官方的 session 格式规范实现，因此也能看任意 pi 项目的会话。
