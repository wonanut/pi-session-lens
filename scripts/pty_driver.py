#!/usr/bin/env python3
"""在真实 pty 里驱动 pi-session-lens，逐屏核对交互。

为什么绕道 python：Node 的 child_process 无法分配 pty，管道 stdin 会被
内核行缓冲，TUI 收不到单字符按键。python 的 pty 模块能给出真正的
终端，TUI 才会进入 raw mode、接管按键。

同时内置一个极简终端模拟器（重放 CSI 光标定位 / 清屏 / 清行），
以便还原「差分渲染」之后的真实屏幕 —— 直接 grep 原始输出会混入
历史帧，导致误判。
"""
import os
import pty
import select
import signal
import subprocess
import sys
import time
import unittest

COLS = 140
ROWS = 34


class Term:
    """极简终端网格：足够还原 TUI 的输出。"""

    def __init__(self, cols, rows):
        self.cols = cols
        self.rows = rows
        self.clear()
        self.r = 0
        self.c = 0

    def clear(self):
        self.grid = [[" "] * self.cols for _ in range(self.rows)]
        self.r = 0
        self.c = 0

    @staticmethod
    def _width(ch):
        cp = ord(ch)
        if cp == 0:
            return 0
        if (
            0x1100 <= cp <= 0x115F
            or 0x2E80 <= cp <= 0x303E
            or 0x3041 <= cp <= 0x33FF
            or 0x3400 <= cp <= 0x4DBF
            or 0x4E00 <= cp <= 0x9FFF
            or 0xAC00 <= cp <= 0xD7A3
            or 0xF900 <= cp <= 0xFAFF
            or 0xFE30 <= cp <= 0xFE6F
            or 0xFF00 <= cp <= 0xFF60
            or 0xFFE0 <= cp <= 0xFFE6
            or 0x1F300 <= cp <= 0x1F64F
        ):
            return 2
        return 1

    def feed(self, data):
        i = 0
        n = len(data)
        while i < n:
            ch = data[i]
            if ch == "\x1b":
                if i + 1 < n and data[i + 1] == "[":
                    # CSI: ESC [ params cmd
                    j = i + 2
                    params = ""
                    while j < n and (data[j].isdigit() or data[j] in ";?"):
                        params += data[j]
                        j += 1
                    if j < n:
                        cmd = data[j]
                        # 默认参数：ESC[K == ESC[0K，ESC[J == ESC[0J
                        pnum = params.split(";")[0] if params else "0"
                        if cmd in ("H", "f"):
                            parts = params.split(";")
                            try:
                                rr = int(parts[0]) if parts[0] else 1
                                cc = int(parts[1]) if len(parts) > 1 and parts[1] else 1
                            except ValueError:
                                rr, cc = 1, 1
                            self.r = max(0, min(self.rows - 1, rr - 1))
                            self.c = max(0, min(self.cols - 1, cc - 1))
                        elif cmd == "J":
                            if pnum in ("2", "3"):
                                self.clear()
                            elif pnum == "0":
                                for x in range(self.c, self.cols):
                                    self.grid[self.r][x] = " "
                                for y in range(self.r + 1, self.rows):
                                    for x in range(self.cols):
                                        self.grid[y][x] = " "
                        elif cmd == "K":
                            if pnum == "0":
                                for x in range(self.c, self.cols):
                                    self.grid[self.r][x] = " "
                            elif pnum == "2":
                                for x in range(self.cols):
                                    self.grid[self.r][x] = " "
                        i = j + 1
                        continue
                elif i + 1 < n and data[i + 1] == "]":
                    # OSC ... BEL 或 ST
                    j = i + 2
                    while j < n and data[j] not in ("\x07",):
                        if data[j] == "\x1b" and j + 1 < n and data[j + 1] == "\\":
                            j += 1
                            break
                        j += 1
                    i = j + 1
                    continue
                i += 1
                continue
            if ch == "\n":
                self.r = min(self.rows - 1, self.r + 1)
                self.c = 0
                i += 1
                continue
            if ch == "\r":
                self.c = 0
                i += 1
                continue
            w = self._width(ch)
            if w == 0:
                i += 1
                continue
            if self.c >= self.cols:
                self.c = 0
                self.r = min(self.rows - 1, self.r + 1)
            self.grid[self.r][self.c] = ch
            if w == 2 and self.c + 1 < self.cols:
                self.grid[self.r][self.c + 1] = ""
            self.c += w
            i += 1

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.grid)


