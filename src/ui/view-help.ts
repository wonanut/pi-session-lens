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
  quiet(
    "pi 把每条消息都写成 jsonl 的一行，但真实运行是两层嵌套的：",
  );
  blank();
  body.push(
    "  " + theme.compaction(glyph.compaction + " SessionLoop") + theme.faint("  一段用户请求的生命周期"),
  );
  body.push(theme.faint("  │"));
  body.push(
    "  " + theme.border(glyph.tee + glyph.hline + " ") + theme.accent("AgentLoop") + theme.faint("  模型 ↔ 工具的一次往复（一个 turn）"),
  );
  body.push(theme.faint("  │"));
  body.push(
    "  " + theme.border(glyph.corner + glyph.hline + " ") + theme.muted("step") + theme.faint("  思考 / 工具调用 / 工具结果 / 输出"),
  );
  blank();
  quiet(
    "SessionLoop 以「用户发一条消息」为界；compaction（上下文压缩）也是硬边界 —— " +
      "压缩后模型只看到摘要，更早的原文不再进入上下文，所以「模型忘了之前的要求」这类问题必须在这里查。",
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
    ["工具错误", "isError=true，工具真的失败了"],
    ["业务拒绝", "ok=false，工具跑通但被业务层否决（如知识库无此命令）"],
    ["渲染失败", "RENDER_FAILED，参数取值不合法"],
    ["压缩", "上下文被摘要替换，是关键断点"],
    ["截断", "stopReason=length，模型输出被上限截断"],
    ["发散", "同参数重复调用，疑似原地打转"],
    ["大返回", "单次结果体积过大，会推高上下文占用"],
  ] as [string, string][]) {
    body.push("  " + theme.warn(padEnd(label, 10)) + theme.dim(desc));
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
