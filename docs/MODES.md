# Modes: `full` vs `statements`

The plugin has exactly two modes. They differ in **one** place: whether a theorem-like
item ever gets a proof. Definitions, statements, read-backs, milestones, exercises and the
public-mission rules are identical.

Mode is set per book at `af_init` and can be overridden per chapter through
`book.json.chapter_modes`. The effective mode of chapter `X` is
`chapter_modes[X] ?? book.mode`.

## 1. Side by side

| | `full` | `statements` |
|---|---|---|
| definitions | required, frozen, audited | required, frozen, audited |
| theorem files | `Theorems/Thm_*.lean`, `Exercises/Ex_*.lean`, `by sorry` at draft | same |
| proof tasks | yes, until `sorry`-free | **never emitted** |
| `Solutions/` | one `<lean_name>.lean` per proved item | **must not exist** for theorem-like items |
| `af_next` kinds | `define, state, audit, sketch, prove, integrate` | `define, state, audit, integrate` |
| file that closes an item | `Solutions/<lean_name>.lean` (`OK_PROOF`) | `Theorems/` or `Exercises/` statement (`OK_STATEMENT`) |
| acceptance for a theorem | `proved`, `sorry_count:0`, no new axiom | `stated`, `readback` present, exactly one `sorry` |
| axiom audit | per proof: leaves `⊆` the three standard axioms; sketches `sorryAx` + that subset | none (nothing is proved) |
| export | `solution.lean` + `meta.json` + `curl.sh` for `/verify` | `statement.lean`, `"proof_type":"statement-only"`, no `/verify` |
| platform state of the item | Open → first `ACCEPTED` wins | Open, permanently, until somebody proves it |
| mission text | describes the results and the open frontier | must say "statement-only: proofs intentionally left open (sorry)" |
| prover role | dispatched | **does not exist** |
| auditor role | required | required (it is the only quality gate) |
| integrator | proofs + axiom audit | statements + open-statement census |

## 2. What `af_next` emits

Selection order (SPEC §`af_next`), with the mode gates marked:

| # | kind | role | emitted in `full` | emitted in `statements` | condition |
|---|---|---|---|---|---|
| 1 | `define` | architect | yes | yes | definition card `status:"draft"` |
| 2 | `state` | statement-smith | yes | yes | theorem-like card whose definition dependencies are `audited` or `stated` |
| 3 | `audit` | auditor | yes | yes | card `stated` without `readback` |
| 4 | `sketch` | prover | **yes** | **never** | audited card with children |
| 5 | `prove` | prover | **yes** | **never** | leaf whose children are `proved` |
| 6 | `integrate` | integrator | yes | yes | all cards proved (`full`) or stated+audited (`statements`) |

The `role` column is the role prompt that owns the kind; dispatch follows `task.kind`
(see `docs/SUBAGENTS.md` §3). A `sketch` is a proof, so it belongs to the prover even if
some build labels its role differently.

Consequences worth internalizing:

- In `statements` mode a theorem card's lifecycle is **three** steps: `state` →
  `audit` → done. There is no fourth step, and calling `af_next` again after the audit
  returns `task:null` for that card.
- In `full` mode the lifecycle is `state` → `audit` → (`sketch` | `prove`) → done. A
  parent with children is never `prove`d directly: it gets a `sketch` that imports the
  children, and the platform records it as a reduction (`SKETCH_ACCEPTED`).
- "Children" come from the item DAG (`depends_on` in `plan.json`), which the architect
  owns. The frontier is a topological sort of that DAG, not a reading order.
- `af_next` claims atomically (`state/claims/<task_id>.lock`), so two workers asking at
  the same time never get the same task, in either mode.

## 3. What `af_check` accepts

`af_check({slug, item_id, file?})` runs `lake env lean` in `book.lean_project` (600 s),
after scanning the file text for `sorry`, `axiom`, `native_decide`, `unsafe`, and
`import Theorems.Thm_<own>`. It never edits the file.

