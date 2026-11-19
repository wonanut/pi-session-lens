#!/usr/bin/env python3
"""截图：把 TUI 各屏渲染成纯文本存档，便于人工核对。

用法：python3 scripts/screenshot.py [会话文件] [输出目录]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_driver import PtySession, ENTRY, TARGET  # noqa: E402


def shot(name, keys_seq, session_file=None):
    argv = ["node", ENTRY, session_file or TARGET]
    s = PtySession(argv)
    try:
        s.pump(2.2)
        for keys, wait in keys_seq:
            s.send(keys)
            s.pump(wait)
        return s.screen()
    finally:
        s.close()


def main():
    session_file = sys.argv[1] if len(sys.argv) > 1 else None
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "/tmp/pi-lens-shots"
    os.makedirs(out_dir, exist_ok=True)

    shots = {
        "01-list": [],
        "02-timeline": [("\r", 2.0)],
        "03-step-detail": [("\r", 2.0), ("\x1b[B", 0.3), ("\x1b[B", 0.3), ("\x1b[B", 0.5)],
        "04-issues": [("\r", 2.0), ("\t", 0.6)],
        "05-issue-detail": [("\r", 2.0), ("\t", 0.6), ("\x1b[B", 0.5)],
        "06-help": [("\r", 2.0), ("?", 0.6)],
        "07-search": [("/", 0.4), ("VPN", 0.6)],
    }

    for name, seq in shots.items():
        screen = shot(name, seq, session_file)
        path = os.path.join(out_dir, name + ".txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(screen + "\n")
        print(f"{name}: {len(screen.splitlines())} 行 -> {path}")


if __name__ == "__main__":
    main()
