#!/usr/bin/env python3
"""临时替身：只为了测宿主侧登录状态机。
收到 login -> 吐假二维码；收到 login-poll -> 直接吐 done + 假凭证。
测完立刻用备份覆盖回来。"""
import base64
import json
import sys

# 1x1 PNG
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)

args = sys.argv[1:]
cmd = args[0] if args else ""

if cmd == "login":
    print(json.dumps({
        "ok": True,
        "image": "data:image/png;base64," + base64.b64encode(PNG).decode(),
        "qrcodeKey": "FAKEKEY_TEST_ONLY",
        "at": 0,
        "expiresInSec": 180,
        "howto": "stub",
    }, ensure_ascii=False))
elif cmd == "login-poll":
    print(json.dumps({
        "ok": True,
        "done": True,
        "state": "done",
        "credential": {
            "sessdata": "FAKE_SESSDATA",
            "bili_jct": "FAKE_JCT",
            "buvid3": "FAKE_BUVID",
            "dedeuserid": "12345",
            "savedAt": "2026-10-25T00:00:00",
        },
        "uid": 12345,
        "name": "假账号（集成测试）",
        "level": 2,
        "coins": 0,
    }, ensure_ascii=False))
elif cmd == "whoami":
    print(json.dumps({"ok": True, "uid": 12345, "name": "假账号", "level": 2, "coins": 0}, ensure_ascii=False))
else:
    print(json.dumps({"ok": False, "error": "stub 不支持: " + cmd}, ensure_ascii=False))
