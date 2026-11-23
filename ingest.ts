/**
 * Markdown ingestion for p2m-auto-formalization.
 *
 * The parser is deliberately narrow: it understands the heading/item grammar of
 * the source book scans and nothing else.
 *
 *   chapter heading   # IV Topoi
 *   section heading   # 1. Elementary topoi
 *   exercises heading # Exercises
 *   item start        Definition 1.1. / **Theorem 1.2.** / ...
 *
 * Part files overlap (part002 restarts at III.8, part003 at VI.6). Ingestion is
 * therefore idempotent by construction: the dedupe key is
 * (chapter, section, kind, ordinal-within-section), and the first occurrence
 * wins. A non-empty proof found in a later occurrence is merged into the kept
 * item, which is what makes a truncated first part usable.
 *
 * No state is appended: items.jsonl is always rewritten from scratch.
 */

import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import {
  AFError,
  ITEM_KINDS,
  type ItemKind,
  type Mode,
  abbrevOf,
  asString,
  asStringArray,
  isDefinition,
  isRecord,
  kindFromLabel,
  labelOf,
  leanNameFor,
  maybeMode,
  statementFileFor,
} from "./modes.ts"

export type Item = {
  id: string
  chapter: string
  chapter_title: string
  section: string
  section_title: string
  kind: ItemKind
  label: string
  number: string
  source: string
  statement_md: string
  proof_md: string
  depends_on: string[]
  lean_name: string
  lean_file: string
  status: string
  mode: Mode
  reuse: string
  readback: string | null
  notes: string
  exercise: boolean
  exercise_section: string
}

export type TocSection = {
  id: string
  title: string
  items: number
  exercises: number
}

export type TocChapter = {
  id: string
  title: string
  sections: TocSection[]
  items: number
  exercises: number
}

export type TocSource = {
  path: string
  bytes: number
  sha256: string
  chapters: string[]
}

export type Toc = {
  slug: string
  sources: TocSource[]
  chapters: TocChapter[]
  counts: {
    chapters: number
    sections: number
    items: number
    definitions: number
    exercises: number
  }
  generated_at: string
}

export type IngestResult = {
  toc: Toc
  items: Item[]
  /** Raw item occurrences across all parts (before overlap dedupe). */
  occurrences: number
}

// ---------------------------------------------------------------------------
// grammar
// ---------------------------------------------------------------------------

const CHAPTER = /^#\s+([IVX]+)\.?\s+(.+?)\s*$/
const SECTION = /^#\s+(\d+)\.\s+(.+?)\s*$/
const EXERCISES = /^#{1,2}\s+Exercises?\s*$/i
const ITEM =
  /^\s*\*{0,2}\s*(Definition|Theorem|Lemma|Proposition|Corollary|Example|Remark|Exercise)\b\s*([0-9]+(?:\.[0-9]+)*)?\s*[.:]?\s*\*{0,2}\s*(.*)$/i
const NUMBERED = /^(\d{1,3})[.)]\s+(\S.*)$/
const PROOF = /^\s*\*{0,2}\s*(?:Proof|Solution|Hint)\b\s*[.:]?\s*\*{0,2}\s*(.*)$/i

function cleanLines(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\*\*\s*$/, "")
    .trim()
}

function cleanTitle(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/^\s*\*|\*\s*$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.:;,]\s*$/, "")
    .trim()
}

type Draft = {
  kind: ItemKind
  label: string
  number: string
  chapter: string
  chapter_title: string
  section: string
  section_title: string
  exercise_section: string
  source: string
  statement: string[]
  proof: string[]
  in_proof: boolean
  exercise: boolean
}

type ChapterBucket = {
  id: string
  title: string
  sections: Map<string, { id: string; title: string }>
}

type ParseContext = {
  slug: string
  path: string
  chapters: Map<string, ChapterBucket>
  chapter: ChapterBucket | null
  section: { id: string; title: string } | null
  exerciseSection: string
  inExercises: boolean
  counters: Map<string, number>
  drafts: Item[]
  byKey: Map<string, Item>
  names: Set<string>
  chaptersTouched: Set<string>
  occurrences: number
}

function ensureChapter(ctx: ParseContext): ChapterBucket {
  if (ctx.chapter) return ctx.chapter
  const existing = ctx.chapters.get("0")
  const bucket: ChapterBucket = existing ?? { id: "0", title: "Front matter", sections: new Map() }
  ctx.chapters.set("0", bucket)
  ctx.chapter = bucket
  ctx.chaptersTouched.add("0")
  return bucket
}

