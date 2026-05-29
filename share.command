#!/bin/zsh
# ダブルクリックで「サーバー起動 + Cloudflareトンネル公開」を一括実行する。
# 共有Wi-Fi(端末分離)や外出先でも、出てきた https://〇〇.trycloudflare.com を
# スマホで開けば全員で同期して遊べる。終了は Ctrl+C。
cd "$(dirname "$0")" || exit 1
PORT=${PORT:-8765}

command -v cloudflared >/dev/null 2>&1 || { echo "cloudflared が未インストールです。 brew install cloudflared を実行してください。"; exit 1; }

LOG=$(mktemp)
node server.js & SERVER_PID=$!
caffeinate -dimsu & CAF_PID=$!     # 起動中はMacをスリープさせない
cloudflared tunnel --url "http://localhost:${PORT}" --no-autoupdate > "$LOG" 2>&1 & CF_PID=$!

cleanup() { kill $SERVER_PID $CAF_PID $CF_PID 2>/dev/null; rm -f "$LOG"; echo "\n停止しました。"; }
trap cleanup EXIT INT TERM

echo "トンネルを準備中..."
URL=""
for i in {1..30}; do
  URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

echo ""
echo "============================================================"
if [ -n "$URL" ]; then
  echo "  スマホでこのURLを開いてください（同じWi-Fiでなくても可）:"
  echo ""
  echo "      $URL"
  echo ""
  echo "  ・全員が同じ room 番号を開くと同期します"
  echo "  ・このURLは起動するたびに変わります"
else
  echo "  URL の取得に失敗しました。ログ: $LOG"
fi
echo "  終了するには Ctrl+C"
echo "============================================================"

wait $CF_PID
