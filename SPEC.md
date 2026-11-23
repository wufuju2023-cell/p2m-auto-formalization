# p2m-auto-formalization — implementation contract

Status: draft for parallel implementation. This file is the single source of truth for
tool names, file layout, schemas, and mode rules. Do not invent extra state files.

## Goal

Turn a math book or paper into **public Prove2Me missions** with a DAG of atomized
definitions / statements / proofs, driven by sub-agents. Two modes:

| Mode | Definitions | Theorems / lemmas / exercises | Proof tasks |
|---|---|---|---|
| `full` | yes | Lean statements | yes, until `sorry`-free |
| `statements` | yes | Lean statements ending in `by sorry` | **never emitted** |

`statements` is deliberately "statement-complete, proof-open": it publishes public
missions whose cards are open problems. It must never create or require a file under
`Solutions/` for a theorem-like item.

Hard requirements from the user:

1. Two modes exactly as above.
2. A per-book workflow record space (`books/<slug>/WORKFLOW.md` plus per-chapter logs).
3. **Every mission is public** (`"visibility": "public"`); reject `"private"`.
4. **All material is in scope, including exercises** (`include_exercises: true` by default).

## Plugin shape

- OpenCode V2 plugin, TypeScript, no runtime dependencies, no network calls.
- Entry: `index.ts`, `export default Plugin.define({ id: "p2m-auto-formalization", ... })`.
- Namespace: `af`.
- Every tool returns a compact JSON string; errors are
  `{"ok":false,"code":"...","error":"..."}`.
- Compile with `lake env lean` only when `af_check` is called; everything else is file I/O.

Reference implementation for style: `../prove2me-agent/index.ts` and `../prove2me-agent/store.ts`.
Do not import from it; keep this plugin self-contained.

## Tools

### `af_init`

Input:
```json
{
  "slug": "sheaves-in-geometry-and-logic",
  "title": "Sheaves in Geometry and Logic",
  "authors": ["Saunders Mac Lane", "Ieke Moerdijk"],
  "source_paths": ["/abs/part001.md", "..."],
  "mode": "full" | "statements",
  "mission_type": "Textbook",
  "namespace": "MacLaneMoerdijk",
  "lean_project": "~/topos-book",
  "include_exercises": true
}
```
Output: `{ok, slug, root, mode, visibility:"public", include_exercises:true}`.

Creates `books/<slug>/` with `book.json`, `toc.json`, `items.jsonl`, `plan.json`,
`WORKFLOW.md`, `state/`, `missions/`, `chapters/`, `exports/`.
Rejects unknown mode, missing sources, `visibility:"private"`, `include_exercises:false`.

### `af_ingest`

Input: `{slug, part_files?: string[], include_exercises?: boolean}`
Output: `{ok, chapters, sections, items, exercises, toc_path, items_path}`.

Parses Markdown:
- chapter heading: `^# ([IVX]+)\s+(.+)$`
- section heading: `^# (\d+)\.\s+(.+)$`
- exercise heading: `^#{1,2}\s+Exercises?\s*$`
- item starts: lines beginning with `Definition`, `Theorem`, `Lemma`, `Proposition`,
  `Corollary`, `Example`, `Remark`, optionally prefixed by `**`.
- part boundaries overlap (part002 restarts at III.8; part003 at VI.6): dedupe by
  `(chapter, section, kind, ordinal-within-section)`, keep the first occurrence and merge
  a non-empty `proof_md` from the later occurrence.

Writes `toc.json` and `items.jsonl`. `items.jsonl` is append-free: rewrite atomically.

### `af_plan`

Input: `{slug}`
Output: `{ok, chapters, missions, cards, mode}`.

Builds `plan.json`:
- one mission per chapter;
- one milestone per section, plus one `Exercises` milestone per chapter when exercises exist;
- one card per item;
- `visibility:"public"` on every mission;
- `depends_on` defaults to `[]` and is editable by the architect;
- mode2 marks theorem-like cards `proof: "skipped"` and `status:"planned"`;
- mode1 marks theorem-like cards `proof:"pending"`.

