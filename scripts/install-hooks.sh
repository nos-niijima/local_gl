#!/bin/sh
# install-hooks.sh — リポジトリ内の hooks/ を .git/hooks/ へインストールする。
# クローン後やフック更新時に一度実行してください:  sh scripts/install-hooks.sh
set -e
ROOT=$(git rev-parse --show-toplevel)
HOOK_DIR="$ROOT/.git/hooks"
SRC="$ROOT/hooks"

for h in "$SRC"/*; do
  [ -f "$h" ] || continue
  name=$(basename "$h")
  cp "$h" "$HOOK_DIR/$name"
  chmod +x "$HOOK_DIR/$name"
  echo "[install-hooks] installed $name -> .git/hooks/$name"
done
echo "[install-hooks] done"