class PtySession:
    def __init__(self, argv, cols=COLS, rows=ROWS):
        self.term = Term(cols, rows)
        self.master, slave = pty.openpty()
        os.set_blocking(self.master, False)
        env = dict(os.environ)
        env["COLUMNS"] = str(cols)
        env["LINES"] = str(rows)
        env["TERM"] = "xterm-256color"
        self.proc = subprocess.Popen(
            argv,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=env,
            close_fds=True,
            preexec_fn=os.setsid,
        )
        os.close(slave)
        self.buf = ""

    def pump(self, seconds):
        """读取并喂给终端模拟器；只累积本会话自己的输出。"""
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.master], [], [], 0.03)
            if not r:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                break
            if not chunk:
                break
            data = chunk.decode("utf-8", "replace")
            self.buf += data
            self.term.feed(data)

    def send(self, keys):
        os.write(self.master, keys.encode())

    def screen(self):
        return self.term.text()

    def close(self):
        # 直接杀进程组，不发 q：q 会让 TUI 退出备用屏幕并回吐全部内容，
        # 残留输出会串到下一次采样里（截图错屏的根因）。
        try:
            self.pump(0.05)
        except OSError:
            pass
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.proc.wait(timeout=2)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        try:
            os.close(self.master)
        except OSError:
            pass


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = os.path.join(ROOT, "bin", "pi-lens.ts")
TARGET = (
    sys.argv[2]
    if len(sys.argv) > 2
    else "/home/tyao/文档/code/config-generation-design-agent/var/pi_sessions"
)

SCENARIOS = [
    {
        "name": "列表 → Enter 打开 → 两层循环时间轴",
        "steps": [("\r", 1.6, "opened")],
        "expect": ["SessionLoop ▸ AgentLoop", "SEG 1"],
        "reject": ["pi 会话列表"],
    },
    {
        "name": "时间轴 → Tab 问题面板 → Enter 跳回现场",
        "session": "issues",
        # 单文件启动直接落在时间轴，不需要先 Enter 打开
        "steps": [("\t", 0.8, "issues"), ("\r", 0.8, "jumped")],
        "expect": ["SessionLoop ▸ AgentLoop"],
    },
    {
        "name": "时间轴 ↓ 移动，详情联动",
        "steps": [
            ("\r", 1.6, "open"),
            ("\x1b[B", 0.4, "d1"),
            ("\x1b[B", 0.4, "d2"),
            ("\x1b[B", 0.4, "d3"),
        ],
        "expect": ["SessionLoop ▸ AgentLoop", "参数"],
    },
    {
        "name": "搜索过滤",
        "steps": [("/", 0.5, "search"), ("GRE", 0.6, "typed")],
        "expect": ["搜索: GRE", "pi 会话列表"],
    },
    {
        "name": "Esc 从时间轴返回列表",
        "steps": [("\r", 1.6, "open"), ("\x1b", 0.6, "esc")],
        "expect": ["pi 会话列表"],
    },
    {
        "name": "空格只看有问题会话",
        "steps": [(" ", 0.8, "filter")],
        "expect": ["已过滤"],
    },
    {
        "name": "问题面板 → n 跳到问题现场",
        "session": "issues",
        "steps": [("n", 0.8, "next-issue")],
        "expect": ["SessionLoop ▸ AgentLoop"],
    },
    {
        "name": "时间轴 → c 进入压缩对比视图",
        "session": "compaction",
        "steps": [("c", 1.0, "compare")],
        "expect": ["被压缩的原文", "摘要（压缩输出）", "压缩比"],
    },
    {
        "name": "压缩视图 → Tab 切到漏词核对",
        "session": "compaction",
        "steps": [("c", 1.0, "compare"), ("\t", 0.4, "t1"), ("\t", 0.8, "t2")],
        "expect": ["原文有、摘要没有"],
    },
    {
        "name": "无压缩会话按 c 给出提示",
        "session": "plain",
        "steps": [("c", 0.8, "c")],
        "expect": ["没有发生上下文压缩"],
    },
    {
        "name": "Z 全部折叠到段",
        "steps": [("\r", 2.2, "open"), ("Z", 0.8, "collapse-all")],
        "expect": ["SEG 1", "⋯", "已折叠到段"],
    },
    {
        "name": "E 全部展开恢复",
        "steps": [("\r", 2.2, "open"), ("Z", 0.7, "col"), ("E", 0.8, "exp")],
        "expect": ["LOOP 1"],
    },
    {
        "name": "z 按粒度折叠（迭代→循环→段）",
        "steps": [("\r", 2.2, "open"), ("z", 0.7, "z1"), ("z", 0.7, "z2")],
        "expect": ["已按"],
    },
    {
        "name": "左箭头折叠当前节点",
        "steps": [("\r", 2.2, "open"), ("\x1b[D", 0.8, "left")],
        "expect": ["已折叠"],
    },
    {
        "name": "a 键切换自动刷新开关",
        "steps": [("a", 0.6, "toggle-off"), ("a", 0.6, "toggle-on")],
        "expect": ["自动"],
    },
    {
        "name": "r 键手动刷新列表",
        "steps": [("r", 1.2, "refresh")],
        "expect": ["已刷新"],
    },
]


