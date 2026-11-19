#!/usr/bin/env bash
# 按需验证：默认跑快速检查，--full 才跑交互验收（较慢）。
#
# 为什么分档：单元测试 + 布局测试约 1 秒，交互验收要起 7 个 pty
# 会话约 40 秒。改一行样式不该等 40 秒。
#
# 用法：
#   ./scripts/verify.sh          单元 + 布局 + 主题 + CLI 冒烟
#   ./scripts/verify.sh --full   额外跑 pty 交互验收
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
FAILED_NAMES=()

step() {
  local name="$1"
  shift
  printf '▶ %s ... ' "$name"
  if "$@" >/tmp/pi-lens-verify.log 2>&1; then
    echo "OK"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$name")
    tail -25 /tmp/pi-lens-verify.log | sed 's/^/    /'
  fi
}

echo "== 单元 / 布局 / 主题 =="
step "core 解析与两层建模" node --test tests/core.test.ts
step "布局宽度（多尺寸）" node --test tests/layout.test.ts
step "theme / glyph 键名" node --test tests/theme.test.ts
step "流程图与联动高亮" node --test tests/flow.test.ts
step "压缩还原与漏词检测" node --test tests/compaction.test.ts

echo
echo "== CLI 冒烟 =="
step "--version" node bin/pi-lens.ts --version
step "--help" node bin/pi-lens.ts --help
step "--list 输出会话表格" bash -c 'node bin/pi-lens.ts --list "${PI_LENS_SAMPLE_DIR:-/home/tyao/文档/code/config-generation-design-agent/var/pi_sessions}" | head -3 | grep -q "健康"'

SAMPLE=$(ls "${PI_LENS_SAMPLE_DIR:-/home/tyao/文档/code/config-generation-design-agent/var/pi_sessions}"/*.jsonl 2>/dev/null | head -1)
if [ -n "${SAMPLE:-}" ]; then
  step "--analyze 单会话报告" bash -c "node bin/pi-lens.ts --analyze '$SAMPLE' | grep -q '两层循环大纲'"
  step "--plain 快照渲染" bash -c "node bin/pi-lens.ts --plain --width 110 --height 20 '$SAMPLE' | grep -q 'SessionLoop'"
fi

if [ "${1:-}" = "--full" ]; then
  echo
  echo "== 交互验收（pty）=="
  step "7 个交互场景" node scripts/interact.mjs
fi

echo
echo "结果：通过 $PASS，失败 $FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '失败项：%s\n' "${FAILED_NAMES[*]}"
  exit 1
fi
