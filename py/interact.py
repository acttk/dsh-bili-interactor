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
    python interact.py whoami
    python interact.py search --keyword 恐怖游戏 --order click --limit 10
    python interact.py info  --bvid BV1xxx
    python interact.py act   --bvid BV1xxx --like --coin 1 --danmaku "这波舒服"
    python interact.py run   --plan plan.json
    python interact.py comment --bvid BV1xxx --text "……" [--root N --parent N]

约定：
    · 结果一律打成 JSON 到 stdout：{"ok": bool, ...}
    · 失败不抛栈，返回 {"ok": false, "error": "...", "code": ...}
    · 凭证从 ~/.dsh/bili-duty/bili_credential.json 读（跟刷视频那个插件共用一套登录）
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


def out(obj):
    """统一出口：JSON + 刷新（被管道读时不至于卡住）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(msg, **extra):
    out({"ok": False, "error": str(msg), **extra})
    raise SystemExit(0)


def load_credential():
    """把 json 里的四个 cookie 拼成 bilibili_api 的 Credential。"""
    from bilibili_api import Credential

    if not CRED_FILE.exists():
        fail(f"没有凭证文件：{CRED_FILE}", hint="先用 dsh-bili-scroll 扫码登录一次")
    try:
        raw = json.loads(CRED_FILE.read_text(encoding="utf-8-sig"))
    except Exception as e:
        fail(f"凭证文件读不出来：{e}")

    sess = raw.get("sessdata") or raw.get("SESSDATA") or ""
    jct = raw.get("bili_jct") or raw.get("BILI_JCT") or ""
    buvid = raw.get("buvid3") or raw.get("BUVID3") or ""
    uid = raw.get("dedeuserid") or raw.get("DedeUserID") or raw.get("dedeUserID") or ""
    if not sess or not jct:
        fail("凭证里缺 SESSDATA 或 bili_jct", hint="重新扫码登录")
    return Credential(sessdata=sess, bili_jct=jct, buvid3=buvid, dedeuserid=str(uid) or None)


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


# ─────────────────────────── 子命令 ───────────────────────────

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

    async def step(kind, coro_factory):
        try:
            r = await coro_factory()
            if isinstance(r, dict) and r.get("code") == 0:
                done.append({"kind": kind, "ok": True})
                return r
            if isinstance(r, dict):
                failed.append({"kind": kind, "code": r.get("code"), "msg": r.get("message")})
            else:
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
        r = await step("danmaku", lambda: v.send_danmaku(danmaku=Danmaku(text=text)))
        if r and r.get("code") == 0:
            d = r.get("data") or {}
            for x in done:
                if x["kind"] == "danmaku":
                    x["text"] = text
                    x["dmid"] = d.get("dmid_str") or d.get("dmid")

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


async def cmd_comment(args):
    cred = load_credential()
    from bilibili_api import comment as comment_api

    v = video_obj(args.bvid, cred)
    try:
        oid = v.get_aid()
        if hasattr(oid, "__await__"):
            oid = await oid
    except Exception as e:
        fail(f"拿不到 aid：{e}")

    kwargs = {
        "text": args.text,
        "oid": int(oid),
        "type_": comment_api.CommentResourceType.VIDEO,
        "credential": cred,
    }
    if args.root:
        kwargs["root"] = int(args.root)
    if args.parent:
        kwargs["parent"] = int(args.parent)
    try:
        r = await comment_api.send_comment(**kwargs)
    except Exception as e:
        fail(f"发送失败：{e}")

    if r.get("code") == 0:
        d = r.get("data") or {}
        out({"ok": True, "rpid": d.get("rpid_str") or d.get("rpid"), "text": args.text})
    else:
        out({"ok": False, "code": r.get("code"), "error": r.get("message")})


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

    return p


CMDS = {
    "whoami": cmd_whoami,
    "search": cmd_search,
    "act": cmd_act,
    "info": cmd_info,
    "run": cmd_run,
    "comment": cmd_comment,
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
