# Sub-agent organization for p2m-auto-formalization

This is the operational manual for running a book through the seven roles in
`agents/`. It covers who exists, what each loop does, how to dispatch, how many
agents may run at once, how to rerun a batch safely, and how `statements` mode
changes the org chart. Companion docs: `docs/WORKFLOW.md` (tool-by-tool) and
`docs/SCHEMA.md` (on-disk schema).

Role prompts are ready-to-paste system prompts:

| File | Role |
|---|---|
| `./plugin/p2m-auto-formalization/agents/captain.md` | chapter captain (orchestrator) |
| `.../agents/librarian.md` | ingest, anchors, dedupe, TOC, inventory |
| `.../agents/architect.md` | definitions, universes, notation, `defs.lock` |
| `.../agents/statement-smith.md` | `Theorems/Thm_*.lean` with `by sorry` |
| `.../agents/auditor.md` | blind read-back, `fidelity.md` |
| `.../agents/prover.md` | `Solutions/<lean_name>.lean`, `af_check`, `af_export` |
| `.../agents/integrator.md` | `Book/ChapterX.lean`, per-proof axiom audit, CI, mission status |

Two path variables are used throughout; define them once per session:

- `$BOOK` = the `root` field returned by `af_init` / `af_status`. In practice
  `.../books/<slug>/`, e.g.
  `./books/sheaves-in-geometry-and-logic/`
  for the deployed plugin, or
  `./plugin/p2m-auto-formalization/books/sheaves-in-geometry-and-logic/`
  for a source checkout run. It holds the book artifacts: `book.json`, `toc.json`,
  `items.jsonl`, `plan.json`, `WORKFLOW.md`, `state/`, `missions/`, `chapters/`, `exports/`.
- `$LEAN_PROJECT` = `book.json.lean_project`, e.g. `~/topos-book`. It holds the Lean
  artifacts: `Definitions/`, `Theorems/`, `Exercises/`, `Solutions/`. Every relative Lean
  path in `plan.json` and in an `af_next` task is relative to it, and every `af_check`
  runs `lake env lean <file>` with it as cwd (600 s timeout).

The book's Lean files live directly in the project, so `import Definitions.Def_...` and
`import Theorems.Thm_...` resolve by construction — that is the whole DAG. If `af_check`
reports a module-resolution error on a file that compiles by hand, the project's lakefile
does not expose that directory: an environment defect, not a statement defect. See the
troubleshooting table at the end.

## 1. Org chart

```
human
  │  self-audit + "Submit Proposal" (platform-side, human-only)
  │  approves mode switches, freeze breaks, decompositions
  ▼
root captain ── owns the book-level plan, the ingest, the single architect
  │
  ├── librarian            1 per book, runs once (before any Lean work)
  ├── architect            1 per book (definitions are book-scoped)
  │
  ├── chapter captain IV   ── one per chapter, owns mission + milestones + frontier
  │     ├── statement-smith ×1..N  (one item per file, atomic claims)
  │     ├── auditor        1 per batch of 10–20 items
  │     ├── prover ×2..4   (full mode only)
  │     └── integrator     1 per chapter (at the end)
  │
  └── chapter captain V    ── same shape, different chapter
```

Rules implied by the chart:

- The **root captain** is the session that ran `af_init`; it owns the book-level
  `WORKFLOW.md`, the `toc.json`/`plan.json` review, and the single architect.
- A **chapter captain** owns `missions/<chapter>/` and the chapter log, and may not
  freeze definitions, edit `plan.json`, or run `af_mission` for another chapter.
- The **architect is book-scoped** because a definition is book-scoped: chapter V
  must import chapter IV's `Def_*`, not restate it. Two architects on one book will
  duplicate concepts and produce two `defs.lock` writers.
- The **captain is the only role that dispatches**. Workers never spawn workers;
  a worker that needs another role reports a handoff line and stops.

## 2. The loops

