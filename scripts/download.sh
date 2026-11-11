#!/usr/bin/env bash
# 由 .github/workflows/download.yml 呼叫。
# 也可在本機直接跑：
#   INPUT_URL='https://...' INPUT_MODE=video INPUT_QUALITY=1080 bash scripts/download.sh
set -euo pipefail

url="${INPUT_URL:?缺少 INPUT_URL}"
mode="${INPUT_MODE:-video}"
quality="${INPUT_QUALITY:-1080}"
subs="${INPUT_SUBS:-no}"
playlist="${INPUT_PLAYLIST:-no}"

if [[ ! "$url" =~ ^https?:// ]]; then
  echo "只接受 http/https 連結：$url" >&2
  exit 1
fi

# pip 的 bin 目錄不一定在 PATH 上，兩種呼叫方式都支援
if command -v yt-dlp >/dev/null 2>&1; then
  YTDLP=(yt-dlp)
elif python3 -c 'import yt_dlp' 2>/dev/null; then
  YTDLP=(python3 -m yt_dlp)
else
  echo "找不到 yt-dlp，請先 pip install yt-dlp" >&2
  exit 1
fi

mkdir -p out

args=(--no-warnings --newline --no-mtime
      --output "out/%(title).120s.%(ext)s")

if [[ "$playlist" == "yes" ]]; then
  args+=(--yes-playlist)
else
  args+=(--no-playlist)
fi

if [[ "$mode" == "audio" ]]; then
  args+=(-x --audio-format mp3 --audio-quality 0)
else
  if [[ "$quality" == "best" ]]; then
    args+=(-f "bv*+ba/b")
  else
    args+=(-f "bv*[height<=${quality}]+ba/b[height<=${quality}]/b")
  fi
  # 合併成單一 mp4，避免產出 .webm/.m4a 兩個檔
  args+=(--merge-output-format mp4)
fi

if [[ "$subs" == "yes" ]]; then
  args+=(--write-subs --sub-langs 'zh.*,en.*' --convert-subs srt)
fi

# 選用：repo secret YTDLP_COOKIES 放 Netscape 格式 cookies.txt，
# 用來下載需要登入的內容（例如私人播放清單、部分抖音/IG 連結）。
if [[ -n "${YTDLP_COOKIES:-}" ]]; then
  cookie_file="$(mktemp)"
  printf '%s\n' "$YTDLP_COOKIES" > "$cookie_file"
  chmod 600 "$cookie_file"
  args+=(--cookies "$cookie_file")
  echo "已套用 cookies"
fi

echo "→ ${YTDLP[*]} ${args[*]} \"$url\""
"${YTDLP[@]}" "${args[@]}" "$url"

echo
echo "產出檔案："
find out -type f -printf '  %P  (%s bytes)\n' | sort
