#!/bin/sh
# Claude Code PostToolUse フック用ラッパー。
# Bash ツールで「main を push」したときだけ rename_ghost を同期する。
#
# 入力: フックの stdin JSON（{ tool_name, tool_input:{command}, tool_response }）
# 出力: 同期した/しなかったを systemMessage で通知（JSON）。
#
# 判定:
#   - コマンドが git push を含む
#   - かつ「origin main / main を明示」または「ブランチ未指定 push でカレントが main」

input=$(cat 2>/dev/null)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)

# git push 以外は無視
printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push' || exit 0

is_main_push=0
# main を明示している push
if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push[^|;&]*\bmain\b'; then
  is_main_push=1
else
  # ブランチ未指定の push（git push / git push origin）でカレントが main か
  if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push([[:space:]]+origin)?[[:space:]]*($|[|;&])'; then
    [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] && is_main_push=1
  fi
fi
[ "$is_main_push" = 1 ] || exit 0

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
LOG=/tmp/gl-rename-sync.log
if GL_SYNC_RENAME=1 sh "$ROOT/scripts/sync-rename-branch.sh" >"$LOG" 2>&1; then
  echo '{"systemMessage":"✅ rename_ghost を main から同期・push しました"}'
else
  echo '{"systemMessage":"⚠️ rename_ghost 同期に失敗（'"$LOG"' を確認）"}'
fi
exit 0
