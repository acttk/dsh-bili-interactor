#!/usr/bin/env bash
# 装「本地转写」环境（Whisper）。装完插件才能把没字幕的视频读成文字。
#
# 用法：
#   bash scripts/setup-asr.sh          # 默认装 small 模型
#   bash scripts/setup-asr.sh medium   # 换更大的模型（更准更慢，约 1.5GB）
#
# 大约占 700MB~1.5GB：venv 约 300MB + 模型 75MB(tiny) / 250MB(base) / 500MB(small) / 1.5GB(medium)
set -euo pipefail

MODEL="${1:-small}"
HOME_DIR="${BILI_INTERACTOR_HOME:-$HOME/.dsh/bili-interactor}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "插件家目录: $HOME_DIR"
echo "仓库目录  : $REPO_DIR"
echo "Whisper 模型: $MODEL"
echo

mkdir -p "$HOME_DIR"

if [ ! -d "$HOME_DIR/.venv-asr" ]; then
  echo "[1/3] 建虚拟环境…"
  python3 -m venv "$HOME_DIR/.venv-asr"
else
  echo "[1/3] 虚拟环境已存在，跳过"
fi

PY="$HOME_DIR/.venv-asr/bin/python"

echo "[2/3] 装依赖（faster-whisper + yt-dlp）…"
"$PY" -m pip install --upgrade pip -q
"$PY" -m pip install -q faster-whisper yt-dlp

echo "[3/3] 预热模型（第一次会下载，走 hf-mirror 国内镜像）…"
HF_ENDPOINT=https://hf-mirror.com \
HF_HOME="$REPO_DIR/py/.hf-cache" \
HF_HUB_DISABLE_XET=1 \
"$PY" - <<PYEOF
from faster_whisper import WhisperModel
WhisperModel("$MODEL", device="cpu", compute_type="int8")
print("模型就绪: $MODEL")
PYEOF

echo
echo "装好了。去插件设置里打开「没字幕就本地转写」。"
echo "试一下："
echo "  $PY $REPO_DIR/py/asr.py BV1x2Jq6NEbT"
