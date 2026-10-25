#!/usr/bin/env python3
"""
dsh-bili-interactor —— B站 互动执行器
============================================================================
职责：**只干活，不判断**。
    Node 那边（或人）决定「对哪条视频做什么」，这里负责真的发出去。

为什么拆成两半：
    · 判断要模型（它懂上下文、会挑），但那玩意儿慢又贵
    · 动作要确定性（点赞投币发弹幕，重试几次都该是同一个结果）
    · 中间用 JSON 说话，谁都能单独测

用法：
    python interact.py login                         # 生成登录二维码
    python interact.py login-poll                    # 查扫码状态（不换码）
    python interact.py logout                        # 删掉本插件凭证
    python interact.py whoami
    python interact.py search --keyword 恐怖游戏 --order click --limit 10
    python interact.py info  --bvid BV1xxx
    python interact.py act   --bvid BV1xxx --like --coin 1 --danmaku "这波舒服"
    python interact.py run   --plan plan.json
    python interact.py comment --bvid BV1xxx --text "……" [--root N --parent N]

约定：
    · 结果一律打成 JSON 到 stdout：{"ok": bool, ...}
    · 失败不抛栈，返回 {"ok": false, "error": "...", "code": ...}
    · 自己那份凭证在 ~/.dsh/bili-interactor/credential.json；
      没有的话退回 ~/.dsh/bili-duty/bili_credential.json（跟刷视频插件共用）
    · bilibili_api 17.x 的接口**几乎全是 async**，所以整个脚本跑在 asyncio 上
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import time
from pathlib import Path

HOME = Path(os.environ.get("BILI_DUTY_HOME") or (Path.home() / ".dsh" / "bili-duty"))
CRED_FILE = HOME / "bili_credential.json"

# ⭐ 自己的家目录：凭证优先存在这儿 —— 本插件不依赖别的插件
OWN_HOME = Path(os.environ.get("BILI_INTERACTOR_HOME") or (Path.home() / ".dsh" / "bili-interactor"))
OWN_CRED = OWN_HOME / "credential.json"
QR_CACHE = OWN_HOME / "qr.png"
LOGIN_STATE = OWN_HOME / "login.json"


def out(obj):
    """统一出口：JSON + 刷新（被管道读时不至于卡住）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(msg, **extra):
    out({"ok": False, "error": str(msg), **extra})
    raise SystemExit(0)


def _ensure_own_home():
    try:
        OWN_HOME.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass


