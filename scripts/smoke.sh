#!/usr/bin/env bash
# Integration smoke test for p2m-auto-formalization.
# Run from the source checkout: ./scripts/smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== 1. TypeScript bundle =="
bun build index.ts --target node --outfile /tmp/p2m-auto-formalization.js

echo "== 2. Selftest =="
bun run tests/selftest.ts

echo "== 3. Required files =="
required=(
  package.json
  index.ts
  store.ts
  ingest.ts
  plan.ts
  modes.ts
  prove2me.ts
  README.md
  modes/full.md
  modes/statements.md
  docs/WORKFLOW.md
  docs/SCHEMA.md
  docs/SUBAGENTS.md
  docs/PROVE2ME.md
  docs/MODES.md
  agents/captain.md
  agents/librarian.md
  agents/architect.md
  agents/statement-smith.md
  agents/auditor.md
  agents/prover.md
  agents/integrator.md
  books/sheaves-in-geometry-and-logic/book.json
  books/sheaves-in-geometry-and-logic/toc.json
  books/sheaves-in-geometry-and-logic/items.jsonl
  books/sheaves-in-geometry-and-logic/WORKFLOW.md
  books/sheaves-in-geometry-and-logic/MISSIONS.md
  books/sheaves-in-geometry-and-logic/EXERCISES.md
)
for f in "${required[@]}"; do
  if [ ! -s "$f" ]; then
    echo "missing or empty: $f" >&2
    exit 1
  fi
done
echo "ok: ${#required[@]} files"

echo "== 4. Book data =="
python3 - <<'PY'
import json, os, sys
root = os.getcwd()
book = json.load(open("books/sheaves-in-geometry-and-logic/book.json", encoding="utf-8"))
toc = json.load(open("books/sheaves-in-geometry-and-logic/toc.json", encoding="utf-8"))
items = [json.loads(l) for l in open("books/sheaves-in-geometry-and-logic/items.jsonl", encoding="utf-8") if l.strip()]
assert book["visibility"] == "public", book.get("visibility")
assert book["include_exercises"] is True
assert book["mode"] in ("full", "statements")
assert len(toc.get("chapters", toc if isinstance(toc, list) else [])) >= 10 or len(toc) >= 10
kinds = {}
for it in items:
    kinds[it["kind"]] = kinds.get(it["kind"], 0) + 1
    assert it["source"].startswith("/"), it["source"]
print(json.dumps({"book": book["slug"], "mode": book["mode"],
                  "toc_keys": list(toc)[:5], "items": len(items), "kinds": kinds}))
PY

echo "== 5. Deploy copy =="
if [ -d "$HOME/.opencode2/plugins/p2m-auto-formalization" ]; then
  test -s "$HOME/.opencode2/plugins/p2m-auto-formalization/index.ts"
  echo "ok: deployed"
else
  echo "not deployed yet"
fi

echo "SMOKE OK"
