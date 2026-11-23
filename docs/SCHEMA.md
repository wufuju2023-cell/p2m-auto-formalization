# On-disk schema

Every file below is written by the plugin with temp-file + `rename` (atomic on
the same filesystem). `items.jsonl` is rewritten from scratch on every ingest;
nothing in a book workspace is append-only except `WORKFLOW.md`,
`chapters/<id>/WORKFLOW.md` and `state/workflow.jsonl`.

Paths are relative to `books/<slug>/` unless stated otherwise. Relative Lean
paths (`Definitions/...`, `Theorems/...`, `Exercises/...`, `Solutions/...`) are
relative to `book.json.lean_project`.

## `book.json`

```json
{
  "slug": "sheaves-in-geometry-and-logic",
  "title": "Sheaves in Geometry and Logic",
  "authors": ["Saunders Mac Lane", "Ieke Moerdijk"],
  "mode": "statements",
  "chapter_modes": {"IV": "full"},
  "mission_type": "Textbook",
  "namespace": "MacLaneMoerdijk",
  "tags": ["topos-theory"],
  "visibility": "public",
  "materials": "all",
  "include_exercises": true,
  "source_paths": ["/abs/part001.md", "/abs/part002.md"],
  "lean_project": "~/topos-book",
  "toolchain": "leanprover/lean4:v4.33.1",
  "mathlib_rev": "0df444a360eaa60ab8c11dca51a86af692955474",
  "imports": ["Mathlib"],
  "created_at": "2026-11-18T10:00:00.000Z",
  "updated_at": "2026-11-18T10:05:00.000Z"
}
```

- `mode` and `chapter_modes[chapter]` are the only places a mode is configured.
  The per-chapter override always wins (`modeOfChapter` in `modes.ts`).
- `mission_type` is `Textbook` (book), `ResearchPaper` (paper) or
  `OpenProblem`; it is emitted in the public proposal.
- `namespace` is the single book-wide Lean namespace; every platform name is
  `<namespace>.<snake_case_lean_name>`. If absent, it is derived from the title.
- `tags` are the platform tags copied onto every proposal item.
- `visibility` is always written as `"public"`. `af_status` reads it as a string
  so a hand-edited private book produces a warning rather than a crash.
- `include_exercises` is always `true`; `false` is rejected by `af_init` and
  `af_ingest`.
- `materials` is fixed to `"all"`.

## `toc.json`

```json
{
  "slug": "sheaves-in-geometry-and-logic",
  "sources": [
    {
      "path": "/abs/part001.md",
      "bytes": 18234,
      "sha256": "…",
      "chapters": ["I", "II"]
    }
  ],
  "chapters": [
    {
      "id": "IV",
      "title": "Elementary Topoi",
      "sections": [
        {"id": "1", "title": "Basic notions", "items": 4, "exercises": 0},
        {"id": "Exercises", "title": "Exercises", "items": 0, "exercises": 3}
      ],
      "items": 4,
      "exercises": 3
    }
  ],
  "counts": {"chapters": 1, "sections": 1, "items": 4, "definitions": 2, "exercises": 3},
  "generated_at": "2026-11-18T10:01:00.000Z"
}
```

`sections` excludes the `Exercises` milestone from `counts.sections`. A chapter
`0` / section `0` ("Front matter" / "Chapter opener") is created only when items
appear before the first real heading.

## `items.jsonl`

One JSON object per line, document order, no trailing commas:

```json
{"id":"IV.1.Def.1","chapter":"IV","chapter_title":"Elementary Topoi","section":"1","section_title":"Basic notions","kind":"definition","label":"Definition","number":"1.1","source":"/abs/part001.md:399","statement_md":"An elementary topos is …","proof_md":"","depends_on":[],"lean_name":"Def_IV_1_ElementaryTopos","lean_file":"Definitions/Def_IV_1_ElementaryTopos.lean","status":"draft","mode":"statements","reuse":"?","readback":null,"notes":"","exercise":false,"exercise_section":"1"}
```

Field notes:

- `id`: `<chapter>.<section>.<Abbrev>.<ordinal>`. `section` may be `Exercises`.
  `Abbrev` is `Def`, `Thm`, `Lem`, `Prop`, `Cor`, `Eg`, `Rmk`, `Exercise`.
- `ordinal`: count of items of the same `kind` in the same section *within the
  part file*, starting at 1. This is the dedupe key, not the printed number.
- `number`: the printed number (`1.1`, `IV.2.3`), or `""`.
- `source`: `<absolute part path>:<1-based line of the item start>`.
- `statement_md`: the extracted statement without the leading label; Markdown
  preserved (LaTeX untouched).