function ensureSection(ctx: ParseContext): { id: string; title: string } {
  const chapter = ensureChapter(ctx)
  if (ctx.section) return ctx.section
  const section = { id: "0", title: "Chapter opener" }
  chapter.sections.set(section.id, section)
  ctx.section = section
  return section
}

function startDraft(
  ctx: ParseContext,
  kind: ItemKind,
  label: string,
  number: string,
  rest: string,
  line: number,
): Draft {
  const chapter = ensureChapter(ctx)
  const section = ensureSection(ctx)
  // Exercise Lean names use the last numbered section before the exercises.
  const exerciseSection =
    ctx.inExercises && section.id === "Exercises" ? ctx.exerciseSection || "0" : section.id
  return {
    kind,
    label,
    number,
    chapter: chapter.id,
    chapter_title: chapter.title,
    section: section.id,
    section_title: section.title,
    exercise_section: exerciseSection,
    source: `${ctx.path}:${line}`,
    statement: rest.trim() ? [rest.trim()] : [],
    proof: [],
    in_proof: false,
    exercise: kind === "exercise",
  }
}

function uniqueName(ctx: ParseContext, base: string): string {
  let name = base
  let n = 2
  while (ctx.names.has(name)) {
    name = `${base}_${n}`
    n += 1
  }
  ctx.names.add(name)
  return name
}

function flush(ctx: ParseContext, draft: Draft | null, mode: Mode): void {
  if (!draft) return
  ctx.occurrences += 1
  const base = `${draft.chapter}|${draft.section}|${draft.kind}`
  const ordinal = (ctx.counters.get(base) ?? 0) + 1
  ctx.counters.set(base, ordinal)
  const key = `${base}|${ordinal}`
  const statement = cleanLines(draft.statement)
  const proof = cleanLines(draft.proof)

  const existing = ctx.byKey.get(key)
  if (existing) {
    // Overlap: keep the first occurrence, absorb a proof the first part lost.
    if (!existing.proof_md && proof) existing.proof_md = proof
    if (!existing.statement_md && statement) existing.statement_md = statement
    if (!existing.notes && statement && existing.statement_md !== statement) {
      existing.notes = "overlapping occurrence differs from the first; first kept"
    }
    return
  }

  const leanBase =
    draft.kind === "exercise"
      ? leanNameFor({
          kind: "exercise",
          chapter: draft.chapter,
          section: draft.exercise_section,
          statement,
          ordinal,
        })
      : leanNameFor({
          kind: draft.kind,
          chapter: draft.chapter,
          section: draft.section,
          statement,
          ordinal,
        })
  const leanName = uniqueName(ctx, leanBase)
  const item: Item = {
    id: `${draft.chapter}.${draft.section}.${abbrevOf(draft.kind)}.${ordinal}`,
    chapter: draft.chapter,
    chapter_title: draft.chapter_title,
    section: draft.section,
    section_title: draft.section_title,
    kind: draft.kind,
    label: draft.label,
    number: draft.number,
    source: draft.source,
    statement_md: statement,
    proof_md: proof,
    depends_on: [],
    lean_name: leanName,
    lean_file: statementFileFor(draft.kind, leanName),
    status: "draft",
    mode,
    reuse: "?",
    readback: null,
    notes: "",
    exercise: draft.exercise,
    exercise_section: draft.exercise_section,
  }
  ctx.byKey.set(key, item)
  ctx.drafts.push(item)
}

// ---------------------------------------------------------------------------
// part parser
// ---------------------------------------------------------------------------

