import type { Plugin as OpenCodePlugin } from "@opencode/plugin"
import { AFError, type MissionType, type Mode, asString, asStringArray, isRecord } from "./modes.ts"
import { AFStore } from "./store.ts"

/**
 * p2m-auto-formalization
 *
 * Turns a math book (Markdown chapter/section/item scans) into public Prove2Me
 * missions with a DAG of definitions, statements and proofs, driven by
 * sub-agents.
 *
 * Two modes:
 *   full       — statements + proofs, proof tasks until sorry-free.
 *   statements — statements ending in `by sorry`; proof tasks are never emitted.
 *
 * Every tool returns a compact JSON string. No network calls are made.
 */

type Context = OpenCodePlugin.Context
type Cleanup = OpenCodePlugin.Cleanup
type PluginShape = {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}

/**
 * Mirrors `Plugin.define` from @opencode/plugin. Kept local with a *type-only*
 * import so `bun build index.ts --target node` works without a node_modules tree
 * in the plugin directory, while `tsc` still checks the real Context type.
 */
function define<T extends PluginShape>(plugin: T): T {
  return plugin
}

type Options = {
  root?: string
  booksDir?: string
  leanTimeoutMs?: number
  lakeBin?: string
}

function json(value: unknown): { content: string } {
  return { content: JSON.stringify(value) }
}

function fail(error: unknown): { content: string } {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof AFError ? error.code : "ERROR"
  return json({ ok: false, code, error: message })
}

function str(value: unknown): string {
  return asString(value)?.trim() ?? ""
}

function optionalStr(value: unknown): string | undefined {
  const text = str(value)
  return text ? text : undefined
}

function modesRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new AFError("INPUT_INVALID", "chapter_modes must be an object")
  const out: Record<string, string> = {}
  for (const [chapter, mode] of Object.entries(value)) {
    if (typeof mode !== "string") throw new AFError("INPUT_INVALID", `chapter_modes.${chapter} must be a string`)
    out[chapter] = mode
  }
  return out
}

