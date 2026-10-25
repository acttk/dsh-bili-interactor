# 装「本地转写」环境（Whisper）。装完插件才能把没字幕的视频读成文字。
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts/setup-asr.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/setup-asr.ps1 medium
#
# 大约占 700MB~1.5GB：venv 约 300MB + 模型 75MB(tiny) / 250MB(base) / 500MB(small) / 1.5GB(medium)
param(
    [string]$Model = "small"
)

$ErrorActionPreference = "Stop"

$HomeDir = if ($env:BILI_INTERACTOR_HOME) { $env:BILI_INTERACTOR_HOME } else { Join-Path $env:USERPROFILE ".dsh\bili-interactor" }
$RepoDir = Split-Path -Parent $PSScriptRoot

Write-Output "插件家目录: $HomeDir"
Write-Output "仓库目录  : $RepoDir"
Write-Output "Whisper 模型: $Model"
Write-Output ""

New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null

$Venv = Join-Path $HomeDir ".venv-asr"
$Py = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path $Py)) {
    Write-Output "[1/3] 建虚拟环境…"
    python -m venv $Venv
} else {
    Write-Output "[1/3] 虚拟环境已存在，跳过"
}

Write-Output "[2/3] 装依赖（faster-whisper + yt-dlp）…"
& $Py -m pip install --upgrade pip -q
& $Py -m pip install -q faster-whisper yt-dlp

Write-Output "[3/3] 预热模型（第一次会下载，走 hf-mirror 国内镜像）…"
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HOME = Join-Path $RepoDir "py\.hf-cache"
$env:HF_HUB_DISABLE_XET = "1"
& $Py -c "from faster_whisper import WhisperModel; WhisperModel('$Model', device='cpu', compute_type='int8'); print('模型就绪: $Model')"

Write-Output ""
Write-Output "装好了。去插件设置里打开「没字幕就本地转写」。"
Write-Output "试一下："
Write-Output "  & '$Py' '$RepoDir\py\asr.py' BV1x2Jq6NEbT"