def _raw_from(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return None


def _cred_from(raw: dict):
    """三个 cookie 拼成 Credential；缺关键项返回 None。"""
    from bilibili_api import Credential

    sess = raw.get("sessdata") or raw.get("SESSDATA") or ""
    jct = raw.get("bili_jct") or raw.get("BILI_JCT") or ""
    buvid = raw.get("buvid3") or raw.get("BUVID3") or ""
    uid = raw.get("dedeuserid") or raw.get("DedeUserID") or raw.get("dedeUserID") or ""
    if not sess or not jct:
        return None
    return Credential(sessdata=sess, bili_jct=jct, buvid3=buvid, dedeuserid=str(uid) or None)


def credential_paths():
    """先自己的，再退回共用的（老用户已经扫码过，不该让他重登）。"""
    return [OWN_CRED, CRED_FILE]


def find_credential():
    """返回 (cred, path) 或 (None, None)。"""
    for p in credential_paths():
        if not p.exists():
            continue
        raw = _raw_from(p)
        if not raw:
            continue
        c = _cred_from(raw)
        if c:
            return c, p
    return None, None


def load_credential():
    cred, _ = find_credential()
    if cred is None:
        fail(
            "还没登录 B站",
            hint="在设置页「B站互动」里点「扫码登录」，或者命令行跑 interact.py login",
            needLogin=True,
        )
    return cred


def video_obj(bvid, cred):
    from bilibili_api import video

    return video.Video(bvid=bvid, credential=cred)


def brief(info: dict) -> dict:
    """把 get_info 的一大坨裁成面板要的那几项。"""
    d = info.get("data") if isinstance(info, dict) and "data" in info else info
    if not isinstance(d, dict):
        return {}
    stat = d.get("stat") or {}
    owner = d.get("owner") or {}
    return {
        "bvid": d.get("bvid") or "",
        "aid": d.get("aid"),
        "title": (d.get("title") or "").strip(),
        "desc": (d.get("desc") or "").strip()[:400],
        "up": (owner.get("name") or "").strip(),
        "upMid": owner.get("mid"),
        "pic": d.get("pic") or "",
        "duration": d.get("duration") or 0,
        "pubdate": d.get("pubdate") or 0,
        "play": stat.get("view") or 0,
        "like": stat.get("like") or 0,
        "coin": stat.get("coin") or 0,
        "favorite": stat.get("favorite") or 0,
        "danmaku": stat.get("danmaku") or 0,
        "reply": stat.get("reply") or 0,
        "url": "https://www.bilibili.com/video/" + (d.get("bvid") or ""),
    }


# ─────────────────────────── 扫码登录 ───────────────────────────
#
# ⚠️ 这里不用 bilibili_api 的 QrCodeLogin：它把 qrcode_key 藏在私有属性里，
#    一个进程生成的码，另一个进程查不了状态；而「重新生成」会换一张新码，
#    用户手机上扫的那张立刻作废。
#    ⇒ 自己按同一套接口走：qr 那步把 key 写文件，poll 那步带着同一个 key 去问。
#
#      GET passport.bilibili.com/x/passport-login/web/qrcode/generate → url + qrcode_key
#      GET passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=…
#          code: 86101 未扫 / 86090 已扫待确认 / 86038 过期 / 0 成功


def _ua_headers():
    return {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"}


def _qr_png(url: str) -> bytes:
    """把扫码链接画成 PNG（qrcode 是 bilibili_api 的依赖，肯定装得上）。"""
    import io

    import qrcode

    qr = qrcode.QRCode(border=2, box_size=8)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def cmd_login(args):
    """
    ⚠️ 只**取**二维码，不写盘 —— 写盘交给宿主。
       原因：DSH 会在沙箱里跑子进程，`~/.dsh/<插件名>` 往往不可写
       （只有名单里的目录能写）。把 IO 留给不受限的宿主，谁都别踩坑。
    """
    import base64

    import httpx

    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(
                "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
                headers=_ua_headers(),
            )
            j = r.json()
    except Exception as e:
        fail(f"取二维码失败（网络）：{e}")

    if j.get("code") != 0:
        fail(f"取二维码失败：{j.get('message')}", code=j.get("code"))

    data = j.get("data") or {}
    url = data.get("url") or ""
    key = data.get("qrcode_key") or ""
    if not url or not key:
        fail("B站 没给 url 或 qrcode_key")

    try:
        png = _qr_png(url)
    except Exception as e:
        fail(f"画二维码失败：{e}")

    out({
        "ok": True,
        "image": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
        "qrcodeKey": key,
        "at": int(time.time()),
        "expiresInSec": 180,
        "howto": "用 B站 App 扫这张码，然后在手机上点「确认登录」",
    })


async def cmd_login_poll(args):
    """
    带着 key 去问状态。key 由宿主通过 --key 传进来（不读盘，省一次权限坑）。
    state: scan / conf / timeout / done；done 时把 cookie payload 一起吐出来，宿主落盘。
    """
    import httpx

    key = (args.key or "").strip()
    if not key:
        fail("没有 qrcode_key", hint="先点一次「扫码登录」重新生成")

    set_cookies = []
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as c:
            r = await c.get(
                "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
                params={"qrcode_key": key, "source": "main-fe-header"},
                headers=_ua_headers(),
            )
            # ⭐ 凭证在 Set-Cookie 头里。以前只从 data.url 的 query 里找，
            #    而那条 url 里根本没有 SESSDATA（那是别的域的游戏票）⇒ 永远拿不到。
            try:
                set_cookies = r.headers.get_list("set-cookie")
            except Exception:
                set_cookies = []
            j = r.json()
    except Exception as e:
        fail(f"查状态失败（网络）：{e}")

    if j.get("code") != 0:
        fail(f"查状态失败：{j.get('message')}", code=j.get("code"))

    d = j.get("data") or {}
    code = d.get("code")
    if code == 86101:
        out({"ok": True, "done": False, "state": "scan", "hint": "还没扫"})
        return
    if code == 86090:
        out({"ok": True, "done": False, "state": "conf", "hint": "扫到了，等你在手机上点确认"})
        return
    if code == 86038:
        out({"ok": True, "done": False, "state": "timeout", "hint": "二维码过期了，重新生成一张"})
        return
    if code != 0:
        fail(f"未知状态 {code}：{d.get('message')}")

    # 成功：B站 把 cookie 塞在返回的 url 里
    cred_url = d.get("url") or ""
    if not cred_url:
        fail("登录成功但没拿到回调 url")

    from urllib.parse import parse_qs, urlparse

    # 先从 Set-Cookie 里抠
    jar = {}
    for raw in set_cookies:
        first = str(raw).split(";")[0] or ""
        if "=" not in first:
            continue
        name, _, value = first.partition("=")
        jar[name.strip()] = value.strip()

    qs = parse_qs(urlparse(cred_url).query)
    payload = {
        "sessdata": jar.get("SESSDATA") or (qs.get("SESSDATA") or [""])[0],
        "bili_jct": jar.get("bili_jct") or (qs.get("bili_jct") or [""])[0],
        "buvid3": jar.get("buvid3") or (qs.get("buvid3") or [""])[0],
        "dedeuserid": jar.get("DedeUserID") or (qs.get("DedeUserID") or [""])[0],
        "ac_time_value": d.get("refresh_token") or "",
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    if not payload["sessdata"] or not payload["bili_jct"]:
        fail("登录成功但 cookie 不完整，重试一次")

    # 确认这个 cookie 真有权限
    from bilibili_api import user

    me = await user.get_self_info(credential=_cred_from(payload))
    dd = me.get("data") if isinstance(me.get("data"), dict) else (me or {})
    out({
        "ok": True,
        "done": True,
        "state": "done",
        "credential": payload,       # ← 宿主负责写盘
        "uid": dd.get("mid"),
        "name": dd.get("name") or dd.get("uname"),
        "level": dd.get("level"),
        "coins": dd.get("coins"),
    })


async def cmd_logout(args):
    """
    只报告「应该删哪几个文件」，实际删除交给宿主。
    （沙箱里的子进程删不动 ~/.dsh/<插件名>，别让它白试。）
    """
    out({
        "ok": True,
        "shouldRemove": [str(OWN_CRED), str(LOGIN_STATE), str(QR_CACHE)],
        "hint": "已退出登录",
    })


# ─────────────────────────── 其它子命令 ───────────────────────────

async def cmd_whoami(args):
    cred = load_credential()
    from bilibili_api import user

    me = await user.get_self_info(credential=cred)
    # 注意：这个接口直接返回扁平 dict（不是 {"code":0,"data":{}} 那套）
    d = me.get("data") if isinstance(me, dict) and isinstance(me.get("data"), dict) else (me or {})
    if not d.get("mid"):
        fail(me.get("message") or "读取自身信息失败（凭证可能过期）", code=me.get("code"))
    out({
        "ok": True,
        "uid": d.get("mid"),
        "name": d.get("name") or d.get("uname"),
        "level": d.get("level"),
        "coins": d.get("coins"),
        "face": d.get("face"),
        "vip": (d.get("vip") or {}).get("status"),
    })


async def cmd_search(args):
    from bilibili_api import search

    order_map = {
        "click": search.OrderVideo.CLICK,
        "pubdate": search.OrderVideo.PUBDATE,
        "totalrank": search.OrderVideo.TOTALRANK,
        "dm": search.OrderVideo.DM,
    }
    order = order_map.get(args.order or "click", search.OrderVideo.CLICK)
    try:
        res = await search.search_by_type(
            keyword=args.keyword,
            search_type=search.SearchObjectType.VIDEO,
            order_type=order,
            page=1,
        )
    except Exception as e:
        fail(f"搜索失败：{e}")

    items = []
    # search_by_type 的 result 是**扁平列表**（不是 {"result":{"result":[…]}} 那套）
    raw_list = res.get("result")
    if isinstance(raw_list, dict):
        raw_list = raw_list.get("result") or []
    for v in (raw_list or []):
        if v.get("type") not in (None, "video"):
            continue
        title = (v.get("title") or "")
        title = title.replace('<em class="keyword">', "").replace("</em>", "")
        items.append({
            "bvid": v.get("bvid") or "",
            "title": title,
            "up": v.get("author") or "",
            "play": v.get("play") or 0,
            "danmaku": v.get("video_review") or 0,
            "duration": v.get("duration") or "",
            "pubdate": v.get("pubdate") or 0,
            "url": "https://www.bilibili.com/video/" + (v.get("bvid") or ""),
        })
    items.sort(key=lambda x: x["play"], reverse=True)
    out({"ok": True, "keyword": args.keyword, "order": args.order, "count": len(items), "items": items[: args.limit]})


async def cmd_recall_danmaku(args):
    """
    撤回自己发过的弹幕。

    ⚠️ bilibili_api 里那个 recall_danmaku 用的是 `GET /x/dm/recall`，B站 已经改成
       **POST** 了 —— 照它调会拿到 405 Method Not Allowed。这里直接走正确的写法。
       接口回 {"code":0,"message":"撤回成功，你还有 N 次撤回机会"}。
    """
    import httpx

    cred, _ = find_credential()
    if cred is None:
        fail("还没登录 B站", needLogin=True)

    dmid = str(args.dmid or "").strip()
    if not dmid.isdigit():
        fail("dmid 必须是数字（发弹幕时返回的那个 dmid_str）")

    bvid = args.bvid
    s = cred.sessdata
    jct = cred.bili_jct
    if not s or not jct:
        fail("凭证里缺 SESSDATA / bili_jct")

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": f"https://www.bilibili.com/video/{bvid}",
        "Origin": "https://www.bilibili.com",
        "Cookie": f"SESSDATA={s}; bili_jct={jct}; buvid3={cred.buvid3 or ''}; DedeUserID={cred.dedeuserid or ''}",
    }

    # 先拿 cid（撤回要 dmid + cid）
    v = video_obj(bvid, cred)
    try:
        pages = await v.get_pages()
        cid = (pages or [{}])[0].get("cid")
    except Exception as e:
        fail(f"拿不到 cid：{e}")
    if not cid and args.cid:
        cid = int(args.cid)
    if not cid:
        fail("拿不到这条视频的 cid")

    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(
                "https://api.bilibili.com/x/dm/recall",
                params={"dmid": int(dmid), "cid": int(cid), "csrf": jct},
                headers=headers,
            )
            j = r.json()
    except Exception as e:
        fail(f"撤回请求失败：{e}")

    if j.get("code") == 0:
        out({"ok": True, "dmid": dmid, "message": j.get("message") or "撤回成功"})
    else:
        out({"ok": False, "code": j.get("code"), "error": j.get("message")})


async def do_actions(bvid, cred, args, info=None):
    """
    按参数对一条视频做动作。每一步单独捕获，一步失败不影响别的步。
    """
    v = video_obj(bvid, cred)
    if info is None:
        try:
            info = brief(await v.get_info())
        except Exception as e:
            info = {"bvid": bvid, "error": f"取信息失败：{e}"}

    done, failed = [], []
    gap = tuple(getattr(args, "interval", [1.5, 4.0]))

    # ⚠️ 风控要认：B站 在「投币」这类写操作上会要二级验证（-401 verify_captcha_level2）。
    #    这不是 bug、也不是没登录 —— 是平台在拦脚本。遇到就把这一轮停掉，
    #    别一条条硬撞（撞多了账号会被盯上）。
    riskTripped = {"hit": False}

    async def step(kind, coro_factory):
        if riskTripped["hit"] and kind != "like":
            return None
        try:
            r = await coro_factory()
            # ⚠️ 不是所有接口都回 {"code":0}：比如发弹幕成功时直接回
            #    {"dmid": ..., "dmid_str": ..., "visible": true}，**没有 code 字段**。
            #    以前只认 code==0，把成功的弹幕判成了失败。
            if isinstance(r, dict):
                if r.get("code") == 0:
                    done.append({"kind": kind, "ok": True})
                    return r
                if "code" not in r and ("dmid" in r or "dmid_str" in r):
                    done.append({"kind": kind, "ok": True})
                    return r
                code = r.get("code")
                msg = r.get("message") or ""
                if code == -401 or "verify_captcha" in str(r):
                    riskTripped["hit"] = True
                    failed.append({
                        "kind": kind, "code": code, "risk": True,
                        "msg": f"{msg or '风控'}（B站 要人机验证了，这一轮不再继续写操作）",
                    })
                elif code == 36703:
                    failed.append({"kind": kind, "code": code, "msg": "发太快了，B站 拦了（频率限制）"})
                elif code == 65006:
                    failed.append({"kind": kind, "code": code, "msg": "已经赞过了"})
                elif code == 65004:
                    failed.append({"kind": kind, "code": code, "msg": "没赞过，取消不了"})
                else:
                    failed.append({"kind": kind, "code": code, "msg": msg or f'code {code}'})
                return r
            done.append({"kind": kind, "ok": True})
            return r
        except Exception as e:
            failed.append({"kind": kind, "msg": str(e)})
            return None
        finally:
            await asyncio.sleep(random.uniform(*gap))

    if getattr(args, "like", False):
        await step("like", lambda: v.like(True))

    if getattr(args, "coin", 0) and args.coin > 0:
        n = min(int(args.coin), 2)
        r = await step("coin", lambda: v.pay_coin(num=n))
        if r:
            for d in done:
                if d["kind"] == "coin":
                    d["n"] = n

    if getattr(args, "fav", 0):
        folder = int(args.fav)
        await step("favorite", lambda: v.set_favorite(add_media_ids=[folder]))

    if getattr(args, "danmaku", None):
        from bilibili_api.utils.danmaku import Danmaku

        text = args.danmaku
        # ⚠️ send_danmaku 必须给 page_index 或 cid，否则 B站 直接拒：
        #    「page_index 和 cid 至少提供一个」。默认发在 P1。
        async def _send_dm():
            try:
                pages = await v.get_pages()
                first = (pages or [{}])[0]
                cid = first.get("cid")
                if cid:
                    return await v.send_danmaku(cid=cid, danmaku=Danmaku(text=text))
            except Exception:
                pass
            return await v.send_danmaku(page_index=0, danmaku=Danmaku(text=text))

        r = await step("danmaku", _send_dm)
        if r and (r.get("code") == 0 or "dmid_str" in r or "dmid" in r):
            # ⚠️ 成功的返回是扁平的：{"dmid":…, "dmid_str":…, "visible":true}，
            #    没有 data 包装 —— 以前从 r["data"] 取，永远拿不到 dmid。
            dmid = r.get("dmid_str") or r.get("dmid") or ((r.get("data") or {}).get("dmid_str"))
            for x in done:
                if x["kind"] == "danmaku":
                    x["text"] = text
                    x["dmid"] = str(dmid) if dmid else None

    if getattr(args, "follow", False):
        from bilibili_api import user as user_api

        mid = info.get("upMid")
        if not mid:
            failed.append({"kind": "follow", "msg": "拿不到 UP 的 mid"})
        else:
            u = user_api.User(uid=int(mid), credential=cred)
            await step("follow", lambda: u.modify_relation(relation=user_api.RelationType.SUBSCRIBE))

    return {
        "ok": bool(done) and not failed,
        "partial": bool(done) and bool(failed),
        "riskTripped": riskTripped["hit"],
        "bvid": bvid,
        "info": info,
        "done": done,
        "failed": failed,
    }


async def cmd_act(args):
    cred = load_credential()
    out(await do_actions(args.bvid, cred, args))


async def cmd_info(args):
    cred = load_credential()
    v = video_obj(args.bvid, cred)
    try:
        out({"ok": True, "info": brief(await v.get_info())})
    except Exception as e:
        fail(f"取信息失败：{e}")


async def cmd_run(args):
    """批量：读一份 plan.json，逐条执行，边跑边打 NDJSON。"""
    cred = load_credential()
    plan_path = Path(args.plan)
    if not plan_path.exists():
        fail(f"计划文件不存在：{plan_path}")
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    except Exception as e:
        fail(f"计划文件读不出来：{e}")

    items = [x for x in (plan.get("items") or []) if x.get("bvid")]
    total = len(items)
    out({"event": "start", "total": total})

    results = []
    for i, it in enumerate(items, 1):
        sub = argparse.Namespace(
            like=it.get("like", args.like),
            coin=it.get("coin", args.coin),
            fav=it.get("fav", args.fav),
            danmaku=it.get("danmaku"),
            follow=it.get("follow", args.follow),
            interval=args.interval,
        )
        out({"event": "item_start", "i": i, "total": total, "bvid": it["bvid"], "title": it.get("title") or ""})
        try:
            r = await do_actions(it["bvid"], cred, sub)
        except Exception as e:
            r = {"ok": False, "bvid": it["bvid"], "error": str(e), "done": [], "failed": []}
        results.append(r)
        out({"event": "item_done", "i": i, "total": total, "result": r})
        if i < total:
            await asyncio.sleep(random.uniform(args.gap[0], args.gap[1]))

    ok_n = sum(1 for r in results if r.get("ok"))
    out({"event": "done", "total": total, "ok": ok_n, "results": results})


def interpret_comment_response(resp, text):
    """把 B站 发评论的响应翻译成 {ok, rpid} 或 {ok:False, code, error}。

    抽成纯函数是为了能单测：这个判断以前写错过一次 —— 用 `.result`
    拿到的是 data 本体（没有 code 字段），却按 r.get("code") == 0 判断，
    永远 False，把成功当失败，界面上报「code null」。
    """
    if not isinstance(resp, dict):
        return {"ok": False, "code": None, "error": "响应不是 JSON 对象：%r" % (resp,)}

    code = resp.get("code")
    msg = resp.get("message") or resp.get("msg") or ""

    def _dig_rpid(obj):
        if not isinstance(obj, dict):
            return None
        rp = obj.get("rpid")
        return (
            obj.get("rpid_str")
            or (rp.get("rpid_str") if isinstance(rp, dict) else None)
            or (rp if not isinstance(rp, (dict, list)) else None)
            or obj.get("rpid")
        )

    if code == 0:
        rpid = _dig_rpid(resp.get("data"))
        return {"ok": True, "rpid": str(rpid) if rpid else None, "text": text}

    # 兼容历史形状：bilibili_api 的 `.result` 直接给 data 本体，没有 code。
    # 这种响应里只要有 rpid，就是真的发出去了 —— 不能再判成失败。
    if code is None:
        rpid = _dig_rpid(resp)
        if rpid:
            return {"ok": True, "rpid": str(rpid), "text": text}

    hint = ""
    if code in (-412, -352, -351):
        hint = "触发了 B站 风控，等一会儿再试，别连着发"
    elif code == 12002:
        hint = "这条视频的评论区关了"
    elif code == 12009:
        hint = "参数不对（比如 oid/type 配错），多半是这条目标不是普通视频"
    elif code == -101:
        hint = "账号未登录或凭证失效，重新扫码登录"
    elif code == 12015:
        hint = "需要先做一次验证码验证（去网页版评论区手动发一条）"
    return {
        "ok": False,
        "code": code,
        "error": (msg or "B站 没给原因") + (("（" + hint + "）") if hint else ""),
        "raw": json.dumps(resp, ensure_ascii=False)[:400],
    }


async def cmd_comment(args):
    """发评论 / 回复评论。

    ⚠️ 这里**不用** comment.send_comment，因为它返回的是 `.result`，
    也就是 data 本体（{rpid, rpid_str, ...}），**没有 code 字段**。
    以前拿 r.get("code") == 0 判断，永远 False，于是把成功当失败，
    报出来就是「code null」——评论其实可能已经发出去了，界面却说没发出去。

    现在直接走 Api(raw=True)，拿到完整的 {code, message, data}，
    B站 到底说了什么一目了然。
    """
    from bilibili_api.utils.network import Api
    from bilibili_api.utils.utils import get_api

    cred = load_credential()
    from bilibili_api import comment as comment_api

    v = video_obj(args.bvid, cred)
    try:
        oid = v.get_aid()
        if hasattr(oid, "__await__"):
            oid = await oid
    except Exception as e:
        fail(f"拿不到 aid：{e}")

    data = {
        "oid": int(oid),
        "type": comment_api.CommentResourceType.VIDEO.value,
        "message": args.text,
        "plat": 1,
        "statistics": {"appId": 100, "platform": 5},
        "gaia_source": "main_web",
    }
    if args.root and args.parent:
        data["root"] = int(args.root)
        data["parent"] = int(args.parent)
    elif args.root:
        data["root"] = int(args.root)
        data["parent"] = int(args.root)
    elif args.parent:
        fail("只给了 parent 没给 root，B站 不接受这种组合")

    api_info = get_api("common")["comment"]["send"]
    try:
        resp = await Api(**api_info, credential=cred).update_data(**data).request(raw=True)
    except Exception as e:
        fail(f"发送失败（网络/异常）：{e}")

    out(interpret_comment_response(resp, args.text))


async def cmd_comments(args):
    """
    读一条视频的评论区（默认按时间倒序，拿最新的）。
    只读，不动任何东西。
    """
    cred = load_credential()
    from bilibili_api import comment as comment_api

    v = video_obj(args.bvid, cred)
    try:
        oid = v.get_aid()
        if hasattr(oid, "__await__"):
            oid = await oid
    except Exception as e:
        fail(f"拿不到 aid：{e}")

    order = comment_api.OrderType.TIME if (args.order or "time") == "time" else comment_api.OrderType.LIKE
    try:
        r = await comment_api.get_comments(
            oid=int(oid), type_=comment_api.CommentResourceType.VIDEO,
            page_index=1, order=order, credential=cred,
        )
    except Exception as e:
        fail(f"读评论区失败：{e}")

    if isinstance(r, dict) and r.get("code") not in (0, None):
        fail(r.get("message") or "读评论区失败", code=r.get("code"))

    # ⚠️ get_comments 有时直接回数据本体（page/replies/…），有时包一层 {"code":0,"data":{…}}
    #    —— 以前只认 data，结果永远读到空列表。
    d = r
    if isinstance(r, dict) and isinstance(r.get("data"), dict) and "replies" in r["data"]:
        d = r["data"]
    replies = (d or {}).get("replies") or []
    me = str(getattr(cred, "dedeuserid", "") or "")
    items = []
    for c in replies:
        member = c.get("member") or {}
        content = c.get("content") or {}
        uid = str(member.get("mid") or "")
        if me and uid == me:
            continue        # 自己发的不回
        items.append({
            "rpid": str(c.get("rpid_str") or c.get("rpid") or ""),
            "uid": uid,
            "uname": member.get("uname") or "",
            "content": (content.get("message") or "").strip(),
            "like": c.get("like") or 0,
            "ctime": c.get("ctime") or 0,
            "rcount": c.get("rcount") or 0,
        })
    out({"ok": True, "bvid": args.bvid, "total": len(items), "items": items[: args.limit]})


async def cmd_uidname(args):
    """UID → 昵称（发评论 @ 人要用昵称，不能用 UID）。"""
    cred, _ = find_credential()
    from bilibili_api import user

    uid = str(args.uid or "").strip()
    if not uid.isdigit():
        fail("uid 必须是数字")
    try:
        u = user.User(uid=int(uid), credential=cred)
        info = await u.get_user_info()
    except Exception as e:
        fail(f"查不到这个 UID：{e}")

    name = (info or {}).get("name") or ((info or {}).get("data") or {}).get("name")
    if not name:
        fail("这个 UID 没有昵称（可能不存在或被封）")
    out({"ok": True, "uid": uid, "name": name})


async def cmd_dm(args):
    """发私信（默认由宿主按开关决定要不要调）。"""
    import httpx

    cred, _ = find_credential()
    if cred is None:
        fail("还没登录 B站", needLogin=True)

    to = str(args.uid or "").strip()
    if not to.isdigit():
        fail("私信对象 uid 必须是数字")
    if not cred.sessdata or not cred.bili_jct:
        fail("凭证里缺 SESSDATA / bili_jct")

    sender = str(cred.dedeuserid or "").strip()
    if not sender:
        fail("凭证里缺自己的 DedeUserID")

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://message.bilibili.com/",
        "Origin": "https://message.bilibili.com",
        "Cookie": f"SESSDATA={cred.sessdata}; bili_jct={cred.bili_jct}; "
                  f"buvid3={cred.buvid3 or ''}; DedeUserID={sender}",
    }
    data = {
        "msg[sender_uid]": sender,
        "msg[receiver_id]": to,
        "msg[receiver_type]": 1,
        "msg[msg_type]": 1,
        "msg[dev_id]": "0",
        "msg[timestamp]": int(time.time()),
        "msg[content]": json.dumps({"content": args.text}, ensure_ascii=False),
        "csrf": cred.bili_jct,
        "csrf_token": cred.bili_jct,
    }
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post("https://api.vc.bilibili.com/web_im/v1/web_im/send_msg", data=data, headers=headers)
            j = r.json()
    except Exception as e:
        fail(f"私信发送失败：{e}")

    if j.get("code") == 0:
        out({"ok": True, "msgKey": (j.get("data") or {}).get("msg_key"), "to": to})
    else:
        out({"ok": False, "code": j.get("code"), "error": j.get("message")})


# ─────────────────────────── 参数 & 入口 ───────────────────────────

def add_actions(x, *, need_bvid=True):
    if need_bvid:
        x.add_argument("--bvid", required=True)
    x.add_argument("--like", action="store_true")
    x.add_argument("--coin", type=int, default=0)
    x.add_argument("--fav", type=int, default=0)
    x.add_argument("--danmaku", default=None)
    x.add_argument("--follow", action="store_true")
    x.add_argument("--interval", nargs=2, type=float, default=[1.5, 4.0])


def build_parser():
    p = argparse.ArgumentParser(description="B站互动执行器")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("whoami")
    sub.add_parser("login")          # 生成二维码（不写盘）
    lp = sub.add_parser("login-poll")  # 查扫码状态（key 由宿主传）
    lp.add_argument("--key", required=False, default="")
    sub.add_parser("logout")         # 删掉本插件的凭证

    s = sub.add_parser("search")
    s.add_argument("--keyword", required=True)
    s.add_argument("--order", default="click")
    s.add_argument("--limit", type=int, default=10)

    add_actions(sub.add_parser("act"))
    add_actions(sub.add_parser("info"))          # 动作参数只为结构统一，不会执行

    r = sub.add_parser("run")
    r.add_argument("--plan", required=True)
    r.add_argument("--gap", nargs=2, type=float, default=[3.0, 8.0])
    add_actions(r, need_bvid=False)              # 计划里没写时的默认动作

    c = sub.add_parser("comment")
    c.add_argument("--bvid", required=True)
    c.add_argument("--text", required=True)
    c.add_argument("--root", type=int, default=0)
    c.add_argument("--parent", type=int, default=0)

    rc = sub.add_parser("recall-danmaku")
    rc.add_argument("--bvid", required=True)
    rc.add_argument("--dmid", required=True)
    rc.add_argument("--cid", type=int, default=0)

    cm = sub.add_parser("comments")          # 读评论区（只读）
    cm.add_argument("--bvid", required=True)
    cm.add_argument("--order", default="time")
    cm.add_argument("--limit", type=int, default=20)

    un = sub.add_parser("uidname")           # UID → 昵称
    un.add_argument("--uid", required=True)

    dm = sub.add_parser("dm")                # 发私信
    dm.add_argument("--uid", required=True)
    dm.add_argument("--text", required=True)

    return p


CMDS = {
    "whoami": cmd_whoami,
    "login": cmd_login,
    "login-poll": cmd_login_poll,
    "logout": cmd_logout,
    "search": cmd_search,
    "act": cmd_act,
    "info": cmd_info,
    "run": cmd_run,
    "comment": cmd_comment,
    "comments": cmd_comments,
    "uidname": cmd_uidname,
    "dm": cmd_dm,
    "recall-danmaku": cmd_recall_danmaku,
}


def main():
    args = build_parser().parse_args()
    try:
        asyncio.run(CMDS[args.cmd](args))
    except SystemExit:
        raise
    except Exception as e:  # 兜底：绝不吐栈给上层
        fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