export default define({
  id: "p2m-auto-formalization",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const store = new AFStore({
      ...(typeof options.root === "string" ? { root: options.root } : {}),
      ...(typeof options.booksDir === "string" ? { booksDir: options.booksDir } : {}),
      ...(typeof options.leanTimeoutMs === "number" ? { leanTimeoutMs: options.leanTimeoutMs } : {}),
      ...(typeof options.lakeBin === "string" ? { lakeBin: options.lakeBin } : {}),
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "af",
        description: "auto-formalization: ingest a book, plan a public mission DAG, dispatch and check Lean files.",
      })

      // -------------------------------------------------------------- af_init
      editor.add({
        name: "init",
        description:
          "Create or refresh books/<slug>/ with book.json, empty toc/items/plan, WORKFLOW.md, state/, missions/, chapters/ and " +
          "exports/. Rejects any mode other than full|statements, visibility other than public, include_exercises:false, and " +
          "missing source files.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Book slug; used as books/<slug>/." },
            title: { type: "string", description: "Human title." },
            authors: { type: "array", items: { type: "string" }, description: "Author names." },
            source_paths: {
              type: "array",
              items: { type: "string" },
              description: "Absolute Markdown part paths; every path must exist.",
            },
            mode: { type: "string", enum: ["full", "statements"], description: "full = proofs; statements = by-sorry only." },
            mission_type: {
              type: "string",
              enum: ["Textbook", "ResearchPaper", "OpenProblem"],
              description: "Platform mission type (default Textbook).",
            },
            namespace: {
              type: "string",
              description: "Book-wide Lean namespace for platform names; default derived from the title.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Platform tags; default is derived from the title/slug (topos books get topos-theory).",
            },
            lean_project: { type: "string", description: "Lean project root; `lake env lean` runs here." },
            visibility: { type: "string", enum: ["public"], description: "Only public is accepted." },
            include_exercises: { type: "boolean", description: "Must be true when present; exercises are in scope." },
            chapter_modes: {
              type: "object",
              additionalProperties: { type: "string", enum: ["full", "statements"] },
              description: "Per-chapter mode overrides; they win over the book mode.",
            },
            imports: {
              type: "array",
              items: { type: "string" },
              description: "Lean imports for generated files (default: Mathlib).",
            },
          },
          required: ["slug", "title", "source_paths", "mode", "lean_project"],
          additionalProperties: false,
        },
        options: { namespace: "af", permission: "af_init", codemode: false },
        execute: async (input) => {
          try {
            const args = (input ?? {}) as Record<string, unknown>
            const chapterModes = modesRecord(args.chapter_modes)
            return json(
              store.init({
                slug: str(args.slug),
                title: str(args.title),
                authors: asStringArray(args.authors),
                source_paths: asStringArray(args.source_paths),
                mode: str(args.mode) as Mode,
                ...(typeof args.mission_type === "string" ? { mission_type: args.mission_type as MissionType } : {}),
                ...(optionalStr(args.namespace) ? { namespace: optionalStr(args.namespace) } : {}),
                ...(Array.isArray(args.tags) ? { tags: asStringArray(args.tags) } : {}),
                lean_project: str(args.lean_project),
                ...(typeof args.visibility === "string" ? { visibility: args.visibility } : {}),
                ...(typeof args.include_exercises === "boolean" ? { include_exercises: args.include_exercises } : {}),
                ...(chapterModes !== undefined ? { chapter_modes: chapterModes } : {}),
                ...(Array.isArray(args.imports) ? { imports: asStringArray(args.imports) } : {}),
              }),
            )
          } catch (error) {
            return fail(error)
          }
        },
      })

      // ------------------------------------------------------------ af_ingest
      editor.add({
        name: "ingest",
        description:
          "Parse the book's Markdown parts into toc.json and items.jsonl (atomic rewrite). Dedupes overlapping parts by " +
          "(chapter, section, kind, ordinal-in-section), keeps the first occurrence and merges a proof from a later one.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Book slug." },
            part_files: {
              type: "array",
              items: { type: "string" },
              description: "Optional replacement part list; defaults to book.json source_paths.",
            },
            include_exercises: { type: "boolean", description: "Must be true when present." },
          },
          required: ["slug"],
          additionalProperties: false,
        },
        options: { namespace: "af", permission: "af_ingest", codemode: false },
        execute: async (input) => {
          try {
            const args = (input ?? {}) as Record<string, unknown>
            return json(
              store.ingest({
                slug: str(args.slug),
                ...(Array.isArray(args.part_files) ? { part_files: asStringArray(args.part_files) } : {}),
                ...(typeof args.include_exercises === "boolean" ? { include_exercises: args.include_exercises } : {}),
              }),
            )
          } catch (error) {
            return fail(error)
          }
        },
      })

      // -------------------------------------------------------------- af_plan
      editor.add({
        name: "plan",
        description:
          "Build plan.json: one public chapter mission, one milestone per section plus Exercises, one card per item. In " +
          "statements mode theorem-like cards get proof:\"skipped\"; in full mode proof:\"pending\". depends_on defaults to [].",
        input: {
          type: "object",
          properties: { slug: { type: "string", description: "Book slug." } },
          required: ["slug"],
          additionalProperties: false,
        },
        options: { namespace: "af", permission: "af_plan", codemode: false },
        execute: async (input) => {
          try {
            const args = (input ?? {}) as Record<string, unknown>
            return json(store.plan(str(args.slug)))
          } catch (error) {
            return fail(error)
          }
        },
      })

      // -------------------------------------------------------------- af_next
      editor.add({
        name: "next",
        description:
          "Atomically claim the next ready task with state/claims/<task_id>.lock (exclusive create). Selection order: define, " +
          "state, audit, sketch (full only), prove (full only), integrate. statements mode never returns sketch or prove.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Book slug." },
            role: {
              type: "string",
              enum: ["architect", "statement-smith", "auditor", "prover", "integrator"],
              description: "Optional role filter.",
            },
          },
          required: ["slug"],
          additionalProperties: false,
        },
        options: { namespace: "af", permission: "af_next", codemode: false },
        execute: async (input, context) => {
          try {
            const args = (input ?? {}) as Record<string, unknown>
            return json(
              store.next({
                slug: str(args.slug),
                ...(typeof args.role === "string" ? { role: args.role } : {}),
                worker: context.sessionID,
              }),
            )
          } catch (error) {
            return fail(error)
          }
        },
      })

      // ------------------------------------------------------------- af_check
      editor.add({
        name: "check",
        description:
          "Compile one Lean file with `lake env lean` (cwd = book.lean_project, 600s). Scans sorry/axiom/native_decide/unsafe and " +
          "self-import first. statements + theorem-like requires exactly one sorry and no Solutions/ file (OK_STATEMENT); " +
          "full + proof requires zero sorry (OK_PROOF); definitions require zero sorry. Does not edit the file.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Book slug." },
            item_id: { type: "string", description: "Item/card id, e.g. IV.1.Thm.1." },
            file: {
              type: "string",
              description: "Optional file (relative to lean_project or absolute inside it); defaults by mode/stage.",
            },
          },
          required: ["slug", "item_id"],
          additionalProperties: false,
        },
        options: { namespace: "af", permission: "af_check", codemode: false },
        execute: async (input) => {
          try {
            const args = (input ?? {}) as Record<string, unknown>
            return json(
              await store.check({
                slug: str(args.slug),
                item_id: str(args.item_id),
                ...(typeof args.file === "string" && args.file.trim() ? { file: args.file } : {}),
              }),
            )
          } catch (error) {
            return fail(error)
          }
        },
      })

      // ------------------------------------------------------------ af_record
      editor.add({
        name: "record",
        description:
          "Append an ISO-timestamped entry to WORKFLOW.md, the chapter log and state/workflow.jsonl. kind=audit with an item_id " +
          "also stores the text as the card readback; kind=mission with a chapter marks that chapter published.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Book slug." },
            kind: {
              type: "string",
              enum: ["decision", "audit", "mission", "blocker", "handoff", "note"],
              description: "Entry kind.",
            },
            text: { type: "string", description: "Entry body." },
            item_id: { type: "string", description: "Optional item id." },
            chapter: { type: "string", description: "Optional chapter id; inferred from item_id." },
          },
          required: ["slug", "kind", "text"],
          additionalProperties: false,
        },
        options: { namespace: "af", permission: "af_record", codemode: false },
        execute: async (input) => {
          try {
            const args = (input ?? {}) as Record<string, unknown>
            return json(
              store.record({
                slug: str(args.slug),
                kind: str(args.kind),
                text: str(args.text),
                ...(optionalStr(args.item_id) ? { item_id: optionalStr(args.item_id) } : {}),
                ...(optionalStr(args.chapter) ? { chapter: optionalStr(args.chapter) } : {}),
              }),
            )
          } catch (error) {
            return fail(error)
          }
        },
      })

      // ------------------------------------------------------------ af_status
      editor.add({
        name: "status",
        description:
          "Counts by status and chapter, chapter/mission counts, DAG frontier and warnings: non-public missions, stated cards " +
          "without readback, Solutions/ in statements mode, sorry in Solutions/ in full mode, stale plan mode, missing deps.",
        input: {
          type: "object",
          properties: { slug: { type: "string", description: "Book slug." } },
          required: ["slug"],
          additionalProperties: false,
        },
        options: { namespace: "af", permission: "af_status", codemode: false },
        execute: async (input) => {
          try {
            const args = (input ?? {}) as Record<string, unknown>
            return json(store.status(str(args.slug)))
          } catch (error) {
            return fail(error)
          }
        },
      })

      // ----------------------------------------------------------- af_mission
      editor.add({
        name: "mission",
        description:
          "Build missions/<chapter>/{proposal.json,mission.md,submit.sh} with visibility:\"public\". Refuses a non-public book. " +
          "proposal.json.items are the platform bodies (namespace-wrapped formal_statement, preamble from the local file, " +
          "citation source, tags, readback); submit.sh posts create/items/milestones and PATCHes main_item_id/item_order. " +
          "It is never executed.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Book slug." },
            chapter: { type: "string", description: "Chapter id, e.g. IV." },
          },
          required: ["slug", "chapter"],
          additionalProperties: false,
        },
        options: { namespace: "af", permission: "af_mission", codemode: false },
        execute: async (input) => {
          try {
            const args = (input ?? {}) as Record<string, unknown>
            return json(store.mission(str(args.slug), str(args.chapter)))
          } catch (error) {
            return fail(error)
          }
        },
      })

      // ------------------------------------------------------------ af_export
      editor.add({
        name: "export",
        description:
          "Write exports/<item_id>/ with solution.lean (full mode, top-level `theorem solution`, sorry-free) or statement.lean " +
          "(statements mode, proof_type statement-only) plus meta.json, explanation.md and curl.sh. Never calls the network.",
        input: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Book slug." },
            item_id: { type: "string", description: "Item id to export." },
          },
          required: ["slug", "item_id"],
          additionalProperties: false,
        },
        options: { namespace: "af", permission: "af_export", codemode: false },
        execute: async (input) => {
          try {
            const args = (input ?? {}) as Record<string, unknown>
            return json(store.exportItem(str(args.slug), str(args.item_id)))
          } catch (error) {
            return fail(error)
          }
        },
      })
    })

    console.log(`[p2m-auto-formalization] loaded · books=${store.booksDir} · leanBin=${store.lakeBin}`)
  },
})