### `af_next`

Input: `{slug, role?: string}`
Output:
```json
{"ok":true,"task":{"id":"...","item_id":"...","kind":"define|state|audit|sketch|prove|integrate",
 "role":"architect|statement-smith|auditor|prover|integrator","mode":"full|statements",
 "file":"Definitions/...","source":"...:123","depends_on":[]},
 "dispatch":{"to":"children","mode":"queue","text":"..."}}
```
or `{ok:true, task:null, reason:"..."}`.

Atomic claim: create `state/claims/<task_id>.lock` with `wx`; if it exists, skip.
Task selection order:
1. `define` for definitions with `status:"draft"`;
2. `state` for theorem-like cards whose definition dependencies are `audited` or `stated`;
3. `audit` for `stated` cards without `readback`;
4. `sketch` (full mode only) for audited cards with children;
5. `prove` (full mode only) for leaves whose children are proved;
6. `integrate` when all chapter cards are proved (full) or stated+audited (statements).

Mode2 must never return `sketch` or `prove`.

### `af_check`

Input: `{slug, item_id, file?: string}`
Output:
```json
{"ok":true,"code":"OK_STATEMENT|OK_PROOF|SORRY|AXIOM|MODE_VIOLATION|COMPILE_ERROR|TYPE_MISMATCH",
 "sorry_count":0,"errors":[],"file":"...","mode":"..."}
```
Runs `lake env lean <file>` in `book.lean_project` (timeout 600s, cwd = project).
Checks the file text before compiling:
- `sorry` count;
- forbidden `axiom`, `native_decide`, `unsafe`;
- self-import `import Theorems.Thm_<item slug>`.
Mode rules:
- `statements` + theorem-like: require exactly one `sorry`, no `Solutions/` file.
- `full` + `prove`: require zero `sorry`.
- Definitions: zero `sorry`.
Do not edit the file.

### `af_record`

Input: `{slug, kind:"decision|audit|mission|blocker|handoff|note", text, item_id?, chapter?}`
Appends to `books/<slug>/WORKFLOW.md` and `books/<slug>/chapters/<chapter>/WORKFLOW.md`
with an ISO timestamp, and to `state/workflow.jsonl`.

### `af_status`

Input: `{slug}`
Output: counts by status and chapter, mode, public mission count, DAG frontier,
warnings:
- any mission with `visibility != "public"`;
- theorem-like `stated` without `readback`;
- mode2 book with a `Solutions/` file for a theorem-like item;
- mode1 book with `sorry` in `Solutions/`.

### `af_mission`

Input: `{slug, chapter}`
Output: `{ok, proposal_path, mission_md, submit_sh, visibility:"public"}`.

Builds `missions/<chapter>/proposal.json` in the Prove2Me mission-proposal shape:
- `name`, `pitch`, `description`, `visibility:"public"`, `main_item_id`;
- `items`: definitions first, then theorem-like cards; each item carries `kind`,
  `definition_name|theorem_name`, `preamble`, `formal_statement`, `natural_language_statement`,
  `source`, `readback`;
- `milestones`: one per section + exercises;
- `item_order`: dependency order.

Also writes `mission.md` (human-readable) and `submit.sh` (curl commands for
`POST /api/v1/mission-proposals`, `/items`, `/milestones`). **Never execute them.**
`submit.sh` refuses to post while any `local_items[].placeholder` is true or any
item has an empty `readback`.

### `af_export`

Input: `{slug, item_id}`
Output: `{ok, dir, files:["solution.lean"|"statement.lean","meta.json","explanation.md","curl.sh"]}`.

- mode1: export the proof as `solution.lean` with `theorem solution`.
- mode2: export `statement.lean` containing the `by sorry` statement; `meta.json` has
  `"proof_type":"statement-only"` and `curl.sh` explains that `/verify` is not applicable.

## File layout

