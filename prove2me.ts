/**
 * Prove2Me proposal and export builders.
 *
 * Everything here is pure with respect to the filesystem: the caller passes a
 * `read(rel)` function and receives file contents back. This keeps the network
 * out of the plugin and makes the platform shapes testable.
 *
 * The local `proposal.json` keeps enough metadata for humans (`local_items`,
 * `main_local_item`, `sources`), but the objects posted by `submit.sh` are the
 * platform bodies: create metadata, one item body per POST, one milestone body
 * per POST, then a PATCH with platform ids. `submit.sh` is generated but NEVER
 * executed.
 */

import type { Book, Mode } from "./modes.ts"
import {
  AFError,
  DEFAULT_IMPORTS,
  bookNamespace,
  countSorry,
  declarationKeyword,
  derivedTags,
  forbiddenTokens,
  hasPlaceholder,
  importBlock,
  isDeclarationLine,
  isDefinition,
  isTheoremLike,
  labelOf,
  modeOfChapter,
  preambleOfFile,
  renameDeclarationName,
  renameToSolution,
  renderItemFile,
  snakeName,
  statementOfFile,
  wrapNamespace,
} from "./modes.ts"
import type { Item, Toc } from "./ingest.ts"
import type { Card, ChapterPlan, Plan } from "./plan.ts"

export type ProposalItem = {
  kind: "theorem" | "definition"
  theorem_name?: string
  theorem_title?: string
  definition_name?: string
  definition_title?: string
  formal_statement: string
  natural_language_statement: string
  preamble: string
  source: string
  tags: string[]
  readback: string
  readback_model?: string
}

export type ProposalMilestone = {
  milestone_title: string
  milestone_description: string
  /** Platform theorem name of the milestone anchor, or "" when none exists. */
  anchor_item: string
  /** Local item ids, for humans. */
  items: string[]
}

export type LocalItem = {
  item_id: string
  platform_name: string
  kind: string
  file: string
  mode: Mode
  /** True when the Lean file is missing or still carries the af:placeholder sentinel. */
  placeholder: boolean
}

export type Proposal = {
  name: string
  pitch: string
  description: string
  visibility: "public"
  mission_type: string
  env: string
  namespace: string
  chapter: string
  book: string
  mode: Mode
  /** Platform name (`Namespace.thm_...`) of the chapter capstone. */
  main_item_id: string
  /** Local card id of the capstone. */
  main_local_item: string
  items: ProposalItem[]
  local_items: LocalItem[]
  milestones: ProposalMilestone[]
  item_order: string[]
  sources: string[]
  created_at: string
}

export type MissionBuild = {
  proposal: Proposal
  mission_md: string
  submit_sh: string
  warnings: string[]
}

export type ExportBuild = {
  files: Array<{ name: string; content: string }>
  proof_type: "prove" | "statement-only"
  warnings: string[]
}

const READBACK_MODEL = "p2m-af-auditor"

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

/**
 * Stable topological order over `depends_on` restricted to this chapter.
 * A dependency cycle is broken by document order and reported as a warning.
 */
function dependencyOrder(items: Item[]): { order: string[]; warnings: string[] } {
  const warnings: string[] = []
  const index = new Map<string, number>()
  const ids = items.map((item) => item.id)
  ids.forEach((id, position) => index.set(id, position))
  const deps = new Map<string, string[]>()
  for (const item of items) deps.set(item.id, item.depends_on.filter((dep) => index.has(dep)))
  const visiting = new Set<string>()
  const done = new Set<string>()
  const order: string[] = []

  const visit = (id: string): void => {
    if (done.has(id) || visiting.has(id)) return
    visiting.add(id)
    for (const dep of deps.get(id) ?? []) visit(dep)
    visiting.delete(id)
    done.add(id)
    order.push(id)
  }

  for (const id of ids) visit(id)
  if (order.length !== ids.length) {
    warnings.push("DEPENDENCY_CYCLE: falling back to document order")
    return { order: ids, warnings }
  }
  return { order, warnings }
}

function definitionsFirst(order: string[], byId: Map<string, Item>): string[] {
  const defs = order.filter((id) => {
    const item = byId.get(id)
    return item ? isDefinition(item.kind) : false
  })
  const rest = order.filter((id) => !defs.includes(id))
  return [...defs, ...rest]
}

