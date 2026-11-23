# Workflow — from Markdown book to public missions

This is the operator's view of the nine `af_*` tools. It intentionally contains
no shell commands that touch the network: the plugin never submits anything.

## 1. Bootstrap

```text
af_init({
  slug: "sheaves-in-geometry-and-logic",
  title: "Sheaves in Geometry and Logic",
  authors: ["Saunders Mac Lane", "Ieke Moerdijk"],
  source_paths: ["/abs/part001.md", "/abs/part002.md"],
  mode: "statements",             // or "full"
  lean_project: "~/topos-book",
  include_exercises: true
})
```

`af_init` creates `books/<slug>/` and, when the Lean project exists, the
`Definitions/`, `Theorems/`, `Exercises/` and `Solutions/` directories inside it.

Re-running `af_init` on an existing slug updates `book.json` without touching
`toc.json`, `items.jsonl`, `plan.json` or `state/`. That is how a book is
switched between `full` and `statements`: re-init with the new mode, then
`af_plan`. Statuses reset when a card's effective mode changes.

Rejected at init: any mode other than `full`/`statements`, any visibility other
than `public`, `include_exercises: false`, a missing source path.

## 2. Ingest

```text
af_ingest({ slug })
```

One pass over `source_paths` (or an explicit `part_files` list). Writes
`toc.json` and rewrites `items.jsonl` atomically. The part files overlap
(`part002` restarts at `III.8`, `part003` at `VI.6`), so the parser dedupes by
`(chapter, section, kind, ordinal-within-section)`:

- first occurrence wins for the statement and the source line;
- a non-empty proof from a later occurrence is merged into the kept item;
- the counter is reset per part, which is what makes the overlapping restart
  line up with the first occurrence.

Part boundaries must therefore restart at a chapter heading (the scanner's
actual layout). A part that starts mid-chapter with no chapter heading lands its
items in chapter `0` ("Front matter").

## 3. Plan

```text
af_plan({ slug })
```

Produces `plan.json`:

- one chapter mission, `MLM <chapter> — <chapter title>`, `visibility: "public"`;
- one milestone per section plus `<chapter>.Exercises`;
- one card per item;
- `depends_on: []` by default.

The architect may edit `plan.json` between plans:

- `chapter.depends_on: ["III"]` serialises chapter missions; `af_next` only emits
  `integrate` for a chapter whose dependencies are `published`;
- `card.depends_on: ["IV.1.Def.1"]` blocks the `state` task until the definition
  is audited; between two theorem-like cards it also creates a proof DAG
  (`children` is derived, do not edit it).

`af_plan` re-reads the previous plan and preserves statuses/readbacks/dependencies
when the book mode and the card's effective mode did not change. A mode change
resets card statuses on purpose: `proved` is meaningless in `statements` mode and
`skipped` is meaningless in `full` mode.

## 4. Dispatch

```text
af_next({ slug, role? })
```

Returns one task or `{ok: true, task: null, reason}`. Selection order is fixed:

| # | Task kind | Eligible card | Mode |
|---|---|---|---|
| 1 | `define` | definition, `status: "draft"` | both |
| 2 | `state` | theorem-like, `status: "planned"`, definition deps audited | both |
| 3 | `audit` | theorem-like, `status: "stated"`, no readback | both |
| 4 | `sketch` | theorem-like, audited statement, has children | `full` |
| 5 | `prove` | theorem-like, audited statement, all children proved | `full` |
| 6 | `integrate` | every card in the chapter done, chapter deps published | both |

The `next` output contains the task and a ready-to-send dispatch payload:

```json
{
  "ok": true,
  "task": {
    "id": "IV.1.Thm.1.prove.r0",
    "item_id": "IV.1.Thm.1",
    "kind": "prove",
    "role": "prover",
    "mode": "full",
    "file": "Solutions/Thm_IV_1_....lean",
    "source": "/abs/part001.md:399",
    "depends_on": []
  },
  "dispatch": { "to": "children", "mode": "queue", "text": "## af task ..." }
}
```

Claims are atomic: `state/claims/<task_id>.lock` is created with `O_EXCL`
(`flag: "wx"`). If the file exists, the task is skipped. A failed `af_check`
increments the item's attempt counter in `state/progress.json`, which produces a
new round (`...prove.r1`) and therefore a new claim file; a crashed worker is
recovered the same way.

`task_id` shape: `<item_id>.<kind>.r<round>` (for integration:
`<chapter>.integrate.r<round>`).

`role` filters the queue:
`architect` (define), `statement-smith` (state), `auditor` (audit),
`prover` (sketch/prove), `integrator` (integrate).

## 5. Verify

```text
af_check({ slug, item_id, file? })
```

Runs `lake env lean <file>` with `cwd = book.json.lean_project` and a 600 s
timeout. The file is resolved against the project and may not escape it.

Text checks happen before the compiler:

- `sorry` count (`sorry` outside comments);
- `axiom`, `native_decide`, `unsafe` → `AXIOM`;
- `admit` → `SORRY`;
- self-import `import Theorems.<lean_name>` → `MODE_VIOLATION`;
- leftover `af:placeholder` or a missing declaration → `TYPE_MISMATCH`.

Mode policy:

| File | Mode | `sorry` rule | Success code |
|---|---|---|---|
| `Definitions/...` | both | zero | `OK_PROOF` |
| `Theorems/...`, `Exercises/...` | `statements` | exactly one, no `Solutions/` file | `OK_STATEMENT` |
| `Theorems/...`, `Exercises/...` | `full` | at most one | `OK_STATEMENT` |
| `Solutions/...` | `full` | zero | `OK_PROOF` |
| `Solutions/...` | `statements` | never allowed | `MODE_VIOLATION` |

Successful checks transition the card: definition → `audited`, statement →
`stated`, proof → `proved`. Failed checks only increment the attempt counter.

The compiler is only invoked when the text/mode checks pass; a file that already
fails a hard rule is rejected without spending a 600 s compile.

## 6. Audit and record

```text
af_record({ slug, kind: "audit", item_id: "IV.1.Thm.1", text: "<readback>" })
```

Writes an ISO-timestamped block to:

- `books/<slug>/WORKFLOW.md`;
- `books/<slug>/chapters/<chapter>/WORKFLOW.md`;
- `books/<slug>/state/workflow.jsonl`.

`kind` is one of `decision | audit | mission | blocker | handoff | note`.
`kind="audit"` with an item id also stores the text as the card's `readback`.
`kind="mission"` with a chapter marks the chapter `published`.

## 7. Integrate

```text
af_mission({ slug, chapter: "IV" })
```

Builds, but never submits:

- `missions/IV/proposal.json` — public mission proposal;
- `missions/IV/mission.md` — human-readable summary (contains the
  "statement-only" notice in statements mode);
- `missions/IV/submit.sh` — curl commands for
  `POST /api/v1/mission-proposals`, `/items`, `/milestones`.

`af_mission` refuses a book whose `visibility !== "public"`. Every mission and
every proposal carries `"visibility": "public"`. The submit script re-checks the
proposal's visibility before its first POST.

`af_mission` moves the chapter to `integrating`; it does **not** mean the
mission was launched. After the human runs `submit.sh` and clicks **Submit
Proposal**, call `af_record({kind:"mission", chapter})` to move it to
`published`. A proposal with any `local_items[].placeholder` or any empty
`readback` is a draft: `submit.sh` refuses to post it.

## 8. Export

```text
af_export({ slug, item_id: "IV.1.Thm.1" })
```

Writes `exports/<item_id>/`:

- `full`: `solution.lean` with a top-level `theorem solution`, plus `meta.json`
  (`proof_type: "prove"`), `explanation.md`, `curl.sh` for `/api/v1/verify`.
- `statements`: `statement.lean` with exactly one `sorry`, `meta.json`
  (`proof_type: "statement-only"`, `submission: "not-applicable"`),
  `explanation.md`, and a `curl.sh` that explains `/verify` is not applicable.

The exporter refuses `sorry`, `axiom`, `native_decide`, `unsafe` or a leftover
placeholder in a mode-1 proof.

## 9. Status and triage

```text
af_status({ slug })
```

Returns counts by status and chapter, chapter/mission counts, the DAG frontier and
warnings. Warning codes:

| Code | Meaning | Fix |
|---|---|---|
| `NON_PUBLIC_BOOK` | `book.json` visibility is not public | re-init with `visibility: "public"` |
| `NON_PUBLIC_MISSION` | plan chapter visibility is not public | `af_plan` rebuilds it public |
| `MISSING_READBACK` | `stated` theorem without readback | `af_record(kind="audit")` |
| `MODE_SOLUTIONS_PRESENT` | `Solutions/` file in a statements chapter | delete it; never create one |
| `SORRY_IN_SOLUTIONS` | mode-1 proof still has `sorry` | finish the proof |
| `MODE_TASK_MISMATCH` | plan proof state contradicts the effective mode | `af_plan` |
| `UNKNOWN_DEPENDENCY` | `depends_on` points at a missing id | fix `plan.json` |
| `DUPLICATE_LEAN_NAME` | two cards share a declaration name | re-ingest / rename |
| `PLAN_MODE_MISMATCH` | plan was built under another book mode | `af_plan` |
| `NOT_PLANNED` | `plan.json` missing | `af_plan` |
| `LEAN_PROJECT_MISSING` | project path missing | fix `book.json` |

The `frontier` is the set of unpublished chapters whose `depends_on` chapters are
all `published`; those are the chapters ready for `af_mission`.

## Resume and handoff

- Claims are durable files, not session state.
- `state/progress.json` records attempts and the last code per item.
- `state/workflow.jsonl` is the append-only event log; `WORKFLOW.md` is the
  human-readable mirror.
- A sub-agent that dies mid-task leaves its claim and its partial file. The next
  check of that item either passes (advancing the card) or fails and increments
  the round, which makes the task dispatchable again.
