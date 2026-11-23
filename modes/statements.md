# Mode `statements` — statement-complete, proof-open

Operational checklist for a chapter whose effective mode is `statements`
(`book.json.mode === "statements"`, or a `chapter_modes[chapter]` override).

## Invariants

- Each theorem-like card ends at `status: "stated"` with a non-empty `readback`.
- `Theorems/<lean_name>.lean` and `Exercises/<lean_name>.lean` end in
  `:= by sorry` and contain **exactly one** `sorry`.
- No `Solutions/<lean_name>.lean` may exist for a theorem-like item. A proof file
  in this mode is a hard `MODE_VIOLATION`.
- `af_next` never returns `sketch` or `prove`, even when a stale plan says
  `proof: "pending"`; the effective mode is recomputed from `book.json`.
- Public missions are expected to contain open goals. `mission.md` says
  "statement-only: proofs intentionally left open (sorry)".
- `af_export` writes `statement.lean` with `"proof_type": "statement-only"`.
  `/verify` is not applicable and `curl.sh` says so.

## Task order for one theorem-like card

1. `state` — write the formal statement in `Theorems/...` (or `Exercises/...`).
   Replace the `af:placeholder` sentinel and the placeholder type, but keep one
   `sorry` as the proof body.
2. `af_check` on the statement file. It must compile and report
   `OK_STATEMENT`, `sorry_count: 1`.
3. `audit` — compare the statement with the source and write the readback with
   `af_record(kind="audit", item_id=..., text=...)`.
4. Card is done. No proof task is ever created.

Definitions are still real Lean definitions, `sorry`-free, and become `audited`
after `af_check`.

## Per-card commands

```text
af_next(slug)                                  # define/state/audit only
af_check(slug, item_id)                        # exactly one sorry required
af_record(slug, kind="audit", item_id, text)   # readback
af_export(slug, item_id)                       # statement.lean bundle
af_mission(slug, chapter)                      # public open-problem mission
```

## Readback

The readback is the statement-smith's evidence that the Lean declaration says
what the book says. Write it as a short comparison:

```text
Source: "An elementary topos is a category with finite limits and power objects."
Lean:   `category`, `FiniteLimits`, `PowerObject` fields in the structure.
Verdict: matches; `HasPowerObjects` is the Mathlib spelling.
```

`af_status` keeps warning about a `stated` card without a readback until one is
recorded.

## Do not

- Do not create `Solutions/` for a theorem or exercise.
- Do not close the goal with a real proof "because it was easy": the mission is
  statement-only, and a zero-sorry statement is a mode violation here.
- Do not delete the final `sorry`; exactly one is required.
- Do not import `Theorems.<own name>`.
- Do not submit the statement bundle to `/verify`.
