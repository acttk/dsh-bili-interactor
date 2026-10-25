#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""asr.py —— 把一条 B站 视频的语音转成文字。

给「没有字幕、但又想知道视频在说什么」的情况用。这是插件能真正理解
视频内容的最后一层：B站 的字幕接口对大多数视频返回空，只能自己转。

用法（在转写环境里跑，见 README 的「转写环境」）：
    .venv-asr/Scripts/python.exe py/asr.py BV1xxxxxxxxx
    .venv-asr/bin/python       py/asr.py https://www.bilibili.com/video/BV1xx
    .venv-asr/Scripts/python.exe py/asr.py D:\\clip.mp4 -o out.txt
    --model tiny|base|small|medium（默认 small，越大越准越慢）

几个踩过的坑，写在这儿省得再踩一遍：
  ① 模型走国内镜像：HuggingFace 直连拉不动，HF_ENDPOINT 要指到 hf-mirror.com，
     而且必须在 import faster_whisper **之前**设好。
  ② 缓存和临时目录都放脚本自己家：沙箱里子进程往往写不进 ~/.cache 和 %TEMP%。
  ③ 音频文件名必须按视频区分：写死 audio.m4a 的话，两轮同时跑会互相覆盖，
     转出来是另一个视频的内容。
  ④ yt-dlp 的进度条默认打到 stdout，会污染「输出非空 = 成功」的判断，要关掉。
"""
import argparse
import os
import re
import shutil
import sys
import tempfile

# Windows 上 Python 默认按 GBK 编解码标准输出，中文和 emoji 打进管道会炸
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_HERE = os.path.dirname(os.path.abspath(__file__))
_TMP = os.path.join(_HERE, "tmp", "asr")
try:
    os.makedirs(_TMP, exist_ok=True)
    tempfile.tempdir = _TMP
except Exception:
    pass

# 必须在 import faster_whisper 之前设好
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HOME", os.path.join(_HERE, ".hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def to_url(target: str) -> str:
    t = target.strip()
    if t.upper().startswith("BV") and len(t) <= 20:
        return "https://www.bilibili.com/video/" + t
    return t


def fetch_audio(url: str, tmp: str, tag: str) -> str:
    """用 yt-dlp 拉 bestaudio。B站 是 DASH 分离流，只要音频，不需要 ffmpeg 合并。"""
    from yt_dlp import YoutubeDL

    opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(tmp, tag + ".%(ext)s"),
        "paths": {"home": tmp, "temp": tmp},
        "cachedir": False,
        "nopart": True,      # 沙箱里「新建再改名」会被拒，直接落最终文件
        "noprogress": True,  # 别污染 stdout
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "http_headers": {
            "Referer": "https://www.bilibili.com",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        return ydl.prepare_filename(info)


def main() -> int:
    ap = argparse.ArgumentParser(description="把一条视频转成文字（默认中文）")
    ap.add_argument("target", help="BV 号 / B站链接 / 本地音视频文件")
    ap.add_argument("-o", "--out", help="写到这个文件（不给就打到标准输出）")
    ap.add_argument("--model", default=os.environ.get("BILI_ASR_MODEL", "small"),
                    help="Whisper 模型：tiny / base / small / medium（默认 small）")
    ap.add_argument("--lang", default="zh", help="语言（默认 zh；auto = 自动判断）")
    args = ap.parse_args()

    src = args.target
    tag = os.path.basename(src).rsplit(".", 1)[0] or "clip"
    tag = re.sub(r"[^0-9A-Za-z_-]", "_", tag)[:40] or "clip"

    audio = ""
    try:
        if src.lower().startswith("http") or src.upper().startswith("BV"):
            print("[asr] 下载音频…", file=sys.stderr)
            audio = fetch_audio(to_url(src), _TMP, tag)
            src = audio
        if not os.path.exists(src):
            print("[asr] 找不到文件：" + src, file=sys.stderr)
            return 2

        from faster_whisper import WhisperModel

        print("[asr] 加载模型 %s（第一次会下模型，之后本地读）…" % args.model, file=sys.stderr)
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        print("[asr] 转写中…", file=sys.stderr)
        segments, info = model.transcribe(
            src,
            language=None if args.lang == "auto" else args.lang,
            vad_filter=True,
            beam_size=1,
        )
        parts = []
        for seg in segments:
            t = (seg.text or "").strip()
            if t:
                parts.append(t)
        text = "".join(parts)

        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(text)
            print("[asr] 已写入 %s（%d 字）" % (args.out, len(text)), file=sys.stderr)
        else:
            sys.stdout.write(text)
            sys.stdout.write("\n")
        return 0
    finally:
        # 音频不留：转完就删，别在用户磁盘上堆视频
        try:
            if audio and os.path.exists(audio):
                os.remove(audio)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