- `proof_md`: text after a `Proof` / `Solution` / `Hint` marker, else `""`.
  Merged from a later overlapping occurrence when the first one had none.
- `lean_name`: see `modes.ts`.
  - definitions: `Def_<chapter>_<section>_<Slug>`
  - theorem-like: `Thm_`, `Lem_`, `Prop_`, `Cor_`, `Eg_`, `Rmk_` + chapter + section + slug
  - exercises: `Ex_<chapter>_<section>_<n>`, where `<section>` is the last
    numbered section before the `Exercises` heading.
- `lean_file`: statement file relative to `lean_project`.
- `status`, `mode`, `reuse`, `readback`, `notes`: ingest defaults; live status
  lives in `plan.json`.
- `exercise`: true for exercise-section items.

## `plan.json`

```json
{
  "slug": "…",
  "title": "…",
  "mode": "statements",
  "visibility": "public",
  "created_at": "…",
  "updated_at": "…",
  "chapters": [
    {
      "id": "IV",
      "title": "Elementary Topoi",
      "mission": "MLM IV — Elementary Topoi",
      "visibility": "public",
      "milestones": [
        {"id": "IV.1", "title": "Basic notions", "items": ["IV.1.Def.1", "IV.1.Thm.1"]},
        {"id": "IV.Exercises", "title": "Exercises", "items": ["IV.Exercises.Exercise.1"]}
      ],
      "cards": ["IV.1.Def.1", "IV.1.Thm.1", "IV.Exercises.Exercise.1"],
      "depends_on": [],
      "status": "planned"
    }
  ],
  "cards": [
    {
      "id": "IV.1.Def.1",
      "item_id": "IV.1.Def.1",
      "chapter": "IV",
      "section": "1",
      "kind": "definition",
      "label": "Definition",
      "mode": "statements",
      "status": "draft",
      "proof": "not_applicable",
      "file": "Definitions/Def_IV_1_ElementaryTopos.lean",
      "proof_file": null,
      "lean_name": "Def_IV_1_ElementaryTopos",
      "depends_on": [],
      "children": [],
      "readback": null,
      "sorry_count": null,
      "last_code": null,
      "notes": ""
    }
  ]
}
```

- `chapters[].status`: `planned` → `integrating` (claim of the integrate task) →
  `published` (af_mission / af_record kind=mission).
- Card `status`: `draft` (definition, not checked yet), `planned`, `stated`,
  `proved`, `audited` (definition checked). Mode changes reset statuses.
- Card `proof`: `pending` (mode1 theorem-like), `skipped` (mode2 theorem-like),
  `not_applicable` (definitions).
- `children` is **derived** from `depends_on` among theorem-like cards in the
  same chapter. Edit `depends_on`, never `children`.
- `readback` is the audit text (also visible in `af_record` output and the
  chapter log).

## `state/progress.json`

```json
{
  "slug": "…",
  "attempts": {
    "IV.1.Thm.1": {
      "count": 2,
      "last_code": "SORRY",
      "sorry_count": 1,
      "file": "Solutions/Thm_IV_1_....lean",
      "checked_at": "2026-11-18T10:20:00.000Z"
    }
  },
  "updated_at": "…"
}
```

The attempt count is the task round: `af_next` produces
`<item_id>.<kind>.r<count>`, so a failed check yields a fresh claim file.

## `state/workflow.jsonl`

Append-only, one event per line:

```json
{"ts":"2026-11-18T10:20:00.000Z","kind":"audit","item_id":"IV.1.Thm.1","chapter":"IV","text":"readback: …"}
```

Mirrored into `WORKFLOW.md` and `chapters/<chapter>/WORKFLOW.md` as:

```markdown
## 2026-11-18T10:20:00.000Z — audit — IV.1.Thm.1 — chapter IV

readback: …
```

## `state/claims/<task_id>.lock`

Created with `writeFileSync(..., {flag: "wx"})`. Content:

```json
{"task_id":"IV.1.Thm.1.prove.r0","item_id":"IV.1.Thm.1","chapter":"IV","kind":"prove","mode":"full","worker":"ses_…","pid":12345,"claimed_at":"…"}
```

## `missions/<chapter>/proposal.json`

