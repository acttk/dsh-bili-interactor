#!/usr/bin/env python3
"""评论结果判定的单元测试。

锁死这次的 bug：`comment.send_comment` 返回 `.result`（data 本体，没有 code），
旧代码按 r.get("code") == 0 判断 → 永远 False → 成功当失败 → 界面报「code null」。

不用联网、不真发评论：只测 interpret_comment_response 这个纯函数。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))

import importlib.util

spec = importlib.util.spec_from_file_location("interact", ROOT / "py" / "interact.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

f = mod.interpret_comment_response

ok = 0
bad = 0


def check(name, cond, extra=""):
    global ok, bad
    if cond:
        ok += 1
        print("  OK   " + name)
    else:
        bad += 1
        print("  FAIL " + name + "  " + str(extra))


print("== 1) 成功：完整 {code:0, data:{rpid}} ==")
r = f({"code": 0, "message": "0", "data": {"rpid": 12345, "rpid_str": "12345"}}, "hi")
check("ok", r.get("ok") is True, r)
check("rpid 正确", r.get("rpid") == "12345", r)

print("== 2) 成功但 data 是扁平结构（bilibili_api 的 .result 就是这种）==")
r = f({"code": 0, "data": {"rpid_str": "999", "rpid": 999}}, "hi")
check("ok", r.get("ok") is True, r)
check("rpid 正确", r.get("rpid") == "999", r)

print("== 3) 旧 bug 场景：只有 data 本体、没有 code —— 不能再被当成失败 ==")
r = f({"rpid": 777, "rpid_str": "777", "dialog": 0}, "hi")
check("不会被误判成失败", r.get("ok") is True, r)
check("能认出 rpid", r.get("rpid") == "777", r)

print("== 4) 真失败：风控 -412 ==")
r = f({"code": -412, "message": "请求被拦截"}, "hi")
check("ok=False", r.get("ok") is False, r)
check("带 B站 原话", "请求被拦截" in (r.get("error") or ""), r)
check("给出可操作提示", "风控" in (r.get("error") or ""), r)
check("保留原始响应方便排查", "raw" in r, r.keys())

print("== 5) 真失败：未登录 -101 ==")
r = f({"code": -101, "message": "账号未登录"}, "hi")
check("ok=False", r.get("ok") is False, r)
check("提示重新登录", "重新扫码" in (r.get("error") or ""), r)

print("== 6) 真失败：评论区关闭 12002 ==")
r = f({"code": 12002, "message": "评论已关闭"}, "hi")
check("ok=False", r.get("ok") is False, r)
check("提示评论区关了", "评论区" in (r.get("error") or ""), r)

print("== 7) 失败但 B站 没给原因，也要能看懂 ==")
r = f({"code": 12345}, "hi")
check("ok=False", r.get("ok") is False, r)
check("有兜底文案", bool(r.get("error")), r)

print("== 8) 响应不是 dict 也不能崩 ==")
r = f("oops", "hi")
check("ok=False", r.get("ok") is False, r)
check("有说明", "JSON" in (r.get("error") or ""), r)

print("\nPASS %d / FAIL %d" % (ok, bad))
sys.exit(0 if bad == 0 else 1)