Each loop is a cycle of *claim → work → check → record → hand off*. The tools are
the only state machine; no role keeps private notes outside `$BOOK`.

### 2.1 Ingest loop (librarian, once per book)

```
af_init ──▶ af_ingest ──▶ verify headings ──▶ verify anchors ──▶ verify dedupe
        ──▶ verify exercises ──▶ af_plan ──▶ af_record(note/blocker)
```

Exit condition: `af_status` reports the expected item total, `toc.json` matches the
source headings, zero duplicate keys, exercise counts match, `plan.json` has one
mission per chapter and one milestone per section plus `Exercises`.

### 2.2 Definition loop (architect, per chapter, before any statement)

```
af_next(role=architect) ──▶ read source + section preamble ──▶ search Mathlib locally
   ──▶ write Definitions/Def_*.lean ──▶ af_check (=OK_PROOF)
   ──▶ af_record(note: signature + imports)
   ──▶ auditor read-back ──▶ af_record(audit)
   ──▶ ... repeat ... ──▶ chapter review ──▶ write state/defs.lock
   ──▶ af_record(decision: "defs frozen")
```

Exit condition: `defs.lock` has an entry for every definition card of the chapter,
each file's sha matches its read-back, and the freeze decision is logged.

### 2.3 Statement loop (statement-smith, per item)

```
af_next(role=statement-smith) ──▶ read item + section preamble + defs.lock
   ──▶ write Theorems/Thm_*.lean (one declaration, `by sorry`)
   ──▶ af_check (=OK_STATEMENT, sorry_count=1)
   ──▶ af_record(note: exact type + imports; decision: added standing assumptions)
   ──▶ handoff to auditor
```

Exit condition: `OK_STATEMENT` for every card, including every `Ex_*` card.

### 2.4 Audit loop (auditor, per batch)

```
af_next(role=auditor) ──▶ read ONLY the Lean file + its Definitions imports
   ──▶ af_check (read-only probe) ──▶ write audit/<item_id>/fidelity.md
   ──▶ af_record(kind=audit, text=<"What the Lean asserts">)
   ──▶ handoff: audited / blocked per item
```

Exit condition: every `stated` card has a `fidelity.md` whose recorded sha matches
the current file, and a matching `kind:"audit"` record.

### 2.5 Proof loop (prover, full mode only, per item)

```
af_next(role=prover) ──▶ read target statement + children
   ──▶ write Solutions/<lean_name>.lean (theorem solution, exact binders)
   ──▶ af_check (=OK_PROOF, sorry_count=0)  [iterate ≤3 structurally different attempts]
   ──▶ af_export ──▶ af_record(note: EXPLANATION ..., code, tactics)
   ──▶ handoff
```

Exit condition: every leaf `proved` with `OK_PROOF`; every parent with children has an
accepted `sketch` importing exactly its children.

### 2.6 Integration loop (integrator, per chapter)

```
af_next(role=integrator) ──▶ topological order ──▶ Book/ChapterX.lean (imports only)
   ──▶ ci/chapter_X.sh + ci/chapter_X.log ──▶ per-proof axiom audit
   ──▶ (after af_mission) verify proposal.json checklist
   ──▶ af_record(mission: status table)
```

Exit condition: the bundle compiles, every leaf proof's axiom list is
`⊆ {propext, Classical.choice, Quot.sound}`, every sketch's list is `sorryAx` plus that
subset, the open-statement census equals the number of statement files in `statements`
mode, and the mission status table is recorded.

Why the audit is per proof and not per bundle: `Theorems/*.lean` ends in `by sorry` by
design (that is what is published), so `#print axioms` on `Book/ChapterX.lean` always
shows `sorryAx`. The bundle proves that the chapter's statements elaborate together; the
proofs are audited one file at a time in `Book/axioms/`.

## 3. Dispatching

`af_next` returns the payload to send, already written for the child:

```json
{"ok":true,
 "task":{"id":"IV.1.Thm.2.state.r1","item_id":"IV.1.Thm.2","kind":"state",
         "role":"statement-smith","mode":"full","file":"Theorems/Thm_IV_1_2.lean",
         "source":"/abs/part001.md:812","depends_on":["IV.1.Def.1"]},
 "dispatch":{"to":"children","mode":"queue","text":"..."}}
```

Send it verbatim, and add only the routing facts the child cannot infer:

```js
team_send({
  to: "children",
  mode: "queue",
  text: dispatch.text + "\n\n" + [
    "Book root: ./books/sheaves-in-geometry-and-logic",
    "Chapter: IV",
    "Role prompt: ./plugin/p2m-auto-formalization/agents/statement-smith.md",
    "Read the role prompt before your first tool call.",
    "Claim the task yourself with af_next({slug, role:\"statement-smith\"}); do not accept pushed files."
  ].join("\n")
})
```

Route by `task.kind`, not by `task.role` — `kind` is the contract, `role` is advisory:

| `task.kind` | role prompt |
|---|---|
| `define` | `agents/architect.md` |
| `state` | `agents/statement-smith.md` |
| `audit` | `agents/auditor.md` |
| `sketch`, `prove` | `agents/prover.md` |
| `integrate` | `agents/integrator.md` |

If the `role` in the task disagrees with the table, send the task to the table's role and
record a `kind:"note"` about the mismatch. A sketch is a proof (a reduction over the
children), so it goes to a prover, never to the architect.

Rules:

1. **Never paste file contents into the dispatch.** The child must claim the task so
   the claim lock exists; a pushed file has no lock and two children can write it.
2. **`mode:"queue"`** is the default: the child finishes its current turn, then starts.
   Use `mode:"steer"` only to change direction mid-run (e.g. a prover editing a
   statement), and `team_interrupt` to stop a run that is already wrong.
3. **One task per message.** Two tasks in one message means the second is never
   claimed and silently forgotten.
4. **Never forward a previous audit, its verdict, or the item's informal statement to an
   auditor.** Auditors get a clean dispatch; see `agents/auditor.md` on contaminated
   dispatches.
5. When the human must act (approve a freeze break, accept a statement that no honest
   encoding can express, run `submit.sh`), use `team_send({to:"parent"})`, not
   `team_space_post`.

### Shared space vs direct messages

`team_space_post` is for facts the whole tree should see but nobody must act on now:

```
team_space_post({topic:"defs", text:"[freeze] IV frozen: 2 definitions, lock sha 3f9c…; chapter V may import Definitions.Def_IV_* from now on"})
team_space_post({topic:"mathlib", text:"[gap] Mathlib 0df444a has no `IsLocallySmall` for large sites; two chapters hit this. Do not reprove it inline — request a definition item."})
team_space_post({topic:"frontier", text:"[status] IV: 18/29 proved, 4 in flight (prover p1/p2), 7 unclaimed"})
```

`team_send` is for "you must act now": a task dispatch, a blocker that changes another
agent's next step, a stop, a handoff to the human. If the recipient can read it
tomorrow, it belongs in the space.

## 4. Concurrency

| Role | Max concurrent | Why |
|---|---|---|
| librarian | 1 per book | `af_ingest` rewrites `items.jsonl`; two writers lose data |
| chapter captain | 1 per chapter | two captains race `WORKFLOW.md`, claims, and `af_mission` |
| architect | 1 per book | definitions are book-scoped; duplicate concepts and two lock writers |
| statement-smith | N, one item per file | claims are atomic, files are disjoint |
| auditor | 1 per batch of 10–20 | one voice, one sha set, one append stream |
| prover | 2 default, 4 max | each `lake env lean` is CPU- and RAM-hungry; more thrashes |
| integrator | 1 per chapter | assembles the same `Book/` file |

Never:

- two agents on the same `item_id`, in any role;
- an auditor and a statement-smith on the same item at the same time (the smith would
  be reacting to the audit while the auditor reads the file — the sha is unstable);
