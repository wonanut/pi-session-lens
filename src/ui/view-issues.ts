/**
 * 视图三：问题面板。
 *
 * 这一屏直接回答「这个会话到底哪里有问题」。按严重度分组，
 * 每条都能一键跳到时间轴上对应的位置 —— 这是「高效定位」的最后一步：
 * 看到问题 → 直接落在现场。
 *
 * 排序原则：error 在前、warn 次之、info 最后；同组内按时间顺序
 * （定位问题时「先出的问题」往往才是根因）。
 */
import type { AppState } from "./state.ts";
import type { Issue, IssueSeverity } from "../core/model.ts";
import { drawPanel, Viewport } from "./render.ts";
import { fmtTimeSec, padEnd, truncate, visibleWidth, wrap } from "./text.ts";
import { glyph, severityColor, theme } from "./theme.ts";

const SEV_ORDER: Record<IssueSeverity, number> = { error: 0, warn: 1, info: 2 };

export function sortedIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const s = SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    if (s !== 0) return s;
    const ta = Date.parse(a.at) || 0;
    const tb = Date.parse(b.at) || 0;
    return ta - tb;
  });
}

export function renderIssues(state: AppState): string[] {
  const a = state.analysis;
  const { width, height } = state;
  const bodyH = Math.max(3, height - 1);

  if (!a) {
    const blank: string[] = [];
    while (blank.length < height - 1) blank.push("");
    blank.push(footer(state));
    return blank;
  }

  const issues = sortedIssues(a.issues);
  const counts = {
    error: issues.filter((i) => i.severity === "error").length,
    warn: issues.filter((i) => i.severity === "warn").length,
    info: issues.filter((i) => i.severity === "info").length,
  };

  // 左侧列表 58%，右侧详情
  const leftW = Math.max(46, Math.floor(width * 0.5));
  const rightW = width - leftW - 1;

  const listBody = renderIssueList(state, issues, leftW - 2, bodyH - 2);
  const listHint = issues.length ? `${state.issueCursor + 1}/${issues.length}` : "0";
  const left = drawPanel(
    { x: 0, y: 0, width: leftW, height: bodyH },
    `问题 ${counts.error}错 ${counts.warn}警 ${counts.info}提示`,
    listHint,
    listBody,
    true,
  );

  const detailBody = renderIssueDetail(state, issues[rightW >= 0 ? state.issueCursor : 0], rightW - 2);
  const right = drawPanel(
    { x: 0, y: 0, width: rightW, height: bodyH },
    "问题详情",
    "",
    detailBody.slice(0, bodyH - 2),
    false,
  );

  const out: string[] = [];
  for (let i = 0; i < bodyH; i++) {
    out.push(padEnd(left[i] ?? "", leftW) + " " + (right[i] ?? ""));
  }
  out.push(footer(state));
  return out;
}

function renderIssueList(
  state: AppState,
  issues: Issue[],
  width: number,
  height: number,
): string[] {
  if (issues.length === 0) {
    const out = [""];
    out.push(theme.ok("  ✔ 没有检测到问题信号"));
    out.push("");
    out.push(theme.faint("  说明这个会话在执行层面是干净的。"));
    out.push(theme.faint("  如果结果仍不符合预期，问题可能在指令措辞或"));
    out.push(theme.faint("  知识库内容，而不是运行过程。"));
    return out;
  }

  const vp = new Viewport();
  vp.cursor = state.issueCursor;
  vp.offset = state.issueOffset;
  vp.sync(issues.length, height);
  state.issueCursor = vp.cursor;
  state.issueOffset = vp.offset;

  const [from, to] = vp.window(issues.length, height);
  const out: string[] = [];
  let lastSev: IssueSeverity | null = null;

  for (let i = from; i < to; i++) {
    const iss = issues[i];
    if (!iss) continue;
    if (iss.severity !== lastSev) {
      if (i > from) out.push("");
      const label =
        iss.severity === "error" ? "错误" : iss.severity === "warn" ? "警告" : "提示";
      const n = issues.filter((x) => x.severity === iss.severity).length;
      out.push(severityColor(iss.severity)(`${label} (${n})`));
      lastSev = iss.severity;
    }

    const c = severityColor(iss.severity);
    const icon = iss.severity === "error" ? glyph.error : iss.severity === "warn" ? glyph.warn : glyph.info;
    const selected = i === vp.cursor;
    const marker = selected ? theme.accentStrong(glyph.cursor) : " ";
    const seg = `S${iss.segmentIndex + 1}`;
    const time = fmtTimeSec(iss.at).slice(6, 14);
    const loc = theme.faint(`${padEnd(seg, 4)}${time}`);

    const titleW = Math.max(8, width - 4 - 4 - 9 - 3);
    const title = truncate(iss.title, titleW);
    // 图标与标题之间留空格，避免 ❯✖ 粘连
    const body = marker + " " + c(icon) + " " + loc + " " + (selected ? theme.white(theme.bold(title)) : theme.bright(title));
    out.push(selected ? theme.selBg(padEnd(truncate(body, width, ""), width)) : padEnd(truncate(body, width, ""), width));
  }
  return out;
}

