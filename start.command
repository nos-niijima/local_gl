#!/bin/zsh
# ダブルクリックで local_gl ローカルサーバーを起動する
cd "$(dirname "$0")" || exit 1
echo "local_gl local server を起動します..."
exec node server.js