function parsePart(ctx: ParseContext, text: string, mode: Mode): void {
  const lines = text.split(/\r?\n/)
  let current: Draft | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ""
    const line = raw.trimEnd()
    const lineNo = index + 1
    const trimmed = line.trim()

    if (!trimmed) {
      if (current) (current.in_proof ? current.proof : current.statement).push("")
      continue
    }

    // --- structure headings -------------------------------------------------
    const chapterMatch = CHAPTER.exec(line)
    if (chapterMatch) {
      flush(ctx, current, mode)
      current = null
      const id = chapterMatch[1] ?? "0"
      const title = cleanTitle(chapterMatch[2] ?? "")
      const existing = ctx.chapters.get(id)
      const bucket: ChapterBucket = existing ?? { id, title, sections: new Map() }
      if (existing && !existing.title) existing.title = title
      ctx.chapters.set(id, bucket)
      ctx.chapter = bucket
      ctx.section = null
      ctx.exerciseSection = ""
      ctx.inExercises = false
      ctx.chaptersTouched.add(id)
      continue
    }

    if (EXERCISES.test(trimmed)) {
      flush(ctx, current, mode)
      current = null
      const chapter = ensureChapter(ctx)
      ctx.exerciseSection = ctx.section && ctx.section.id !== "Exercises" ? ctx.section.id : ctx.exerciseSection
      const section = { id: "Exercises", title: "Exercises" }
      chapter.sections.set(section.id, section)
      ctx.section = section
      ctx.inExercises = true
      continue
    }

    const sectionMatch = SECTION.exec(line)
    if (sectionMatch) {
      flush(ctx, current, mode)
      current = null
      const chapter = ensureChapter(ctx)
      const section = { id: sectionMatch[1] ?? "0", title: cleanTitle(sectionMatch[2] ?? "") }
      chapter.sections.set(section.id, section)
      ctx.section = section
      ctx.inExercises = false
      continue
    }

    if (trimmed.startsWith("#")) {
      // Unknown heading level: close the current item, keep the structure.
      flush(ctx, current, mode)
      current = null
      continue
    }

    // --- item starts --------------------------------------------------------
    const itemMatch = ITEM.exec(line)
    if (itemMatch) {
      const label = itemMatch[1] ?? ""
      let kind = kindFromLabel(label)
      if (!kind) continue
      // `Exercise` is only an item kind inside an exercises section; elsewhere it
      // is a cross-reference and belongs to the current item's text.
      if (kind === "exercise" && !ctx.inExercises) {
        if (current) (current.in_proof ? current.proof : current.statement).push(trimmed)
        continue
      }
      // Inside an exercises section the numbered form is the common one, but a
      // stray `Theorem 2.1` reference should not create a theorem card.
      if (ctx.inExercises && kind !== "exercise") kind = "exercise"
      flush(ctx, current, mode)
      current = startDraft(ctx, kind, labelOf(kind), itemMatch[2] ?? "", itemMatch[3] ?? "", lineNo)
      continue
    }

    if (ctx.inExercises && (!current || !current.in_proof)) {
      const numbered = NUMBERED.exec(line)
      if (numbered) {
        flush(ctx, current, mode)
        current = startDraft(ctx, "exercise", "Exercise", numbered[1] ?? "", numbered[2] ?? "", lineNo)
        continue
      }
    }

    // --- body ---------------------------------------------------------------
    if (!current) continue
    const proofMatch = PROOF.exec(line)
    if (proofMatch && !current.in_proof) {
      current.in_proof = true
      const rest = (proofMatch[1] ?? "").trim()
      if (rest) current.proof.push(rest)
      continue
    }
    if (current.in_proof) current.proof.push(line)
    else current.statement.push(line)
  }

  flush(ctx, current, mode)
}

// ---------------------------------------------------------------------------
// toc + entry point
// ---------------------------------------------------------------------------

function buildToc(slug: string, items: Item[], ctx: ParseContext, sources: TocSource[]): Toc {
  const chapters: TocChapter[] = []
  let sections = 0
  for (const bucket of ctx.chapters.values()) {
    if (bucket.id === "0" && items.every((item) => item.chapter !== "0")) continue
    const chapterItems = items.filter((item) => item.chapter === bucket.id)
    const sectionList: TocSection[] = []
    for (const section of bucket.sections.values()) {
      const inSection = chapterItems.filter((item) => item.section === section.id)
      if (inSection.length === 0 && section.id === "0") continue
      sectionList.push({
        id: section.id,
        title: section.title,
        items: inSection.filter((item) => !item.exercise).length,
        exercises: inSection.filter((item) => item.exercise).length,
      })
      if (section.id !== "Exercises") sections += 1
    }
    chapters.push({
      id: bucket.id,
      title: bucket.title,
      sections: sectionList,
      items: chapterItems.filter((item) => !item.exercise).length,
      exercises: chapterItems.filter((item) => item.exercise).length,
    })
  }

  const definitions = items.filter((item) => isDefinition(item.kind)).length
  const exercises = items.filter((item) => item.exercise).length
  return {
    slug,
    sources,
    chapters,
    counts: {
      chapters: chapters.length,
      sections,
      items: items.length - exercises,
      definitions,
      exercises,
    },
    generated_at: new Date().toISOString(),
  }
}

/**
 * Parse one or more Markdown parts. Files are read synchronously; the whole
 * ingest is a planning-time operation, not a hot path.
 */
