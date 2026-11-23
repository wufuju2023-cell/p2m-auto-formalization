/**
 * Selftest for the storage/planning layer. No OpenCode runtime, no Lean, no
 * network: a fake `lake` executable makes `af_check` deterministic.
 *
 * Run: bun run tests/selftest.ts
 */

import assert from "node:assert/strict"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AFError,
  MATHLIB_REV,
  countSorry,
  isTheoremLike,
  modeOfChapter,
  preambleOfFile,
  renderItemFile,
  snakeName,
} from "../modes.ts"
import type { Mode } from "../modes.ts"
import { normalizeItem, normalizeToc } from "../ingest.ts"
import type { Item } from "../ingest.ts"
import type { Card, Plan } from "../plan.ts"
import { AFStore } from "../store.ts"

let failures = 0
let passes = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passes += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}`)
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  }
}

function expectCode(fn: () => unknown, code: string, label: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof AFError, `${label}: expected AFError, got ${String(error)}`)
      assert.equal(error.code, code, `${label}: expected code ${code}, got ${error.code}`)
      return true
    },
    label,
  )
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed), `${path} is not an object`)
  return parsed as Record<string, unknown>
}

function renderCard(item: Item, card: Card, mode: Mode): string {
  return renderItemFile({
    item: {
      id: item.id,
      kind: item.kind,
      label: item.label,
      number: item.number,
      chapter: item.chapter,
      chapter_title: item.chapter_title,
      section: item.section,
      section_title: item.section_title,
      source: item.source,
      statement_md: item.statement_md,
    },
    leanName: card.lean_name,
    mode,
    stage: card.kind === "definition" ? "definition" : "statement",
  })
}

const PART1 = `# Prologue

This front matter is not a chapter and must be ignored.

# I Sets and Functions

Chapter introduction.

# 1. Basic notions

**Definition 1.1.** A *widget* is a set equipped with a chosen element.

**Definition 1.2.** A morphism of widgets is a function preserving the chosen element.

**Theorem 1.1.** Every widget has exactly one chosen element.
*Proof.* Immediate from the definition.

**Lemma 1.2.** Widgets are closed under products.

# 2. Limits

**Definition 2.1.** A diagram is a functor from a small category.

# Exercises

**Exercise 1.** Show that the terminal widget is unique.
1. Construct a product of two widgets.
2. Prove that every limit is a widget.

# II Topoi

# 1. Elementary topoi

Definition 1.1. An elementary topos is a category with finite limits and power objects.

Theorem 1.1. Every elementary topos has a subobject classifier.
`

// part002 restarts at II.1: the two first items overlap part001 and only
// Theorem 1.2 / Definition 2.1 / Exercise 1 are new.
const PART2 = `# II Topoi

# 1. Elementary topoi

Definition 1.1. An elementary topos is a category with finite limits and power objects.

Theorem 1.1. Every elementary topos has a subobject classifier.
Proof. Standard, see Mac Lane IV.1.

Theorem 1.2. The category of sets is an elementary topos.

# 2. Sheaves

Definition 2.1. A sheaf is a presheaf satisfying the gluing condition.

# Exercises