def pick_session(kind):
    """按场景需要挑一个目标：有压缩 / 无压缩 / 有工具报错的会话。"""
    import glob

    files = sorted(glob.glob(os.path.join(TARGET, "*.jsonl"))) if os.path.isdir(TARGET) else [TARGET]
    for p in files:
        try:
            with open(p, encoding="utf-8", errors="replace") as fh:
                txt = fh.read()
        except OSError:
            continue
        has_comp = '"type":"compaction"' in txt
        has_err = '"isError":true' in txt
        if kind == "compaction" and has_comp:
            return p
        if kind == "plain" and not has_comp:
            # 还需要确保会话本身有内容可展示（有 assistant）
            if '"role":"assistant"' in txt:
                return p
        if kind == "issues" and has_err:
            return p
    return TARGET


def make_refresh_fixture():
    """准备一个只含少量会话的临时目录，供刷新场景使用。"""
    import glob
    import shutil
    import tempfile

    d = tempfile.mkdtemp(prefix="pi-lens-refresh-")
    files = sorted(glob.glob(os.path.join(TARGET, "*.jsonl")))[:2]
    for f in files:
        shutil.copy(f, d)
    return d, files


def run_scenario(sc):
    target = pick_session(sc.get("session", "any")) if sc.get("session") else TARGET
    sess = PtySession(["node", ENTRY, target])
    ok = True
    msgs = []
    try:
        sess.pump(2.2)
        for keys, wait, _label in sc["steps"]:
            sess.send(keys)
            sess.pump(wait)
        screen = sess.screen()
    finally:
        sess.close()

    for k in sc.get("expect", []):
        if k not in screen:
            ok = False
            msgs.append(f"  ✖ 缺少 {k!r}")
    for k in sc.get("reject", []):
        if k in screen:
            ok = False
            msgs.append(f"  ✖ 不应出现 {k!r}")
    if not ok:
        msgs.append("  --- 屏幕 ---")
        msgs.extend("  | " + l for l in screen.split("\n")[:16])
    return ok, msgs


def main():
    passed = 0
    for sc in SCENARIOS:
        print(f"\n=== {sc['name']} ===")
        ok, msgs = run_scenario(sc)
        if ok:
            passed += 1
            print("  ✔ 通过")
        else:
            print("\n".join(msgs))
    print(f"\n结果：{passed}/{len(SCENARIOS)} 通过")
    return 0 if passed == len(SCENARIOS) else 1


if __name__ == "__main__":
    sys.exit(main())