| File checked | `full` | `statements` |
|---|---|---|
| `Definitions/Def_*.lean` | `OK_PROOF` (0 `sorry`) | `OK_PROOF` (0 `sorry`) |
| `Theorems/Thm_*.lean` | `OK_STATEMENT` (at most 1 `sorry`) | `OK_STATEMENT` (exactly 1 `sorry`); a `Solutions/` file for the item is a `MODE_VIOLATION` |
| `Exercises/Ex_*.lean` | `OK_STATEMENT` (at most 1 `sorry`) | `OK_STATEMENT` (exactly 1 `sorry`) |
| `Solutions/<lean_name>.lean` | `OK_PROOF` (0 `sorry`) | `MODE_VIOLATION` |

`Book/ChapterX.lean` is not an `af_check` target — it belongs to no single item — so the
integrator compiles it directly in `ci/chapter_X.sh` (see `agents/integrator.md`, Phase A).

Codes: `OK_STATEMENT`, `OK_PROOF`, `SORRY`, `AXIOM`, `MODE_VIOLATION`, `COMPILE_ERROR`,
`TYPE_MISMATCH`. When several fire the priority is
`AXIOM > MODE_VIOLATION > TYPE_MISMATCH > SORRY > COMPILE_ERROR`, so a file that has both
a `sorry` and a syntax error reports `SORRY` — fix the hard rule first, then compile.
Anything other than the acceptance code for that cell is a failure of the task, not a
warning.

A successful check also moves the card: definition → `audited`, statement → `stated`,
proof → `proved`. A failed check only increments the attempt counter, which is why a
retry gets a fresh claim id (`<item_id>.<kind>.r<n>`) rather than reusing the old one.

Note the asymmetry the SPEC leaves implicit: a **statement** file in `full` mode is
accepted with at most one `sorry` (it is the frozen statement, not a proof), while a
`Solutions/` file in `full` mode is accepted only with zero. The plugin's discipline is
stricter than the tool: a `Theorems/` or `Exercises/` file always carries exactly one
`sorry`, in both modes, because that is the artifact the platform publishes. A zero-`sorry`
statement file is accepted by `af_check` but is a defect for us — it means somebody proved
inside the statement file, which freezes the statement to that proof and makes the
read-back describe a file that no longer matches the published one.

`AXIOM` deserves its own sentence: it has **no server analogue**. An `axiom` compiles and
the platform would accept a proof that cites it. The local rejection is a self-imposed
integrity rule, and it applies in both modes.

## 4. Switching a chapter's mode

There are two levels, and they use different mechanisms:

- **Book level.** Re-run `af_init` on the existing slug with the new `mode`. It updates
  `book.json` without touching `toc.json`, `items.jsonl`, `plan.json` or `state/`; then
  `af_plan` re-derives the cards. Statuses reset for every card whose effective mode
  changed, which is why a book-level switch is a deliberate, recorded act and not
  something to do on a whim mid-flight.
- **Chapter level.** Add or change one key in `chapter_modes`. This is the override that
  makes "full for IV, statements for V" possible, and it is what the rest of this section
  covers.

The switch lives in `book.json`:

```json
{
  "mode": "full",
  "chapter_modes": { "IV": "full", "V": "statements" }
}
```

Procedure (captain only, one chapter at a time):

1. **Finish the batch.** Never switch mid-batch: statements in flight would be checked
   against a different gate than the one they were written for, and the audit shas would
   move under the auditor.
2. `af_status` and write down the chapter's current counts (cards by status, `Solutions/`
   files, exports).
3. Record the decision:

   ```js
   af_record({slug, kind:"decision", chapter:"V",
     text:"mode switch: V statements -> full. Reason: audit batch V-2 closed; 0 Solutions files; 9 audited cards become prove tasks. Approved by human 2026-11-18."})
   ```

4. Edit only `chapter_modes` in `book.json` (JSON must stay valid; do not touch
   `visibility`, `materials`, `include_exercises`).
