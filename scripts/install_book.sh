#!/usr/bin/env bash
# Install the bundled Sheaves book workspace into the live books directory.
#
# The plugin repo keeps the canonical seed (book.json, parser, TOC, items,
# WORKFLOW.md, chapter logs). The live copy is where af_record appends; it lives
# outside the plugin checkout so a redeploy never destroys the workflow record.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/books/sheaves-in-geometry-and-logic"
DST_ROOT="${BOOKS_DIR:-./books}"
DST="$DST_ROOT/sheaves-in-geometry-and-logic"

if [ -d "$DST" ]; then
  echo "book workspace already installed: $DST"
  echo "use --force to replace it (the existing WORKFLOW.md will be backed up)"
  if [ "${1:-}" != "--force" ]; then
    exit 0
  fi
  mv "$DST/WORKFLOW.md" "$DST/WORKFLOW.md.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  rm -rf "$DST"
fi

mkdir -p "$DST_ROOT"
cp -a "$SRC" "$DST"
echo "installed: $DST"
echo "next: set the plugin option booksDir to $DST_ROOT, then call af_plan"
