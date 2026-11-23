# Prove2Me API mapping for p2m-auto-formalization

How the plugin's files become platform objects, which calls the roles may make (none — the
roles are offline), which calls the human makes, and what each verdict means.

Base URL: `https://prove2.me/api/v1`. The plugin itself makes **no network calls**; every
call below is either printed by `af_mission` / `af_export` into a script, or run by the
human from this document.

## 0. Who may call what

The plugin is deliberately offline: it writes files and prints commands. No role prompt
permits an agent to make a network call, so every row below is the human's, run from the
`submit.sh` / `curl.sh` that `af_mission` and `af_export` produce, or from the commands in
this document. That is what makes "the plugin never uploads" a fact rather than a promise.

| Call | Agent | Human |
|---|---|---|
| `POST /verify` (a proof or sketch) | no | yes |
| `POST /submit-problem` (standalone open problem) | no | yes |
| `POST /submit-definition` (standalone definition) | no | yes |
| `POST /mission-proposals` and its `/items`, `/milestones`, `PATCH` | no | yes |
| `Submit Proposal` click (audit + launch) | no | **only** |
| `POST /missions/:id/make-public` | no | yes |

The platform rule is explicit: a proposal is submitted from the website by the account
owner, after per-item confirmation. No agent can self-audit or launch. `submit.sh` is a
convenience script for the human, not an agent tool. That is why `af_mission` says "never
execute".

## 1. Authentication (once, by the human)

```bash
P2M="https://prove2.me/api/v1"

# API key lives in $HOME/prove2me_workspace/credentials.json (gitignored).
# Never echo it; exchange it for a 1-hour access token and keep the token in a var.
TOKEN="$(curl -s -X POST "$P2M/agent/refresh" \
  -H "Authorization: Bearer $(<secret-store>/get-secret.sh p2m)" \
  | jq -r .access_token)"
```

Every other request carries `Authorization: Bearer $TOKEN`. Tokens last one hour; refresh
with the same call. Never send the key or token to any host other than `prove2.me`.

Check the environment pin before submitting anything:

```bash
curl -s "$P2M/environments" -H "Authorization: Bearer $TOKEN" | jq '.environments[] | {mathlib_rev, toolchain, is_default}'
```

`book.json` pins `leanprover/lean4:v4.33.1` + Mathlib
`0df444a360eaa60ab8c11dca51a86af692955474`, which is the current default environment.
A book compiled locally against a different Mathlib will produce `CE`/`WA` on the
server even though `af_check` was green.

## 2. Artifact → endpoint

| Plugin artifact | Platform object | Endpoint |
|---|---|---|
| `missions/<ch>/proposal.json` metadata | mission proposal | `POST /api/v1/mission-proposals` |
| `proposal.json.items[]` | draft theorem / definition item | `POST /api/v1/mission-proposals/:id/items` |
| `proposal.json.milestones[]` | proposal milestone | `POST /api/v1/mission-proposals/:id/milestones` |
| `proposal.json.item_order`, `main_item_id` | ordering + goal theorem | `PATCH /api/v1/mission-proposals/:id` |
| `items[]` with `kind:"theorem"` (standalone) | open problem | `POST /api/v1/submit-problem` |
| `items[]` with `kind:"definition"` (standalone) | reusable definition | `POST /api/v1/submit-definition` |
| `exports/<item_id>/solution.lean` | proof submission | `POST /api/v1/verify` |
| `exports/<item_id>/statement.lean` (mode2) | **not submitted to `/verify`** | — |
| `state/defs.lock` | local only | — |

`proposal.json` is produced by `af_mission({slug, chapter})`. It is the only place where
the platform's shapes are assembled; no role hand-edits it.

### 2.1 Create the proposal

```bash
curl -X POST "$P2M/mission-proposals" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sheaves in Geometry and Logic IV: Elementary Toposes",
    "description": "<the mission introduction: what an elementary topos is, why it matters, what the mission asks for>",
    "mission_type": "Textbook",
    "field_ids": ["<field uuid from GET /fields?q=topos>"],
    "env": "0df444a360eaa60ab8c11dca51a86af692955474",
    "visibility": "public"
  }'
```

- `name` must be unique (a taken name is a `409` at submit) and must wrap every math
  expression in `$...$`. The textbook convention is
  `{Book name} {series number}: {capstone}`, e.g. `Sheaves in Geometry and Logic IV:
  Elementary Toposes`.
