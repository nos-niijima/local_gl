#!/bin/sh
# sync-rename-branch.sh
# main(正式名称版) の最新コミットから rename_ghost(名称変更版) を再生成し、
# rename を適用して force push する。pre-push フックから呼ばれる想定。
#
# 設計:
#   - main を source of truth とし、rename_ghost は「main + rename適用 を1コミット」した派生ブランチ。
#   - 毎回 main から作り直すため drift しない（rename_ghost は常に最新 main の名称変更版）。
#   - 一時 worktree で生成するので、作業ツリーには一切触れない。
set -e

SRC_BRANCH=main
DERIVED=rename_ghost
TARGET_FILES="public/index.html"   # rename を適用するファイル

ROOT=$(git rev-parse --show-toplevel)

git show-ref --verify --quiet "refs/heads/$SRC_BRANCH" || { echo "[sync] no local $SRC_BRANCH branch; skip"; exit 0; }
MAIN_SHA=$(git rev-parse --short "$SRC_BRANCH")

WT=$(mktemp -d 2>/dev/null || mktemp -d -t glsync)
cleanup() { cd "$ROOT" 2>/dev/null || true; git worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "[sync] regenerating $DERIVED from $SRC_BRANCH ($MAIN_SHA)"
git worktree add --quiet --force --detach "$WT" "$SRC_BRANCH"
cd "$WT"
git switch -C "$DERIVED" >/dev/null 2>&1

# 名称変更を適用
node scripts/apply-rename.js $TARGET_FILES

git add -A
if git diff --cached --quiet; then
  echo "[sync] no rename diff"
else
  git commit --quiet --no-verify -m "sync: rename_ghost from $SRC_BRANCH ($MAIN_SHA) [auto]"
fi

# 派生ブランチを force push（再帰は GL_SYNC_RENAME と remote_ref 判定で回避）
GL_SYNC_RENAME=1 git push --force --quiet origin "$DERIVED"
echo "[sync] pushed origin/$DERIVED"
