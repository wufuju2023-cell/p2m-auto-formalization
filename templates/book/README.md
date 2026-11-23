# `templates/book` — generic book workspace

`af_init` copies this tree to `books/<slug>/` and expands the placeholders:

| Placeholder | Value |
| --- | --- |
| `{{slug}}` | the book slug from `af_init` |
| `{{title}}` | the book title from `af_init` |
| `{{chapter}}` | one chapter id (`I`, `II`, …, or any id the parser produces) |

`{{chapter}}` is special: it appears both inside file contents and in the
directory name `chapters/{{chapter}}/`. After copying, `af_init` creates one
real directory per parsed chapter (for example `chapters/I/`,
`chapters/II/`) and expands the template inside each one. The literal
`chapters/{{chapter}}/WORKFLOW.md.tmpl` file is not kept in the book.

What `af_init` fills or rewrites:

- `book.json` — replaces the template with the real metadata object:
  `slug`, `title`, `authors`, `mode`, `chapter_modes`, `visibility:"public"`,
  `materials:"all"`, `include_exercises:true`, `source_paths`,
  `lean_project`, `toolchain`, `mathlib_rev`, timestamps. It rejects
  `visibility:"private"`, an unknown mode, missing sources, and
  `include_exercises:false`.
- `WORKFLOW.md` — expands `{{slug}}`, `{{title}}`, `{{chapter}}` and replaces
  the placeholder chapter row with one row per chapter after ingest.
- `MISSIONS.md` — expands the single mission block into one block per chapter
  and replaces the placeholder index row.
- `chapters/<id>/WORKFLOW.md` — expands `{{slug}}`, `{{chapter}}`, `{{title}}`
  (chapter title) and the section/status tables.

The template is deliberately small: it carries the workflow shape, not a
parser and not book-specific counts. `af_ingest` writes `toc.json` and
`items.jsonl`; `af_plan` writes `plan.json`; `af_mission` writes
`missions/<chapter>/`.

Files here:

- `book.json.tmpl`
- `WORKFLOW.md.tmpl`
- `MISSIONS.md.tmpl`
- `chapters/{{chapter}}/WORKFLOW.md.tmpl`