Exercise 1. Verify that the category of sets is a topos.
`

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "p2m-af-selftest-"))
  const booksDir = join(root, "books")
  const project = join(root, "lean-project")
  const part1 = join(root, "part001.md")
  const part2 = join(root, "part002.md")
  mkdirSync(project, { recursive: true })
  writeFileSync(part1, PART1)
  writeFileSync(part2, PART2)

  // A fake lake that accepts every file. af_check still runs the real text
  // checks; only the compiler round-trip is stubbed.
  const fakeLake = join(root, "fake-lake.sh")
  writeFileSync(fakeLake, "#!/usr/bin/env bash\nexit 0\n")
  chmodSync(fakeLake, 0o755)
  const failingLake = join(root, "failing-lake.sh")
  writeFileSync(failingLake, "#!/usr/bin/env bash\necho 'error: synthetic compile failure' >&2\nexit 1\n")
  chmodSync(failingLake, 0o755)

  const store = new AFStore({ root, booksDir, lakeBin: fakeLake })
  const slug = "test-book"
  const base = {
    slug,
    title: "Test Book",
    authors: ["A. Author"],
    source_paths: [part1, part2],
    mode: "statements" as Mode,
    mission_type: "Textbook" as const,
    namespace: "TestBook",
    tags: ["topos-theory"],
    lean_project: project,
  }

  const writeLean = (rel: string, content: string): void => {
    const abs = join(project, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }

  await test("af_init creates a public statements book", () => {
    const result = store.init({ ...base, mode: "statements" })
    assert.equal(result.ok, true)
    assert.equal(result.slug, slug)
    assert.equal(result.mode, "statements")
    assert.equal(result.mission_type, "Textbook")
    assert.equal(result.namespace, "TestBook")
    assert.equal(result.visibility, "public")
    assert.equal(result.created, true)
    assert.ok(existsSync(store.bookPath(slug)))
    const book = readJson(store.bookPath(slug))
    assert.equal(book.mode, "statements")
    assert.equal(book.visibility, "public")
    assert.equal(book.include_exercises, true)
    assert.equal(book.materials, "all")
    assert.equal(book.mission_type, "Textbook")
    assert.equal(book.namespace, "TestBook")
    assert.deepEqual(book.tags, ["topos-theory"])
    for (const dir of ["state", "missions", "chapters", "exports"]) {
      assert.ok(existsSync(join(store.bookDir(slug), dir)), `${dir}/ was created`)
    }
    assert.ok(existsSync(join(project, "Definitions")))
    assert.ok(existsSync(join(project, "Solutions")))
  })

  await test("af_init rejects private, non-full/statements modes, disabled exercises and missing sources", () => {
    expectCode(() => store.init({ ...base, mode: "statements", visibility: "private" }), "VISIBILITY_REQUIRED", "private")
    expectCode(() => store.init({ ...base, mode: "both" as Mode }), "MODE_INVALID", "bad mode")
    expectCode(
      () => store.init({ ...base, mode: "statements", include_exercises: false }),
      "EXERCISES_REQUIRED",
      "no exercises",
    )
    expectCode(
      () => store.init({ ...base, mode: "statements", source_paths: [join(root, "missing.md")] }),
      "SOURCE_MISSING",
      "missing source",
    )
  })

  await test("af_ingest parses chapters/sections/items and dedupes overlapping parts", () => {
    const result = store.ingest({ slug })
    assert.equal(result.ok, true)
    assert.equal(result.chapters, 2)
    assert.equal(result.sections, 4)
    assert.equal(result.items, 9)
    assert.equal(result.exercises, 4)
    assert.equal(result.definitions, 5)
    assert.equal(result.duplicates_merged, 2)

    const items = store.readItems(slug)
    assert.equal(items.length, 13)
    const ids = items.map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length, "item ids are unique")

    const iiThm = items.find((item) => item.id === "II.1.Thm.1")
    assert.ok(iiThm, "II.1.Thm.1 exists exactly once")
    assert.match(iiThm.statement_md, /subobject classifier/)
    assert.match(iiThm.proof_md, /Mac Lane IV\.1/, "proof merged from the later overlapping part")

    const iiDef = items.find((item) => item.id === "II.1.Def.1")
    assert.ok(iiDef)
    assert.match(iiDef.statement_md, /power objects/)

    const toc = store.readToc(slug)
    const ii = toc.chapters.find((chapter) => chapter.id === "II")
    assert.ok(ii)
    assert.equal(ii.title, "Topoi")
    assert.equal(ii.sections.find((section) => section.id === "1")?.items, 3)
    assert.equal(toc.counts.definitions, 5)
  })

  await test("af_plan (statements) marks every theorem-like card skipped and emits no prove/sketch", () => {
    const result = store.plan(slug)
    assert.equal(result.mode, "statements")
    assert.equal(result.chapters, 2)
    assert.equal(result.missions, 2)
    assert.equal(result.cards, 13)

    const plan = store.readPlan(slug)
    assert.ok(plan)
    assert.equal(plan.visibility, "public")
    for (const chapter of plan.chapters) {
      assert.equal(chapter.visibility, "public")
      assert.ok(chapter.milestones.some((milestone) => milestone.id.endsWith(".Exercises")), `${chapter.id} has an Exercises milestone`)
      assert.deepEqual(chapter.depends_on, [])
    }
    assert.equal(plan.chapters.find((chapter) => chapter.id === "I")?.milestones.length, 3)
    assert.equal(plan.chapters.find((chapter) => chapter.id === "II")?.milestones.length, 3)

    for (const card of plan.cards) {
      if (card.kind === "definition") {
        assert.equal(card.proof, "not_applicable")
        assert.equal(card.status, "draft")
        assert.equal(card.proof_file, null)
      } else {
        assert.equal(card.mode, "statements")
        assert.equal(card.proof, "skipped", `${card.id} proof is skipped`)
        assert.equal(card.status, "planned", `${card.id} is planned`)
        assert.ok(card.proof_file?.startsWith("Solutions/"), `${card.id} has a proof path for full mode`)
      }
    }

    const tasks = store.candidates(slug)
    const kinds = new Set(tasks.map((task) => task.kind))
    assert.ok(kinds.has("define"), "definition tasks exist")
    assert.ok(kinds.has("state"), "statement tasks exist")
    assert.ok(!kinds.has("prove"), "statements mode never emits prove")
    assert.ok(!kinds.has("sketch"), "statements mode never emits sketch")
    assert.ok(tasks.every((task) => task.mode === "statements"))

    const proverTasks = store.next({ slug, role: "prover", worker: "selftest" })
    assert.equal(proverTasks.task, null, "a prover gets no task in statements mode")
  })

  await test("every generated theorem/exercise statement carries exactly one sorry; definitions carry none", () => {
    const plan = store.readPlan(slug)
    assert.ok(plan)
    const items = store.readItems(slug)
    const byId = new Map(items.map((item) => [item.id, item]))
    let theorems = 0
    let defs = 0
    for (const card of plan.cards) {
      const item = byId.get(card.item_id)
      assert.ok(item)
      const text = renderCard(item, card, "statements")
      if (card.kind === "definition") {
        defs += 1
        assert.equal(countSorry(text), 0, `${card.id} definition has no sorry`)
      } else {
        theorems += 1
        assert.equal(countSorry(text), 1, `${card.id} has exactly one sorry`)
        assert.match(text, /:= by[^\n]*\n  sorry/, `${card.id} ends in by/sorry`)
      }
    }
    assert.equal(defs, 5)
    assert.equal(theorems, 8)
  })

  await test("exercises are included as cards with Ex_<chapter>_<section>_<n> names", () => {
    const plan = store.readPlan(slug)
    assert.ok(plan)
    const exerciseCards = plan.cards.filter((card) => card.kind === "exercise")
    assert.equal(exerciseCards.length, 4)
    const names = exerciseCards.map((card) => card.lean_name).sort()
    assert.deepEqual(names, ["Ex_I_2_1", "Ex_I_2_2", "Ex_I_2_3", "Ex_II_2_1"].sort())
    assert.ok(plan.chapters.find((chapter) => chapter.id === "I")?.milestones.some((milestone) => milestone.id === "I.Exercises"))
  })

  await test("af_next claims atomically with wx lock files", () => {
    const first = store.next({ slug, worker: "selftest" }) as { task: { id: string } | null }
    const second = store.next({ slug, worker: "selftest" }) as { task: { id: string } | null }
    assert.ok(first.task)
    assert.ok(second.task)
    assert.notEqual(first.task.id, second.task.id)
    assert.ok(existsSync(join(store.claimsDir(slug), `${first.task.id}.lock`)))
    assert.ok(existsSync(join(store.claimsDir(slug), `${second.task.id}.lock`)))
    const third = store.next({ slug, worker: "selftest" }) as { task: { id: string } | null }
    assert.ok(third.task)
  })

  await test("af_mission (statements) emits the public platform shape", () => {
    const result = store.mission(slug, "I")
    assert.equal(result.ok, true)
    assert.equal(result.visibility, "public")
    const proposal = readJson(String(result.proposal_path))
    assert.equal(proposal.visibility, "public")
    assert.equal(proposal.mode, "statements")
    assert.equal(proposal.mission_type, "Textbook")
    assert.equal(proposal.namespace, "TestBook")
    assert.equal(proposal.env, MATHLIB_REV)
    assert.ok(typeof proposal.description === "string")
    assert.ok(!String(proposal.description).includes(root), "no absolute workspace path in the description")
    assert.ok(!/\/mnt\//.test(String(proposal.description)), "no /mnt path in the description")

    const items = proposal.items as Array<Record<string, unknown>>
    assert.equal(items.length, 8)
    const firstTheorem = items.findIndex((item) => item.kind !== "definition")
    assert.ok(firstTheorem > 0)
    assert.ok(items.slice(0, firstTheorem).every((item) => item.kind === "definition"), "definitions come first")
    for (const item of items) {
      assert.ok(item.kind === "definition" || item.kind === "theorem")
      assert.ok(!("item_id" in item), "no local item_id in the posted body")
      assert.ok(!("file" in item), "no local file in the posted body")
      assert.ok(!("mode" in item), "no local mode in the posted body")
      assert.ok(typeof item.theorem_title === "string" || typeof item.definition_title === "string")
      assert.ok(typeof item.preamble === "string" && item.preamble.includes("import Mathlib"))
      assert.ok(typeof item.source === "string" && !item.source.startsWith("/"))
      assert.ok(item.source.includes("Test Book"), "source is a citation")
      assert.ok(Array.isArray(item.tags) && item.tags.includes("topos-theory"))
      assert.equal(item.readback, "")
      assert.ok(!("readback_model" in item), "no readback_model without a readback")
      if (item.kind === "theorem") {
        assert.ok(String(item.theorem_name).startsWith("TestBook."))
        assert.match(String(item.formal_statement), /^namespace TestBook\n/)
        assert.match(String(item.formal_statement), /\nend TestBook$/)
        assert.match(String(item.formal_statement), /:= by\n  sorry/)
        assert.match(String(item.theorem_title), /^(Theorem|Lemma|Exercise) /)
      } else {
        assert.ok(String(item.definition_name).startsWith("TestBook."))
        assert.match(String(item.formal_statement), /^namespace TestBook\n/)
      }
    }

    const localItems = proposal.local_items as Array<Record<string, unknown>>
    assert.equal(localItems.length, items.length)
    assert.ok(localItems.every((entry) => typeof entry.item_id === "string" && typeof entry.platform_name === "string"))
    const chapterItems = store.readItems(slug).filter((item) => item.chapter === "I")
    const theorems = chapterItems.filter((item) => item.kind === "theorem" && !item.exercise)
    const capstone =
      theorems[theorems.length - 1] ??
      [...chapterItems].reverse().find((item) => isTheoremLike(item.kind) && !item.exercise)
    assert.ok(capstone, "a non-exercise capstone exists")
    const capstoneLocal = localItems.find((entry) => entry.item_id === capstone.id)
    assert.ok(capstoneLocal)
    assert.equal(proposal.main_item_id, capstoneLocal.platform_name, "capstone prefers the last theorem over a trailing lemma")

    const milestones = proposal.milestones as Array<Record<string, unknown>>
    assert.deepEqual(
      milestones.map((milestone) => String(milestone.milestone_title).split(" — ")[0]),
      ["I.1", "I.2", "I.Exercises"],
    )
    assert.ok(String(milestones[0]?.anchor_item).startsWith("TestBook."), "I.1 anchors to its first theorem")
    assert.equal(milestones[1]?.anchor_item, "", "I.2 has only a definition, so no anchor")
    assert.ok(String(milestones[2]?.anchor_item).startsWith("TestBook."), "Exercises anchor to the first exercise")

    const itemOrder = proposal.item_order as string[]
    assert.equal(itemOrder.length, items.length)
    assert.ok(itemOrder.every((name) => name.startsWith("TestBook.")))

    const missionMd = readFileSync(String(result.mission_md), "utf8")
    assert.match(missionMd, /statement-only: proofs intentionally left open \(sorry\)/)
    assert.ok(!missionMd.includes(root), "mission.md has no absolute workspace path")

    const submit = readFileSync(String(result.submit_sh), "utf8")
    assert.match(submit, /mission_type/)
    assert.match(submit, /visibility:"public"/)
    assert.match(submit, /env/)
    assert.match(submit, /milestone_title/)
    assert.match(submit, /item_order/)
    assert.match(submit, /refusing non-public proposal/)
    assert.match(submit, /\/mission-proposals/)
    assert.match(submit, /patch/)
    assert.doesNotMatch(submit, /--data-binary\s+@proposal\.json/)
    assert.doesNotMatch(submit, /<\s*proposal\.json/)
    assert.doesNotMatch(submit, /-d\s+@proposal\.json/)
  })

  await test("preambleOfFile copies imports/open/universe and excludes the declaration", () => {
    const source = [
      "import Mathlib.CategoryTheory.Limits.Shapes.FiniteLimits",
      "import Definitions.Def_IV_1_ElementaryTopos",
      "",
      "open CategoryTheory",
      "",
      "universe u v w",
      "",
      "/-- A theorem. -/",
      "theorem thm_x : True := by",
      "  trivial",
    ].join("\n")
    const preamble = preambleOfFile(source)
    assert.match(preamble, /import Mathlib\.CategoryTheory\.Limits\.Shapes\.FiniteLimits/)
    assert.match(preamble, /import Definitions\.Def_IV_1_ElementaryTopos/)
    assert.match(preamble, /open CategoryTheory/)
    assert.match(preamble, /universe u v w/)
    assert.ok(!preamble.includes("theorem thm_x"), "declaration is not part of the preamble")
    assert.equal(preambleOfFile("theorem y : True := by trivial"), "import Mathlib")
    assert.equal(snakeName("Thm_IV_1_ElementaryTopos"), "thm_iv_1_elementary_topos")
  })

  await test("chapter.goal_item overrides the capstone", () => {
    const plan = store.readPlan(slug)
    assert.ok(plan)
    const chapter = plan.chapters.find((entry) => entry.id === "I")
    assert.ok(chapter)
    const firstTheorem = plan.cards.find((card) => card.chapter === "I" && card.kind === "theorem")
    assert.ok(firstTheorem)
    chapter.goal_item = firstTheorem.item_id
    store.writeJson(store.planPath(slug), plan)

    const result = store.mission(slug, "I")
    const proposal = readJson(String(result.proposal_path))
    const local = (proposal.local_items as Array<Record<string, unknown>>).find(
      (entry) => entry.item_id === firstTheorem.item_id,
    )
    assert.ok(local)
    assert.equal(proposal.main_item_id, local.platform_name)

    const cleanup = store.readPlan(slug)
    assert.ok(cleanup)
    const cleanupChapter = cleanup.chapters.find((entry) => entry.id === "I")
    assert.ok(cleanupChapter)
    delete cleanupChapter.goal_item
    store.writeJson(store.planPath(slug), cleanup)
  })


  await test("af_export (statements) writes statement.lean with proof_type statement-only", () => {
    const result = store.exportItem(slug, "I.1.Thm.1")
    assert.equal(result.ok, true)
    assert.equal(result.proof_type, "statement-only")
    assert.deepEqual(result.files, ["statement.lean", "meta.json", "explanation.md", "curl.sh"])
    const dir = String(result.dir)
    const statement = readFileSync(join(dir, "statement.lean"), "utf8")
    assert.equal(countSorry(statement), 1)
    const meta = readJson(join(dir, "meta.json"))
    assert.equal(meta.proof_type, "statement-only")
    assert.equal(meta.submission, "not-applicable")
    const curl = readFileSync(join(dir, "curl.sh"), "utf8")
    assert.match(curl, /not applicable/)
    assert.ok(!existsSync(join(dir, "solution.lean")))
  })

  await test("af_check statements policy: exactly one sorry, no Solutions file", async () => {
    const plan = store.readPlan(slug)
    assert.ok(plan)
    const card = plan.cards.find((entry) => entry.item_id === "I.1.Thm.1")
    assert.ok(card)
    const declaration = (body: string): string => `import Mathlib\n\ntheorem ${card.lean_name} : True := by\n${body}\n`

    writeLean(card.file, declaration("  sorry"))
    const ok = await store.check({ slug, item_id: card.item_id })
    assert.equal(ok.code, "OK_STATEMENT")
    assert.equal(ok.sorry_count, 1)
    assert.equal(ok.mode, "statements")
    assert.equal(ok.status, "stated")
    assert.deepEqual(ok.errors, [])

    const missingReadback = store.status(slug) as { warnings: Array<{ code: string; detail: string }> }
    assert.ok(
      missingReadback.warnings.some((warning) => warning.code === "MISSING_READBACK" && warning.detail.includes(card.item_id)),
      "stated card without readback is warned",
    )

    const recorded = store.record({ slug, kind: "audit", item_id: card.item_id, text: "readback: matches the source" })
    assert.equal(recorded.readback, true)
    assert.match(readFileSync(store.workflowPath(slug), "utf8"), new RegExp(`— audit — ${card.item_id}`))
    assert.match(readFileSync(store.chapterLogPath(slug, card.chapter), "utf8"), new RegExp(card.item_id))
    assert.match(readFileSync(store.workflowJsonlPath(slug), "utf8"), /"kind":"audit"/)
    const afterReadback = store.status(slug) as { warnings: Array<{ code: string; detail: string }> }
    assert.ok(
      !afterReadback.warnings.some((warning) => warning.code === "MISSING_READBACK" && warning.detail.includes(card.item_id)),
      "readback clears the warning",
    )

    // Rebuilding the proposal must carry the readback + model, and read the real preamble.
    const rebuilt = store.mission(slug, "I")
    const rebuiltProposal = readJson(String(rebuilt.proposal_path))
    const rebuiltLocal = rebuiltProposal.local_items as Array<Record<string, unknown>>
    const rebuiltItems = rebuiltProposal.items as Array<Record<string, unknown>>
    const rebuiltIndex = rebuiltLocal.findIndex((entry) => entry.item_id === card.item_id)
    assert.ok(rebuiltIndex >= 0)
    const posted = rebuiltItems[rebuiltIndex]
    assert.ok(posted)
    assert.equal(posted.readback, "readback: matches the source")
    assert.equal(posted.readback_model, "p2m-af-auditor")
    assert.match(String(posted.preamble), /import Mathlib/)

    // A Solutions/ file in statements mode is a mode violation.
    const proofRel = `Solutions/${card.lean_name}.lean`
    writeLean(proofRel, declaration("  sorry"))
    const violation = await store.check({ slug, item_id: card.item_id })
    assert.equal(violation.code, "MODE_VIOLATION")
    assert.ok(violation.errors.some((error) => error.includes("Solutions")))
    const solutionsWarning = store.status(slug) as { warnings: Array<{ code: string; detail: string }> }
    assert.ok(solutionsWarning.warnings.some((warning) => warning.code === "MODE_SOLUTIONS_PRESENT"))
    rmSync(join(project, proofRel))

    writeLean(card.file, declaration("  trivial"))
    const zero = await store.check({ slug, item_id: card.item_id })
    assert.equal(zero.code, "MODE_VIOLATION")
    assert.equal(zero.sorry_count, 0)

    writeLean(card.file, declaration("  sorry\n  sorry"))
    const two = await store.check({ slug, item_id: card.item_id })
    assert.equal(two.code, "MODE_VIOLATION")
    assert.equal(two.sorry_count, 2)

    writeLean(card.file, `import Mathlib\n\naxiom badAxiom : False\n\ntheorem ${card.lean_name} : True := by\n  sorry\n`)
    const axiomatic = await store.check({ slug, item_id: card.item_id })
    assert.equal(axiomatic.code, "AXIOM")

    writeLean(
      card.file,
      `import Mathlib\nimport Theorems.${card.lean_name}\n\ntheorem ${card.lean_name} : True := by\n  sorry\n`,
    )
    const self = await store.check({ slug, item_id: card.item_id })
    assert.equal(self.code, "MODE_VIOLATION")
    assert.ok(self.errors.some((error) => error.includes("self-import")))

    writeLean(card.file, `import Mathlib\n\ntheorem ${card.lean_name} : True := by -- af:placeholder\n  sorry\n`)
    const placeholder = await store.check({ slug, item_id: card.item_id })
    assert.equal(placeholder.code, "TYPE_MISMATCH")

    writeLean(card.file, declaration("  sorry"))
    const restored = await store.check({ slug, item_id: card.item_id })
    assert.equal(restored.code, "OK_STATEMENT")
  })

  await test("definitions must be sorry-free and become audited", async () => {
    const plan = store.readPlan(slug)
    assert.ok(plan)
    const card = plan.cards.find((entry) => entry.kind === "definition")
    assert.ok(card)
    writeLean(card.file, `import Mathlib\n\ndef ${card.lean_name} : Prop := by\n  sorry\n`)
    const bad = await store.check({ slug, item_id: card.item_id })
    assert.equal(bad.code, "SORRY")
    assert.equal(bad.sorry_count, 1)

    writeLean(card.file, `import Mathlib\n\ndef ${card.lean_name} : Prop := True\n`)
    const ok = await store.check({ slug, item_id: card.item_id })
    assert.equal(ok.code, "OK_PROOF")
    assert.equal(ok.stage, "definition")
    assert.equal(ok.status, "audited")
  })

  await test("switching to full mode re-plans with prove tasks for leaves", async () => {
    const again = store.init({ ...base, mode: "full" })
    assert.equal(again.created, false, "re-init preserves the workspace")
    const result = store.plan(slug)
    assert.equal(result.mode, "full")

    const plan = store.readPlan(slug)
    assert.ok(plan)
    for (const card of plan.cards) {
      if (card.kind === "definition") {
        assert.equal(card.status, "draft", "mode change resets card state")
        assert.equal(card.proof, "not_applicable")
      } else {
        assert.equal(card.mode, "full")
        assert.equal(card.proof, "pending")
        assert.equal(card.status, "planned")
      }
    }

    // Simulate statements+audits recorded by the statement-smith/auditor roles.
    for (const card of plan.cards) {
      if (card.kind === "definition") card.status = "audited"
      else {
        card.status = "stated"
        card.readback = `readback for ${card.item_id}`
      }
    }
    store.writeJson(store.planPath(slug), plan)

    const tasks = store.candidates(slug)
    const prove = tasks.filter((task) => task.kind === "prove")
    assert.equal(prove.length, 8, "every theorem-like leaf gets a prove task")
    assert.ok(prove.every((task) => task.file.startsWith("Solutions/")))
    assert.equal(tasks.filter((task) => task.kind === "sketch").length, 0, "no children -> no sketch")
  })

  await test("af_check full mode requires a sorry-free Solutions file; export renames to theorem solution", async () => {
    const plan = store.readPlan(slug)
    assert.ok(plan)
    const card = plan.cards.find((entry) => entry.item_id === "I.1.Thm.1")
    assert.ok(card)
    assert.ok(card.proof_file)
    writeLean(card.proof_file, `import Mathlib\n\ntheorem ${card.lean_name} : True := by\n  trivial\n`)
    const ok = await store.check({ slug, item_id: card.item_id })
    assert.equal(ok.code, "OK_PROOF")
    assert.equal(ok.stage, "proof")
    assert.equal(ok.status, "proved")
    assert.equal(ok.sorry_count, 0)

    const result = store.exportItem(slug, card.item_id)
    assert.equal(result.proof_type, "prove")
    assert.deepEqual(result.files, ["solution.lean", "meta.json", "explanation.md", "curl.sh"])
    const dir = String(result.dir)
    const solution = readFileSync(join(dir, "solution.lean"), "utf8")
    assert.match(solution, /^theorem solution :/m)
    assert.equal(countSorry(solution), 0)
    const meta = readJson(join(dir, "meta.json"))
    assert.equal(meta.proof_type, "prove")
    assert.equal(meta.theorem_name, card.lean_name)
  })

  await test("af_status reports counts, frontier and no public-mission warnings", () => {
    const status = store.status(slug) as {
      mode: string
      counts: { items: number; definitions: number; exercises: number; by_status: Record<string, number> }
      missions: { planned: number; built: number; public: number }
      frontier: string[]
      warnings: Array<{ code: string; detail: string }>
    }
    assert.equal(status.mode, "full")
    assert.equal(status.counts.items, 13)
    assert.equal(status.counts.definitions, 5)
    assert.equal(status.counts.exercises, 4)
    assert.ok((status.counts.by_status.proved ?? 0) >= 1)
    assert.equal(status.missions.public, 1)
    assert.ok(Array.isArray(status.frontier))
    const codes = new Set(status.warnings.map((warning) => warning.code))
    assert.ok(!codes.has("NON_PUBLIC_BOOK"))
    assert.ok(!codes.has("NON_PUBLIC_MISSION"))
    assert.ok(!codes.has("SORRY_IN_SOLUTIONS"))
    assert.ok(!codes.has("MODE_TASK_MISMATCH"))
  })

  await test("af_mission refuses a non-public book", () => {
    const book = store.readBook(slug)
    book.visibility = "private"
    store.writeBook(book)
    expectCode(() => store.mission(slug, "II"), "VISIBILITY_REQUIRED", "private mission")
    const restored = store.readBook(slug)
    restored.visibility = "public"
    store.writeBook(restored)
  })

  await test("per-chapter mode override wins over the book mode", () => {
    const book = store.readBook(slug)
    book.mode = "statements"
    book.chapter_modes = { II: "full" }
    store.writeBook(book)
    assert.equal(modeOfChapter(book, "I"), "statements")
    assert.equal(modeOfChapter(book, "II"), "full")
    store.plan(slug)
    const plan = store.readPlan(slug)
    assert.ok(plan)
    const iiCard = plan.cards.find((card) => card.chapter === "II" && card.kind === "theorem")
    const iCard = plan.cards.find((card) => card.chapter === "I" && card.kind === "theorem")
    assert.ok(iiCard && iCard)
    assert.equal(iiCard.mode, "full")
    assert.equal(iiCard.proof, "pending")
    assert.equal(iCard.mode, "statements")
    assert.equal(iCard.proof, "skipped")
    book.chapter_modes = {}
    store.writeBook(book)
  })

  await test("plan.json survives a re-plan and keeps architect dependencies", () => {
    const before = store.readPlan(slug)
    assert.ok(before)
    const target = before.cards.find((card) => card.kind === "definition")
    assert.ok(target)
    const dependent = before.cards.find((card) => card.item_id !== target.item_id && card.kind !== "definition")
    assert.ok(dependent)
    dependent.depends_on = [target.item_id]
    store.writeJson(store.planPath(slug), before)
    store.plan(slug)
    const after = store.readPlan(slug)
    assert.ok(after)
    assert.deepEqual(after.cards.find((card) => card.item_id === dependent.item_id)?.depends_on, [target.item_id])
  })

  await test("bundled Sheaves seed normalizes, plans and builds public missions", () => {
    const seedSource = join(dirname(fileURLToPath(import.meta.url)), "..", "books", "sheaves-in-geometry-and-logic")
    assert.ok(existsSync(join(seedSource, "toc.json")), `seed missing at ${seedSource}`)
    const seedSlug = "sheaves-in-geometry-and-logic"
    const seedTarget = join(booksDir, seedSlug)
    mkdirSync(seedTarget, { recursive: true })
    for (const file of ["book.json", "toc.json", "items.jsonl"]) {
      copyFileSync(join(seedSource, file), join(seedTarget, file))
    }
    // Keep the test hermetic: the copied book points at a temp project.
    const seedBookPath = join(seedTarget, "book.json")
    const seedBookRaw = readJson(seedBookPath)
    seedBookRaw.lean_project = join(root, "seed-project")
    writeFileSync(seedBookPath, `${JSON.stringify(seedBookRaw, null, 2)}\n`)

    // --- tolerance of the seed's toc shape ---------------------------------
    const rawToc: unknown = JSON.parse(readFileSync(join(seedTarget, "toc.json"), "utf8"))
    const normalizedNoBook = normalizeToc(rawToc)
    assert.equal(normalizedNoBook.chapters.length, 11)
    assert.equal(normalizedNoBook.counts.sections, 96)
    assert.equal(normalizedNoBook.sources.length, 4, "sources synthesized from raw.source_paths")
    const normalizedWithBook = normalizeToc(rawToc, { source_paths: [part1] })
    assert.deepEqual(normalizedWithBook.sources.map((source) => source.path), [part1], "book.source_paths wins")

    // --- tolerance of the seed's item shape --------------------------------
    const rawLines = readFileSync(join(seedTarget, "items.jsonl"), "utf8").split("\n").filter(Boolean)
    const rawDef = JSON.parse(rawLines[0] ?? "{}")
    const def = normalizeItem(rawDef)
    assert.equal(def.number, "")
    assert.equal(def.exercise, false)
    assert.equal(def.exercise_section, "")
    assert.equal(def.notes, "")
    assert.equal(def.readback, null)
    assert.deepEqual(def.depends_on, [])
    const rawExercise = rawLines.map((line) => JSON.parse(line)).find((item) => item.kind === "exercise")
    assert.ok(rawExercise)
    const exercise = normalizeItem(rawExercise)
    assert.equal(exercise.exercise, true)
    assert.equal(exercise.exercise_section, "Exercises")
    assert.equal(exercise.number, "")

    // --- plan --------------------------------------------------------------
    const planned = store.plan(seedSlug)
    assert.equal(planned.chapters, 11)
    assert.equal(planned.cards, 451)
    const seedPlan = store.readPlan(seedSlug)
    assert.ok(seedPlan)
    assert.equal(seedPlan.chapters.length, 11)
    assert.equal(seedPlan.cards.length, 451)
    const seedToc = store.readToc(seedSlug)
    assert.equal(seedToc.counts.sections, 96)
    assert.equal(seedPlan.chapters.find((chapter) => chapter.id === "IV")?.cards.length, 57)
    const seedBook = store.readBook(seedSlug)
    assert.equal(modeOfChapter(seedBook, "I"), "statements")
    assert.equal(modeOfChapter(seedBook, "IV"), "full")
    assert.equal(seedBook.namespace, "MacLaneMoerdijk")
    assert.equal(seedBook.mission_type, "Textbook")
    assert.deepEqual(seedBook.tags, ["topos-theory"])

    const seedStatus = store.status(seedSlug) as {
      counts: { items: number; exercises: number }
      warnings: Array<{ code: string; detail: string }>
    }
    assert.equal(seedStatus.counts.items, 451, "af_status reads the normalized items")
    assert.equal(seedStatus.counts.exercises, 130)
    assert.ok(Array.isArray(seedStatus.warnings))

    // --- missions ----------------------------------------------------------
    const missionI = store.mission(seedSlug, "I")
    assert.equal(missionI.ok, true)
    assert.equal(missionI.visibility, "public")
    const propI = readJson(String(missionI.proposal_path))
    assert.equal(propI.visibility, "public")
    assert.equal(propI.namespace, "MacLaneMoerdijk")
    assert.equal(propI.mission_type, "Textbook")
    const itemsI = propI.items as Array<Record<string, unknown>>
    assert.equal(itemsI.length, 28)
    assert.ok(itemsI.every((item) => !("item_id" in item) && !("file" in item) && !("mode" in item)))
    assert.ok(itemsI.every((item) => typeof item.source === "string" && !item.source.startsWith("/")))
    assert.ok(!String(propI.description).includes("/data/"), "description has no absolute data path")
    assert.deepEqual(propI.sources, seedBook.source_paths, "local proposal keeps the source list")

    const missionIV = store.mission(seedSlug, "IV")
    assert.equal(missionIV.ok, true)
    const propIV = readJson(String(missionIV.proposal_path))
    assert.equal(propIV.mode, "full")
    assert.equal((propIV.items as unknown[]).length, 57)

    const missionA = store.mission(seedSlug, "A")
    assert.equal(missionA.ok, true)
    assert.equal(missionA.visibility, "public")
    const propA = readJson(String(missionA.proposal_path))
    assert.equal(propA.visibility, "public")
    assert.equal((propA.items as unknown[]).length, 15)
    assert.equal((propA.milestones as unknown[]).length, 4, "Appendix has four section milestones and no empty Exercises milestone")
  })

  console.log("")
  console.log(`selftest: ${passes} passed, ${failures} failed`)
  console.log(`workspace: ${root}`)
  if (failures > 0) process.exit(1)
}

await main()