- a prover started before the item's audit record exists (it would prove a statement
  nobody has read back);
- a chapter captain for chapter IV dispatching a task whose `chapter` field is V.

The auditor batch is the slowest stage; do not shrink batches below 10 to "get feedback
faster" — the read-back is the quality gate, and 10 items is roughly one human
review sitting.

## 5. Batching, markers, idempotent reruns

**Batch size: 10–20 items.** A batch is a contiguous slice of `item_order` inside one
chapter and one milestone. It is the unit of audit, of `af_record` reporting, and of
human review.

**Markers.** The only marker the tools honor is the atomic claim
`$BOOK/state/claims/<task_id>.lock`. Do not create `.done` files, `batch_*.json`, or
`state/done/`: the SPEC forbids extra state files, and a marker that `af_next` does not
read is a lie that survives restarts. Batch boundaries live in `WORKFLOW.md` as
`af_record` lines with a stable prefix:

```
af_record({slug, kind:"note", chapter, text:"batch IV-3: items IV.2.1..IV.2.10; stated 9, blocked 1; codes: OK_STATEMENT×9, COMPILE_ERROR×1"})
```

**Idempotent reruns.**

| Call | Rerun behavior | Rule |
|---|---|---|
| `af_ingest` | rewrites `items.jsonl` atomically; dedupe keeps the first occurrence | safe to rerun with the same parts; always rerun with all parts, not a subset |
| `af_plan` | rebuilds `plan.json` | snapshot `depends_on` into a `decision` record **before** rerunning, restore after |
| `af_next` | skips claimed tasks | safe; returns `task:null` when the frontier is empty |
| `af_check` | recompiles the same file | safe; do not run it to "refresh" an unchanged file |
| `af_record` | appends | duplicates are possible; prefix each line with `batch <label>:` so the captain can dedupe on read |
| `af_export` | overwrites `exports/<item_id>/` | safe |
| `af_mission` | overwrites `missions/<chapter>/` | safe; hand the human only the latest |

**Crash recovery.** A crashed worker leaves its claim lock behind. The captain's
procedure (from `agents/captain.md`): confirm the child is idle or failed, record
`kind:"decision"` with the task id and reason, delete
`$BOOK/state/claims/<task_id>.lock`, re-dispatch. Never delete a lock while its worker
is running; never delete a lock without a decision record.

## 6. How `statements` mode changes the org chart

| | `full` | `statements` |
|---|---|---|
| librarian | same | same |
| architect | same (freeze still mandatory) | same |
| statement-smith | same | same — this is the terminal role for a theorem |
| auditor | same | same, and **more** important: the read-back is the only quality gate left |
| prover | dispatched | **role does not exist**; do not create one |
| integrator | proofs + per-proof axioms + mission | statements + open-statement census + mission |
| mission | proved items, then open ones | every item is an open problem by design |

Consequences:

1. `af_next` never returns `sketch` or `prove`; if it does, the mode is inconsistent
   (see `docs/MODES.md`).
2. No `Solutions/` file may exist for a theorem-like card; `af_status` warns, and the
   integrator fails the chapter on it.
3. Missions **stay open**. The platform's normal state for a submitted statement is
   `Open`; publishing open problems is the product, not a failure. The proposal's
   `mission.md` must say "statement-only: proofs intentionally left open (sorry)".
4. The acceptance question changes from "does it compile without `sorry`?" to "does a
   blind reader, given only the Lean, describe the same theorem the source states?".
   That is why the auditor is not optional in this mode.
5. Promotion to `full` later is a supported, normal operation: the statements are
   already frozen and audited, so `af_next` starts emitting proofs for them. See
   `docs/MODES.md`.

## 7. Worked example — Chapter IV of *Sheaves in Geometry and Logic*

