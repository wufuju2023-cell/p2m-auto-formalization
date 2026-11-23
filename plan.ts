/**
 * Plan construction for p2m-auto-formalization.
 *
 * plan.json is the single source of truth for card state:
 *   one chapter mission  -> one milestone per section (+ Exercises)
 *   one item             -> one card
 *
 * Re-planning is non-destructive: when the book mode and the card's effective
 * chapter mode did not change, the previous status/readback/attempt metadata is
 * preserved. A mode change resets statuses, because `proved` is meaningless in
 * `statements` mode and `skipped` is meaningless in `full` mode.
 *
 * `depends_on` is architect-editable. `children` is derived (the inverse edges
 * restricted to theorem-like cards in the same chapter) and must not be edited.
 */

import type { Book, CardStatus, ChapterStatus, ItemKind, Mode, ProofState } from "./modes.ts"
import {
  isDefinition,
  isTheoremLike,
  modeOfChapter,
  proofFileFor,
  statementFileFor,
} from "./modes.ts"
import type { Item, Toc } from "./ingest.ts"

export type Card = {
  id: string
  item_id: string
  chapter: string
  section: string
  kind: ItemKind
  label: string
  mode: Mode
  status: CardStatus
  proof: ProofState
  file: string
  proof_file: string | null
  lean_name: string
  depends_on: string[]
  children: string[]
  readback: string | null
  sorry_count: number | null
  last_code: string | null
  notes: string
}

export type Milestone = {
  id: string
  title: string
  items: string[]
}

export type ChapterPlan = {
  id: string
  title: string
  mission: string
  visibility: "public"
  milestones: Milestone[]
  cards: string[]
  depends_on: string[]
  /** Architect-selected capstone item id (platform main_item_id). */
  goal_item?: string
  status: ChapterStatus
}

export type Plan = {
  slug: string
  title: string
  mode: Mode
  visibility: "public"
  created_at: string
  updated_at: string
  chapters: ChapterPlan[]
  cards: Card[]
}

function defaultProof(kind: ItemKind, mode: Mode): ProofState {
  if (isDefinition(kind)) return "not_applicable"
  return mode === "full" ? "pending" : "skipped"
}

function defaultStatus(kind: ItemKind): CardStatus {
  return isDefinition(kind) ? "draft" : "planned"
}

/** Human label used for the mission name and plan.json. */
export function missionName(chapter: string, title: string): string {
  return `MLM ${chapter} — ${title}`
}