// ---------------------------------------------------------------------------
// item metadata
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** `Saunders Mac Lane & Ieke Moerdijk`, or `First et al.`. */
function authorCitation(authors: string[]): string {
  const clean = authors.map((author) => author.trim()).filter(Boolean)
  if (clean.length === 0) return ""
  if (clean.length <= 2) return clean.join(" & ")
  return `${clean[0]} et al.`
}

/** Public citation; never an absolute local path. */
function citationOf(book: Book, item: Item): string {
  const who = authorCitation(book.authors)
  const head = who ? `${who}, ${book.title}` : book.title
  if (item.section === "Exercises") {
    const printed = /\.Ex\.(\d+)$/.exec(item.id)?.[1] ?? item.number
    return `${head}, ${item.chapter}.Exercises${printed ? `, Exercise ${printed}` : ""}`
  }
  const detail = item.number ? `, ${item.label} ${item.number}` : ""
  return `${head}, ${item.chapter}.${item.section}${detail}`
}

/** `Theorem IV.1.2 — finite-limit-preserving functors ...` */
function itemTitle(item: Item): string {
  const index = item.number ? `${item.label} ${item.number}` : `${item.label} ${item.chapter}.${item.section}`
  const firstLine = item.statement_md.split("\n").find((line) => line.trim().length > 0) ?? ""
  const stripped = firstLine
    .replace(new RegExp(`^\\s*\\*{0,2}\\s*${escapeRegExp(item.label)}\\b[^.:]*[.:]?\\s*`, "i"), "")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const short = stripped.length > 96 ? `${stripped.slice(0, 95)}…` : stripped
  return short ? `${index} — ${short}` : index
}

/**
 * The chapter capstone: the architect's `goal_item` when valid, else the last
 * non-exercise theorem-like item, else the last theorem-like item, else the last
 * item. Never the first theorem by default.
 */
function capstoneItem(items: Item[], chapter: ChapterPlan): { item: Item | undefined; warning: string | null } {
  const theoremLike = items.filter((item) => isTheoremLike(item.kind))
  const nonExercise = theoremLike.filter((item) => !item.exercise)
  // Prefer a real theorem over a corollary/proposition; the last theorem in the
  // chapter is usually the section's headline result.
  const theorems = nonExercise.filter((item) => item.kind === "theorem")
  const fallback =
    theorems[theorems.length - 1] ??
    nonExercise[nonExercise.length - 1] ??
    theoremLike[theoremLike.length - 1] ??
    items[items.length - 1]
  if (chapter.goal_item) {
    const found = items.find((item) => item.id === chapter.goal_item)
    if (found && isTheoremLike(found.kind)) return { item: found, warning: null }
    return {
      item: fallback,
      warning: `GOAL_ITEM_INVALID: ${chapter.goal_item} is not a theorem-like item of chapter ${chapter.id}`,
    }
  }
  return { item: fallback, warning: null }
}

// ---------------------------------------------------------------------------
// local Lean file → platform declaration
// ---------------------------------------------------------------------------

function readSource(input: { read: (rel: string) => string | null }, file: string): string | null {
  try {
    return input.read(file)
  } catch {
    return null
  }
}

/** Full declaration text of a definition/abbrev/structure, placeholders included. */
function declarationBody(source: string, leanName: string): string | null {
  const match = new RegExp(
    `^((?:private\\s+|protected\\s+|noncomputable\\s+|partial\\s+)*(?:def|abbrev|structure|inductive|theorem|lemma)\\s+${escapeRegExp(leanName)}\\b[\\s\\S]*)$`,
    "m",
  ).exec(source)
  if (!match) return null
  const lines = (match[1] ?? "").split("\n")
  const out: string[] = []
  for (const [index, line] of lines.entries()) {
    if (index > 0 && isDeclarationLine(line)) break
    out.push(line)
  }
  return out.join("\n").trim()
}

/** Take the declaration out of a rendered skeleton (imports + doc comment + decl). */
function declarationFromRendered(text: string): string {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => isDeclarationLine(line))
  return (start >= 0 ? lines.slice(start) : lines).join("\n").trim()
}