The book is ingested from three Markdown parts (`part001.md`, `part002.md`,
`part003.md`) whose boundaries overlap (part002 restarts at III.8, part003 at VI.6).
Chapter IV is *Elementary Toposes*. Counts and ids below are the shape one run
produces; the authoritative values are always the ones in your `items.jsonl`. The
item id `IV.1.Def.1` / `Def_IV_1_ElementaryTopos` is the SPEC's own example.

### 7.1 Ingest

```js
af_init({
  slug: "sheaves-in-geometry-and-logic",
  title: "Sheaves in Geometry and Logic",
  authors: ["Saunders Mac Lane", "Ieke Moerdijk"],
  source_paths: ["/data/WSP/math/sheaves/part001.md",
                 "/data/WSP/math/sheaves/part002.md",
                 "/data/WSP/math/sheaves/part003.md"],
  mode: "full",
  mission_type: "Textbook",
  namespace: "MacLaneMoerdijk",
  lean_project: "~/topos-book",
  include_exercises: true
})
// → {"ok":true,"slug":"sheaves-in-geometry-and-logic",
//    "root":".../books/sheaves-in-geometry-and-logic","mode":"full",
//    "visibility":"public","include_exercises":true}
```

```js
af_ingest({slug:"sheaves-in-geometry-and-logic",
           part_files:["/data/.../part001....md",
                       "/data/.../part002....md",
                       "/data/.../part003....md",
                       "/data/.../part004....md"],
           include_exercises:true})
// → {"ok":true,"chapters":11,"sections":96,"items":321,"exercises":130,
//    "toc_path":".../toc.json","items_path":".../items.jsonl"}
```

The librarian then reports, per chapter, e.g.:

```
inventory IV: 10 sections, 2 definitions, 39 theorem-like, 16 exercises
(Ex_IV_Exercises_1..16); anchors verified 57/57; dedupe: 0 duplicates; defects: none
```

```js
af_plan({slug:"sheaves-in-geometry-and-logic"})
// → {"ok":true,"chapters":11,"missions":11,"cards":451,"mode":"statements"}
```

Chapter IV becomes one mission with 11 milestones (`IV.1` … `IV.10` + `IV.Exercises`)
and 57 cards (2 def + 39 theorem-like + 16 exercises).

### 7.2 Captain orients

```js
af_record({slug, kind:"note", chapter:"IV",
  text:"IV opens: 57 cards (2 def / 39 thm-like / 16 ex), 11 milestones, mode full, visibility public. Capstone candidate: IV.7.Thm.1 (slice category is a topos)."})
```

`kind:"note"` on purpose: `kind:"mission"` with a chapter marks it `published`, and nothing
is published yet.

### 7.3 Definitions first

The captain asks the architect for `define` tasks until the chapter's definition layer
is done. The architect writes, e.g.:

```lean
-- $LEAN_PROJECT/Definitions/Def_IV_1_ElementaryTopos.lean
import Mathlib.CategoryTheory.Limits.Shapes.FiniteLimits
import Mathlib.CategoryTheory.Subobject.Basic
import Mathlib.CategoryTheory.CartesianClosed.Basic

universe u v

namespace MacLaneMoerdijk          -- book.json.namespace

/-- Source: Mac Lane–Moerdijk IV.1, Definition 1. An elementary topos is a
category with finite limits, cartesian closed, with a subobject classifier. -/
structure Def_IV_1_ElementaryTopos (C : Type u) [Category.{v} C] where
  hasFiniteLimits : HasFiniteLimits C
  isCartesianClosed : CartesianClosed C
  hasSubobjectClassifier : HasSubobjectClassifier C

end MacLaneMoerdijk
```

```js
af_check({slug, item_id:"IV.1.Def.1"})       // → OK_PROOF, sorry 0
af_record({slug, kind:"note", item_id:"IV.1.Def.1",
  text:"Def_IV_1_ElementaryTopos :: structure (C : Type u) [Category.{v} C] with 3 fields\nimports: Mathlib.CategoryTheory.Limits.Shapes.FiniteLimits, ...\ncheck: OK_PROOF"})
```

