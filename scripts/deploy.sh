#!/usr/bin/env bash
# Deploy the plugin from its source checkout to the running OpenCode plugin dir.
#
# Source:  ./plugin/p2m-auto-formalization
# Deploy:  ~/.opencode2/plugins/p2m-auto-formalization
#
# The deploy copy has its own git repo so "what is actually running" is
# recoverable. Source edits are never made in the deploy copy.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${HOME}/.opencode2/plugins/p2m-auto-formalization"

mkdir -p "$DST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'books/*/exports' \
    --exclude 'state' \
    --exclude 'node_modules' \
    "$SRC/" "$DST/"
else
  # Fallback: copy everything except the deploy repo's own .git.
  find "$DST" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
  cp -a "$SRC/." "$DST/"
  rm -rf "$DST/.git"
fi

cd "$DST"
if [ ! -d .git ]; then
  git init -q
fi
git add -A
if git diff --cached --quiet; then
  echo "deploy: no changes"
else
  git -c user.name='opencode' -c user.email='opencode@local' \
    commit -q -m "chore(deploy): p2m-auto-formalization $(date -Iseconds)"
  echo "deploy: committed $(git rev-parse --short HEAD)"
fi
echo "deploy: $DST"
