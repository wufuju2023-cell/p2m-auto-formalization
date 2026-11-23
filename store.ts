/**
 * Storage, planning and verification layer for p2m-auto-formalization.
 *
 * This module deliberately has no dependency on the OpenCode runtime so that
 * tests/selftest.ts can drive the whole workflow from a plain process.
 *
 * Layout (all under booksDir, default ./books):
 *   books/<slug>/
 *     book.json  toc.json  items.jsonl  plan.json  WORKFLOW.md
 *     state/progress.json  state/workflow.jsonl  state/claims/<task>.lock
 *     missions/<chapter>/{proposal.json,mission.md,submit.sh}
 *     chapters/<chapter>/WORKFLOW.md
 *     exports/<item_id>/{solution.lean|statement.lean,meta.json,explanation.md,curl.sh}
 *
 * Lean sources live in book.json.lean_project (relative paths in items.jsonl are
 * relative to that project), because `lake env lean <file>` must run with the
 * project as cwd.
 */

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Item, Toc } from "./ingest.ts"
import { normalizeItem, normalizeToc, parseSources } from "./ingest.ts"
import type { Card, ChapterPlan, Plan } from "./plan.ts"
import { buildPlan } from "./plan.ts"
import type { Book, CheckCode, FileStage, MissionType, Mode, Role, TaskKind } from "./modes.ts"
import {
  AFError,
  DEFAULT_IMPORTS,
  MATHLIB_REV,
  TOOLCHAIN,
  asString,
  asStringArray,
  checkPolicy,
  countSorry,
  declaresName,
  derivedTags,
  forbiddenTokens,
  hasAdmit,
  hasPlaceholder,
  isDefinition,
  isRecord,
  isTheoremLike,
  maybeMissionType,
  maybeMode,
  modeOfChapter,
  namespaceFromTitle,
  normalizeMissionType,
  normalizeMode,
  normalizeNamespace,
  normalizeRole,
  proofFileFor,
  requireString,
  roleForTask,
  safeSlug,
  selfImport,
  stageOfPath,
  statementFileFor,
  taskAllowed,
} from "./modes.ts"
import { buildExport, buildMission } from "./prove2me.ts"

export const DEFAULT_ROOT = "."
export const DEFAULT_LEAN_TIMEOUT_MS = 600_000

export type StoreOptions = {
  root?: string
  booksDir?: string
  leanTimeoutMs?: number
  /** Testing hook: command used for lean (default "lake"). */
  lakeBin?: string
}

export type InitInput = {
  slug: string
  title: string
  authors?: string[]
  source_paths: string[]
  mode: Mode
  mission_type?: MissionType
  namespace?: string
  tags?: string[]
  lean_project: string
  visibility?: string
  include_exercises?: boolean
  chapter_modes?: Record<string, string>
  imports?: string[]
  toolchain?: string
  mathlib_rev?: string
}

export type Task = {
  id: string
  item_id: string
  chapter: string
  kind: TaskKind
  role: Role
  mode: Mode
  file: string
  source: string
  depends_on: string[]
  round: number
  instructions: string
}

export type CheckResult = {
  ok: true
  code: CheckCode
  sorry_count: number
  errors: string[]
  file: string
  mode: Mode
  item_id: string
  stage: FileStage
  status: string
  readback_required: boolean
  duration_ms: number
}

type Attempt = {
  count: number
  last_code: string
  sorry_count: number
  file: string
  checked_at: string
}

type Progress = {
  slug: string
  attempts: Record<string, Attempt>
  updated_at: string
}

type Context = {
  book: Book
  toc: Toc
  items: Item[]
  plan: Plan
  progress: Progress
}

const TASK_KIND_ORDER: readonly TaskKind[] = ["define", "state", "audit", "sketch", "prove", "integrate"]
const CHECK_PRIORITY: Record<CheckCode, number> = {
  AXIOM: 5,
  MODE_VIOLATION: 4,
  TYPE_MISMATCH: 3,
  SORRY: 2,
  COMPILE_ERROR: 1,
  OK_STATEMENT: 0,
  OK_PROOF: 0,
}
const ID_FOR_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TASK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function rand(bytes = 4): string {
  return randomBytes(bytes).toString("hex")
}

function nowISO(): string {
  return new Date().toISOString()
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST"
}

function assertInside(root: string, target: string): void {
  const base = resolve(root)
  const full = resolve(target)
  if (full !== base && !full.startsWith(base + sep)) {
    throw new AFError("PATH_OUTSIDE_ROOT", `refusing to write outside ${base}: ${full}`)
  }
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"))
}