The captain dispatches the auditor for `IV.1.Def.1`; the auditor writes
`$BOOK/chapters/IV/audit/IV.1.Def.1/fidelity.md` and records:

```js
af_record({slug, kind:"audit", chapter:"IV", item_id:"IV.1.Def.1",
  text:"A structure on a category C whose objects are types in a universe u ... it carries three pieces of data: finite limits, cartesian closedness, and a subobject classifier. It asserts no property beyond those three."})
```

When the book's define queue is empty, the architect freezes IV: writes
`$BOOK/state/defs.lock` with the 2 definitions and their shas, and records the freeze
decision:

```js
af_record({slug, kind:"decision", chapter:"IV",
  text:"defs frozen: 11 files, lock sha 3f9c…, notation 0 symbols, all audited"})
```

No `state` task may be dispatched before this line. That is the whole point of the
freeze: a statement written against an unstable definition is a statement about
nothing.

### 7.4 Statements, batch IV-1

Batch IV-1 = the first ten theorem-like cards of IV.1 (`IV.1.Thm.1..Thm.10`, exercises
included when they fall in the slice). Statement-smith output:

```lean
-- $LEAN_PROJECT/Theorems/Thm_IV_1_2.lean
import Mathlib.CategoryTheory.Limits.Shapes.FiniteLimits
import Definitions.Def_IV_1_ElementaryTopos

open CategoryTheory

universe u v w

namespace MacLaneMoerdijk

/-- Source: Mac Lane–Moerdijk IV.1, Theorem 2. -/
theorem Thm_IV_1_2 (C : Type u) [Category.{v} C] (D : Type w) [Category.{v} D]
    [ElementaryTopos C] (F : C ⥤ D) (hF : Limits.PreservesFiniteLimits F) :
    <conclusion exactly as the source> := by
  sorry

end MacLaneMoerdijk
```

```js
af_check({slug, item_id:"IV.1.Thm.2"})   // → OK_STATEMENT, sorry_count 1
af_record({slug, kind:"note", item_id:"IV.1.Thm.2",
  text:"stated Thm_IV_1_2\ntype: <declaration line>\nimports: ...\ncheck: OK_STATEMENT (sorry_count=1)"})
af_record({slug, kind:"decision", item_id:"IV.1.Thm.2",
  text:"added hypothesis [ElementaryTopos C] from section IV.1 preamble; the source states it once for the section"})
```

### 7.5 Audit, batch IV-1

