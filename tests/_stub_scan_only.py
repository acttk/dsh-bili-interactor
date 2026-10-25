#!/usr/bin/env python3
"""永远返回 scan（没人扫）的桩：用来验证「快过期就主动换码」。"""
import base64
import json
import sys

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)

args = sys.argv[1:]
cmd = args[0] if args else ""

if cmd == "login":
    import time
    print(json.dumps({
        "ok": True,
        "image": "data:image/png;base64," + base64.b64encode(PNG).decode(),
        "qrcodeKey": "SCANONLY_%d" % int(time.time() * 1000),
        "expiresInSec": 180,
    }, ensure_ascii=False))
elif cmd == "login-poll":
    print(json.dumps({"ok": True, "done": False, "state": "scan", "hint": "没人扫"}, ensure_ascii=False))
else:
    print(json.dumps({"ok": False, "error": "stub 不支持: " + cmd}, ensure_ascii=False))