```
books/<slug>/
  book.json
  toc.json
  items.jsonl
  plan.json
  WORKFLOW.md
  state/
    progress.json
    workflow.jsonl
    claims/<task_id>.lock
  missions/<chapter>/{proposal.json,mission.md,submit.sh}
  chapters/<chapter>/WORKFLOW.md
  exports/<item_id>/{...}
```

Derived, role-owned files (allowed; they are not core state): `state/defs.lock`,
`chapters/<chapter>/audit/<item_id>/fidelity.md`, `ci/chapter_<id>.sh`,
`$LEAN_PROJECT/Book/Chapter<id>.lean` and `$LEAN_PROJECT/Book/axioms/*.lean`.
`field_ids` is not stored by the plugin: the human adds at least one platform
field in the proposal UI before Submit (the create endpoint accepts an empty
list, but the platform requires a field before launch).

`book.json`:
```json
{
  "slug": "...",
  "title": "...",
  "authors": ["..."],
  "mode": "full|statements",
  "chapter_modes": {"IV":"full"},
  "mission_type": "Textbook|ResearchPaper|OpenProblem",
  "namespace": "MacLaneMoerdijk",
  "visibility": "public",
  "materials": "all",
  "include_exercises": true,
  "source_paths": ["..."],
  "lean_project": "/abs/path",
  "toolchain": "leanprover/lean4:v4.33.1",
  "mathlib_rev": "0df444a360eaa60ab8c11dca51a86af692955474",
  "created_at": "...",
  "updated_at": "..."
}
```

`items.jsonl` record:
```json
{"id":"IV.1.Def.1","chapter":"IV","chapter_title":"...","section":"1","section_title":"...",
 "kind":"definition","label":"Definition","source":"/abs.md:399","statement_md":"...",
 "proof_md":"","depends_on":[],"lean_name":"Def_IV_1_ElementaryTopos",
 "lean_file":"Definitions/Def_IV_1_ElementaryTopos.lean","status":"draft",
 "mode":"statements","reuse":"?","readback":null,"readback_model":null,"notes":""}
```

`plan.json`:
```json
{"slug":"...","mode":"...","chapters":[{"id":"IV","title":"...","mission":"MLM IV — ...",
 "visibility":"public","milestones":[{"id":"IV.1","title":"...","items":["..."]}],
 "cards":["..."],"depends_on":["III"],"status":"planned"}]}
```

## Mode rules (normative)

`full`:
- `af_next` may emit `sketch` and `prove`.
- A theorem-like card is done only when `status:"proved"`, `sorry_count:0`, no new axiom.
- `af_status` fails if any `Solutions/` file contains `sorry`.

`statements`:
- `af_next` never emits `sketch` or `prove`.
- A theorem-like card is done when `status:"stated"`, `readback` exists, and the file
  compiles with exactly one `sorry`.
- `af_status` fails if a theorem-like `Solutions/` file exists.
- Public missions are expected to contain open goals; `mission.md` must say
  "statement-only: proofs intentionally left open (sorry)".

## Public mission rule

`af_init` and `af_mission` reject `visibility != "public"`.
`af_status` warns on any non-public mission. `submit.sh` always passes
`"visibility":"public"`.

## Exercises

`include_exercises` defaults to `true` and cannot be false at `af_init`.
Each chapter gets an `Exercises` milestone. Exercise cards use `Ex_<chapter>_<section>_<n>`
names. In mode2 they are `by sorry`; in mode1 they are proof tasks like theorems.
Exercise statements are included in the mission proposal and count toward progress.

## Testing

`tests/selftest.ts` drives the storage/planning layer without OpenCode:
1. init a temp book with 2 chapters, one exercise section;
2. ingest a small synthetic Markdown;
3. plan in `statements` mode;
4. assert no `prove` tasks, exactly one `sorry` per theorem card;
5. plan in `full` mode;
6. assert `prove` tasks appear for leaves;
7. assert a private mission is rejected;
8. assert exercises are included.

Run `bun test` or `bun run tests/selftest.ts`. `bun build index.ts --target node`
must succeed.
