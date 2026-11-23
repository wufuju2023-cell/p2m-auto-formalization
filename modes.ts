/**
 * p2m-auto-formalization — domain types, mode rules and Lean file renderers.
 *
 * This module is pure: no I/O and no imports beyond the TypeScript runtime.
 * Everything mode-specific (which task kinds exist, how many `sorry`s a file is
 * allowed to contain, where a file lives) is decided here so that store.ts,
 * prove2me.ts and the tools cannot drift apart.
 */

export const TOOLCHAIN = "leanprover/lean4:v4.33.1"
export const MATHLIB_REV = "0df444a360eaa60ab8c11dca51a86af692955474"
export const DEFAULT_IMPORTS = ["Mathlib"]
export const STATEMENT_SORRY = "sorry"
export const PLACEHOLDER = "af:placeholder"

export type Mode = "full" | "statements"
export type MissionType = "Textbook" | "ResearchPaper" | "OpenProblem"
export type ItemKind =
  | "definition"
  | "theorem"
  | "lemma"
  | "proposition"
  | "corollary"
  | "example"
  | "remark"
  | "exercise"

export type TaskKind = "define" | "state" | "audit" | "sketch" | "prove" | "integrate"
export type Role = "architect" | "statement-smith" | "auditor" | "prover" | "integrator"
export type CardStatus = "planned" | "draft" | "stated" | "proved" | "audited"
export type ChapterStatus = "planned" | "integrating" | "published"
export type ProofState = "pending" | "skipped" | "not_applicable"
export type FileStage = "definition" | "statement" | "proof"
export type CheckCode =
  | "OK_STATEMENT"
  | "OK_PROOF"
  | "SORRY"
  | "AXIOM"
  | "MODE_VIOLATION"
  | "COMPILE_ERROR"
  | "TYPE_MISMATCH"

export const MODES: readonly Mode[] = ["full", "statements"]
export const MISSION_TYPES: readonly MissionType[] = ["Textbook", "ResearchPaper", "OpenProblem"]
export const TASK_KINDS: readonly TaskKind[] = ["define", "state", "audit", "sketch", "prove", "integrate"]
export const ROLES: readonly Role[] = ["architect", "statement-smith", "auditor", "prover", "integrator"]
export const RECORD_KINDS = ["decision", "audit", "mission", "blocker", "handoff", "note"] as const
export type RecordKind = (typeof RECORD_KINDS)[number]

export const ITEM_KINDS: readonly ItemKind[] = [
  "definition",
  "theorem",
  "lemma",
  "proposition",
  "corollary",
  "example",
  "remark",
  "exercise",
]

/** A typed error whose `code` is surfaced verbatim by every tool. */
export class AFError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "AFError"
    this.code = code
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

export function requireString(value: unknown, label: string): string {
  const text = asString(value)?.trim()
  if (!text) throw new AFError("INPUT_INVALID", `${label} is required`)
  return text
}

export function normalizeMode(value: unknown, label = "mode"): Mode {
  const text = asString(value)?.trim().toLowerCase()
  if (text === "full" || text === "statements") return text
  throw new AFError("MODE_INVALID", `${label} must be "full" or "statements" (got ${JSON.stringify(value)})`)
}

export function maybeMode(value: unknown): Mode | null {
  const text = asString(value)?.trim().toLowerCase()
  return text === "full" || text === "statements" ? text : null
}

export function normalizeRole(value: unknown): Role | null {
  const text = asString(value)?.trim().toLowerCase()
  if (!text) return null
  for (const role of ROLES) if (role === text) return role
  throw new AFError("ROLE_INVALID", `unknown role ${JSON.stringify(value)}; expected one of ${ROLES.join(", ")}`)
}

export function maybeMissionType(value: unknown): MissionType | null {
  const text = asString(value)?.trim().toLowerCase()
  if (!text) return null
  for (const type of MISSION_TYPES) if (type.toLowerCase() === text) return type
  return null
}