One auditor, 10 items, one `fidelity.md` each. It never opens `items.jsonl` or the
source; it only reads the Lean and the imported definitions. Its read-back of
`IV.1.Thm.2` says what the code asserts, including the degenerate case ("for every
functor `F`, including the constant functor on an initial object") — not whether that
is the right theorem.

### 7.6 Proofs

Leaf `IV.1.Thm.2` → prover writes `Solutions/Thm_IV_1_2.lean` with
`theorem solution` and the exact binders, `af_check(file:"Solutions/...")` → `OK_PROOF`,
`af_export`, then an `EXPLANATION` note.

Parent `IV.3.Thm.2` (the capstone) has children `IV.3.Thm.1` and `IV.3.Lem.4`:
`af_next` returns a `sketch`, and the prover writes a reduction importing
`Theorems.Thm_IV_3_1` and `Theorems.Thm_IV_3_Lem_4`, using both. The platform records
that as `SKETCH_ACCEPTED`; locally it is `OK_PROOF` with zero `sorry` in its own file.

### 7.7 Integration

```lean
-- $LEAN_PROJECT/Book/ChapterIV.lean — imports only, never a proof
import Definitions.Def_IV_1_ElementaryTopos
import Theorems.Thm_IV_1_2
import Theorems.Thm_IV_3_1
import Theorems.Thm_IV_3_2
```

```lean
-- $LEAN_PROJECT/Book/axioms/IV.1.Thm.2.lean — the proof file, copied, plus one line
import Definitions.Def_IV_1_ElementaryTopos
...
theorem solution (C : Type u) [Category.{v} C] [ElementaryTopos C] : <conclusion> := by
  ...
#print axioms solution
```

The leaf audit prints `propext`, `Classical.choice`, `Quot.sound` only. The sketch audit for
`IV.3.Thm.2` prints `sorryAx` plus those three — not a defect: its imported children are
`Theorems/*.lean` files that still say `by sorry`, and only the platform, where the
children are real proofs, can clear that. The integrator records the status table (mode,
cards, proved, readbacks, visibility, main item, milestones, leaf/sketch axiom counts, CI,
exports).

### 7.8 Handoff

```js
af_mission({slug:"sheaves-in-geometry-and-logic", chapter:"IV"})
// → {"ok":true,"proposal_path":".../missions/IV/proposal.json",
//    "mission_md":".../missions/IV/mission.md",
//    "submit_sh":".../missions/IV/submit.sh","visibility":"public"}
```

The captain reads the three files, the integrator's checklist passes, and the captain
tells the human: proposal path, item count, readback count, and that the self-audit and
**Submit Proposal** click happen on the platform. Nobody runs `submit.sh`.

A proposal may be built as a **draft** before every Lean file exists: each missing or
`af:placeholder` item sets `local_items[].placeholder: true`, `mission.md` prints the
count, and `submit.sh` refuses to post until that count is zero. Draft proposals are
for inspection and ordering; they are never launched.

### 7.9 The same chapter in `statements` mode

Identical until 7.6. Then: no prover is dispatched; `IV.1.Thm.2` stops at `OK_STATEMENT`
+ read-back; the integrator's bundle is `Book/ChapterIV.lean` with the
"statement-only: proofs intentionally left open (sorry)" header, no axiom audit at all,
and an open-statement census equal to 18 + 12 = 30 (theorem-like + exercises), counted from
the `Theorems/*.lean` files. The proposal publishes 39 open statements plus 2 definitions
inside one public mission, and the mission status table says
`proved: 0/30 — statement-only`. A prover later promoted into this chapter (see
`docs/MODES.md`) closes them one by one without changing a single statement.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `af_next` always `task:null` | all cards claimed, or definitions not frozen | `af_status`; check `state/defs.lock` for the chapter; check `state/claims/` for stale locks |
| two workers wrote the same `Thm_*.lean` | dispatch did not require `af_next`, or a hand-edited claim | stop both, keep the version whose `af_check` code matches the log, record a decision |
| `af_check` module error on a good file | book Lean root not importable from `lean_project` | fix `lean_project`/lakefile; do not rewrite imports |
| auditor output says "faithful" | contaminated dispatch or a role-prompt violation | discard the read-back, re-dispatch clean |
| `af_status` warns "stated without readback" | audit was skipped or its record was written to the wrong chapter | re-run the audit; the record must carry `chapter` |
| mission contains a `Solutions/` file in `statements` mode | prover dispatched into mode2 | delete nothing; captain decides archive vs mode switch |
| a leaf proof's axiom audit shows `sorryAx` in `full` mode | the "leaf" imports an open theorem | either it is a sketch (fix the DAG) or the import must go; never "fix" it by editing the statement |
| proposal rejected by moderator | unfaithful statement or missing read-back | read `reviews` + item `flags`; fix by *replacement* (published items are immutable), re-audit, re-submit |

## 9. Non-negotiables

1. Every mission is public (`"visibility":"public"`); `af_init` and `af_mission` reject
   anything else, and no role works around a rejection.
2. All material is in scope, exercises included. An `Exercises` milestone is a real
   milestone; an `Ex_*` card is a real card.
3. No network from any role. The plugin writes files; the human submits.
4. No role edits outside `$BOOK`; no role edits another role's files.
5. A statement is never weakened to make a proof go through. Hard targets are the
   product.