```json
{
  "name": "Sheaves in Geometry and Logic IV: First Properties of Elementary Topoi",
  "pitch": "…",
  "description": "…",
  "visibility": "public",
  "mission_type": "Textbook",
  "env": "0df444a360eaa60ab8c11dca51a86af692955474",
  "namespace": "MacLaneMoerdijk",
  "chapter": "IV",
  "book": "sheaves-in-geometry-and-logic",
  "mode": "statements",
  "main_item_id": "IV.1.Thm.1",
  "items": [
    {
      "kind": "definition",
      "definition_name": "MacLaneMoerdijk.def_iv_1_elementary_topos",
      "definition_title": "Definition IV.1 — elementary topos",
      "preamble": "import Mathlib.CategoryTheory.Limits.Shapes.FiniteLimits\nimport Mathlib.CategoryTheory.Subobject.Classifier.Defs\n\nopen CategoryTheory\n\nuniverse u v",
      "formal_statement": "namespace MacLaneMoerdijk\n\nstructure def_iv_1_elementary_topos (C : Type u) [Category.{v} C] where\n  hasFiniteLimits : HasFiniteLimits C\n  hasClassifier : HasSubobjectClassifier C\n\nend MacLaneMoerdijk",
      "natural_language_statement": "An elementary topos is …",
      "source": "Mac Lane–Moerdijk, Sheaves in Geometry and Logic, IV.1",
      "tags": ["topos-theory"],
      "readback": "A structure on a category C with …",
      "readback_model": "p2m-af-auditor"
    }
  ],
  "local_items": [
    {
      "item_id": "IV.1.Def.1",
      "platform_name": "MacLaneMoerdijk.def_iv_1_elementary_topos",
      "kind": "definition",
      "file": "Definitions/Def_IV_1_ElementaryTopos.lean",
      "mode": "statements",
      "placeholder": false
    }
  ],
  "milestones": [
    {
      "milestone_title": "IV.1 — Definition of a Topos",
      "milestone_description": "The two equivalent definitions and the characteristic map.",
      "anchor_item": "MacLaneMoerdijk.thm_iv_1_…",
      "items": ["IV.1.Def.1", "IV.1.Thm.1"]
    }
  ],
  "item_order": ["IV.1.Def.1", "IV.1.Thm.1"],
  "sources": ["/abs/part001.md"],
  "created_at": "…"
}
```

- `items` are the **platform bodies**: they contain only fields the
  `/mission-proposals/:id/items` endpoint accepts. `local_items` carries the
  local `item_id`, `file`, `mode` and a `placeholder` flag; it is never posted.
- `definition_name` / `theorem_name` are book-namespace-qualified and
  snake_cased (`MacLaneMoerdijk.def_iv_1_…`). `*_title` is human-facing only.
- `preamble` is copied from the item's Lean file (`import` / `open` /
  `universe` lines), not a blanket `import Mathlib`.
- `source` is a citation, never an absolute path to the local Markdown.
- `readback` travels with `readback_model`; the platform rejects a read-back
  without the model id. Definitions need read-backs too.
- `formal_statement` is wrapped in the book-wide namespace and ends in
  `:= by sorry` for theorem-like items. A missing file or a leftover
  `af:placeholder` sets `local_items[].placeholder: true`; `submit.sh` refuses
  to post a proposal with any placeholder.
- `item_order` is the stable topological order, definitions first.
- `submit.sh` posts create → items → milestones → `PATCH {main_item_id,
  item_order}`; it never posts this whole object.

`mission.md` and `submit.sh` sit next to `proposal.json`. `submit.sh` is
generated with mode `0755` but is never executed by the plugin.

## `exports/<item_id>/`

Mode `full`:

```text
solution.lean    top-level `theorem solution`, sorry-free
meta.json        {theorem_id, theorem_name, env, proof_type: "prove", imports, explanation}
explanation.md   NL statement + proof provenance
curl.sh          POST /api/v1/verify (multipart), never executed
```

Mode `statements`:

```text
statement.lean   declaration ending in `by sorry` (exactly one sorry)
meta.json        proof_type: "statement-only", submission: "not-applicable"
explanation.md   NL statement + "proofs intentionally left open"
curl.sh          prints that /verify is not applicable
```

## Verdict codes (`af_check`)

| Code | Meaning |
|---|---|
| `OK_STATEMENT` | Statement accepted (mode policy satisfied, compiles) |
| `OK_PROOF` | Definition or mode-1 proof accepted (sorry-free, compiles) |
| `SORRY` | A file that must be sorry-free contains `sorry`/`admit` |
| `AXIOM` | `axiom`, `native_decide` or `unsafe` present |
| `MODE_VIOLATION` | Policy breach: wrong sorry count, Solutions/ in statements mode, self-import |
| `TYPE_MISMATCH` | Missing/renamed declaration, or the `af:placeholder` sentinel remained |
| `COMPILE_ERROR` | `lake env lean` failed, timed out, or the file is missing |

Priority when several fire: `AXIOM` > `MODE_VIOLATION` > `TYPE_MISMATCH` >
`SORRY` > `COMPILE_ERROR`.

The tool result itself is `{"ok": true, ...}` whenever the check ran; `ok:false`
is reserved for bad input (unknown slug/item, missing project, path escape).