export function parseSources(input: {
  slug: string
  partPaths: string[]
  mode: Mode
}): IngestResult {
  if (input.partPaths.length === 0) {
    throw new AFError("SOURCE_REQUIRED", "at least one source path is required")
  }
  const ctx: ParseContext = {
    slug: input.slug,
    path: "",
    chapters: new Map(),
    chapter: null,
    section: null,
    exerciseSection: "",
    inExercises: false,
    counters: new Map(),
    drafts: [],
    byKey: new Map(),
    names: new Set(),
    chaptersTouched: new Set(),
    occurrences: 0,
  }
  const sources: TocSource[] = []

  for (const partPath of input.partPaths) {
    const path = resolve(partPath)
    let text: string
    let size: number
    try {
      const stat = statSync(path)
      if (!stat.isFile()) throw new AFError("SOURCE_NOT_FILE", `source is not a file: ${path}`)
      size = stat.size
      text = readFileSync(path, "utf8")
    } catch (error) {
      if (error instanceof AFError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new AFError("SOURCE_MISSING", `cannot read source ${path}: ${message}`)
    }
    // Counters reset per part. This is what makes the overlapping restarts line
    // up with the first occurrence.
    ctx.counters = new Map()
    ctx.chapter = null
    ctx.section = null
    ctx.exerciseSection = ""
    ctx.inExercises = false
    ctx.path = path
    ctx.chaptersTouched = new Set()
    parsePart(ctx, text, input.mode)
    sources.push({
      path,
      bytes: size,
      sha256: createHash("sha256").update(text).digest("hex"),
      chapters: [...ctx.chaptersTouched],
    })
  }

  const items = ctx.drafts
  return { toc: buildToc(input.slug, items, ctx, sources), items, occurrences: ctx.occurrences }
}

// ---------------------------------------------------------------------------
// tolerant readers for externally generated books
// ---------------------------------------------------------------------------

/**
 * The bundled Sheaves seed was produced by a different parser: its toc uses
 * `source_paths` instead of `sources`, fully qualified section ids (`IV.1`),
 * item-id arrays plus `item_count`, and an `exercises` object per chapter. These
 * normalizers make one plugin read both that shape and the shape af_ingest
 * writes.
 */
export type TocBook = { source_paths?: string[] }

function bareSectionId(chapter: string, value: unknown, fallback: string): string {
  const id = asString(value)?.trim() || fallback
  if (id === "Exercises") return "Exercises"
  const prefix = `${chapter}.`
  if (id.startsWith(prefix)) return id.slice(prefix.length)
  if (id.includes(".")) return id.split(".").slice(1).join(".")
  return id
}

function countOf(raw: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = raw[key]
    if (Array.isArray(value)) return value.length
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return 0
}

/** Accept `items: string[] | number`, `item_count`, and a separate exercises block. */
export function normalizeSection(raw: unknown, chapter: string, fallbackId: string): TocSection | null {
  if (!isRecord(raw)) return null
  const id = bareSectionId(chapter, raw.id, fallbackId)
  if (!id) return null
  const title = asString(raw.title)?.trim() || (id === "Exercises" ? "Exercises" : `Section ${id}`)
  const count = countOf(raw, "items", "item_count")
  const extra = countOf(raw, "exercises", "exercise_count")
  if (id === "Exercises") {
    return { id, title, items: 0, exercises: Math.max(count, extra) }
  }
  return { id, title, items: count, exercises: extra }
}

export function normalizeToc(raw: unknown, book?: TocBook): Toc {
  if (!isRecord(raw)) throw new AFError("TOC_INVALID", "toc.json is not an object")
  const slug = asString(raw.slug) ?? "book"
  const bookSources = book?.source_paths && book.source_paths.length > 0 ? book.source_paths : asStringArray(raw.source_paths)
  const rawSources = Array.isArray(raw.sources) && raw.sources.length > 0 ? raw.sources : null
  const sources: TocSource[] = rawSources
    ? rawSources.map((entry, index) => {
        if (!isRecord(entry)) {
          return { path: asString(entry) ?? bookSources[index] ?? "", bytes: 0, sha256: "", chapters: [] }
        }
        return {
          path: asString(entry.path) ?? bookSources[index] ?? "",
          bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
          sha256: asString(entry.sha256) ?? "",
          chapters: asStringArray(entry.chapters),
        }
      })
    : bookSources.map((path) => ({ path, bytes: 0, sha256: "", chapters: [] }))

  const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : []
  const chapters: TocChapter[] = []
  for (const [index, entry] of rawChapters.entries()) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id) ?? String(index + 1)
    const title = asString(entry.title)?.trim() || `Chapter ${id}`
    const sections: TocSection[] = []
    const rawSections = Array.isArray(entry.sections) ? entry.sections : []
    for (const [position, sectionRaw] of rawSections.entries()) {
      const section = normalizeSection(sectionRaw, id, String(position + 1))
      if (section) sections.push(section)
    }
    // The seed keeps exercises outside `sections`; expose them as a milestone.
    if (isRecord(entry.exercises)) {
      const exercises = normalizeSection(entry.exercises, id, "Exercises")
      if (exercises && !sections.some((section) => section.id === "Exercises")) sections.push(exercises)
    }
    const plainItems = sections.filter((section) => section.id !== "Exercises").reduce((sum, section) => sum + section.items, 0)
    const plainExercises = sections.filter((section) => section.id === "Exercises").reduce((sum, section) => sum + section.exercises, 0)
    const items =
      Array.isArray(entry.items) || typeof entry.items === "number"
        ? countOf(entry, "items")
        : typeof entry.item_count === "number"
          ? entry.item_count
          : plainItems
    const exercises =
      Array.isArray(entry.exercises) || typeof entry.exercises === "number"
        ? countOf(entry, "exercises")
        : typeof entry.exercise_count === "number"
          ? entry.exercise_count
          : plainExercises
    chapters.push({ id, title, sections, items, exercises })
  }

  const countsRaw = isRecord(raw.counts) ? raw.counts : {}
  const byKind = isRecord(countsRaw.by_kind) ? countsRaw.by_kind : {}
  const summedItems = chapters.reduce((sum, chapter) => sum + chapter.items, 0)
  const summedExercises = chapters.reduce((sum, chapter) => sum + chapter.exercises, 0)
  const measuredSections = chapters.reduce(
    (sum, chapter) => sum + chapter.sections.filter((section) => section.id !== "Exercises").length,
    0,
  )
  const definitions =
    (typeof byKind.definition === "number" ? byKind.definition : undefined) ??
    (typeof countsRaw.definitions === "number" ? countsRaw.definitions : 0)

  return {
    slug,
    sources,
    chapters,
    counts: {
      chapters: chapters.length,
      sections: measuredSections,
      items: summedItems > 0 ? summedItems : typeof countsRaw.items === "number" ? countsRaw.items : 0,
      definitions,
      exercises:
        summedExercises > 0
          ? summedExercises
          : typeof countsRaw.exercises === "number"
            ? countsRaw.exercises
            : 0,
    },
    generated_at: asString(raw.generated_at) ?? new Date().toISOString(),
  }
}