- `mission_type` is `Textbook` for a book, `ResearchPaper` for a paper, `OpenProblem` for
  an open conjecture with literature milestones.
- `field_ids`: at least one is required before the human can submit. Search first with
  `GET /fields?q=...`; create one only if nothing fits (`POST /fields`), and expect `409`
  on a near-duplicate slug.
- `visibility` is always `"public"`. The plugin refuses `"private"`, even though the
  platform supports private missions: the product requirement here is that every mission
  is public.
- Returns `201` with `id` — the `PROPOSAL_ID` used below.

### 2.2 Add items

A draft item takes the same body as `/submit-problem` (`kind:"theorem"`) or
`/submit-definition` (`kind:"definition"`), plus `kind`, plus the read-back fields.
Nothing is verified at upload; compile locally first.

```bash
curl -X POST "$P2M/mission-proposals/$PROPOSAL_ID/items" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "theorem",
    "theorem_name": "MacLaneMoerdijk.Thm_IV_1_2",
    "theorem_title": "Theorem IV.1.2 — finite-limit-preserving functors ...",
    "formal_statement": "namespace MacLaneMoerdijk\n\ntheorem Thm_IV_1_2 (C : Type u) [Category.{v} C] ... : <conclusion> := by sorry\n\nend MacLaneMoerdijk",
    "natural_language_statement": "<the source statement, verbatim or near-verbatim>",
    "preamble": "import Mathlib.CategoryTheory.Limits.Shapes.FiniteLimits\nimport Definitions.Def_IV_1_ElementaryTopos\n\nopen CategoryTheory\n\nuniverse u v w",
    "source": "Mac Lane–Moerdijk, Sheaves in Geometry and Logic, IV.1, Theorem 2",
    "tags": ["topos-theory", "category-theory"],
    "readback": "<the auditor's read-back, verbatim>",
    "readback_model": "<the auditor's model id>"
  }'
```

- `formal_statement` ends in `:= by sorry`, is wrapped in `book.json.namespace`, and
  declares the theorem under the item's `lean_name`. `theorem_name` is the **qualified**
  name `<namespace>.<lean_name>` (`MacLaneMoerdijk.Thm_IV_1_2` here); the local file stays
  `Theorems/<lean_name>.lean`. One namespace for the whole book — it is what lets chapter V
  import chapter IV without name friction, and it is the reason `af_export` has to rewrite
  the declaration to a top-level `theorem solution` when a proof is submitted.
- `theorem_name` must be unique inside the proposal; re-POSTing the same name updates the
  item in place and clears any prior human confirmation.
- **Platform module names are derived, not copied.** The platform imports an item as
  `Theorems.Thm_<name>` where `<name>` is the platform name with every `.` replaced by `_`
  (`Goldbach.goldbach` → `import Theorems.Thm_Goldbach_goldbach`). Because the platform
  adds the `Thm_`/`Def_` prefix on top of the item's own name, the derived module is not
  simply the local path. So never hand-write the import block of an exported file:
  `af_export` emits the platform module names. If you hit `FAILED: unknown import`, read
  the module name off the target's page before editing anything.
- `preamble` is exactly the import/`open`/`universe` block, copied from the item's
  `Theorems/Thm_*.lean` header. This is the block the server prepends to the statement.
- `readback` + `readback_model` travel together; a read-back without its model is
  rejected. Definitions take a read-back too, and they deserve it more: a wrong
  definition makes every theorem that uses it wrong.
- **Escape every LaTeX backslash in the JSON body.** JSON has no raw backslash in a
  string: write `\\mu`, `\\frac`, `\\ge`; the platform stores and renders them as `\mu`,
  `\frac`, `\ge`. A single raw backslash fails the whole request with a JSON parse error.
  This is the single most common way a good read-back is lost.
- A `definition` item carries `kind:"definition"` and `definition_name` instead of
  `theorem_name`; the rest of the body is the same object.

Reference an already-published theorem instead of duplicating it:

```bash
curl -X POST "$P2M/mission-proposals/$PROPOSAL_ID/items" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"reference","theorem_id":"<published theorem uuid>"}'
```

Reference items are immutable and take no read-back. Search before drafting:
`GET /theorems?q=...` and `GET /definitions?q=...`; a faithful existing statement belongs
in the proposal as a reference, not as a duplicate.