5. `af_status` → confirm the chapter now reports the new mode. `af_status` is the
   authority here, not `plan.json`.
6. If `plan.json` still reports the old mode for that chapter's cards (it was written at
   plan time), re-run `af_plan({slug})` and **restore `depends_on`** from the edges listed
   in the decision log. `af_plan` rebuilds the file; the DAG is not regenerable from the
   source, so it must be restored from the record.
7. Hand off: the next `af_next` in that chapter reflects the new mode.

Allowed directions:

| Direction | Allowed | Conditions |
|---|---|---|
| `statements` → `full` | yes, at any time after the audit | all cards must be `stated` + `readback`; provers start from frozen statements |
| `full` → `statements` | only **before** any `Solutions/` file exists | after a proof exists, the chapter has a result it would then have to disclaim; create a new book slug instead |
| `full` → `statements` with proofs on disk | **no** | `af_status` warns, the integrator fails the chapter, and the honest fix is either keep `full` or start a separate `statements` book |

Why the asymmetry: `statements` promises "no proof exists for this item". A leftover
file in `Solutions/` makes that promise false, and deleting proofs to satisfy a mode change
is destroying work to fit a label.

## 5. Promoting a `statements` chapter to `full`

This is the normal lifecycle, not a rescue operation. The published statements are
immutable and already public; proving them later is exactly what the platform expects
(an Open theorem accumulates submissions until one is `ACCEPTED`).

1. Captain records the promotion decision and the counts (as in §4).
2. `chapter_modes["V"] = "full"`; `af_status` confirms.
3. **Expect a status reset.** A mode change resets the status of every card whose
   effective mode changed. If `af_status` shows the chapter's cards back at `planned`,
   `af_next` first re-emits `state` for them: the statement files are already correct, so
   the smith re-checks the unchanged file (`af_check` → `OK_STATEMENT`) and does not
   rewrite the type. Re-audit only where the file's sha moved; an unchanged statement
   keeps its read-back.
4. After that pass, `af_next({slug, role:"prover"})` yields `prove` for every audited leaf
   and `sketch` for every audited parent with children. The statements are frozen, so the
   provers start from a fixed target.
5. Provers may **not** edit `Theorems/Thm_*.lean` or `Exercises/Ex_*.lean`. If a statement
   turns out to be wrong while proving, that is a freeze break (`agents/architect.md`,
   Step 6): captain decision, corrected statement, fresh audit, and — because the published
   item is immutable — a new `theorem_name` for the corrected version.
6. `af_export` changes shape: `statement.lean` is replaced by `solution.lean` +
   `meta.json` + `curl.sh`. The old `statement.lean` bundle is superseded; keep it until
   the proof is `ACCEPTED`, then let `af_export` overwrite.
7. Milestones do not change: the published mission keeps the same milestone list, and the
   items it links become `Proved` as proofs land.
8. The integrator re-runs Phase A with the axiom audit on: every leaf's proof depends only
   on `{propext, Classical.choice, Quot.sound}`, and every sketch's list is `sorryAx` plus
   that subset (the local `Theorems/` modules always keep `by sorry`, so a sketch can never
   be axiom-free locally; the platform clears it when the children are proved).
9. The `statements`-mode census from the old integration note stays in
   `WORKFLOW.md` as history. Do not delete it: it records what was claimed at the time.

Partial promotion is fine: promote chapter V while IV stays `statements`. The book-level
mission status table then has two modes in it, and that is correct as long as each row
names its chapter's mode.

## 6. Acceptance criteria

### `full`

A chapter is done when all of the following hold:

- [ ] every definition card: `af_check` = `OK_PROOF`, 0 `sorry`, present in
      `state/defs.lock` with a matching sha, read-back on record;
- [ ] every theorem-like card, exercises included: `status:"proved"`, `af_check` =
      `OK_PROOF`, `sorry_count:0`, no `AXIOM`;