function summarizeCompilerOutput(output: string): string[] {
  const lines = output.split("\n").map((line) => line.trimEnd())
  const errors = lines.filter((line) => /(^|\s)error:/.test(line) || /^\s*error\(/.test(line))
  const chosen = (errors.length > 0 ? errors : lines).filter((line) => line.trim().length > 0)
  return chosen.slice(0, 16).map((line) => clip(line, 800))
}

export class AFStore {
  readonly root: string
  readonly booksDir: string
  readonly leanTimeoutMs: number
  readonly lakeBin: string

  constructor(options: StoreOptions = {}) {
    this.root = resolve(options.root ?? DEFAULT_ROOT)
    this.booksDir = resolve(options.booksDir ?? join(this.root, "books"))
    const timeout = Number(options.leanTimeoutMs ?? DEFAULT_LEAN_TIMEOUT_MS)
    this.leanTimeoutMs = Number.isFinite(timeout) ? Math.max(1_000, Math.min(timeout, 1_800_000)) : DEFAULT_LEAN_TIMEOUT_MS
    this.lakeBin = options.lakeBin?.trim() || "lake"
  }

  // ------------------------------------------------------------------ paths

  bookDir(slug: string): string {
    return join(this.booksDir, safeSlug(slug))
  }

  bookPath(slug: string): string {
    return join(this.bookDir(slug), "book.json")
  }

  tocPath(slug: string): string {
    return join(this.bookDir(slug), "toc.json")
  }

  itemsPath(slug: string): string {
    return join(this.bookDir(slug), "items.jsonl")
  }

  planPath(slug: string): string {
    return join(this.bookDir(slug), "plan.json")
  }

  workflowPath(slug: string): string {
    return join(this.bookDir(slug), "WORKFLOW.md")
  }

  stateDir(slug: string): string {
    return join(this.bookDir(slug), "state")
  }

  claimsDir(slug: string): string {
    return join(this.stateDir(slug), "claims")
  }

  progressPath(slug: string): string {
    return join(this.stateDir(slug), "progress.json")
  }

  workflowJsonlPath(slug: string): string {
    return join(this.stateDir(slug), "workflow.jsonl")
  }

  missionsDir(slug: string): string {
    return join(this.bookDir(slug), "missions")
  }

  chaptersDir(slug: string): string {
    return join(this.bookDir(slug), "chapters")
  }

  exportsDir(slug: string): string {
    return join(this.bookDir(slug), "exports")
  }

  chapterLogPath(slug: string, chapter: string): string {
    return join(this.chaptersDir(slug), safeSegment(chapter), "WORKFLOW.md")
  }

  // ------------------------------------------------------------------- io

  private ensureDir(path: string): void {
    mkdirSync(path, { recursive: true })
  }

  /** temp + rename; every JSON/markdown write goes through here. */
  writeAtomic(path: string, data: string, mode?: number): void {
    assertInside(this.booksDir, path)
    this.ensureDir(dirname(path))
    const tmp = `${path}.${process.pid}.${rand()}.tmp`
    assertInside(this.booksDir, tmp)
    writeFileSync(tmp, data, "utf8")
    renameSync(tmp, path)
    if (mode !== undefined) {
      try {
        chmodSync(path, mode)
      } catch {
        // best effort on filesystems that do not support chmod
      }
    }
  }

  writeJson(path: string, value: unknown): void {
    this.writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
  }

  private append(path: string, text: string): void {
    assertInside(this.booksDir, path)
    this.ensureDir(dirname(path))
    appendFileSync(path, text, "utf8")
  }

  readText(path: string): string | null {
    try {
      return readFileSync(path, "utf8")
    } catch (error) {
      if (isENOENT(error)) return null
      throw error
    }
  }

  listBooks(): string[] {
    let entries: string[] = []
    try {
      entries = readdirSync(this.booksDir)
    } catch (error) {
      if (isENOENT(error)) return []
      throw error
    }
    return entries
      .filter((entry) => ID_FOR_FILE.test(entry))
      .filter((entry) => existsSync(join(this.booksDir, entry, "book.json")))
      .sort()
  }

  readBook(slug: string): Book {
    const path = this.bookPath(slug)
    let parsed: unknown
    try {
      parsed = readJsonFile(path)
    } catch (error) {
      if (isENOENT(error)) throw new AFError("BOOK_NOT_FOUND", `no book at ${this.bookDir(slug)}`)
      throw new AFError("BOOK_INVALID", `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isRecord(parsed)) throw new AFError("BOOK_INVALID", `book.json is not an object: ${path}`)
    const chapterModes: Record<string, Mode> = {}
    if (isRecord(parsed.chapter_modes)) {
      for (const [chapter, value] of Object.entries(parsed.chapter_modes)) {
        const mode = maybeMode(value)
        if (mode) chapterModes[chapter] = mode
      }
    }
    const mode = maybeMode(parsed.mode) ?? "statements"
    const title = asString(parsed.title) ?? safeSlug(slug)
    const namespace = asString(parsed.namespace)?.trim() || namespaceFromTitle(title)
    const tags = Array.isArray(parsed.tags) ? asStringArray(parsed.tags) : derivedTags(title, safeSlug(slug))
    return {
      slug: asString(parsed.slug) ?? safeSlug(slug),
      title,
      authors: asStringArray(parsed.authors),
      mode,
      chapter_modes: chapterModes,
      mission_type: maybeMissionType(parsed.mission_type) ?? "Textbook",
      namespace,
      tags,
      visibility: asString(parsed.visibility) ?? "public",
      materials: asString(parsed.materials) ?? "all",
      include_exercises: parsed.include_exercises !== false,
      source_paths: asStringArray(parsed.source_paths),
      lean_project: asString(parsed.lean_project) ?? "",
      toolchain: asString(parsed.toolchain) ?? TOOLCHAIN,
      mathlib_rev: asString(parsed.mathlib_rev) ?? MATHLIB_REV,
      imports: asStringArray(parsed.imports),
      created_at: asString(parsed.created_at) ?? nowISO(),
      updated_at: asString(parsed.updated_at) ?? nowISO(),
    }
  }

  writeBook(book: Book): void {
    book.updated_at = nowISO()
    this.writeJson(this.bookPath(book.slug), book)
  }

  readToc(slug: string, book?: Book): Toc {
    const path = this.tocPath(slug)
    try {
      const parsed = readJsonFile(path)
      return normalizeToc(parsed, book ?? { source_paths: asStringArray(isRecord(parsed) ? parsed.source_paths : undefined) })
    } catch (error) {
      if (isENOENT(error)) {
        return {
          slug,
          sources: (book?.source_paths ?? []).map((source) => ({ path: source, bytes: 0, sha256: "", chapters: [] })),
          chapters: [],
          counts: { chapters: 0, sections: 0, items: 0, definitions: 0, exercises: 0 },
          generated_at: nowISO(),
        }
      }
      if (error instanceof AFError) throw error
      throw new AFError("TOC_INVALID", `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  readItems(slug: string): Item[] {
    const text = this.readText(this.itemsPath(slug))
    if (text === null) return []
    const items: Item[] = []
    for (const raw of text.split("\n")) {
      const line = raw.trim()
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new AFError("ITEMS_INVALID", `items.jsonl has a non-JSON line: ${clip(line, 120)}`)
      }
      try {
        items.push(normalizeItem(parsed))
      } catch (error) {
        if (error instanceof AFError) throw error
        throw new AFError("ITEMS_INVALID", `items.jsonl has an invalid record: ${clip(line, 120)}`)
      }
    }
    return items
  }

  readPlan(slug: string): Plan | null {
    const text = this.readText(this.planPath(slug))
    if (text === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new AFError("PLAN_INVALID", `plan.json is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.chapters) || !Array.isArray(parsed.cards)) {
      throw new AFError("PLAN_INVALID", "plan.json must contain chapters[] and cards[]")
    }
    return parsed as Plan
  }

  readProgress(slug: string): Progress {
    const text = this.readText(this.progressPath(slug))
    if (text === null) return { slug, attempts: {}, updated_at: nowISO() }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed)) return { slug, attempts: {}, updated_at: nowISO() }
      const attempts: Record<string, Attempt> = {}
      if (isRecord(parsed.attempts)) {
        for (const [key, value] of Object.entries(parsed.attempts)) {
          if (!isRecord(value)) continue
          attempts[key] = {
            count: Number(value.count) || 0,
            last_code: asString(value.last_code) ?? "",
            sorry_count: Number(value.sorry_count) || 0,
            file: asString(value.file) ?? "",
            checked_at: asString(value.checked_at) ?? "",
          }
        }
      }
      return { slug, attempts, updated_at: asString(parsed.updated_at) ?? nowISO() }
    } catch {
      return { slug, attempts: {}, updated_at: nowISO() }
    }
  }

  private writeProgress(progress: Progress): void {
    progress.updated_at = nowISO()
    this.writeJson(this.progressPath(progress.slug), progress)
  }

  // ----------------------------------------------------------------- init

  init(input: InitInput): Record<string, unknown> {
    const slug = safeSlug(input.slug)
    const title = requireString(input.title, "title")
    const mode = normalizeMode(input.mode)
    if (input.visibility !== undefined && input.visibility !== "public") {
      throw new AFError("VISIBILITY_REQUIRED", `visibility must be "public" (got ${JSON.stringify(input.visibility)})`)
    }
    if (input.include_exercises === false) {
      throw new AFError("EXERCISES_REQUIRED", "include_exercises cannot be false: all book material, exercises included, is in scope")
    }
    if (!Array.isArray(input.source_paths) || input.source_paths.length === 0) {
      throw new AFError("SOURCE_REQUIRED", "source_paths must list at least one Markdown part")
    }
    const sources: string[] = []
    for (const raw of input.source_paths) {
      if (typeof raw !== "string" || !raw.trim()) throw new AFError("SOURCE_REQUIRED", "source_paths contains an empty path")
      const path = resolve(raw)
      let stat
      try {
        stat = statSync(path)
      } catch {
        throw new AFError("SOURCE_MISSING", `source does not exist: ${path}`)
      }
      if (!stat.isFile()) throw new AFError("SOURCE_NOT_FILE", `source is not a file: ${path}`)
      sources.push(path)
    }
    const leanProject = resolve(requireString(input.lean_project, "lean_project"))
    const chapterModes: Record<string, Mode> = {}
    if (input.chapter_modes !== undefined) {
      if (!isRecord(input.chapter_modes)) throw new AFError("INPUT_INVALID", "chapter_modes must be an object")
      for (const [chapter, value] of Object.entries(input.chapter_modes)) {
        chapterModes[chapter] = normalizeMode(value, `chapter_modes.${chapter}`)
      }
    }
    const imports = Array.isArray(input.imports) && input.imports.length > 0 ? input.imports : DEFAULT_IMPORTS

    const dir = this.bookDir(slug)
    const existed = existsSync(this.bookPath(slug))
    const previous = existed ? this.readBook(slug) : null
    const now = nowISO()
    const missionType = normalizeMissionType(input.mission_type ?? previous?.mission_type ?? "Textbook")
    const namespace =
      input.namespace !== undefined
        ? normalizeNamespace(input.namespace)
        : previous?.namespace ?? namespaceFromTitle(title)
    const tags = (
      input.tags !== undefined ? input.tags : previous?.tags ?? derivedTags(title, slug)
    )
      .map((tag) => tag.trim())
      .filter(Boolean)
    const book: Book = {
      slug,
      title,
      authors: Array.isArray(input.authors) ? input.authors.filter((entry): entry is string => typeof entry === "string") : [],
      mode,
      chapter_modes: chapterModes,
      mission_type: missionType,
      namespace,
      tags,
      visibility: "public",
      materials: "all",
      include_exercises: true,
      source_paths: sources,
      lean_project: leanProject,
      toolchain: input.toolchain ?? TOOLCHAIN,
      mathlib_rev: input.mathlib_rev ?? MATHLIB_REV,
      imports,
      created_at: previous?.created_at ?? now,
      updated_at: now,
    }

    this.ensureDir(dir)
    this.ensureDir(this.stateDir(slug))
    this.ensureDir(this.claimsDir(slug))
    this.ensureDir(this.missionsDir(slug))
    this.ensureDir(this.chaptersDir(slug))
    this.ensureDir(this.exportsDir(slug))
    this.writeJson(this.bookPath(slug), book)

    if (!existsSync(this.tocPath(slug))) {
      this.writeJson(this.tocPath(slug), {
        slug,
        sources: [],
        chapters: [],
        counts: { chapters: 0, sections: 0, items: 0, definitions: 0, exercises: 0 },
        generated_at: now,
      })
    }
    if (!existsSync(this.itemsPath(slug))) this.writeAtomic(this.itemsPath(slug), "")
    if (!existsSync(this.planPath(slug))) {
      this.writeJson(this.planPath(slug), {
        slug,
        title,
        mode,
        visibility: "public",
        created_at: now,
        updated_at: now,
        chapters: [],
        cards: [],
      })
    }
    if (!existsSync(this.workflowPath(slug))) {
      this.writeAtomic(this.workflowPath(slug), workflowHeader(book, ""))
    }
    this.ensureLeanLayout(book)

    const warnings: string[] = []
    if (!isDirectory(leanProject)) {
      warnings.push(`lean_project does not exist yet: ${leanProject}`)
    }
    return {
      ok: true,
      slug,
      root: dir,
      mode,
      mission_type: missionType,
      namespace,
      tags,
      visibility: "public",
      include_exercises: true,
      lean_project: leanProject,
      created: !existed,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  }

  /** Create the four Lean source directories, but only inside an existing project. */
  private ensureLeanLayout(book: Book): void {
    if (!book.lean_project) return
    let stat
    try {
      stat = statSync(book.lean_project)
    } catch {
      return
    }
    if (!stat.isDirectory()) return
    for (const name of ["Definitions", "Theorems", "Exercises", "Solutions"]) {
      const path = join(book.lean_project, name)
      try {
        mkdirSync(path, { recursive: true })
      } catch {
        // a read-only project is reported later by af_check
      }
    }
  }

  // --------------------------------------------------------------- ingest

  ingest(input: { slug: string; part_files?: string[]; include_exercises?: boolean }): Record<string, unknown> {
    if (input.include_exercises === false) {
      throw new AFError("EXERCISES_REQUIRED", "include_exercises cannot be false: exercises are part of the material")
    }
    const book = this.readBook(input.slug)
    const partPaths = input.part_files && input.part_files.length > 0 ? input.part_files : book.source_paths
    if (partPaths.length === 0) throw new AFError("SOURCE_REQUIRED", "book.json has no source_paths; pass part_files")
    const parsed = parseSources({ slug: book.slug, partPaths, mode: book.mode })
    this.writeJson(this.tocPath(book.slug), parsed.toc)
    this.writeAtomic(this.itemsPath(book.slug), parsed.items.map((item) => JSON.stringify(item)).join("\n") + "\n")
    book.source_paths = parsed.toc.sources.map((source) => source.path)
    this.writeBook(book)
    return {
      ok: true,
      slug: book.slug,
      chapters: parsed.toc.chapters.length,
      sections: parsed.toc.counts.sections,
      items: parsed.toc.counts.items,
      exercises: parsed.toc.counts.exercises,
      definitions: parsed.toc.counts.definitions,
      duplicates_merged: Math.max(0, parsed.occurrences - parsed.items.length),
      toc_path: this.tocPath(book.slug),
      items_path: this.itemsPath(book.slug),
      sources: parsed.toc.sources.map((source) => ({ path: source.path, chapters: source.chapters })),
    }
  }

  // ----------------------------------------------------------------- plan

  plan(slug: string): Record<string, unknown> {
    const book = this.readBook(slug)
    const toc = this.readToc(slug, book)
    const items = this.readItems(slug)
    if (items.length === 0) {
      throw new AFError("NO_ITEMS", "items.jsonl is empty; run af_ingest first")
    }
    const previous = this.readPlan(slug)
    const plan = buildPlan({ book, toc, items, previous })
    this.writeJson(this.planPath(slug), plan)
    for (const chapter of plan.chapters) {
      const logPath = this.chapterLogPath(slug, chapter.id)
      if (!existsSync(logPath)) this.writeAtomic(logPath, workflowHeader(book, chapter.id))
    }
    this.ensureLeanLayout(book)
    const milestones = plan.chapters.reduce((sum, chapter) => sum + chapter.milestones.length, 0)
    return {
      ok: true,
      slug,
      mode: plan.mode,
      chapters: plan.chapters.length,
      missions: plan.chapters.length,
      cards: plan.cards.length,
      milestones,
      plan_path: this.planPath(slug),
    }
  }

  // ------------------------------------------------------------- context

  private context(slug: string): Context {
    const book = this.readBook(slug)
    const toc = this.readToc(slug, book)
    const items = this.readItems(slug)
    const plan = this.readPlan(slug)
    if (!plan) throw new AFError("NOT_PLANNED", `plan.json is missing for ${slug}; run af_plan first`)
    return { book, toc, items, plan, progress: this.readProgress(slug) }
  }

  /** Public read-only snapshot, used by prove2me.ts and tests. */
  snapshot(slug: string): { book: Book; toc: Toc; items: Item[]; plan: Plan } {
    const ctx = this.context(slug)
    return { book: ctx.book, toc: ctx.toc, items: ctx.items, plan: ctx.plan }
  }

  // --------------------------------------------------------------- tasks

  private cardIndex(plan: Plan): Map<string, Card> {
    const map = new Map<string, Card>()
    for (const card of plan.cards) map.set(card.id, card)
    return map
  }

  /** Effective mode is recomputed from book.json, never trusted from a stale plan. */
  private effectiveMode(book: Book, chapter: string): Mode {
    return modeOfChapter(book, chapter)
  }

  private definitionDepsReady(card: Card, byId: Map<string, Card>): boolean {
    for (const depId of card.depends_on) {
      const dep = byId.get(depId)
      if (!dep) return false
      if (!isDefinition(dep.kind)) continue
      if (dep.status !== "audited" && dep.status !== "proved") return false
    }
    return true
  }

  private statementAudited(card: Card): boolean {
    return (card.status === "stated" || card.status === "proved") && Boolean(card.readback)
  }

  private childrenProved(card: Card, byId: Map<string, Card>): boolean {
    if (card.children.length === 0) return true
    return card.children.every((id) => byId.get(id)?.status === "proved")
  }

  /** Chapter completion recomputed against the effective mode, not a stale plan. */
  private chapterDone(chapter: ChapterPlan, plan: Plan, book: Book): boolean {
    const byId = this.cardIndex(plan)
    for (const id of chapter.cards) {
      const card = byId.get(id)
      if (!card) return false
      if (isDefinition(card.kind)) {
        if (card.status !== "audited" && card.status !== "proved") return false
        continue
      }
      if (this.effectiveMode(book, card.chapter) === "full") {
        if (card.status !== "proved") return false
      } else if (card.status !== "stated" || !card.readback) {
        return false
      }
    }
    return true
  }

  private roundOf(progress: Progress, key: string): number {
    return progress.attempts[key]?.count ?? 0
  }

  private taskId(itemID: string, kind: TaskKind, round: number): string {
    return `${itemID}.${kind}.r${round}`
  }

  private instructionsFor(task: {
    kind: TaskKind
    mode: Mode
    file: string
    source: string
    item_id: string
  }): string {
    switch (task.kind) {
      case "define":
        return `Write the Lean definition in ${task.file}. Replace the af:placeholder sentinel and the placeholder type. Then call af_check and af_record(kind="note").`
      case "state":
        return task.mode === "statements"
          ? `Write the formal statement in ${task.file}: exactly one sorry, no Solutions/ file, no proof. Then call af_check and af_record(kind="audit") with a readback.`
          : `Write the formal statement in ${task.file} (one sorry is allowed at this stage). Then call af_check on the statement file and af_record(kind="audit") with a readback.`
      case "audit":
        return `Read ${task.file} and compare it with the source ${task.source}. Record a readback with af_record(kind="audit", item_id="${task.item_id}", text=...).`
      case "sketch":
        return `Sketch the proof strategy for ${task.item_id} in af_record(kind="note"), then dispatch the child proof tasks. Do not write a sorry-free proof yet.`
      case "prove":
        return `Prove ${task.item_id} in ${task.file}. There must be zero sorry, no axiom/native_decide/unsafe, and no self-import. Then call af_check(${task.item_id}, "${task.file}") and af_record(kind="note").`
      case "integrate":
        return `Build the public mission with af_mission(${JSON.stringify(task.item_id)}) and attach the chapter log. Never call the network.`
    }
  }

  /** All currently ready, unclaimed tasks in SPEC priority order. */
  candidates(slug: string, role?: Role | null): Task[] {
    const ctx = this.context(slug)
    const byId = this.cardIndex(ctx.plan)
    const chapters = new Map<string, ChapterPlan>()
    for (const chapter of ctx.plan.chapters) chapters.set(chapter.id, chapter)
    const out: Record<TaskKind, Task[]> = {
      define: [],
      state: [],
      audit: [],
      sketch: [],
      prove: [],
      integrate: [],
    }

    for (const card of ctx.plan.cards) {
      const mode = this.effectiveMode(ctx.book, card.chapter)
      const allowed = (kind: TaskKind) => taskAllowed(mode, kind)
      const make = (kind: TaskKind, file: string, depends_on: string[], itemID = card.item_id): Task => ({
        id: this.taskId(itemID, kind, this.roundOf(ctx.progress, itemID)),
        item_id: itemID,
        chapter: card.chapter,
        kind,
        role: roleForTask(kind),
        mode,
        file,
        source: ctx.items.find((item) => item.id === card.item_id)?.source ?? "",
        depends_on,
        round: this.roundOf(ctx.progress, itemID),
        instructions: this.instructionsFor({
          kind,
          mode,
          file,
          source: ctx.items.find((item) => item.id === card.item_id)?.source ?? "",
          item_id: itemID,
        }),
      })

      if (isDefinition(card.kind) && card.status === "draft") {
        out.define.push(make("define", card.file, card.depends_on))
        continue
      }
      if (isDefinition(card.kind)) continue

      if (card.status === "planned" && allowed("state") && this.definitionDepsReady(card, byId)) {
        out.state.push(make("state", card.file, card.depends_on))
      }
      if (card.status === "stated" && !card.readback) {
        out.audit.push(make("audit", card.file, card.depends_on))
      }
      if (mode === "full" && allowed("sketch") && card.status === "stated" && this.statementAudited(card) && card.children.length > 0) {
        out.sketch.push(make("sketch", card.proof_file ?? card.file, card.depends_on))
      }
      if (
        mode === "full" &&
        allowed("prove") &&
        card.status === "stated" &&
        this.statementAudited(card) &&
        card.proof_file &&
        this.childrenProved(card, byId)
      ) {
        out.prove.push(make("prove", card.proof_file, card.depends_on))
      }
    }

    for (const chapter of ctx.plan.chapters) {
      if (chapter.status !== "planned") continue
      if (!this.chapterDone(chapter, ctx.plan, ctx.book)) continue
      const depsReady = chapter.depends_on.every((id) => chapters.get(id)?.status === "published")
      if (!depsReady) continue
      const itemID = `${chapter.id}.integrate`
      out.integrate.push({
        id: this.taskId(itemID, "integrate", this.roundOf(ctx.progress, itemID)),
        item_id: itemID,
        chapter: chapter.id,
        kind: "integrate",
        role: roleForTask("integrate"),
        mode: this.effectiveMode(ctx.book, chapter.id),
        file: `missions/${chapter.id}/mission.md`,
        source: `plan.json:${chapter.id}`,
        depends_on: chapter.depends_on,
        round: this.roundOf(ctx.progress, itemID),
        instructions: this.instructionsFor({
          kind: "integrate",
          mode: this.effectiveMode(ctx.book, chapter.id),
          file: `missions/${chapter.id}/mission.md`,
          source: `plan.json:${chapter.id}`,
          item_id: itemID,
        }),
      })
    }

    const tasks: Task[] = []
    for (const kind of TASK_KIND_ORDER) {
      for (const task of out[kind]) {
        if (!taskAllowed(task.mode, task.kind)) continue
        if (role && task.role !== role) continue
        tasks.push(task)
      }
    }
    return tasks
  }

  /** Atomic claim via exclusive-create of state/claims/<task_id>.lock. */
  private claim(slug: string, task: Task, worker: string): boolean {
    if (!TASK_FILE.test(task.id)) throw new AFError("TASK_ID_INVALID", `task id is not file-safe: ${task.id}`)
    const dir = this.claimsDir(slug)
    this.ensureDir(dir)
    const path = join(dir, `${task.id}.lock`)
    assertInside(this.booksDir, path)
    const payload = {
      task_id: task.id,
      item_id: task.item_id,
      chapter: task.chapter,
      kind: task.kind,
      mode: task.mode,
      worker,
      pid: process.pid,
      claimed_at: nowISO(),
    }
    try {
      writeFileSync(path, `${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "wx" })
      return true
    } catch (error) {
      if (isEEXIST(error)) return false
      throw error
    }
  }

  next(input: { slug: string; role?: string | null; worker: string }): Record<string, unknown> {
    const role = normalizeRole(input.role)
    const ctx = this.context(input.slug)
    const candidates = this.candidates(input.slug, role)
    for (const task of candidates) {
      if (!this.claim(input.slug, task, input.worker)) continue
      if (task.kind === "integrate") {
        const chapter = ctx.plan.chapters.find((entry) => entry.id === task.chapter)
        if (chapter) {
          chapter.status = "integrating"
          ctx.plan.updated_at = nowISO()
          this.writeJson(this.planPath(input.slug), ctx.plan)
        }
      }
      return {
        ok: true,
        task,
        dispatch: { to: "children", mode: "queue", text: dispatchText(ctx.book, task) },
        ready: candidates.length,
        book: { slug: ctx.book.slug, mode: ctx.book.mode, visibility: ctx.book.visibility },
      }
    }
    const reason =
      candidates.length > 0
        ? `${candidates.length} ready task(s), all already claimed`
        : this.explainEmpty(ctx)
    return { ok: true, task: null, reason, ready: 0 }
  }

  private explainEmpty(ctx: Context): string {
    const total = ctx.plan.cards.length
    const done = ctx.plan.cards.filter((card) => {
      if (isDefinition(card.kind)) return card.status === "audited" || card.status === "proved"
      if (this.effectiveMode(ctx.book, card.chapter) === "full") return card.status === "proved"
      return card.status === "stated" && Boolean(card.readback)
    }).length
    if (total === 0) return "plan has no cards; run af_plan"
    if (done === total) {
      const pending = ctx.plan.chapters.filter((chapter) => chapter.status === "planned").length
      const integrating = ctx.plan.chapters.filter((chapter) => chapter.status === "integrating").length
      if (pending > 0) {
        return `all cards are done; ${pending} chapter(s) still need af_mission (integrate) or a dependency is unpublished`
      }
      if (integrating > 0) {
        return `all cards are done; ${integrating} chapter mission(s) are built and awaiting the human launch; call af_record(kind:"mission", chapter) after launch`
      }
      return "book complete: every card is done and every chapter mission is published"
    }
    return `blocked: ${total - done} card(s) are not in a dispatchable state (check af_status warnings)`
  }

  // --------------------------------------------------------------- check

  leanProject(book: Book): string {
    if (!book.lean_project) throw new AFError("LEAN_PROJECT_MISSING", "book.json has no lean_project")
    const project = resolve(book.lean_project)
    let stat
    try {
      stat = statSync(project)
    } catch {
      throw new AFError("LEAN_PROJECT_MISSING", `lean_project does not exist: ${project}`)
    }
    if (!stat.isDirectory()) throw new AFError("LEAN_PROJECT_MISSING", `lean_project is not a directory: ${project}`)
    return project
  }

  /** Resolve a Lean source path against the book's project and forbid escapes. */
  resolveLeanFile(book: Book, pathOrRel: string): { abs: string; rel: string } {
    const project = this.leanProject(book)
    const abs = isAbsolute(pathOrRel) ? resolve(pathOrRel) : resolve(project, pathOrRel)
    assertInside(project, abs)
    return { abs, rel: relative(project, abs).split(sep).join("/") }
  }

  private defaultCheckFile(card: Card, mode: Mode): string {
    if (isDefinition(card.kind)) return card.file
    if (mode === "statements") return card.file
    return card.proof_file ?? card.file
  }

  private compile(file: string, project: string): Promise<{ code: number | null; output: string; timed_out: boolean; duration_ms: number }> {
    return new Promise((resolvePromise) => {
      const started = Date.now()
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${join(homedir(), ".elan", "bin")}:${process.env.PATH ?? ""}`,
      }
      let output = ""
      let timedOut = false
      let settled = false
      const finish = (code: number | null, extra?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (extra) output += `\n${extra}`
        resolvePromise({ code, output, timed_out: timedOut, duration_ms: Date.now() - started })
      }
      const child = spawn(this.lakeBin, ["env", "lean", file], {
        cwd: project,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, this.leanTimeoutMs)
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
      })
      child.on("error", (error) => finish(null, `spawn error: ${error.message}`))
      child.on("close", (code) => finish(code))
    })
  }

  async check(input: { slug: string; item_id: string; file?: string }): Promise<CheckResult> {
    const ctx = this.context(input.slug)
    const item = ctx.items.find((entry) => entry.id === input.item_id)
    if (!item) throw new AFError("UNKNOWN_ITEM", `unknown item_id: ${input.item_id}`)
    const card = ctx.plan.cards.find((entry) => entry.item_id === item.id)
    if (!card) throw new AFError("UNKNOWN_ITEM", `${item.id} has no card; run af_plan`)
    const mode = this.effectiveMode(ctx.book, item.chapter)
    const project = this.leanProject(ctx.book)
    const { abs, rel } = this.resolveLeanFile(
      ctx.book,
      input.file && input.file.trim() ? input.file : this.defaultCheckFile(card, mode),
    )
    const stage = stageOfPath(rel)
    const policy = checkPolicy(mode, item.kind, stage)
    const errors: string[] = []
    let code: CheckCode | null = null
    const setCode = (candidate: CheckCode, message: string) => {
      errors.push(message)
      if (code === null || CHECK_PRIORITY[candidate] > CHECK_PRIORITY[code]) code = candidate
    }

    const source = this.readText(abs)
    let sorryCount = 0
    let durationMs = 0

    if (source === null) {
      setCode("COMPILE_ERROR", `file not found: ${rel}`)
    } else {
      sorryCount = countSorry(source)
      for (const token of forbiddenTokens(source)) {
        setCode("AXIOM", `forbidden construct: ${token}`)
      }
      if (hasAdmit(source)) setCode("SORRY", "forbidden construct: admit")
      if (hasPlaceholder(source)) {
        setCode("TYPE_MISMATCH", `the af:placeholder sentinel is still present in ${rel}; replace the skeleton statement`)
      }
      if (!declaresName(source, card.lean_name) && !declaresName(source, "solution")) {
        setCode("TYPE_MISMATCH", `no top-level declaration of ${card.lean_name} (or solution) in ${rel}`)
      }
      const imported = selfImport(source, card.lean_name)
      if (imported) setCode("MODE_VIOLATION", `self-import of the target module ${imported}`)
      if (stage === "proof" && mode !== "full") {
        setCode("MODE_VIOLATION", `statements mode must not contain Solutions/ proof files (${rel})`)
      }
      if (policy.forbid_solutions && card.proof_file) {
        const proof = this.resolveLeanFile(ctx.book, card.proof_file)
        if (existsSync(proof.abs)) {
          setCode("MODE_VIOLATION", `statements mode forbids ${card.proof_file} for ${item.id}`)
        }
      }
      if (policy.sorry === "exactly-one" && sorryCount !== 1) {
        setCode("MODE_VIOLATION", `statements mode requires exactly one sorry in ${rel}; found ${sorryCount}`)
      }
      if (policy.sorry === "at-most-one" && sorryCount > 1) {
        setCode("MODE_VIOLATION", `a statement file may contain at most one sorry; found ${sorryCount}`)
      }
      if (policy.sorry === "none" && sorryCount > 0) {
        setCode("SORRY", `this file must be sorry-free; found ${sorryCount}`)
      }

      // Only plausible files are worth a compiler round-trip.
      if (code === null) {
        const result = await this.compile(rel, project)
        durationMs = result.duration_ms
        if (result.timed_out) {
          setCode("COMPILE_ERROR", `lake env lean timed out after ${this.leanTimeoutMs} ms`)
        } else if (result.code !== 0) {
          setCode("COMPILE_ERROR", `lake env lean exited with ${result.code ?? "null"}`)
          errors.push(...summarizeCompilerOutput(result.output))
        } else {
          code = policy.success
        }
      }
    }

    const finalCode: CheckCode = code ?? "COMPILE_ERROR"
    const success = finalCode === policy.success

    // Persist the outcome: plan.json owns card state, progress.json owns attempts.
    card.last_code = finalCode
    card.sorry_count = sorryCount
    if (success) {
      if (stage === "proof") card.status = "proved"
      else if (isDefinition(item.kind)) card.status = "audited"
      else card.status = "stated"
    } else {
      const count = (ctx.progress.attempts[item.id]?.count ?? 0) + 1
      ctx.progress.attempts[item.id] = {
        count,
        last_code: finalCode,
        sorry_count: sorryCount,
        file: rel,
        checked_at: nowISO(),
      }
      this.writeProgress(ctx.progress)
    }
    ctx.plan.updated_at = nowISO()
    this.writeJson(this.planPath(input.slug), ctx.plan)

    return {
      ok: true,
      code: finalCode,
      sorry_count: sorryCount,
      errors: success ? [] : errors,
      file: rel,
      mode,
      item_id: item.id,
      stage,
      status: card.status,
      readback_required: mode === "statements" && isTheoremLike(item.kind) && success,
      duration_ms: durationMs,
    }
  }

  // -------------------------------------------------------------- record

  record(input: {
    slug: string
    kind: string
    text: string
    item_id?: string
    chapter?: string
  }): Record<string, unknown> {
    const kind = input.kind.trim().toLowerCase()
    if (!(kind === "decision" || kind === "audit" || kind === "mission" || kind === "blocker" || kind === "handoff" || kind === "note")) {
      throw new AFError("RECORD_KIND_INVALID", `kind must be decision|audit|mission|blocker|handoff|note (got ${JSON.stringify(input.kind)})`)
    }
    const text = requireString(input.text, "text")
    const book = this.readBook(input.slug)
    const plan = this.readPlan(input.slug)
    const items = this.readItems(input.slug)
    const item = input.item_id ? items.find((entry) => entry.id === input.item_id) : undefined
    if (input.item_id && !item) throw new AFError("UNKNOWN_ITEM", `unknown item_id: ${input.item_id}`)
    const chapter = input.chapter?.trim() || item?.chapter || ""
    const iso = nowISO()
    const heading = `## ${iso} — ${kind}${item ? ` — ${item.id}` : ""}${chapter ? ` — chapter ${chapter}` : ""}`
    const block = `${heading}\n\n${clip(text, 20_000)}\n\n`

    if (!existsSync(this.workflowPath(input.slug))) {
      this.writeAtomic(this.workflowPath(input.slug), workflowHeader(book, ""))
    }
    this.append(this.workflowPath(input.slug), block)

    let chapterLog = ""
    if (chapter) {
      chapterLog = this.chapterLogPath(input.slug, chapter)
      if (!existsSync(chapterLog)) this.writeAtomic(chapterLog, workflowHeader(book, chapter))
      this.append(chapterLog, block)
    }

    this.append(
      this.workflowJsonlPath(input.slug),
      `${JSON.stringify({ ts: iso, kind, item_id: item?.id ?? input.item_id ?? null, chapter: chapter || null, text })}\n`,
    )

    let readback = false
    if (kind === "audit" && item && plan) {
      const card = plan.cards.find((entry) => entry.item_id === item.id)
      if (card) {
        card.readback = clip(text, 8_000)
        plan.updated_at = iso
        this.writeJson(this.planPath(input.slug), plan)
        readback = true
      }
    }
    if (kind === "mission" && chapter && plan) {
      const chapterPlan = plan.chapters.find((entry) => entry.id === chapter)
      if (chapterPlan) {
        chapterPlan.status = "published"
        plan.updated_at = iso
        this.writeJson(this.planPath(input.slug), plan)
      }
    }

    return {
      ok: true,
      workflow: this.workflowPath(input.slug),
      chapter_workflow: chapterLog || null,
      workflow_jsonl: this.workflowJsonlPath(input.slug),
      chapter: chapter || null,
      readback,
    }
  }

  // -------------------------------------------------------------- status

  status(slug: string): Record<string, unknown> {
    const book = this.readBook(slug)
    const toc = this.readToc(slug, book)
    const items = this.readItems(slug)
    const plan = this.readPlan(slug)
    const warnings: Array<{ code: string; detail: string }> = []
    const seen = new Set<string>()
    const warn = (code: string, detail: string) => {
      const key = `${code}|${detail}`
      if (seen.has(key)) return
      seen.add(key)
      warnings.push({ code, detail })
    }

    if (book.visibility !== "public") {
      warn("NON_PUBLIC_BOOK", `book.json visibility is ${JSON.stringify(book.visibility)}; every mission must be public`)
    }
    if (book.include_exercises === false) {
      warn("EXERCISES_DISABLED", "book.json has include_exercises=false; exercises are part of the material")
    }
    const knownChapters = new Set<string>([...toc.chapters.map((chapter) => chapter.id), ...items.map((item) => item.chapter)])
    for (const chapter of Object.keys(book.chapter_modes)) {
      if (!knownChapters.has(chapter)) {
        warn("UNKNOWN_CHAPTER_MODE", `chapter_modes.${chapter} does not match any chapter`)
      }
    }

    const byStatus: Record<string, number> = {}
    const byChapter: Record<string, { items: number; definitions: number; theorems: number; exercises: number; statuses: Record<string, number> }> = {}
    let definitions = 0
    let exercises = 0
    let theoremLike = 0

    for (const item of items) {
      if (isDefinition(item.kind)) definitions += 1
      else if (item.exercise) exercises += 1
      else theoremLike += 1
      const bucket = byChapter[item.chapter] ?? { items: 0, definitions: 0, theorems: 0, exercises: 0, statuses: {} }
      bucket.items += 1
      if (isDefinition(item.kind)) bucket.definitions += 1
      else if (item.exercise) bucket.exercises += 1
      else bucket.theorems += 1
      byChapter[item.chapter] = bucket
    }

    if (!plan) {
      warn("NOT_PLANNED", "plan.json is missing; run af_plan")
      return {
        ok: true,
        slug: book.slug,
        mode: book.mode,
        mission_type: book.mission_type,
        namespace: book.namespace,
        visibility: book.visibility,
        include_exercises: book.include_exercises,
        counts: { items: items.length, definitions, theorems: theoremLike, exercises, by_status: {}, by_chapter: byChapter },
        chapters: { planned: 0, integrating: 0, published: 0 },
        missions: { planned: 0, built: 0, public: 0 },
        frontier: [],
        warnings,
      }
    }

    if (plan.mode !== book.mode) {
      warn("PLAN_MODE_MISMATCH", `plan.json mode=${plan.mode} but book.json mode=${book.mode}; run af_plan`)
    }
    if (plan.visibility !== "public") {
      warn("NON_PUBLIC_MISSION", `plan.json visibility is ${JSON.stringify(plan.visibility)}`)
    }

    const byId = this.cardIndex(plan)
    const leanNames = new Map<string, string>()
    for (const card of plan.cards) {
      byStatus[card.status] = (byStatus[card.status] ?? 0) + 1
      const bucket = byChapter[card.chapter] ?? { items: 0, definitions: 0, theorems: 0, exercises: 0, statuses: {} }
      bucket.statuses[card.status] = (bucket.statuses[card.status] ?? 0) + 1
      byChapter[card.chapter] = bucket

      const mode = this.effectiveMode(book, card.chapter)
      if (leanNames.has(card.lean_name)) {
        warn("DUPLICATE_LEAN_NAME", `${card.lean_name} is used by ${leanNames.get(card.lean_name)} and ${card.id}`)
      } else {
        leanNames.set(card.lean_name, card.id)
      }
      if (isTheoremLike(card.kind) && card.status === "stated" && !card.readback) {
        warn("MISSING_READBACK", `${card.id} is stated but has no readback`)
      }
      for (const depId of card.depends_on) {
        if (!byId.has(depId)) warn("UNKNOWN_DEPENDENCY", `${card.id} depends on unknown ${depId}`)
      }
      if (isDefinition(card.kind)) continue
      if (mode === "statements") {
        if (card.proof !== "skipped") {
          warn("MODE_TASK_MISMATCH", `${card.id} is in a statements chapter but proof=${card.proof}`)
        }
        if (card.status === "proved") {
          warn("MODE_TASK_MISMATCH", `${card.id} is proved in a statements chapter`)
        }
        if (card.proof_file) {
          const proof = this.resolveLeanFileIfPossible(book, card.proof_file)
          if (proof && existsSync(proof.abs)) {
            warn("MODE_SOLUTIONS_PRESENT", `${card.proof_file} exists for ${card.id} in a statements chapter`)
          }
        }
      } else if (card.proof !== "pending" && card.status !== "proved") {
        warn("MODE_TASK_MISMATCH", `${card.id} is in a full chapter but proof=${card.proof}`)
      }
    }

    // Solutions/ sorry scan for full-mode chapters.
    if (book.lean_project && isDirectory(book.lean_project)) {
      let names: string[] = []
      try {
        names = readdirSync(join(book.lean_project, "Solutions")).filter((name) => name.endsWith(".lean"))
      } catch (error) {
        if (!isENOENT(error)) throw error
      }
      const hasStatementsChapter = plan.cards.some(
        (card) => this.effectiveMode(book, card.chapter) === "statements",
      )
      for (const name of names) {
        const rel = `Solutions/${name}`
        const card = plan.cards.find((entry) => entry.proof_file === rel)
        if (!card) {
          if (hasStatementsChapter) {
            warn("MODE_SOLUTIONS_PRESENT", `${rel} is not the proof file of any full-mode card`)
          }
          continue
        }
        if (this.effectiveMode(book, card.chapter) !== "full") continue
        const text = this.readText(join(book.lean_project, rel))
        if (text !== null && countSorry(text) > 0) {
          warn("SORRY_IN_SOLUTIONS", `${rel} still contains sorry`)
        }
      }
    } else {
      warn("LEAN_PROJECT_MISSING", "book.json lean_project is missing or not a directory")
    }

    for (const chapter of plan.chapters) {
      if (chapter.visibility !== "public") warn("NON_PUBLIC_MISSION", `${chapter.id} visibility is ${JSON.stringify(chapter.visibility)}`)
      for (const depId of chapter.depends_on) {
        if (!plan.chapters.some((entry) => entry.id === depId)) {
          warn("UNKNOWN_DEPENDENCY", `chapter ${chapter.id} depends on unknown chapter ${depId}`)
        }
      }
      if (chapter.status !== "published") {
        for (const cardId of chapter.cards) {
          const card = byId.get(cardId)
          if (!card) warn("UNKNOWN_CARD", `${chapter.id} lists unknown card ${cardId}`)
        }
      }
    }

    const published = new Set(plan.chapters.filter((chapter) => chapter.status === "published").map((chapter) => chapter.id))
    const frontier = plan.chapters
      .filter((chapter) => chapter.status !== "published" && chapter.depends_on.every((dep) => published.has(dep)))
      .map((chapter) => chapter.id)

    let built = 0
    let publicMissions = 0
    for (const chapter of plan.chapters) {
      const path = join(this.missionsDir(slug), safeSegment(chapter.id), "proposal.json")
      const text = this.readText(path)
      if (text === null) continue
      built += 1
      try {
        const parsed: unknown = JSON.parse(text)
        if (isRecord(parsed) && parsed.visibility === "public") publicMissions += 1
        else warn("NON_PUBLIC_MISSION", `${chapter.id}/proposal.json is not public`)
      } catch {
        warn("MISSION_INVALID", `${chapter.id}/proposal.json is not valid JSON`)
      }
    }

    return {
      ok: true,
      slug: book.slug,
      title: book.title,
      mode: book.mode,
      mission_type: book.mission_type,
      namespace: book.namespace,
      visibility: book.visibility,
      include_exercises: book.include_exercises,
      counts: {
        items: items.length,
        definitions,
        theorems: theoremLike,
        exercises,
        by_status: byStatus,
        by_chapter: byChapter,
      },
      chapters: {
        planned: plan.chapters.filter((chapter) => chapter.status === "planned").length,
        integrating: plan.chapters.filter((chapter) => chapter.status === "integrating").length,
        published: plan.chapters.filter((chapter) => chapter.status === "published").length,
      },
      missions: { planned: plan.chapters.length, built, public: publicMissions },
      frontier,
      next: this.candidates(slug).slice(0, 8).map((task) => ({ id: task.id, kind: task.kind, item_id: task.item_id, mode: task.mode })),
      warnings,
      toc_chapters: toc.chapters.length,
    }
  }

  private resolveLeanFileIfPossible(book: Book, rel: string): { abs: string; rel: string } | null {
    try {
      return this.resolveLeanFile(book, rel)
    } catch {
      return null
    }
  }

  // ------------------------------------------------------ mission + export

  mission(slug: string, chapterID: string): Record<string, unknown> {
    const ctx = this.context(slug)
    if (ctx.book.visibility !== "public") {
      throw new AFError("VISIBILITY_REQUIRED", `book.json visibility is ${JSON.stringify(ctx.book.visibility)}; mission proposals must be public`)
    }
    const chapter = ctx.plan.chapters.find((entry) => entry.id === chapterID)
    if (!chapter) throw new AFError("UNKNOWN_CHAPTER", `chapter ${chapterID} is not in plan.json`)
    // Publishing a proposal does not require the Lean project to exist yet: a
    // missing project simply means every formal_statement is a rendered skeleton
    // and the mission carries STATEMENT_FILE_MISSING warnings.
    const project = isDirectory(ctx.book.lean_project) ? resolve(ctx.book.lean_project) : ctx.book.lean_project
    const built = buildMission({
      book: ctx.book,
      toc: ctx.toc,
      items: ctx.items,
      plan: ctx.plan,
      chapter,
      project,
      read: (rel: string) => {
        try {
          const resolved = this.resolveLeanFile(ctx.book, rel)
          return this.readText(resolved.abs)
        } catch {
          return null
        }
      },
    })
    const dir = join(this.missionsDir(slug), safeSegment(chapter.id))
    this.writeJson(join(dir, "proposal.json"), built.proposal)
    this.writeAtomic(join(dir, "mission.md"), built.mission_md)
    this.writeAtomic(join(dir, "submit.sh"), built.submit_sh, 0o755)
    chapter.status = "integrating"
    ctx.plan.updated_at = nowISO()
    this.writeJson(this.planPath(slug), ctx.plan)
    this.append(this.workflowPath(slug), `## ${nowISO()} — mission — chapter ${chapter.id}\n\npublic proposal written to missions/${chapter.id}/proposal.json (not submitted; status=integrating)\n\n`)
    return {
      ok: true,
      slug,
      chapter: chapter.id,
      proposal_path: join(dir, "proposal.json"),
      mission_md: join(dir, "mission.md"),
      submit_sh: join(dir, "submit.sh"),
      visibility: "public",
      items: built.proposal.items.length,
      milestones: built.proposal.milestones.length,
      warnings: built.warnings,
    }
  }

  exportItem(slug: string, itemID: string): Record<string, unknown> {
    const ctx = this.context(slug)
    if (!ID_FOR_FILE.test(itemID)) throw new AFError("ITEM_ID_INVALID", `item id is not file-safe: ${itemID}`)
    const item = ctx.items.find((entry) => entry.id === itemID)
    if (!item) throw new AFError("UNKNOWN_ITEM", `unknown item_id: ${itemID}`)
    const card = ctx.plan.cards.find((entry) => entry.item_id === itemID)
    if (!card) throw new AFError("UNKNOWN_ITEM", `${itemID} has no card; run af_plan`)
    const mode = this.effectiveMode(ctx.book, item.chapter)
    const project = this.leanProject(ctx.book)
    const built = buildExport({
      book: ctx.book,
      item,
      card,
      mode,
      project,
      read: (rel: string) => {
        const resolved = this.resolveLeanFile(ctx.book, rel)
        return this.readText(resolved.abs)
      },
    })
    const dir = join(this.exportsDir(slug), itemID)
    for (const file of built.files) {
      this.writeAtomic(join(dir, file.name), file.content, file.name === "curl.sh" ? 0o755 : undefined)
    }
    return {
      ok: true,
      slug,
      item_id: item.id,
      dir,
      files: built.files.map((file) => file.name),
      proof_type: built.proof_type,
      mode,
      warnings: built.warnings,
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Chapter directory names are Roman numerals / short ids; keep them safe. */
function safeSegment(value: string): string {
  const text = value.trim()
  if (!text) throw new AFError("SEGMENT_INVALID", "empty path segment")
  if (/[/\\\0]/.test(text) || text === "." || text === "..") {
    throw new AFError("SEGMENT_INVALID", `unsafe path segment: ${JSON.stringify(value)}`)
  }
  return text
}

function workflowHeader(book: Book, chapter: string): string {
  const scope = chapter ? `Chapter ${chapter}` : "Book"
  return [
    `# ${scope} workflow — ${book.title}`,
    "",
    `- book: \`${book.slug}\``,
    `- mode: \`${book.mode}\``,
    `- visibility: \`${book.visibility}\``,
    `- lean_project: \`${book.lean_project}\``,
    "",
    "Append-only log. Every entry is written by `af_record` with an ISO timestamp.",
    "",
  ].join("\n")
}

function dispatchText(book: Book, task: Task): string {
  return [
    `## af task ${task.id}`,
    `book: ${book.slug} · chapter: ${task.chapter} · mode: ${task.mode} · role: ${task.role}`,
    `item: ${task.item_id} · kind: ${task.kind} · file: ${task.file}`,
    task.source ? `source: ${task.source}` : "source: plan.json",
    "",
    "1. Read the mode checklist `modes/" + task.mode + ".md` and the target file before editing.",
    "2. Edit only the file named above (never another card's file, never the source Markdown).",
    `3. ${task.instructions}`,
    "4. Verify with `af_check`; a check is only advisory until it returns OK_STATEMENT/OK_PROOF.",
    "5. Keep the mission public: never write a private proposal. Never call the network.",
  ].join("\n")
}