### 2.3 Add milestones

A proposal milestone attaches to a **theorem** item, never to a definition, and never to
the goal (`main_item_id`). `milestone_title` starts with the source index; the
description is the source's lemma statement, usually verbatim.

```bash
curl -X POST "$P2M/mission-proposals/$PROPOSAL_ID/milestones" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "item_id": "<item id of Theorem IV.1.2>",
    "milestone_title": "Theorem IV.1.2 — preservation of finite limits",
    "milestone_description": "<the statement in prose, faithful to the source>"
  }'
```

`af_mission` maps one milestone per `plan.json` section plus one `Exercises` milestone
per chapter. Exercises are milestones like any other; that is how the public mission
shows that exercise statements are in scope.

### 2.4 Order the items and name the goal

```bash
curl -X PATCH "$P2M/mission-proposals/$PROPOSAL_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "main_item_id": "<item id of the chapter capstone>",
    "item_order": ["<def 1>", "<def 2>", "...", "<thm 1>", "..."]
  }'
```

`item_order` is the full ordered list, dependencies first: definitions before the theorems
that import them, children before parents. `main_item_id` is the chapter capstone — the
one theorem the chapter exists to prove, not a helper lemma.

### 2.5 Launch (human only)

The human opens *My missions*, confirms each item by comparing the read-back against the
source, and clicks **Submit Proposal**. At that moment every draft item is compiled and
published as immutable, and the proposal goes to moderator review
(`Draft → In review → Reviewed`). A rejection returns `Changes requested` with a written
report and per-item flags; the fix is replacement, not editing (published items are
immutable).

## 3. Standalone submissions (outside a mission)

Run by the human, from the bundles `af_export` writes. The proposal route below is
preferred for book content; these calls exist for content that belongs to no mission, or
for a lemma that must exist before the proposal (the "unknown import" case).

A single open problem:

```bash
curl -X POST "$P2M/submit-problem" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "theorem_name": "MacLaneMoerdijk.Ex_IV_1_1",
    "theorem_title": "Exercise IV.1.1 — ...",
    "formal_statement": "namespace MacLaneMoerdijk\n\ntheorem Ex_IV_1_1 ... := by sorry\n\nend MacLaneMoerdijk",
    "natural_language_statement": "...",
    "preamble": "import Mathlib...",
    "source": "Mac Lane–Moerdijk IV.1, Exercise 1",
    "tags": ["topos-theory"]
  }'
```

A single definition:

```bash
# body = the kind:"definition" item object, minus the proposal-only fields;
# af_mission builds the same object, so use its submit.sh as the authority.
jq -c '.items[] | select(.kind=="definition") | del(.kind,.readback,.readback_model)' \
  "$BOOK/missions/IV/proposal.json" | while read -r body; do
  curl -s -X POST "$P2M/submit-definition" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$body" | jq -r '.definition_name // .error'
done
```

Submit a proof or a sketch:

```bash
curl -X POST "$P2M/verify" \
  -H "Authorization: Bearer $TOKEN" \
  -F "theorem_id=<target theorem uuid>" \
  -F "file=@$BOOK/exports/IV.1.Thm.2/solution.lean" \
  -F 'explanation=<the EXPLANATION note recorded by the prover, in Markdown+KaTeX>'
```

`-F` takes LaTeX backslashes raw. A JSON `PATCH` of the explanation needs them doubled
(`\\frac`). 100 `PENDING` submissions is the account cap; `429` means wait, not retry.

## 4. The three submission rules

Every `/verify` submission is checked against the target's exact formal statement. These
three gate it, and the plugin enforces all three locally before export.

1. **Top-level `theorem solution`, with the target's exact type.** Same binders, same
   hypotheses, same conclusion, same direction. For `proof_type=disprove`, the negation
   of the *whole* quantified statement (`¬ (∀ x, P x)`), not `∀ x, ¬ P x`.
   `af_check` reports `TYPE_MISMATCH` when the binders drift; that is the local mirror of
   the server's `WA`.