- [ ] every parent with children has an accepted `sketch` importing exactly its children;
- [ ] `Book/ChapterX.lean` compiles (imports only — it is not a proof); every leaf's axiom
      audit is a subset of `{propext, Classical.choice, Quot.sound}`; every sketch's audit
      is `sorryAx` plus that subset, and its imports are exactly its proved children;
- [ ] `ci/chapter_X.sh` reruns clean and `ci/chapter_X.log` + `ci/chapter_X.axioms.log` are
      saved;
- [ ] every card has `exports/<item_id>/solution.lean` (plus `meta.json`, `explanation.md`,
      `curl.sh`);
- [ ] `af_status` has no warnings for the chapter;
- [ ] the public mission proposal exists with `visibility:"public"`, one milestone per
      section plus `Exercises`, `main_item_id` = capstone, read-backs on every item.

### `statements`

A chapter is done when all of the following hold:

- [ ] every definition card: as above;
- [ ] every theorem-like card, exercises included: `status:"stated"`, `af_check` =
      `OK_STATEMENT` with exactly one `sorry`, `readback` present and sha-current;
- [ ] **no** `Solutions/` file exists for any theorem-like card;
- [ ] `Book/ChapterX.lean` compiles and carries the header
      "statement-only: proofs intentionally left open (sorry)"; no axiom audit, no proof;
- [ ] the open-statement census equals the number of theorem-like cards (theorems +
      exercises): count the `Theorems/*.lean` files that carry a `sorry`, do not run an
      axiom audit — no proof exists to audit;
- [ ] every export is `statement.lean` + `meta.json` with `"proof_type":"statement-only"`
      and a `curl.sh` that says `/verify` does not apply;
- [ ] `mission.md` and the proposal `description` both state the statement-only line;
- [ ] `af_status` has no warnings, in particular no "mode2 book with a `Solutions/` file";
- [ ] the mission is public and the status table reports `proved: 0` explicitly rather
      than omitting the column.

## 7. Failure signatures

| Symptom | Meaning | Fix |
|---|---|---|
| `af_next` returns `prove` in a `statements` chapter | mode read from `book.json` disagrees with `plan.json`, or the chapter override was not applied | `af_status`; fix `chapter_modes`; §4 step 6 |
| `af_check` returns `MODE_VIOLATION` for a `Theorems/` file | a `Solutions/` file exists for that item in `statements` mode | find it with `ls $LEAN_PROJECT/Solutions/`; the captain decides (move it out after a recorded decision, or promote the chapter). A worker never deletes a proof. |
| `MODE_VIOLATION` for a `Solutions/` file | a prover ran in a `statements` chapter | stop the prover; do not "just check" the proof |
| `af_status` warns "mode2 book with a `Solutions/` file" | stale proof from an earlier mode | §4, direction table |
| a leaf's axiom audit shows `sorryAx` in `full` | the "leaf" imports an open theorem | either it is really a sketch (fix the DAG) or the import must go |
| a sketch's axiom audit shows anything besides `sorryAx` and the three standard axioms | a real axiom leaked into the proof | blocker; find the declaration and remove it |
| the platform shows a mission item as Open in a `full` book | the proof was exported locally but never submitted, or it was `SKETCH_ACCEPTED` with open children | submit/await children; local `OK_PROOF` is not a platform verdict |
| a `statements` mission is reported as "proved" anywhere | integrator status table bug | rewrite the table with `proved: 0` and the `sorryAx` census |

## 8. Choosing a mode

- Choose `full` when the chapter's proofs are expected to be closable with the pinned
  Mathlib, or when the point is to produce proved results.
- Choose `statements` when the value is the formal statement: a book whose proofs need
  theory that does not exist yet, a chapter that is a survey, or a first pass whose
  statements you want public and audited before anyone invests in proofs.
- Mixing is normal: `full` for the chapters you can close, `statements` for the rest, one
  book, one namespace, one proposal series. Promotion later is cheap because the
  statements are already frozen and audited.
- Never choose a mode per *item*. Mode is per book and per chapter; an item-level
  exception would break the acceptance criteria and the `af_status` warnings that make
  them checkable.