function platformFormal(input: {
  item: Item
  card: Card
  namespace: string
  localName: string
  imports: string[]
  mode: Mode
  read: (rel: string) => string | null
}): { formal: string; preamble: string; warnings: string[] } {
  const warnings: string[] = []
  const source = readSource(input, input.card.file)
  const preamble = source !== null ? preambleOfFile(source) : importBlock(input.imports)
  let declaration: string | null = null
  if (source !== null) {
    if (hasPlaceholder(source)) warnings.push(`PLACEHOLDER_STATEMENT: ${input.item.id}`)
    declaration = isDefinition(input.item.kind)
      ? declarationBody(source, input.card.lean_name)
      : statementOfFile(source, input.card.lean_name)
    if (declaration === null) {
      warnings.push(`STATEMENT_UNREADABLE: ${input.card.file} has no declaration of ${input.card.lean_name}`)
    }
  } else {
    warnings.push(`STATEMENT_FILE_MISSING: ${input.card.file} for ${input.item.id}`)
  }
  if (declaration === null) {
    declaration = declarationFromRendered(
      renderItemFile({
        item: {
          id: input.item.id,
          kind: input.item.kind,
          label: input.item.label,
          number: input.item.number,
          chapter: input.item.chapter,
          chapter_title: input.item.chapter_title,
          section: input.item.section,
          section_title: input.item.section_title,
          source: input.item.source,
          statement_md: input.item.statement_md,
        },
        leanName: input.card.lean_name,
        mode: input.mode,
        stage: isDefinition(input.item.kind) ? "definition" : "statement",
        imports: input.imports,
      }),
    )
  }
  return {
    formal: wrapNamespace(
      renameDeclarationName(declaration.replace(/[ \t]*--[ \t]*af:placeholder[ \t]*/g, ""), input.localName),
      input.namespace,
    ),
    preamble,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// mission proposal
// ---------------------------------------------------------------------------

export function buildMission(input: {
  book: Book
  toc: Toc
  items: Item[]
  plan: Plan
  chapter: ChapterPlan
  project: string
  read: (rel: string) => string | null
  mode?: Mode
}): MissionBuild {
  const warnings: string[] = []
  const book = input.book
  const namespace = bookNamespace(book)
  const chapterMode = input.mode ?? modeOfChapter(book, input.chapter.id)
  const imports = book.imports && book.imports.length > 0 ? book.imports : DEFAULT_IMPORTS
  const tags = book.tags && book.tags.length > 0 ? [...book.tags] : derivedTags(book.title, book.slug)
  // The seed toc has no `sources`; fall back to book.source_paths without throwing.
  const sources =
    input.toc.sources && input.toc.sources.length > 0
      ? input.toc.sources.map((source) => source.path)
      : [...book.source_paths]

  const chapterItemIDs = new Set(
    input.plan.cards.filter((card) => card.chapter === input.chapter.id).map((card) => card.item_id),
  )
  const chapterItems = input.items.filter((item) => chapterItemIDs.has(item.id))
  if (chapterItems.length === 0) throw new AFError("CHAPTER_EMPTY", `chapter ${input.chapter.id} has no items`)

  const byId = new Map<string, Item>()
  for (const item of chapterItems) byId.set(item.id, item)
  const topo = dependencyOrder(chapterItems)
  warnings.push(...topo.warnings)
  const order = definitionsFirst(topo.order, byId)
  const cards = new Map<string, Card>()
  for (const card of input.plan.cards) cards.set(card.item_id, card)

  // Platform names are unique, book-wide, and snake_cased.
  const usedNames = new Set<string>()
  const localNameFor = (leanName: string): string => {
    const base = snakeName(leanName)
    let name = base
    let suffix = 2
    while (usedNames.has(name)) {
      name = `${base}_${suffix}`
      suffix += 1
    }
    usedNames.add(name)
    return name
  }

  const platformItems: ProposalItem[] = []
  const localItems: LocalItem[] = []
  const platformByLocal = new Map<string, string>()

  for (const id of order) {
    const item = byId.get(id)
    const card = cards.get(id)
    if (!item || !card) continue
    const localName = localNameFor(card.lean_name)
    const platformName = `${namespace}.${localName}`
    platformByLocal.set(id, platformName)
    const built = platformFormal({
      item,
      card,
      namespace,
      localName,
      imports,
      mode: chapterMode,
      read: input.read,
    })
    warnings.push(...built.warnings)
    const readback = (card.readback ?? "").trim()
    const common = {
      formal_statement: built.formal,
      natural_language_statement: item.statement_md,
      preamble: built.preamble,
      source: citationOf(book, item),
      tags: [...tags],
      readback,
      ...(readback ? { readback_model: READBACK_MODEL } : {}),
    }
    if (isDefinition(item.kind)) {
      platformItems.push({
        kind: "definition",
        definition_name: platformName,
        definition_title: itemTitle(item),
        ...common,
      })
    } else {
      platformItems.push({
        kind: "theorem",
        theorem_name: platformName,
        theorem_title: itemTitle(item),
        ...common,
      })
    }
    localItems.push({
      item_id: item.id,
      platform_name: platformName,
      kind: item.kind,
      file: card.file,
      mode: chapterMode,
      placeholder: built.warnings.some(
        (warning) =>
          warning.startsWith("PLACEHOLDER_STATEMENT") ||
          warning.startsWith("STATEMENT_FILE_MISSING") ||
          warning.startsWith("STATEMENT_UNREADABLE"),
      ),
    })
  }
  if (platformItems.length === 0) throw new AFError("CHAPTER_EMPTY", `chapter ${input.chapter.id} has no planned items`)

  const capstone = capstoneItem(chapterItems, input.chapter)
  if (capstone.warning) warnings.push(capstone.warning)
  const mainLocal = capstone.item?.id ?? ""
  const mainPlatform = mainLocal ? platformByLocal.get(mainLocal) ?? "" : ""
  if (capstone.item && isDefinition(capstone.item.kind)) {
    warnings.push(`MAIN_ITEM_NOT_THEOREM: ${capstone.item.id} is a definition`)
  }
  if (!mainPlatform) warnings.push(`MAIN_ITEM_MISSING: chapter ${input.chapter.id} has no capstone item`)

  const milestones: ProposalMilestone[] = input.chapter.milestones.map((milestone) => {
    const ids = milestone.items.filter((id) => chapterItemIDs.has(id))
    const anchor = ids.find((id) => {
      const item = byId.get(id)
      return item ? isTheoremLike(item.kind) : false
    })
    const anchorItem = anchor ? byId.get(anchor) : undefined
    if (!anchor) warnings.push(`MILESTONE_WITHOUT_ANCHOR: ${milestone.id} has no theorem-like item`)
    return {
      milestone_title: `${milestone.id} — ${milestone.title}`,
      milestone_description: (anchorItem?.statement_md.trim() || `${milestone.title} (${milestone.id})`).slice(0, 4000),
      anchor_item: anchor ? platformByLocal.get(anchor) ?? "" : "",
      items: ids,
    }
  })

  const pending = chapterItems.filter((item) => {
    const card = cards.get(item.id)
    if (!card || isDefinition(item.kind)) return false
    return chapterMode === "full" ? card.status !== "proved" : card.status !== "stated" || !card.readback
  }).length
  if (pending > 0) {
    warnings.push(`CHAPTER_INCOMPLETE: ${pending} theorem-like item(s) are not at their ${chapterMode} end state`)
  }

  const definitions = platformItems.filter((item) => item.kind === "definition").length
  const open = platformItems.length - definitions
  const pitch = `${definitions} definition(s) and ${open} theorem/exercise statement(s) from ${book.title} ${input.chapter.id} as a public Prove2Me mission.`

  const proposal: Proposal = {
    name: `${book.title} ${input.chapter.id}: ${input.chapter.title}`,
    pitch,
    description: missionDescription({
      book,
      chapter: input.chapter,
      namespace,
      mode: chapterMode,
      definitions,
      open,
    }),
    visibility: "public",
    mission_type: book.mission_type,
    env: book.mathlib_rev,
    namespace,
    chapter: input.chapter.id,
    book: book.slug,
    mode: chapterMode,
    main_item_id: mainPlatform,
    main_local_item: mainLocal,
    items: platformItems,
    local_items: localItems,
    milestones,
    item_order: platformItems.map((item) => item.theorem_name ?? item.definition_name ?? ""),
    sources,
    created_at: new Date().toISOString(),
  }

  return {
    proposal,
    mission_md: renderMissionMarkdown({ book, chapter: input.chapter, proposal }),
    submit_sh: renderSubmitScript(proposal),
    warnings: [...new Set(warnings)],
  }
}

function missionDescription(input: {
  book: Book
  chapter: ChapterPlan
  namespace: string
  mode: Mode
  definitions: number
  open: number
}): string {
  const authors = authorCitation(input.book.authors)
  const lines = [
    `Public formalization mission for **${input.book.title}**${authors ? ` by ${authors}` : ""}, chapter **${input.chapter.id} — ${input.chapter.title}**.`,
    "",
    `- mission type: \`${input.book.mission_type}\``,
    `- mode: \`${input.mode}\``,
    `- namespace: \`${input.namespace}\``,
    `- items: ${input.definitions} definition(s) + ${input.open} theorem/exercise statement(s)`,
    "",
  ]
  if (input.mode === "statements") {
    lines.push(
      "statement-only: proofs intentionally left open (sorry).",
      "",
      "Each theorem item is a Lean statement ending in `by sorry`. A proof is not expected and no `Solutions/` file exists.",
    )
  } else {
    lines.push(
      "Each theorem item is a Lean statement; the accompanying proof is checked to be `sorry`-free before the mission is published.",
    )
  }
  return lines.join("\n")
}

function renderMissionMarkdown(input: { book: Book; chapter: ChapterPlan; proposal: Proposal }): string {
  const { proposal } = input
  const lines: string[] = []
  lines.push(`# ${proposal.name}`, "")
  lines.push(`- book: **${input.book.title}**${input.book.authors.length > 0 ? ` — ${input.book.authors.join(", ")}` : ""}`)
  lines.push(`- chapter: ${input.chapter.id} — ${input.chapter.title}`)
  lines.push(`- mission type: \`${proposal.mission_type}\``)
  lines.push(`- mode: \`${proposal.mode}\``)
  lines.push(`- namespace: \`${proposal.namespace}\``)
  lines.push("- visibility: `public`")
  lines.push(`- main item: \`${proposal.main_item_id}\``)
  const placeholders = proposal.local_items.filter((item) => item.placeholder).length
  if (placeholders > 0) {
    lines.push(
      `- **draft:** ${placeholders}/${proposal.local_items.length} item(s) still have a missing or placeholder Lean statement; \`submit.sh\` refuses to post until they are written and checked.`,
    )
  }
  lines.push("- proposal: `proposal.json` · submit script: `submit.sh` (never run by the plugin)")
  lines.push("")
  if (proposal.mode === "statements") {
    lines.push("> statement-only: proofs intentionally left open (sorry)", "")
  }
  lines.push("## Items", "")
  lines.push("| # | platform name | kind | source |")
  lines.push("|---|---|---|---|")
  proposal.items.forEach((item, index) => {
    const name = item.theorem_name ?? item.definition_name ?? ""
    lines.push(`| ${index + 1} | \`${name}\` | ${item.kind} | ${item.source} |`)
  })
  lines.push("", "## Milestones", "")
  for (const milestone of proposal.milestones) {
    lines.push(`### ${milestone.milestone_title}`, "")
    lines.push(milestone.anchor_item ? `Anchor: \`${milestone.anchor_item}\`` : "_No theorem anchor; skipped by submit.sh._")
    lines.push("")
  }
  lines.push("## Public mission rule", "")
  lines.push(
    "This proposal is public. The plugin refuses to build it from a non-public book, and `submit.sh` re-checks the visibility before its first POST.",
    "",
  )
  return lines.join("\n")
}

/**
 * The platform sequence:
 *   1. POST create metadata (only name/description/mission_type/visibility/env)
 *   2. POST each item body, mapping platform name -> returned id
 *   3. POST each milestone as {item_id, milestone_title, milestone_description}
 *   4. PATCH {main_item_id, item_order} with platform ids
 * The script never posts `proposal.json` wholesale.
 */
function renderSubmitScript(proposal: Proposal): string {
  return [
    "#!/usr/bin/env bash",
    "# Generated by p2m-auto-formalization. The plugin NEVER executes this script.",
    "# Requires: curl, jq. Run it yourself, then confirm each item in the website.",
    "set -euo pipefail",
    'cd "$(dirname "$0")"',
    "",
    'BASE="${P2M_BASE_URL:-https://prove2.me}/api/v1"',
    'TOKEN="${P2M_API_TOKEN:-}"',
    'if [[ -z "$TOKEN" ]]; then echo "set P2M_API_TOKEN" >&2; exit 1; fi',
    'auth=(-H "Authorization: Bearer $TOKEN")',
    "",
    "post() {",
    '  local path="$1"',
    '  local body="$2"',
    '  curl -sS -X POST "$BASE$path" "${auth[@]}" -H \'content-type: application/json\' --data-binary "$body"',
    "}",
    "",
    "patch() {",
    '  local path="$1"',
    '  local body="$2"',
    '  curl -sS -X PATCH "$BASE$path" "${auth[@]}" -H \'content-type: application/json\' --data-binary "$body"',
    "}",
    "",
    `# ${proposal.name} — visibility: ${proposal.visibility}`,
    'VISIBILITY="$(jq -r \'.visibility\' proposal.json)"',
    'if [[ "$VISIBILITY" != "public" ]]; then echo "refusing non-public proposal" >&2; exit 1; fi',
    'PLACEHOLDERS="$(jq \'[.local_items[] | select(.placeholder)] | length\' proposal.json)"',
    'if [[ "$PLACEHOLDERS" != "0" ]]; then',
    '  echo "refusing: $PLACEHOLDERS item(s) still missing a real Lean statement; run af_check and af_mission again" >&2',
    "  exit 1",
    "fi",
    'MISSING_READBACK="$(jq \'[.items[] | select((.readback // "") == "")] | length\' proposal.json)"',
    'if [[ "$MISSING_READBACK" != "0" ]]; then',
    '  echo "refusing: $MISSING_READBACK item(s) have no read-back; run af_record(kind:audit) first" >&2',
    "  exit 1",
    "fi",
    "",
    "# 1. create metadata; field_ids are added by the human before Submit Proposal",
    'CREATE="$(jq -c \'{name, description, mission_type, visibility:"public", env}\' proposal.json)"',
    'PROPOSAL_ID="$(post /mission-proposals "$CREATE" | jq -r \'.id // .proposal_id // .mission_id // empty\')"',
    'if [[ -z "$PROPOSAL_ID" ]]; then echo "no proposal id in response" >&2; exit 1; fi',
    "",
    "# 2. items, in item_order (already definitions-first); map name -> platform id",
    'ITEM_COUNT="$(jq \'.items | length\' proposal.json)"',
    "IDS='{}'",
    'for ((i = 0; i < ITEM_COUNT; i++)); do',
    '  BODY="$(jq -c ".items[$i]" proposal.json)"',
    '  NAME="$(jq -r ".items[$i] | .theorem_name // .definition_name // empty" proposal.json)"',
    '  LOCAL_ID="$(jq -r ".local_items[$i].item_id" proposal.json)"',
    '  RESP="$(post "/mission-proposals/$PROPOSAL_ID/items" "$BODY")"',
    '  ITEM_ID="$(printf \'%s\' "$RESP" | jq -r \'.id // .item_id // empty\')"',
    '  if [[ -z "$ITEM_ID" ]]; then echo "item $i ($NAME) returned no id: $RESP" >&2; exit 1; fi',
    '  IDS="$(jq -c --arg k "$NAME" --arg v "$ITEM_ID" \'. + {($k): $v}\' <<<"$IDS")"',
    '  IDS="$(jq -c --arg k "$LOCAL_ID" --arg v "$ITEM_ID" \'. + {($k): $v}\' <<<"$IDS")"',
    "done",
    "",
    "# 3. milestones attach to theorem items, never to definitions",
    'MS_COUNT="$(jq \'.milestones | length\' proposal.json)"',
    'for ((i = 0; i < MS_COUNT; i++)); do',
    '  ANCHOR="$(jq -r ".milestones[$i].anchor_item // empty" proposal.json)"',
    '  if [[ -z "$ANCHOR" ]]; then echo "skip milestone $i: no theorem anchor" >&2; continue; fi',
    '  ITEM_ID="$(jq -r --arg k "$ANCHOR" \'.[$k] // empty\' <<<"$IDS")"',
    '  if [[ -z "$ITEM_ID" ]]; then echo "skip milestone $i: anchor has no platform id" >&2; continue; fi',
    '  BODY="$(jq -c --arg id "$ITEM_ID" ".milestones[$i] | {item_id: \\$id, milestone_title, milestone_description}" proposal.json)"',
    '  post "/mission-proposals/$PROPOSAL_ID/milestones" "$BODY" >/dev/null',
    "done",
    "",
    "# 4. dependency order + chapter capstone",
    'MAIN_NAME="$(jq -r \'.main_item_id\' proposal.json)"',
    'MAIN_ID="$(jq -r --arg k "$MAIN_NAME" \'.[$k] // empty\' <<<"$IDS")"',
    'ORDER="$(jq -c --argjson ids "$IDS" \'[.item_order[] | $ids[.] // empty]\' proposal.json)"',
    'if [[ -n "$MAIN_ID" ]]; then',
    '  PATCH_BODY="$(jq -n --arg main "$MAIN_ID" --argjson order "$ORDER" \'{main_item_id: $main, item_order: $order}\')"',
    '  patch "/mission-proposals/$PROPOSAL_ID" "$PATCH_BODY" >/dev/null',
    "else",
    '  echo "warning: no capstone id; PATCH skipped" >&2',
    "fi",
    "",
    'echo "proposal $PROPOSAL_ID: $ITEM_COUNT items, $MS_COUNT milestones (public; no field_ids yet)" >&2',
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// export bundle
// ---------------------------------------------------------------------------

export function buildExport(input: {
  book: Book
  item: Item
  card: Card
  mode: Mode
  project: string
  read: (rel: string) => string | null
}): ExportBuild {
  const warnings: string[] = []
  const imports = input.book.imports && input.book.imports.length > 0 ? input.book.imports : DEFAULT_IMPORTS
  const namespace = bookNamespace(input.book)
  const platformName = `${namespace}.${snakeName(input.card.lean_name)}`
  const citation = citationOf(input.book, input.item)
  const explanation = renderExplanation({
    book: input.book,
    item: input.item,
    card: input.card,
    mode: input.mode,
    citation,
    platformName,
  })

  if (input.mode === "full") {
    if (isDefinition(input.item.kind)) {
      throw new AFError("EXPORT_UNSUPPORTED", `${input.item.id} is a definition; /verify expects a theorem`)
    }
    const proofFile = input.card.proof_file
    if (!proofFile) throw new AFError("PROOF_MISSING", `${input.item.id} has no proof file`)
    const source = input.read(proofFile)
    if (source === null) throw new AFError("PROOF_MISSING", `proof file not found: ${proofFile}`)
    const sorry = countSorry(source)
    if (sorry > 0) throw new AFError("SORRY", `${proofFile} still contains ${sorry} sorry`)
    const forbidden = forbiddenTokens(source)
    if (forbidden.length > 0) throw new AFError("AXIOM", `${proofFile} contains ${forbidden.join(", ")}`)
    if (hasPlaceholder(source)) throw new AFError("TYPE_MISMATCH", `${proofFile} still contains the af:placeholder sentinel`)
    const renamed = renameToSolution(source)
    if (!/\btheorem\s+solution\b/.test(renamed.text)) {
      throw new AFError(
        "TYPE_MISMATCH",
        `no top-level theorem/lemma declaration to export as theorem solution in ${proofFile}`,
      )
    }
    const meta = {
      theorem_id: input.item.id,
      theorem_name: input.card.lean_name,
      platform_name: platformName,
      namespace,
      book: input.book.slug,
      chapter: input.item.chapter,
      source: citation,
      mode: input.mode,
      proof_type: "prove",
      env: {
        lean_project: input.project,
        toolchain: input.book.toolchain,
        mathlib_rev: input.book.mathlib_rev,
      },
      imports,
      explanation,
      created_at: new Date().toISOString(),
    }
    return {
      proof_type: "prove",
      warnings,
      files: [
        { name: "solution.lean", content: renamed.text },
        { name: "meta.json", content: `${JSON.stringify(meta, null, 2)}\n` },
        { name: "explanation.md", content: explanation },
        { name: "curl.sh", content: renderVerifyScript() },
      ],
    }
  }

  // statements mode: export the open statement. A proof is never bundled.
  let statement: string | null = null
  const source = input.read(input.card.file)
  if (source !== null) {
    if (hasPlaceholder(source)) warnings.push(`PLACEHOLDER_STATEMENT: ${input.card.file} still contains the af:placeholder sentinel`)
    statement = isDefinition(input.item.kind)
      ? declarationBody(source, input.card.lean_name)
      : statementOfFile(source, input.card.lean_name)
  } else {
    warnings.push(`STATEMENT_FILE_MISSING: ${input.card.file}; rendered from the source Markdown`)
    statement = declarationFromRendered(
      renderItemFile({
        item: {
          id: input.item.id,
          kind: input.item.kind,
          label: input.item.label,
          number: input.item.number,
          chapter: input.item.chapter,
          chapter_title: input.item.chapter_title,
          section: input.item.section,
          section_title: input.item.section_title,
          source: input.item.source,
          statement_md: input.item.statement_md,
        },
        leanName: input.card.lean_name,
        mode: "statements",
        stage: isDefinition(input.item.kind) ? "definition" : "statement",
        imports,
      }),
    )
  }
  if (statement === null) {
    throw new AFError("TYPE_MISMATCH", `cannot read a declaration for ${input.item.id} from ${input.card.file}`)
  }
  if (isDefinition(input.item.kind)) {
    warnings.push("STATEMENT_ONLY_DEFINITION: definitions have no proof obligation")
  } else if (countSorry(statement) !== 1) {
    throw new AFError("MODE_VIOLATION", `${input.item.id} does not end in exactly one sorry`)
  }
  const meta = {
    theorem_id: input.item.id,
    theorem_name: input.card.lean_name,
    platform_name: platformName,
    namespace,
    book: input.book.slug,
    chapter: input.item.chapter,
    source: citation,
    mode: input.mode,
    proof_type: "statement-only",
    submission: "not-applicable",
    env: {
      lean_project: input.project,
      toolchain: input.book.toolchain,
      mathlib_rev: input.book.mathlib_rev,
    },
    imports,
    explanation,
    created_at: new Date().toISOString(),
  }
  return {
    proof_type: "statement-only",
    warnings,
    files: [
      { name: "statement.lean", content: `${statement.trimEnd()}\n` },
      { name: "meta.json", content: `${JSON.stringify(meta, null, 2)}\n` },
      { name: "explanation.md", content: explanation },
      { name: "curl.sh", content: renderStatementOnlyScript() },
    ],
  }
}

function renderExplanation(input: {
  book: Book
  item: Item
  card: Card
  mode: Mode
  citation: string
  platformName: string
}): string {
  const keyword = declarationKeyword(input.item.kind)
  return [
    `# ${input.item.id} — ${labelOf(input.item.kind)}${input.item.number ? ` ${input.item.number}` : ""}`,
    "",
    `- book: ${input.book.title}`,
    `- chapter: ${input.item.chapter} — ${input.item.chapter_title}`,
    `- section: ${input.item.section} — ${input.item.section_title}`,
    `- source: ${input.citation}`,
    `- Lean declaration: \`${keyword} ${input.card.lean_name}\``,
    `- platform name: \`${input.platformName}\``,
    `- mode: \`${input.mode}\``,
    "",
    "## Statement",
    "",
    input.item.statement_md || "_No extracted statement text._",
    "",
    "## Proof",
    "",
    input.mode === "full"
      ? `Exported from \`${input.card.proof_file ?? ""}\`. The file is sorry-free and contains no axiom/native_decide/unsafe.`
      : "statement-only: proofs intentionally left open (sorry). This bundle is not submitted to /verify.",
    "",
    ...(input.item.proof_md ? ["## Source proof", "", input.item.proof_md, ""] : []),
  ].join("\n")
}

function renderVerifyScript(): string {
  return [
    "#!/usr/bin/env bash",
    "# Generated by p2m-auto-formalization. The plugin NEVER executes this script.",
    "set -euo pipefail",
    'cd "$(dirname "$0")"',
    ': "${P2M_API_TOKEN:?set P2M_API_TOKEN}"',
    'BASE="${P2M_BASE_URL:-https://prove2.me}"',
    "curl -sS -X POST \"$BASE/api/v1/verify\" \\",
    '  -H "Authorization: Bearer $P2M_API_TOKEN" \\',
    '  -F "solution=@solution.lean;type=text/plain" \\',
    '  -F "meta=@meta.json;type=application/json"',
    "",
  ].join("\n")
}

function renderStatementOnlyScript(): string {
  return [
    "#!/usr/bin/env bash",
    "# Generated by p2m-auto-formalization. The plugin NEVER executes this script.",
    "# statement-only export: /verify is not applicable because no proof was bundled.",
    "# Publish this statement through af_mission / submit.sh instead.",
    "cat >&2 <<'MSG'",
    "statement-only export: /verify is not applicable.",
    "This bundle contains an open Lean statement ending in `by sorry`.",
    "Use af_mission to publish it as a public mission proposal.",
    "MSG",
    "exit 0",
    "",
  ].join("\n")
}