/** Platform mission type; defaults to Textbook for a book pipeline. */
export function normalizeMissionType(value: unknown, fallback: MissionType = "Textbook"): MissionType {
  const text = asString(value)?.trim()
  if (!text) return fallback
  const found = maybeMissionType(text)
  if (found) return found
  throw new AFError("MISSION_TYPE_INVALID", `mission_type must be one of ${MISSION_TYPES.join(", ")} (got ${JSON.stringify(value)})`)
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Book slugs become directory names, so keep them boring. */
export function safeSlug(value: unknown): string {
  const text = requireString(value, "slug").toLowerCase()
  if (!SLUG.test(text)) {
    throw new AFError("SLUG_INVALID", `slug must match ${SLUG.source}: ${JSON.stringify(value)}`)
  }
  return text
}

// ---------------------------------------------------------------------------
// book / plan shapes
// ---------------------------------------------------------------------------

/**
 * On-disk book.json. `visibility` is typed as string because status must be
 * able to read (and warn about) a hand-edited non-public book.
 */
export type Book = {
  slug: string
  title: string
  authors: string[]
  mode: Mode
  chapter_modes: Record<string, Mode>
  mission_type: MissionType
  namespace: string
  tags: string[]
  visibility: string
  materials: string
  include_exercises: boolean
  source_paths: string[]
  lean_project: string
  toolchain: string
  mathlib_rev: string
  imports?: string[]
  created_at: string
  updated_at: string
}

const LEAN_NAMESPACE = /^[A-Za-z][A-Za-z0-9_.]*$/

/** Strict validator for an explicit af_init namespace. */
export function normalizeNamespace(value: unknown): string {
  const text = requireString(value, "namespace")
  if (!LEAN_NAMESPACE.test(text)) {
    throw new AFError("NAMESPACE_INVALID", `namespace must match ${LEAN_NAMESPACE.source}: ${JSON.stringify(value)}`)
  }
  return text
}

/** Lenient cleanup for a namespace read from disk or derived from a title. */
export function sanitizeNamespace(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.]/g, "")
  if (!cleaned) return "Book"
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `Book${cleaned}`
}

/** PascalCase a title into a book-wide Lean namespace (e.g. `MacLaneMoerdijk`). */
export function namespaceFromTitle(title: string): string {
  const words = title
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word.toLowerCase()))
  const joined = words.map(pascal).join("").slice(0, 48)
  return sanitizeNamespace(joined)
}

/** The single namespace shared by every mission of a book. */
export function bookNamespace(book: Pick<Book, "namespace" | "title">): string {
  const explicit = asString(book.namespace)?.trim()
  return explicit ? sanitizeNamespace(explicit) : namespaceFromTitle(book.title)
}

/** Lean names are PascalCase; platform item names are lower_snake_case. */
export function snakeName(leanName: string): string {
  const snake = leanName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
  return snake || "item"
}

/** Default tags when book.json does not carry an explicit list. */
export function derivedTags(title: string, slug: string): string[] {
  const haystack = `${title} ${slug}`.toLowerCase()
  return /topos|topoi|sheaf|sheaves/.test(haystack) ? ["topos-theory"] : []
}

/** Effective mode: a per-chapter override always wins over the book mode. */
export function modeOfChapter(book: Book, chapter: string): Mode {
  const override = maybeMode(book.chapter_modes?.[chapter])
  return override ?? maybeMode(book.mode) ?? "statements"
}

// ---------------------------------------------------------------------------
// item kinds
// ---------------------------------------------------------------------------

type KindMeta = {
  label: string
  abbrev: string
  dir: string
  /** Proof-bearing (theorem-like) rather than definitional. */
  theorem_like: boolean
}

export const KIND_META: Record<ItemKind, KindMeta> = {
  definition: { label: "Definition", abbrev: "Def", dir: "Definitions", theorem_like: false },
  theorem: { label: "Theorem", abbrev: "Thm", dir: "Theorems", theorem_like: true },
  lemma: { label: "Lemma", abbrev: "Lem", dir: "Theorems", theorem_like: true },
  proposition: { label: "Proposition", abbrev: "Prop", dir: "Theorems", theorem_like: true },
  corollary: { label: "Corollary", abbrev: "Cor", dir: "Theorems", theorem_like: true },
  example: { label: "Example", abbrev: "Eg", dir: "Theorems", theorem_like: true },
  remark: { label: "Remark", abbrev: "Rmk", dir: "Theorems", theorem_like: true },
  exercise: { label: "Exercise", abbrev: "Exercise", dir: "Exercises", theorem_like: true },
}

export function kindFromLabel(label: string): ItemKind | null {
  const text = label.trim().toLowerCase()
  for (const kind of ITEM_KINDS) {
    if (KIND_META[kind].label.toLowerCase() === text) return kind
  }
  return null
}

export function isDefinition(kind: ItemKind): boolean {
  return kind === "definition"
}

