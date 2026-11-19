/**
 * 帮助页：解释「两层循环」这个概念本身。
 *
 * 单独一屏而不是塞进底栏，因为用户第一次打开时会看不懂
 * 「SessionLoop / AgentLoop」意味着什么；把概念讲清楚，
 * 后面所有视图才有共同语言。
 */
import type { AppState } from "./state.ts";
import { drawPanel, divider } from "./render.ts";
import { padEnd, truncate, visibleWidth, wrap } from "./text.ts";
import { glyph, theme } from "./theme.ts";
import { KEY_HELP } from "./keys.ts";

export function renderHelp(state: AppState): string[] {
  const { width, height } = state;
  const bodyH = Math.max(3, height - 1);
  const innerW = width - 2;
  const body: string[] = [];

  const h = (t: string): void => {
    body.push(theme.accentStrong(theme.bold(t)));
  };
  const p = (t: string): void => {
    for (const l of wrap(t, innerW)) body.push(theme.bright(l));
  };
  const quiet = (t: string): void => {
    for (const l of wrap(t, innerW)) body.push(theme.muted(l));
  };
  const blank = (): void => {
    body.push("");
  };

  h("这是什么");
  p(
    "pi-session-lens 把 pi-agent 的 jsonl 会话记录还原成可浏览的两层循环，" +
      "让你不必读原始 JSON 就能定位「哪一步出了问题」。",
  );
  blank();

  h("两层循环");
  quiet("pi 把每条消息都写成 jsonl 的一行，但真实运行是嵌套的：");
  blank();
  body.push(
    "  " + theme.compaction(glyph.dot + " SessionLoop") + theme.faint("  一次用户请求"),
  );
  body.push(theme.faint("  └─ ") + theme.accent("AgentLoop") + theme.faint("  一个循环体：思考↔工具反复迭代"));
  body.push(theme.faint("     ├─ ") + theme.muted("迭代 1") + theme.faint("  ①构建请求 ②思考 ③调工具 ④执行 ⑤判定「继续」"));
  body.push(theme.faint("     ├─ ") + theme.muted("迭代 2") + theme.faint("  …同上，回到 ① 是因为工具结果要再交给模型"));
  body.push(theme.faint("     └─ ") + theme.muted("迭代 N") + theme.faint("  ⑤判定「收敛」→ 循环结束"));
  blank();
  p(
    "⚠ 迭代不是独立循环。一次用户请求里模型会绕很多圈（实测 27 次往返），" +
      "这些属于同一个 AgentLoop。把每圈当成并列循环，流程图上就每个都从" +
      "「构建请求」重开，看着像跳过了构建请求。",
  );
  blank();
  quiet(
    "compaction（上下文压缩）是硬边界：压缩后模型只看到摘要，更早的原文" +
      "不再进入上下文。所以「模型忘了之前的要求」必须在 SessionLoop 层查。",
  );
  blank();

  h("四种视图");
  body.push(
    "  " + theme.accent("会话列表") +
      theme.faint("   按健康分排序，一眼看出哪个会话最该看"),
  );
  body.push(
    "  " + theme.accent("时间轴") +
      theme.faint("     缩进即层级：段 → 轮 → 步；右侧联动显示该步详情"),
  );
  body.push(
    "  " + theme.accent("问题面板") +
      theme.faint("   自动检出错误/压缩/发散/截断，回车跳到现场"),
  );
  body.push(
    "  " + theme.compaction("压缩对比") +
      theme.faint("   摘要 ⟷ 被压缩原文 ⟷ 漏词核对（按 c 进入）"),
  );
  blank();

  h("问题信号怎么判定");
  for (const [label, desc] of [
    ["查无结果", "知识库中确实没有该命令/特性 —— 有效结论，不是故障（info）"],
    ["步骤核对", "有步骤未覆盖 —— 核对结论，不是执行错误（info）"],
    ["执行失败", "网络/超时/未执行/崩溃 —— 工具真的挂了（error）"],
    ["缺必填参数", "missing_required 非空，需补齐（warn）"],
    ["参数非法", "RENDER_FAILED / 枚举位域格式错（warn）"],
    ["压缩", "上下文被摘要替换，是关键断点（warn）"],
    ["截断", "stopReason=length，模型输出被上限截断（warn）"],
    ["发散", "同参数重复调用，疑似原地打转（info）"],
    ["大返回", "单次结果体积过大，会推高上下文占用（info）"],
  ] as [string, string][]) {
    body.push("  " + theme.warn(padEnd(label, 12)) + theme.dim(desc));
  }
  blank();

  h("键盘");
  const colW = Math.floor(innerW / 2);
  for (const [k, d] of KEY_HELP) {
    body.push("  " + theme.accent(padEnd(k, 10)) + theme.bright(truncate(d, innerW - 14)));
  }
  blank();

  h("复用解析能力");
  quiet(
    "解析层（src/core）与 UI 完全独立：parseSessionFile 返回结构化 entry 与分支，" +
      "analyzeSessionFile 返回两层模型 + 问题列表。可以在自己的脚本里直接 import，不外挂 TUI。",
  );
  blank();
  body.push(theme.faint("  Esc / q 返回"));

  const lines = drawPanel({ x: 0, y: 0, width, height: bodyH }, "帮助", "? 关闭", body, false);
  const footer = theme.accent("提示") + theme.faint("  按 ? 或 Esc 返回");
  const footerW = visibleWidth(footer);
  lines.push(footer + (footerW < width ? " ".repeat(width - footerW) : ""));
  return lines.slice(0, height);
}