/**
 * Normalize one items.jsonl record. Missing `number`, `exercise`,
 * `exercise_section`, `notes` and `readback` are the seed's known gaps.
 */
export function normalizeItem(raw: unknown): Item {
  if (!isRecord(raw)) throw new AFError("ITEMS_INVALID", "item record is not an object")
  const id = asString(raw.id)
  const chapter = asString(raw.chapter)
  const kindText = asString(raw.kind)
  if (!id || !chapter || !kindText) throw new AFError("ITEMS_INVALID", `item needs id/chapter/kind: ${JSON.stringify(raw).slice(0, 120)}`)
  if (!ITEM_KINDS.includes(kindText as ItemKind)) {
    throw new AFError("ITEMS_INVALID", `unknown item kind ${JSON.stringify(kindText)} in ${id}`)
  }
  const kind = kindText as ItemKind
  const section = asString(raw.section) ?? "0"
  const leanName = asString(raw.lean_name) ?? id
  return {
    id,
    chapter,
    chapter_title: asString(raw.chapter_title) ?? "",
    section,
    section_title: asString(raw.section_title) ?? "",
    kind,
    label: asString(raw.label) ?? labelOf(kind),
    number: asString(raw.number) ?? "",
    source: asString(raw.source) ?? "",
    statement_md: asString(raw.statement_md) ?? "",
    proof_md: asString(raw.proof_md) ?? "",
    depends_on: asStringArray(raw.depends_on),
    lean_name: leanName,
    lean_file: asString(raw.lean_file) ?? statementFileFor(kind, leanName),
    status: asString(raw.status) ?? "draft",
    mode: maybeMode(raw.mode) ?? "statements",
    reuse: asString(raw.reuse) ?? "?",
    readback: raw.readback === null || raw.readback === undefined ? null : asString(raw.readback) ?? null,
    notes: asString(raw.notes) ?? "",
    exercise: typeof raw.exercise === "boolean" ? raw.exercise : kind === "exercise",
    exercise_section: asString(raw.exercise_section) ?? (section === "Exercises" ? "Exercises" : ""),
  }
}

