# p2m-auto-formalization

An OpenCode V2 plugin that turns a mathematics book (or paper) into **public
Prove2Me missions**: an atomized DAG of definitions, formal statements and, in
`full` mode, proofs. Sub-agents claim tasks, write Lean files, compile them
through `af_check` and record the result; the plugin never calls the network.

- Namespace: `af` (tools are `af_init`, `af_ingest`, …).
- Runtime dependencies: none. Node builtins only (`node:fs`, `node:path`,
  `node:child_process`, `node:crypto`, `node:os`).
- Mode enforcement is closed: `statements` mode can never emit a `prove` or
  `sketch` task, and can never accept a `Solutions/` file.

## Install

The plugin is a directory with `package.json` + `index.ts`; deploy it as a copy
and register it in the OpenCode config.

```bash
./scripts/deploy.sh          # copy to ~/.opencode2/plugins/p2m-auto-formalization
python3 scripts/register.py  # add the plugin entry, timestamped backup of opencode.json
```

`~/.opencode2/config/opencode/opencode.json` (the script writes this entry):

```json
{
  "plugins": [
    {
      "package": "~/.opencode2/plugins/p2m-auto-formalization",
      "options": {
        "booksDir": "./books"
      }
    }
  ]
}
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `root` | `.` | Base for the default books directory |
| `booksDir` | `<root>/books` | Where `books/<slug>/` lives |
| `leanTimeoutMs` | `600000` | `lake env lean` timeout in ms (clamped 1s..30min) |
| `lakeBin` | `lake` | Lake executable; a test hook for a fake compiler |

Restart OpenCode after registering. The tools are then visible as `af_init`,
`af_ingest`, `af_plan`, `af_next`, `af_check`, `af_record`, `af_status`,
`af_mission`, `af_export`.

## Modes

| Mode | Definitions | Theorems / lemmas / exercises | Proof tasks |
|---|---|---|---|
| `full` | yes | Lean statements | yes, until `sorry`-free |
| `statements` | yes | Lean statements ending in `by sorry` | **never emitted** |

`statements` is deliberately "statement-complete, proof-open": it publishes
public missions whose theorem cards are open problems. It must never create or
require a file under `Solutions/` for a theorem-like item.

A per-chapter override (`book.json.chapter_modes`) always wins over the book
mode. The effective mode is recomputed from `book.json` by `af_next`,
`af_check`, `af_status`, `af_mission` and `af_export`; a stale `plan.json` cannot
widen it.

## Tools

| Tool | Input | Behaviour |
|---|---|---|
| `af_init` | `slug,title,authors,source_paths,mode,mission_type?,namespace?,tags?,lean_project,visibility?,include_exercises?,chapter_modes?,imports?` | Create/refresh `books/<slug>/`. Rejects non-public visibility, unknown mode, `include_exercises:false`, missing sources. |
| `af_ingest` | `slug,part_files?,include_exercises?` | Parse Markdown into `toc.json` + atomic `items.jsonl`. Dedupes overlapping parts. |
| `af_plan` | `slug` | Build `plan.json`: chapter missions, section + `Exercises` milestones, one card per item, `visibility:"public"`, `depends_on:[]`. |
| `af_next` | `slug,role?` | Claim the next task with an exclusive `state/claims/<task_id>.lock`. Order: define, state, audit, sketch, prove, integrate. |
| `af_check` | `slug,item_id,file?` | `lake env lean` + sorry/axiom/unsafe/self-import/placeholder scans and mode policy. Does not edit the file. |
| `af_record` | `slug,kind,text,item_id?,chapter?` | Append to `WORKFLOW.md`, the chapter log and `state/workflow.jsonl`; `audit` sets the readback. |
| `af_status` | `slug` | Counts, chapter/mission counts, DAG frontier, warnings. |
| `af_mission` | `slug,chapter` | Write `proposal.json`, `mission.md`, `submit.sh` (public; never submitted). |
| `af_export` | `slug,item_id` | Write `solution.lean` (full) or `statement.lean` (statements) + `meta.json`, `explanation.md`, `curl.sh`. |

All tools return a compact JSON string. Errors are
`{"ok":false,"code":"...","error":"..."}`; `af_check` returns `ok:true` with a
verdict code when the check ran, even if the verdict is `COMPILE_ERROR`.

### Check verdicts

`OK_STATEMENT`, `OK_PROOF`, `SORRY`, `AXIOM`, `MODE_VIOLATION`,
`TYPE_MISMATCH`, `COMPILE_ERROR`. Priority when several apply:
`AXIOM` > `MODE_VIOLATION` > `TYPE_MISMATCH` > `SORRY` > `COMPILE_ERROR`.

| File | Mode | Rule | Success |
|---|---|---|---|
| `Definitions/...` | both | zero `sorry` | `OK_PROOF` |
| `Theorems/...`, `Exercises/...` | `statements` | exactly one `sorry`, no `Solutions/` file | `OK_STATEMENT` |
| `Theorems/...`, `Exercises/...` | `full` | at most one `sorry` | `OK_STATEMENT` |
| `Solutions/...` | `full` | zero `sorry`, no `axiom`/`native_decide`/`unsafe`, no self-import | `OK_PROOF` |
| `Solutions/...` | `statements` | never allowed | `MODE_VIOLATION` |

## Platform proposal shape

`af_mission` writes two layers into `missions/<chapter>/proposal.json`:

- the **platform bodies** in `items`, exactly what `submit.sh` POSTs:
  `kind` (`theorem` | `definition`), `theorem_name` / `definition_name` in the
  book-wide namespace (`MacLaneMoerdijk.thm_iv_1_...`), `theorem_title` /
  `definition_title`, `formal_statement` wrapped in `namespace ... end` and
  ending in `:= by sorry` for theorems, `natural_language_statement`,
  `preamble` (the item file's import/open/universe block), a citation `source`
  (never an absolute path), `tags`, and `readback` (+ `readback_model` only when
  the readback is non-empty; the placeholder is `p2m-af-auditor`);
- local metadata in `local_items`, `main_local_item` and `sources`.

The Create body is only `{name, description, mission_type, visibility, env}`,
where `env` is `book.json.mathlib_rev`. `submit.sh` then posts one item at a
time, captures `.id // .item_id` into a name -> platform-id map, posts each
milestone as `{item_id, milestone_title, milestone_description}` (anchored to the
milestone's first theorem-like item, title starting with the section number),
and finally PATCHes `{main_item_id, item_order}`. It refuses a non-public
proposal, strips local fields from the posted bodies, and never runs itself.

The capstone (`main_item_id`) is `chapter.goal_item` when set, else the **last
theorem** of the chapter (falling back to the last non-exercise theorem-like
item). The book-wide `namespace`
(`book.json.namespace`, derived from the title when absent) is applied to every
`formal_statement`; `book.json.mission_type` defaults to `Textbook`;
`book.json.tags` defaults to `["topos-theory"]` for topos/sheaf books and `[]`
otherwise. A chapter milestone with only definitions has no theorem anchor and
is skipped by `submit.sh` (the proposal keeps it with `anchor_item: ""`).

A proposal can be built as a draft before every Lean file exists. Each missing
or `af:placeholder` item is marked `local_items[].placeholder: true`;
`mission.md` prints the count, and `submit.sh` refuses to post until the count is
zero. Draft proposals are for inspection and ordering, not launch.

## Book workspace layout

```text
books/<slug>/
  book.json                    # mode, mission_type, namespace, tags, visibility, sources, lean project
  toc.json                     # chapters / sections / counts
  items.jsonl                  # one record per extracted item
  plan.json                    # missions, milestones, cards, statuses, DAG
  WORKFLOW.md                  # append-only book log
  state/
    progress.json              # attempts per item (task rounds)
    workflow.jsonl             # append-only event log
    claims/<task_id>.lock      # exclusive-create claim files
  missions/<chapter>/
    proposal.json              # public mission proposal
    mission.md                 # human summary
    submit.sh                  # curl commands, never executed
  chapters/<chapter>/WORKFLOW.md
  exports/<item_id>/
    solution.lean | statement.lean
    meta.json
    explanation.md
    curl.sh
```

Lean sources live in `book.json.lean_project`; relative paths in `items.jsonl`
and `plan.json` are relative to that project, because `lake env lean` runs with
the project as cwd:

```text
<lean_project>/
  Definitions/Def_<chapter>_<section>_<Slug>.lean
  Theorems/Thm_<chapter>_<section>_<Slug>.lean
  Exercises/Ex_<chapter>_<section>_<n>.lean
  Solutions/Thm_<chapter>_<section>_<Slug>.lean
```

`af_init` creates those four directories when the project already exists.

## Ingestion grammar

```text
# IV Elementary Topoi              chapter heading
# 1. Basic notions                 section heading
# Exercises                        exercise heading
Definition 1.1. …                  item start (also **Definition 1.1.**)
Theorem 1.2. …                     item start
Lemma / Proposition / Corollary / Example / Remark
*Proof.* …                         proof marker (also Proof., **Proof.** / Solution / Hint)
```

Items are deduplicated by `(chapter, section, kind, ordinal-within-section)`. The
part files overlap (part002 restarts at III.8, part003 at VI.6), so the ordinal
counter is reset per part; the first occurrence wins and a non-empty proof from a
later occurrence is merged into the kept item. Each part must begin at a chapter
heading, matching the source scans.

Exercises are always included. `include_exercises:false` is rejected by both
`af_init` and `af_ingest`.

## Public mission rule

Every mission is public.

- `af_init` rejects `visibility` other than `"public"`.
- `af_plan` writes `"visibility":"public"` on every chapter and the plan.
- `af_mission` refuses to build if `book.json.visibility !== "public"`; every
  proposal item and milestone belongs to a public proposal.
- `submit.sh` re-checks `proposal.json.visibility` before its first POST.
- `af_status` warns on any non-public book/chapter/proposal.
- `af_record(kind="mission")` and `af_mission` mark the chapter `published`.

## Readbacks and progress

A theorem-like card is not done in `statements` mode until it is `stated` **and**
has a readback: a short audit text comparing the Lean statement with the source.
Record it with:

```text
af_record({ slug, kind: "audit", item_id: "IV.1.Thm.1", text: "<readback>" })
```

`af_status` warns `MISSING_READBACK` until then. In `full` mode a card is done
only at `status:"proved"`, `sorry_count:0`.

## Testing

```bash
cd ./plugin/p2m-auto-formalization

# 1. bundle (works without node_modules; the @opencode/plugin import is type-only)
bun build index.ts --target node --outfile /tmp/p2m-af.js

# 2. storage/planning selftest (temp dir, fake lake, no network)
bun run tests/selftest.ts

# 3. type check (TypeScript 6.0.3)
bun x tsc --noEmit
```

The selftest covers: init in both modes, private/mode/exercise/source rejection,
two-chapter ingest with overlapping parts, dedupe + proof merge, statements plan
(no prove/sketch, exactly one sorry per theorem, exercises present), full plan
(prove tasks for leaves), atomic claims, the platform proposal shape
(namespace-wrapped `formal_statement`, preamble, citation source, tags, capstone,
`submit.sh` sequence, no whole-proposal POST), statement-only export, every
`af_check` policy path, readback warnings/models, a non-public book, a
per-chapter override, re-plan preservation of `depends_on`, and a regression over
the bundled Sheaves seed (11 chapters, 96 sections, 451 cards, missions I, IV and the Appendix A).

## Notes and deliberate choices

- **`Plugin.define` shim.** `index.ts` imports only the `Context` type from
  `@opencode/plugin` and defines a local identity `define()` with the same shape.
  This keeps `bun build index.ts --target node` working without a `node_modules`
  tree in the plugin directory, while `tsc` still checks the real `Context` type.
- **Tolerant book reader.** `toc.json` and `items.jsonl` are normalized on read,
  so books produced by other parsers (the bundled Sheaves seed) work without a
  re-ingest: `source_paths` replaces `sources`, section item-arrays become
  counts, fully qualified section ids are stripped to their bare number, and
  missing item fields (`number`, `exercise`, `exercise_section`, `notes`,
  `readback`) get defaults.
- **Compiler only after text checks.** A file that already violates a hard rule
  (`axiom`, wrong sorry count, self-import, placeholder) is rejected without
  spending a 600 s `lake env lean` run.
- **Remarks and examples are theorem-like.** The mode table is closed over
  definitions vs. everything else. A pure-commentary `Remark` card can be deleted
  from `plan.json` by the architect; `children` is derived and must not be edited.
- **`TYPE_MISMATCH` is local.** Without a formal target in the source book, the
  plugin can only check the declaration name and the placeholder sentinel, not
  semantic equality with a reference statement.
- **`af_mission` sets the chapter to `published`.** This is the integration step;
  `af_status` warns (`CHAPTER_INCOMPLETE`) but does not refuse a partially
  complete chapter, so an operator can publish an open subset deliberately.
- **The Create body has no `field_ids`.** The platform needs at least one field
  at Submit Proposal time; the human adds it in the website after running
  `submit.sh`, as `docs/PROVE2ME.md` describes.
- **Default data directory.** `books/` lives under `./books`,
  outside this git repository. Add `books/` to `.gitignore` if you point
  `booksDir` inside the repo; the export directory is already ignored.

## Data

Book data used during development is not redistributed in this repository.
Bring your own PDF/Markdown and run `af_ingest` locally.