function renderIssueDetail(state: AppState, iss: Issue | undefined, width: number): string[] {
  if (!iss) {
    return [theme.faint("  ↑↓ 选择左侧问题，回车跳到时间轴对应位置")];
  }
  const out: string[] = [];
  const c = severityColor(iss.severity);

  out.push(c(theme.bold(iss.title)));
  out.push(theme.faint("─".repeat(Math.max(0, width))));
  out.push("");

  const kv = (k: string, v: string): void => {
    out.push(theme.faint(padEnd("  " + k, 12)) + v);
  };
  kv("类别", theme.bright(iss.category));
  kv("严重度", c(iss.severity));
  kv("位置", theme.bright(`段落 S${iss.segmentIndex + 1} · Turn T${iss.turnIndex + 1}`));
  kv("时间", theme.bright(fmtTimeSec(iss.at)));
  if (iss.tool) kv("工具", theme.accent(iss.tool));
  if (iss.entryId) kv("entry", theme.faint(iss.entryId));
  out.push("");

  out.push(theme.muted("详情"));
  for (const l of wrap(iss.detail, width - 2)) out.push(theme.bright("  " + l));
  out.push("");

  // 上下文提示：帮用户判断「这是不是根因」
  out.push(theme.muted("怎么用这条线索"));
  const advice = adviceFor(iss);
  for (const l of wrap(advice, width - 2)) out.push(theme.dim("  " + l));

  return out;
}

function adviceFor(iss: Issue): string {
  switch (iss.category) {
    case "not_found":
      return "模型查了知识库，确认没有这条命令/特性。这是有效的检索结论，" +
        "说明它没有凭记忆编命令（这一步是对的）。" +
        "只有当你确信「知识库本该收录却漏了」时才需要处理。";
    case "step_gap":
      return "这是特性步骤的覆盖核对：模型自己把所有步骤和已生成命令对过一遍，" +
        "发现还有步骤没配。属于核对结论，需要补步骤而不是改代码。";
    case "tool_error":
      return "工具真的执行失败了（网络、超时、未执行、崩溃）。" +
        "跳到该步看错误原文和参数；同一工具连续失败通常不是偶发。";
    case "missing_params":
      return "必填参数没给全，工具拒绝渲染。看 missing_required 里缺哪些，" +
        "这类问题通常说明模型对命令的必填项理解不完整。";
    case "invalid_params":
      return "参数名对、取值不合法（枚举写错、位域缺 -0/-1 后缀、格式错）。" +
        "跳到该步看 param_errors 逐条改正。";
    case "render_failed":
      return "渲染失败通常是参数取值不在允许范围。重点核对枚举值、" +
        "位域后缀（-0/-1）、必填项是否齐全。";
    case "compaction":
      return "压缩把之前的原文换成了摘要。如果用户抱怨「模型忘了之前的要求」，" +
        "按 c 进入压缩对比视图，看摘要是否保留了关键约束（对象名、取值、禁止项）。";
    case "truncation":
      return "模型输出被长度上限截断。如果这一轮本该输出完整命令清单，" +
        "用户看到的就是残缺结果 —— 需要让任务拆分或提高输出上限。";
    case "retry_loop":
      return "同一参数反复调用说明模型在原地打转。看前后几步的思考，" +
        "通常是它没意识到检索已经失败，或误以为换个写法能命中。";
    case "big_result":
      return "单次返回体积过大。它本身不是错误，但会推高上下文占用，" +
        "间接导致后续压缩 —— 如果这个会话压缩频繁，这里是诱因。";
    case "aborted":
      return "用户主动中断。检查中断后模型是否在「不完整的历史」上继续推理，"
        + "这容易产生看起来正确但前提错误的结果。";
    case "empty_output":
      return "模型返回空。可能是上游报错或被安全策略拦截，联系 stopReason 和 provider 看。";
    case "unknown_entry":
      return "出现本工具不认识的 entry 类型。如果是新版本 pi 引入的，" +
        "需要在 parser 里补充——否则这类数据会被静默忽略。";
    default:
      return "回车跳到时间轴对应位置，结合前后几步判断。";
  }
}

function footer(state: AppState): string {
  const tail = state.flash ? theme.warn("  " + state.flash) : "";
  const keys: [string, string][] = [
    ["↑↓", "选择"],
    ["↵", "跳转"],
    ["esc", "返回时间轴"],
    ["q", "退出"],
  ];
  const hint = keys.map(([k, d]) => theme.accent(k) + theme.faint(" " + d)).join(theme.faint(" · "));
  // 与时间轴底栏一致：flash 优先，提示让位
  const tailW = tail ? visibleWidth(tail) : 0;
  const room = Math.max(0, state.width - tailW);
  const hintClipped = visibleWidth(hint) > room ? truncate(hint, room, "…") : hint;
  const line = hintClipped + tail;
  return padEnd(truncate(line, state.width, ""), state.width);
}