/**
 * Theorem-like = everything that is not a definition. Remarks and examples are
 * included: they usually assert something, and the architect may delete a card
 * from plan.json when a remark is pure commentary.
 */
export function isTheoremLike(kind: ItemKind): boolean {
  return KIND_META[kind].theorem_like
}

export function dirOf(kind: ItemKind): string {
  return KIND_META[kind].dir
}

export function labelOf(kind: ItemKind): string {
  return KIND_META[kind].label
}

export function abbrevOf(kind: ItemKind): string {
  return KIND_META[kind].abbrev
}

/** The Lean file holding the *statement* of an item. */
export function statementFileFor(kind: ItemKind, leanName: string): string {
  return `${dirOf(kind)}/${leanName}.lean`
}

/** Mode-1 proof file (never used for definitions). */
export function proofFileFor(leanName: string): string {
  return `Solutions/${leanName}.lean`
}

export function stageOfPath(relPath: string): FileStage {
  const top = relPath.replace(/\\/g, "/").split("/")[0]
  if (top === "Solutions") return "proof"
  if (top === "Definitions") return "definition"
  return "statement"
}

// ---------------------------------------------------------------------------
// task rules
// ---------------------------------------------------------------------------

export function roleForTask(kind: TaskKind): Role {
  switch (kind) {
    case "define":
      return "statement-smith"
    case "state":
      return "statement-smith"
    case "audit":
      return "auditor"
    case "sketch":
      return "architect"
    case "prove":
      return "prover"
    case "integrate":
      return "integrator"
  }
}

/**
 * Modes are closed under task kinds: `statements` never emits `sketch`/`prove`.
 * This is the single gate used by af_next, af_status and the docs.
 */
export function taskAllowed(mode: Mode, kind: TaskKind): boolean {
  if (kind === "sketch" || kind === "prove") return mode === "full"
  return true
}

export type SorryRule = "none" | "exactly-one" | "at-most-one"

export type CheckPolicy = {
  stage: FileStage
  sorry: SorryRule
  /** Successful verdict for this stage. */
  success: "OK_PROOF" | "OK_STATEMENT"
  /** A Solutions/ file must not exist in this mode for this item. */
  forbid_solutions: boolean
}

/**
 * Check rules per SPEC:
 *   - statements + theorem-like statement: exactly one sorry, no Solutions file
 *   - full + proof: zero sorry
 *   - definitions: zero sorry
 *   - full-mode statement files (Theorems/, Exercises/): at most one sorry
 */
export function checkPolicy(mode: Mode, kind: ItemKind, stage: FileStage): CheckPolicy {
  if (stage === "proof") {
    return {
      stage,
      sorry: "none",
      success: "OK_PROOF",
      forbid_solutions: mode === "statements",
    }
  }
  if (stage === "definition" || isDefinition(kind)) {
    return { stage, sorry: "none", success: "OK_PROOF", forbid_solutions: false }
  }
  return {
    stage,
    sorry: mode === "statements" ? "exactly-one" : "at-most-one",
    success: "OK_STATEMENT",
    forbid_solutions: mode === "statements",
  }
}

// ---------------------------------------------------------------------------
// Lean naming + rendering
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "or",
  "for",
  "with",
  "on",
  "in",
  "to",
  "is",
  "are",
  "be",
  "by",
  "as",
  "at",
  "from",
  "that",
  "this",
  "there",
  "it",
  "its",
  "if",
  "then",
  "let",
  "we",
  "has",
  "have",
  "every",
  "each",
  "any",
  "all",
])