export function buildPlan(input: {
  book: Book
  toc: Toc
  items: Item[]
  previous?: Plan | null
}): Plan {
  const { book, toc, items } = input
  const previous = input.previous ?? null
  const sameBook = previous !== null && previous.slug === book.slug && previous.mode === book.mode
  const previousCards = new Map<string, Card>()
  for (const card of previous?.cards ?? []) previousCards.set(card.item_id, card)
  const previousChapters = new Map<string, ChapterPlan>()
  for (const chapter of previous?.chapters ?? []) previousChapters.set(chapter.id, chapter)

  // Chapter order: toc order first, then any chapter that only exists in items.
  const chapterIds: string[] = []
  const chapterTitles = new Map<string, string>()
  for (const chapter of toc.chapters) {
    chapterIds.push(chapter.id)
    chapterTitles.set(chapter.id, chapter.title)
  }
  for (const item of items) {
    if (!chapterTitles.has(item.chapter)) {
      chapterIds.push(item.chapter)
      chapterTitles.set(item.chapter, item.chapter_title)
    }
  }

  const cards: Card[] = []
  const cardsByChapter = new Map<string, Card[]>()
  const chapterReset = new Map<string, boolean>()

  for (const item of items) {
    const mode = modeOfChapter(book, item.chapter)
    const prev = previousCards.get(item.id)
    const keep =
      sameBook === true &&
      prev !== undefined &&
      prev.mode === mode &&
      prev.kind === item.kind &&
      prev.lean_name === item.lean_name
    if (!keep) chapterReset.set(item.chapter, true)

    const card: Card = {
      id: item.id,
      item_id: item.id,
      chapter: item.chapter,
      section: item.section,
      kind: item.kind,
      label: item.label,
      mode,
      status: keep && prev ? prev.status : defaultStatus(item.kind),
      proof: defaultProof(item.kind, mode),
      file: statementFileFor(item.kind, item.lean_name),
      proof_file: isDefinition(item.kind) ? null : proofFileFor(item.lean_name),
      lean_name: item.lean_name,
      depends_on: keep && prev ? [...prev.depends_on] : [...item.depends_on],
      children: [],
      readback: keep && prev ? prev.readback : null,
      sorry_count: keep && prev ? prev.sorry_count : null,
      last_code: keep && prev ? prev.last_code : null,
      notes: keep && prev ? prev.notes : item.notes,
    }
    cards.push(card)
    const bucket = cardsByChapter.get(item.chapter) ?? []
    bucket.push(card)
    cardsByChapter.set(item.chapter, bucket)
  }

  // Derived child edges: a theorem depending on another theorem makes the
  // dependency a parent (sketch first, then prove when the children are done).
  const byId = new Map<string, Card>()
  for (const card of cards) byId.set(card.id, card)
  for (const card of cards) {
    for (const depId of card.depends_on) {
      const parent = byId.get(depId)
      if (!parent || parent.chapter !== card.chapter) continue
      if (!isTheoremLike(parent.kind)) continue
      if (!parent.children.includes(card.id)) parent.children.push(card.id)
    }
  }

  const chapters: ChapterPlan[] = []
  for (const chapterId of chapterIds) {
    const chapterCards = cardsByChapter.get(chapterId) ?? []
    const previousChapter = previousChapters.get(chapterId)

    const milestoneMap = new Map<string, Milestone>()
    const order: string[] = []
    for (const card of chapterCards) {
      if (!milestoneMap.has(card.section)) {
        const title =
          items.find((item) => item.chapter === chapterId && item.section === card.section)?.section_title ??
          (card.section === "Exercises" ? "Exercises" : card.section)
        milestoneMap.set(card.section, {
          id: `${chapterId}.${card.section}`,
          title,
          items: [],
        })
        order.push(card.section)
      }
      milestoneMap.get(card.section)?.items.push(card.id)
    }
    // Sections declared in the toc but not represented by an item stay visible.
    for (const section of toc.chapters.find((entry) => entry.id === chapterId)?.sections ?? []) {
      if (milestoneMap.has(section.id)) continue
      milestoneMap.set(section.id, { id: `${chapterId}.${section.id}`, title: section.title, items: [] })
      order.push(section.id)
    }
    // Exercises milestone is always last, but only when it has cards.
    const ordered = order.filter((id) => id !== "Exercises")
    if (order.includes("Exercises") && (milestoneMap.get("Exercises")?.items.length ?? 0) > 0) {
      ordered.push("Exercises")
    }

    const title = chapterTitles.get(chapterId) ?? chapterId
    const keepChapter =
      sameBook === true && previousChapter !== undefined && !chapterReset.get(chapterId)
    chapters.push({
      id: chapterId,
      title,
      mission: missionName(chapterId, title),
      visibility: "public",
      milestones: ordered
        .map((id) => milestoneMap.get(id))
        .filter((entry): entry is Milestone => Boolean(entry)),
      cards: chapterCards.map((card) => card.id),
      depends_on: keepChapter && previousChapter ? [...previousChapter.depends_on] : [],
      // The capstone choice is structural, not status: preserve it across mode
      // changes so the architect does not lose it on a re-plan.
      ...(previousChapter?.goal_item ? { goal_item: previousChapter.goal_item } : {}),
      status: keepChapter && previousChapter ? previousChapter.status : "planned",
    })
  }

  const now = new Date().toISOString()
  return {
    slug: book.slug,
    title: book.title,
    mode: book.mode,
    visibility: "public",
    created_at: previous?.created_at ?? now,
    updated_at: now,
    chapters,
    cards,
  }
}

/** A chapter is complete when every card reached its mode-specific end state. */
export function chapterComplete(chapter: ChapterPlan, plan: Plan): boolean {
  const byId = new Map<string, Card>()
  for (const card of plan.cards) byId.set(card.id, card)
  for (const id of chapter.cards) {
    const card = byId.get(id)
    if (!card) return false
    if (isDefinition(card.kind)) {
      if (card.status !== "audited" && card.status !== "proved") return false
      continue
    }
    if (card.mode === "full") {
      if (card.status !== "proved") return false
    } else if (card.status !== "stated" || !card.readback) {
      return false
    }
  }
  return true
}
