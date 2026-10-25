#!/usr/bin/env python3
"""登录状态机打桩（无状态版）。

⚠️ DSH 沙箱下 python 子进程写不了任何文件（连 %TEMP% 都 PermissionError），
所以桩不能靠计数器文件。改成**把签发时间编进 qrcode_key**，
poll 时按「距签发过了多久」推导状态 —— 完全无状态，且更接近真实节奏。

  < 1.2 秒  -> scan   （没人扫）
  < 2.4 秒  -> conf   （扫了，等确认）
  否则      -> timeout（过期）
"""
import base64
import json
import sys
import time

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)

args = sys.argv[1:]
cmd = args[0] if args else ""


def opt(name, default=""):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return default


if cmd == "login":
    print(json.dumps({
        "ok": True,
        "image": "data:image/png;base64," + base64.b64encode(PNG).decode(),
        # key 里带签发毫秒时间戳，poll 时据此推导状态
        "qrcodeKey": "STUBKEY_%d" % int(time.time() * 1000),
        "expiresInSec": 180,
        "howto": "stub",
    }, ensure_ascii=False))
elif cmd == "login-poll":
    key = opt("--key")
    try:
        issued = int(key.split("_", 1)[1])
    except Exception:
        issued = 0
    elapsed = (time.time() * 1000) - issued if issued else 0

    if elapsed < 1200:
        print(json.dumps({"ok": True, "done": False, "state": "scan", "hint": "还没扫"}, ensure_ascii=False))
    elif elapsed < 2400:
        print(json.dumps({"ok": True, "done": False, "state": "conf", "hint": "扫到了待确认"}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": True, "done": False, "state": "timeout", "hint": "过期"}, ensure_ascii=False))
elif cmd == "whoami":
    print(json.dumps({"ok": True, "uid": 999, "name": "桩账号", "level": 2, "coins": 0}, ensure_ascii=False))
else:
    print(json.dumps({"ok": False, "error": "stub 不支持: " + cmd}, ensure_ascii=False))