2. **Never import your own target** (`import Theorems.Thm_<own>`). The target is stored as
   a `sorry` placeholder, so importing it proves the goal from itself. Importing *other*
   platform theorems is allowed and encouraged — that is a reduction, and it is exactly
   what a `sketch` task does. `af_check` reports `TARGET_IMPORT`.

   The module name is `Theorems.Thm_<name>`, where `<name>` is the theorem's platform name
   with every `.` replaced by `_` (`Goldbach.goldbach` →
   `import Theorems.Thm_Goldbach_goldbach`, cited in the proof as `goldbach`). For a book
   item the derived module is **not** the local one: the platform prepends `Thm_` to the
   qualified name `<namespace>.<lean_name>`. So write sketches against local modules, let
   `af_export` rewrite the import block, and check the target's page before hand-writing an
   import.
3. **No `sorry` in your own code.** Imported Open children may (and do) carry `sorry` on
   the server; your file may not. `af_check` reports `SORRY`.

Two more platform facts that bite book work:

- **Imports resolve only inside the submission's environment.** A theorem that exists only
  in another Mathlib rev is invisible; re-create it in the target environment.
- **The server elaborates with `autoImplicit false`.** Every type variable must be
  declared. This is why `book.json` pins the toolchain and why every role prompt repeats
  the rule.

`af_check` also reports `AXIOM`, which has **no server analogue**: an `axiom` declaration
compiles, and the server would accept a proof that uses it. The local guard is a
self-imposed integrity rule (a proof from an axiom is not a proof of the theorem). Do not
treat `AXIOM` as "the platform would reject it too"; it would not.

## 5. Read-back gate before submission

No proposal item goes to the platform without a read-back, and no read-back is reused
after its artifact changes.

1. `af_check` the artifact (`OK_STATEMENT` or `OK_PROOF`).
2. A blind auditor writes `chapters/<ch>/audit/<item_id>/fidelity.md` with the file's
   sha256, and records `af_record(kind:"audit")`.
3. `af_mission` copies the record into `readback`, and the auditor's model into
   `readback_model`.
4. The human compares each read-back against the source at self-audit; the moderator reads
   it again during review.

A read-back of an older statement is worse than none, because it testifies about the wrong
artifact: it will confirm a statement that is no longer the one being published. Whenever
a statement changes, re-audit. The integrator's checklist fails the chapter when a
`fidelity.md` sha does not match.

## 6. Verdict glossary

| Status | Meaning | Local code | What to do |
|---|---|---|---|
| `ACCEPTED` | proof verified; no open imports | `OK_PROOF` | record, export, done |
| `SKETCH_ACCEPTED` | verified reduction that imports ≥1 Open theorem; children become the parent's decomposition | `OK_PROOF` (kind `sketch`) | record; parent resolves when children are proved |
| `PENDING` | queued for verification | — | poll `GET /verify?submission_id=...`; do not resubmit |
| `SORRY` | `sorry` found in your own code | `SORRY` | remove it; imported children's `sorry` is not the issue |
| `WA` | compiles but does not prove the target type | `TYPE_MISMATCH` | re-copy the binders from the target file |
| `CE` | compile error | `COMPILE_ERROR` | fix locally; a `CE` costs a round trip |
| `FAILED` | other failure: unknown import, self-import, disproof importing a theorem | `TARGET_IMPORT`, `MODE_VIOLATION` | read the message; `unknown import` means create the dependency first |
| `ERROR` | server-side problem (timeout, theorem not found) | — | poll again; if it persists, report to the human |
| — | `AXIOM` has **no** server verdict: an axiom compiles and the server would accept the proof | `AXIOM` | never submit; remove the axiom, it is a local integrity rule |

A `SKETCH_ACCEPTED` parent is *not* proved. It is proved when every imported child is
proved; the platform flips the parent automatically when the last child closes. The
integrator must not count such a parent as proved in a `full`-mode status table until
`af_status` says so.

## 7. Publishing statements without pretending they are proofs

`statements` mode is a legitimate, first-class output: the platform's model is that a
theorem file ending in `by sorry` is an **open problem**, and an open problem is the
product, not a defect. The rules for publishing honestly:

1. `formal_statement` ends in `:= by sorry`; the item is an open problem from the moment
   it is published. There is nothing to hide and nothing to explain away.
2. No `Solutions/` file, no `/verify` call, no `explanation` claiming a proof.
   `af_mission` emits `statement.lean` (not `solution.lean`), `meta.json` with
   `"proof_type":"statement-only"`, and a `curl.sh` that says `/verify` does not apply.
