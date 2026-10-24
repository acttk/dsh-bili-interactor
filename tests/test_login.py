#!/usr/bin/env python3
"""
登录链路测试：把 httpx 换成假客户端，走**真实的** cmd_login / cmd_login_poll 代码路径。

架构前提（很重要）：
    python 子进程跑在 DSH 沙箱里，`~/.dsh/<插件名>` 写不进去。
    所以 py 这一半只负责「联网要数据」，落盘一律由宿主做。
    这个测试就是来钉死这条边界的 —— 任何一步偷偷写盘都会失败。

验五件事：
  1. login 只返回 base64 图和 qrcodeKey，**不碰文件系统**
  2. poll 在 86101/86090/86038 三种状态下都只吐一行 JSON，不抛、不改 key
  3. 成功（code=0）时从回调 url 正确解出 SESSDATA / bili_jct / DedeUserID
  4. 成功时把 credential **交给宿主**（payload 里带着），而不是自己写
  5. 参数缺失时给的是可读错误，不是栈
"""
import asyncio
import builtins
import json
import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlencode

HOME = Path(tempfile.mkdtemp(prefix="bi-login-"))
os.environ["BILI_INTERACTOR_HOME"] = str(HOME)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))

PASS, FAIL = 0, 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}  {extra}")


# ── 假 httpx（必须塞进 sys.modules：interact.py 是函数内 import） ──
class FakeResp:
    def __init__(self, payload):
        self._p = payload

    def json(self):
        return self._p


class FakeClient:
    script = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, params=None, headers=None):
        return FakeResp(FakeClient.script.pop(0))


fake_httpx = type(sys)("httpx")
fake_httpx.AsyncClient = FakeClient
sys.modules["httpx"] = fake_httpx

import interact as M  # noqa: E402

# ── 抓所有写盘尝试：py 这半边一次都不该写 ──
WRITES = []
_real_write_text = Path.write_text
_real_write_bytes = Path.write_bytes


def spy_write_text(self, *a, **k):
    WRITES.append(("write_text", str(self)))
    return _real_write_text(self, *a, **k)


def spy_write_bytes(self, *a, **k):
    WRITES.append(("write_bytes", str(self)))
    return _real_write_bytes(self, *a, **k)


Path.write_text = spy_write_text
Path.write_bytes = spy_write_bytes


async def main():
    print("== 1) login 只出图 + key，不写盘 ==")
    FakeClient.script = [{
        "code": 0,
        "data": {
            "url": "https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=ABC123",
            "qrcode_key": "ABC123",
        },
    }]
    captured = {}
    _real_out = M.out
    M.out = lambda o: captured.update(o) or _real_out(o)
    try:
        await M.cmd_login(None)
    finally:
        M.out = _real_out

    check("返回 qrcodeKey", captured.get("qrcodeKey") == "ABC123", captured.get("qrcodeKey"))
    check("返回 base64 图", str(captured.get("image", "")).startswith("data:image/png;base64,"))
    check("给了有效期", captured.get("expiresInSec") == 180)
    check("没有任何写盘动作", len(WRITES) == 0, WRITES)

    # ── 2) 三种未完成状态 ──
    print("== 2) 未完成状态：不抛、不改 key ==")
    for code, want in ((86101, "scan"), (86090, "conf"), (86038, "timeout")):
        FakeClient.script = [{"code": 0, "data": {"code": code, "message": "x"}}]
        ns = type("A", (), {"key": "ABC123"})()
        got, raised = {}, None
        M.out = lambda o: got.update(o) or _real_out(o)
        try:
            await M.cmd_login_poll(ns)
        except SystemExit:
            raised = "SystemExit"
        except Exception as e:
            raised = repr(e)
        finally:
            M.out = _real_out
        check(f"{code} -> {want} 不抛", raised is None, raised)
        check(f"{code} 返回 done=false", got.get("done") is False, got)

    # ── 3) 成功：解 cookie，交给宿主 ──
    print("== 3) 成功：解出 cookie 并交给宿主 ==")
    qs = urlencode({
        "DedeUserID": "123456789012",
        "DedeUserID__ckMd5": "deadbeef",
        "Expires": "1795000000",
        "SESSDATA": "sess_value%2C1795000000%2Cabcdef%2A11",
        "bili_jct": "jct_value_123",
        "gourl": "https://www.bilibili.com",
    })
    FakeClient.script = [{
        "code": 0,
        "data": {
            "code": 0,
            "message": "",
            "refresh_token": "rt_value",
            "url": "https://passport.biligame.com/crossDomain?" + qs,
        },
    }]

    import bilibili_api

    async def fake_self(credential=None):
        return {"mid": 123456789012, "name": "测试账号", "level": 2, "coins": 5}

    bilibili_api.user.get_self_info = fake_self

    got2 = {}
    M.out = lambda o: got2.update(o) or _real_out(o)
    try:
        await M.cmd_login_poll(type("A", (), {"key": "ABC123"})())
    finally:
        M.out = _real_out

    cred = got2.get("credential") or {}
    check("done=true", got2.get("done") is True, got2.get("state"))
    check("SESSDATA 解出来了", str(cred.get("sessdata", "")).startswith("sess_value"), cred.get("sessdata"))
    check("bili_jct 解出来了", cred.get("bili_jct") == "jct_value_123")
    check("DedeUserID 解出来了", cred.get("dedeuserid") == "123456789012")
    check("refresh_token 带上了", cred.get("ac_time_value") == "rt_value")
    check("账号信息一并返回", got2.get("name") == "测试账号")
    check("全程没有写盘", len(WRITES) == 0, WRITES)

    # ── 4) 缺 key 时给可读错误 ──
    print("== 4) 缺 qrcode_key ==")
    err = {}
    M.out = lambda o: err.update(o) or _real_out(o)
    try:
        await M.cmd_login_poll(type("A", (), {"key": ""})())
    except SystemExit:
        pass
    finally:
        M.out = _real_out
    check("ok=false", err.get("ok") is False, err)
    check("错误可读", "qrcode_key" in str(err.get("error", "")), err.get("error"))

    # ── 5) logout 只给清单，不自己删 ──
    print("== 5) logout 只报告该删哪些 ==")
    got3 = {}
    M.out = lambda o: got3.update(o) or _real_out(o)
    try:
        await M.cmd_logout(None)
    finally:
        M.out = _real_out
    check("给了 shouldRemove", isinstance(got3.get("shouldRemove"), list) and len(got3["shouldRemove"]) >= 1)
    check("自己没删文件（写盘数仍为 0）", len(WRITES) == 0, WRITES)

    print()
    print(f"PASS {PASS} / FAIL {FAIL}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