function pascal(word: string): string {
  return word
    .replace(/[^A-Za-z0-9]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")
}

/** Derive a short PascalCase name from the first meaningful words of a statement. */
export function slugTitle(statement: string, fallback: string, maxWords = 5): string {
  const firstLine = statement.split("\n").find((line) => line.trim().length > 0) ?? ""
  const plain = firstLine
    .replace(/[*_`$\\]/g, " ")
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .trim()
  const words = plain
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word.toLowerCase()))
    .slice(0, maxWords)
  const joined = words.map(pascal).join("")
  return (joined || pascal(fallback) || "Item").slice(0, 48)
}

/**
 * Lean declaration name. Exercises use the SPEC-mandated Ex_<chapter>_<section>_<n>;
 * everything else uses <Abbrev>_<chapter>_<section>_<Slug>.
 */
export function leanNameFor(input: {
  kind: ItemKind
  chapter: string
  section: string
  statement: string
  ordinal: number
}): string {
  const chapter = input.chapter.replace(/[^A-Za-z0-9]/g, "") || "0"
  const section = input.section.replace(/[^A-Za-z0-9]/g, "") || "0"
  if (input.kind === "exercise") return `Ex_${chapter}_${section}_${input.ordinal}`
  const slug = slugTitle(input.statement, `Item${input.ordinal}`)
  return `${abbrevOf(input.kind)}_${chapter}_${section}_${slug}`
}

export function declarationKeyword(kind: ItemKind): "def" | "theorem" {
  return isDefinition(kind) ? "def" : "theorem"
}

export function escapeDoc(text: string): string {
  return text.replace(/-\//g, "- /").trim()
}

export function importBlock(imports: string[]): string {
  const list = imports.length > 0 ? imports : DEFAULT_IMPORTS
  return list.map((module) => `import ${module.trim()}`).join("\n")
}

/**
 * A column-0 declaration start. Used both to cut a preamble and to stop a
 * definition extraction before the next declaration.
 */
export function isDeclarationLine(line: string): boolean {
  return /^(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+|partial\s+|unsafe\s+)*(?:theorem|lemma|def|abbrev|structure|inductive|instance|example)\b/.test(
    line,
  )
}

/**
 * The import/open/universe block copied from a local Lean file, which is what
 * the platform prepends to `formal_statement`. Comments are skipped. A file
 * without imports falls back to `import Mathlib`.
 */
export function preambleOfFile(source: string): string {
  const imports: string[] = []
  const directives: string[] = []
  for (const line of source.split("\n")) {
    if (isDeclarationLine(line)) break
    const text = line.trim()
    if (!text) continue
    if (/^(?:public\s+)?import\s+/.test(text)) {
      if (!imports.includes(text)) imports.push(text)
      continue
    }
    if (/^(?:open|universe|set_option|attribute|noncomputable\s+section)\b/.test(text)) {
      if (!directives.includes(text)) directives.push(text)
    }
  }
  const head = imports.length > 0 ? imports : importBlock(DEFAULT_IMPORTS).split("\n")
  return [...head, ...(directives.length > 0 ? ["", ...directives] : [])].join("\n")
}

/** Rename the declaration at the head of a statement to a platform name. */
export function renameDeclarationName(statement: string, newName: string): string {
  const match =
    /^((?:private\s+|protected\s+|noncomputable\s+|partial\s+|unsafe\s+)*)(theorem|lemma|def|abbrev|structure|inductive|instance)\s+([A-Za-z0-9_'.!?]+)/.exec(
      statement,
    )
  if (!match) return statement
  return `${match[1] ?? ""}${match[2] ?? "theorem"} ${newName}${statement.slice(match[0].length)}`
}

/** Wrap a declaration in the book-wide namespace used by the platform. */
export function wrapNamespace(statement: string, namespace: string): string {
  return `namespace ${namespace}\n\n${statement.trim()}\n\nend ${namespace}`
}

export type RenderItem = {
  id: string
  kind: ItemKind
  label: string
  number: string
  chapter: string
  chapter_title: string
  section: string
  section_title: string
  source: string
  statement_md: string
}

/**
 * A compilable skeleton. It deliberately contains a `True` placeholder and the
 * `af:placeholder` sentinel: af_check refuses a file that still carries the
 * sentinel, so a skeleton can never be mistaken for a real formalization.
 */
export function renderItemFile(input: {
  item: RenderItem
  leanName: string
  mode: Mode
  stage: FileStage
  imports?: string[]
}): string {
  const { item, leanName } = input
  const imports = input.imports ?? DEFAULT_IMPORTS
  const heading = `${item.label}${item.number ? ` ${item.number}` : ""}`
  const doc = [
    "/--",
    `**${item.id}** — ${heading}`,
    "",
    `Chapter ${item.chapter} (${item.chapter_title}), section ${item.section} (${item.section_title}).`,
    `Source: ${item.source}`,
    "",
    escapeDoc(item.statement_md) || "_No extracted statement text._",
    "-/",
  ].join("\n")

  const keyword = declarationKeyword(item.kind)
  if (input.stage === "definition" || isDefinition(item.kind)) {
    return `${importBlock(imports)}\n\n${doc}\n${keyword} ${leanName} : Prop := True -- ${PLACEHOLDER}\n`
  }

  // Both statement and proof skeletons start with one sorry. In mode1 the
  // prover replaces the body (and the placeholder type); in mode2 the sorry is
  // the deliverable.
  return `${importBlock(imports)}\n\n${doc}\n${keyword} ${leanName} : True := by -- ${PLACEHOLDER}\n  sorry\n`
}

/** A statement file that is complete except for the (intended) final sorry. */
export function renderStatementOnly(input: {
  item: RenderItem
  leanName: string
  imports?: string[]
}): string {
  return renderItemFile({ ...input, mode: "statements", stage: "statement" })
}

/**
 * Rewrite the first top-level declaration of a proof file into `theorem solution`
 * for the /verify bundle. When the file already declares `solution`, keep it.
 */
export function renameToSolution(source: string): { text: string; renamed: boolean } {
  // Only a column-0 declaration is a /verify candidate; an indented declaration
  // inside a namespace is rejected rather than silently exported under rename.
  const declaration = /^((?:private\s+|protected\s+|noncomputable\s+|partial\s+)*)(theorem|lemma|def)\s+([A-Za-z0-9_'.!?]+)\b/m
  const match = declaration.exec(source)
  if (!match) return { text: source, renamed: false }
  const name = match[3]
  if (name === "solution") return { text: source, renamed: false }
  const start = match.index
  const end = match.index + match[0].length
  const head = source.slice(0, start)
  const tail = source.slice(end)
  const keyword = match[2] === "def" ? "def" : "theorem"
  return { text: `${head}${keyword} solution${tail}`, renamed: true }
}

/**
 * Extract the declaration part of a Lean file and force `:= by sorry`, which is
 * the shape Prove2Me mission items expect for an open statement. The cut point
 * is the first `:=` at bracket depth zero, so binder defaults such as
 * `(n : Nat := 0)` do not truncate the signature.
 */
export function statementOfFile(source: string, leanName: string | null): string | null {
  const head = leanName
    ? new RegExp(
        `^((?:private\\s+|protected\\s+|noncomputable\\s+|partial\\s+)*(?:theorem|lemma|def)\\s+${escapeRegExp(leanName)}\\b)`,
        "m",
      )
    : /^((?:private\s+|protected\s+|noncomputable\s+|partial\s+)*(?:theorem|lemma|def)\s+[A-Za-z0-9_'.!?]+\b)/m
  const match = head.exec(source)
  if (!match) return null
  const start = match.index
  let depth = 0
  let cut = -1
  for (let index = start + match[1].length; index < source.length - 1; index += 1) {
    const char = source[index]
    if (char === "(" || char === "[" || char === "{") depth += 1
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1)
    else if (depth === 0 && char === ":" && source[index + 1] === "=") {
      cut = index
      break
    }
  }
  if (cut < 0) return null
  return `${source.slice(start, cut).trimEnd()} := by\n  sorry`
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Count `sorry` tokens outside comments; also returns the stripped source. */
export function stripComments(source: string): string {
  return source.replace(/\/-[\s\S]*?-\//g, " ").replace(/--[^\n]*/g, " ")
}

export function countSorry(source: string): number {
  const code = stripComments(source)
  const matches = code.match(/\bsorry\b/g)
  return matches ? matches.length : 0
}

export function hasAdmit(source: string): boolean {
  return /\badmit\b/.test(stripComments(source))
}

/** Forbidden constructs, reported as AXIOM per SPEC. */
export function forbiddenTokens(source: string): string[] {
  const code = stripComments(source)
  const found: string[] = []
  if (/\baxiom\b/.test(code)) found.push("axiom")
  if (/\bnative_decide\b/.test(code)) found.push("native_decide")
  if (/\bunsafe\b/.test(code)) found.push("unsafe")
  return found
}

export function hasPlaceholder(source: string): boolean {
  return source.includes(PLACEHOLDER)
}

/**
 * The declaration a book file must contain. This is the only local defence
 * against a file that compiles but formalizes the wrong item.
 */
export function declaresName(source: string, leanName: string): boolean {
  const pattern = new RegExp(
    `^(?:@\\[[^\\]]*\\]\\s*)?(?:private\\s+|protected\\s+|noncomputable\\s+|partial\\s+)*` +
      `(?:theorem|lemma|def|abbrev|structure|inductive|instance|example)\\s+${escapeRegExp(leanName)}\\b`,
    "m",
  )
  return pattern.test(source)
}

export function selfImport(source: string, leanName: string): string | null {
  const needle = `Theorems.${leanName}`
  for (const line of stripComments(source).split("\n")) {
    if (/^\s*(?:public\s+)?import\s+/.test(line) && line.includes(needle)) return needle
  }
  return null
}