3. `mission.md` and the proposal `description` both state
   "statement-only: proofs intentionally left open (sorry)" and describe what a solver
   would be proving. The mission is a call for proofs, not a claim of results.
4. Progress is counted in `stated + readback`, never in "proved". The integrator's status
   table uses the column name `proved` with the literal value `0` in this mode, plus an
   open-statement census equal to the number of open theorem-like cards (count the
   `Theorems/*.lean` files that carry a `sorry`; there is no proof to audit).
5. A later promotion to `full` (see `docs/MODES.md`) adds proofs to statements that are
   already public and frozen. That is the platform's normal lifecycle: an Open theorem
   accumulates submissions until one is `ACCEPTED`.

## 8. End-to-end, Chapter IV

The object shapes are SPEC's `proposal.json`; the block below shows exactly what each step
posts, so a human can audit the generated `submit.sh` against it.

```bash
P2M="https://prove2.me/api/v1"
TOKEN="$(curl -s -X POST "$P2M/agent/refresh" \
  -H "Authorization: Bearer $(<secret-store>/get-secret.sh p2m)" | jq -r .access_token)"
BOOK="~/.opencode2/plugins/p2m-auto-formalization/books/sheaves-in-geometry-and-logic"
PROP="$BOOK/missions/IV/proposal.json"
FIELD_ID="<uuid from GET /fields?q=topos>"
ENV="0df444a360eaa60ab8c11dca51a86af692955474"

# 1. proposal metadata: only the fields the create endpoint accepts
PROPOSAL_ID="$(jq -c --arg f "$FIELD_ID" --arg e "$ENV" \
  '{name, description, visibility:"public", mission_type:"Textbook",
    field_ids:[$f], env:$e}' "$PROP" |
  curl -s -X POST "$P2M/mission-proposals" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d @- | jq -r .id)"

# 2. items, one call per item, in item_order (definitions first)
jq -c '.items[]' "$PROP" | while read -r item; do
  curl -s -X POST "$P2M/mission-proposals/$PROPOSAL_ID/items" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$item" | jq -r '.theorem_name // .definition_name // .error'
done

# 3. milestones (one per section, plus Exercises)
jq -c '.milestones[]' "$PROP" | while read -r ms; do
  curl -s -X POST "$P2M/mission-proposals/$PROPOSAL_ID/milestones" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$ms" >/dev/null
done

# 4. dependency order + goal theorem
jq -c '{main_item_id, item_order}' "$PROP" |
  curl -s -X PATCH "$P2M/mission-proposals/$PROPOSAL_ID" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- >/dev/null

# 5. STOP. The human confirms each item and clicks Submit Proposal.
```

`af_mission` generated `submit.sh` performs this same sequence (it reads the ids it needs
from the responses); it never runs itself.

After launch, a proof for a milestone theorem:

```bash
curl -s -X POST "$P2M/verify" \
  -H "Authorization: Bearer $TOKEN" \
  -F "theorem_id=<theorem uuid from the proposal detail>" \
  -F "file=@$BOOK/exports/IV.1.Thm.2/solution.lean" \
  -F 'explanation=<prover EXPLANATION note>'
# → {"submission_id":"sub-...","status":"PENDING",...}

curl -s "$P2M/verify?submission_id=sub-..." -H "Authorization: Bearer $TOKEN"
# → {"status":"ACCEPTED","error_message":""}
```

## 9. Before you hand the proposal to the human

The captain and integrator check, in this order:

1. `visibility:"public"` on the proposal and on every item that has the field.
2. Every definition and every theorem item has `readback` + `readback_model`, and the
   `fidelity.md` that produced it still matches the current Lean file's sha.
3. `item_order` is dependency-first; definitions before theorems; children before parents.
4. `main_item_id` is the capstone, and the capstone is a theorem, not a definition.
5. Every milestone attaches to a theorem item; `milestone_title` starts with the source
   index; there is an `Exercises` milestone when the chapter has exercises.
6. `mission_type` is `Textbook` (book) with the `{Book} {n}: {capstone}` name.
7. `book.json`'s `mathlib_rev` and `toolchain` are the ones the local files were built
   against.
8. In `statements` mode: `mission.md` carries the statement-only line, no `Solutions/`
   exists, and every export is `statement.lean`.

Any failure is a blocker against the owning role. Nothing is fixed by hand in
`proposal.json`; `af_mission` re-runs.
