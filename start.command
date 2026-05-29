#!/bin/zsh
# ダブルクリックで Ghost Liner ローカルサーバーを起動する
cd "$(dirname "$0")" || exit 1
echo "Ghost Liner local server を起動します..."
exec node server.js
