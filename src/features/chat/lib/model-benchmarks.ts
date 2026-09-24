// ============================================================
// Model Benchmarks — Published Competence, Not Price
// ============================================================
// `escalation.ts` used to open with an apology it could not avoid:
//
//   "The harness does not know which model is good. It cannot: the catalog
//    publishes prices, context windows and parameter lists, not competence."
//
// and then, reasonably, used price per million output tokens as the only
// available stand-in. Every automatic upgrade was therefore buying *price* and
// hoping it correlated with capability — and the code said so out loud, which
// is what made it honest but did not make it right.
//
// That ingredient now exists. `GET /api/v1/benchmarks` publishes, per model:
//
//   • `coding_index` / `agentic_index` / `intelligence_index`
//     (Artificial Analysis, `source: "artificial-analysis"`)
//   • `accuracy` + `avg_cost_per_task` on OpenRouter's own task suites
//     (`benchmark_type: "tau_bench_verified_airline" | "gpqa_diamond"`,
//     `source: "openrouter"`)
//
// `avg_cost_per_task` is the genuinely new thing: a MEASURED dollar cost for
// doing one realistic task, which is not derivable from per-token pricing
// because it depends on how many tokens a model needs to finish.
//
// The join is the catch, and the probe caught it: benchmark rows key on
// `model_permaslug` — `anthropic/claude-fable-5.1-20260831` — which is NOT the
// catalog `id` (`anthropic/claude-fable-5.1`). 308 of 459 catalog ids also
// differ from their own `canonical_slug` in the same date-suffixed way. So a
// single normalizer is used for all three vocabularies; without it the index
// is keyed on strings that never match, and the escalation picker silently
// finds nothing while looking like it is working.
//
// Pure: no fetch, no clock, no store. The caller supplies parsed payloads.

import type { ModelInfo } from "../types";

// ── Slug normalization ──────────────────────────────────────

/**
 * Collapses the three ways OpenRouter names the same model into one key.
 *
 * Applied to benchmark `model_permaslug`, catalog `id`, AND catalog
 * `canonical_slug` — because those three disagree for most of the catalog, and
 * a join that only normalizes one side is a join that mostly fails.
 *
 * Handles:
 *   `anthropic/claude-fable-5.1-20260831` → `anthropic/claude-fable-5.1`
 *   `z-ai/glm-5.3-flash-20260826`         → `z-ai/glm-5.3-flash`
 *   `vendor/model:free`                   → `vendor/model`
 *   `vendor/model:thinking`               → `vendor/model`
 *
 * Lowercased, because the vocabularies disagree about case on vendor prefixes
 * and a model id is not case-sensitive in any way that matters here.
 */
export function normalizeModelSlug(slug: string): string {
  let out = slug.trim().toLowerCase();
  // Variant suffix (`:free`, `:thinking`, `:extended`, `:online`) is routing
  // detail about the same underlying model, so it is dropped for the join.
  const colon = out.lastIndexOf(":");
  if (colon > 0 && out.indexOf("/") < colon) out = out.slice(0, colon);
  // Date stamp: `-YYYYMMDD` at the end, and the same with an underscore, which
  // appears on a handful of providers.
  out = out.replace(/[-_](\d{8})$/, "");
  return out;
}

// ── Payload parsing ─────────────────────────────────────────

/** One flattened benchmark observation about one model. */
export interface BenchmarkRow {
  /** `artificial-analysis` | `openrouter` */
  source: string;
  /** Normalized join key */
  slug: string;
  /** The original `model_permaslug`, kept for diagnostics */
  rawSlug: string;
  displayName?: string;
  intelligenceIndex?: number;
  codingIndex?: number;
  agenticIndex?: number;
  /** OpenRouter-run suite name (`tau_bench_verified_airline`, `gpqa_diamond`) */
  benchmarkType?: string;
  /** Fraction 0..1 on the OpenRouter suites */
  accuracy?: number;
  /** MEASURED USD cost of completing one task on this suite */
  avgCostPerTask?: number;
  totalTasks?: number;
}

/** The `/benchmarks` envelope: `{ data: [...], meta: {...} }` */
export interface BenchmarksPayload {
  data?: unknown;
  meta?: { as_of?: string; task_type?: string; model_count?: number } | null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Flattens one `/benchmarks` response into rows.
 *
 * Rows that carry no `model_permaslug` are dropped rather than guessed at:
 * a score that cannot be attached to a specific model is not a score the
 * picker may act on.
 */
export function parseBenchmarkRows(payload: BenchmarksPayload | null | undefined): BenchmarkRow[] {
  const data = payload?.data;
  if (!Array.isArray(data)) return [];

  const rows: BenchmarkRow[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const rawSlug = str(r.model_permaslug);
    if (!rawSlug) continue;

    rows.push({
      source: str(r.source) ?? "unknown",
      slug: normalizeModelSlug(rawSlug),
      rawSlug,
      ...(str(r.display_name) ? { displayName: str(r.display_name) } : {}),
      ...(num(r.intelligence_index) !== undefined
        ? { intelligenceIndex: num(r.intelligence_index) }
        : {}),
      ...(num(r.coding_index) !== undefined ? { codingIndex: num(r.coding_index) } : {}),
      ...(num(r.agentic_index) !== undefined ? { agenticIndex: num(r.agentic_index) } : {}),
      ...(str(r.benchmark_type) ? { benchmarkType: str(r.benchmark_type) } : {}),
      ...(num(r.accuracy) !== undefined ? { accuracy: num(r.accuracy) } : {}),
      ...(num(r.avg_cost_per_task) !== undefined
        ? { avgCostPerTask: num(r.avg_cost_per_task) }
        : {}),
      ...(num(r.total_tasks) !== undefined ? { totalTasks: num(r.total_tasks) } : {}),
    });
  }
  return rows;
}

// ── The index ───────────────────────────────────────────────

/** Everything published about one model, merged across sources and suites. */
export interface ModelCompetence {
  slug: string;
  displayName?: string;
  codingIndex?: number;
  agenticIndex?: number;
  intelligenceIndex?: number;
  /** Measured USD per task on the suite that produced it */
  avgCostPerTask?: number;
  /** Which suite `avgCostPerTask` came from, so the two are never mixed up */
  costTaskSuite?: string;
  /** Accuracy by suite name (`tau_bench_verified_airline` → 0.62) */
  accuracy: Record<string, number>;
  /** When the publisher measured this, so a stale score is identifiable */
  asOf?: string;
  sources: string[];
}

export interface CompetenceIndex {
  bySlug: Map<string, ModelCompetence>;
  /** Rows whose slug matched no catalog model — surfaced, never hidden */
  unmatchedSlugs: string[];
  asOf?: string;
}

export type CompetenceTask = "coding" | "agentic" | "intelligence";

/**
 * Builds the lookup from parsed rows plus the catalog it must join against.
 *
 * Two passes, because of the date-suffix divergence: the index is keyed by the
 * normalized slug, and every catalog model additionally registers its
 * `canonical_slug` as an alias pointing at the same record. That way a lookup
 * by `id`, by `canonical_slug`, or by `model_permaslug` all land on one entry.
 *
 * `unmatchedSlugs` is reported rather than discarded: it is the only way to
 * notice that the publisher renamed a family and the join has quietly stopped
 * working for it.
 */
export function buildCompetenceIndex(
  rows: BenchmarkRow[],
  catalog: ModelInfo[] = [],
  asOf?: string
): CompetenceIndex {
  const bySlug = new Map<string, ModelCompetence>();

  for (const row of rows) {
    const existing = bySlug.get(row.slug);
    const record: ModelCompetence = existing ?? {
      slug: row.slug,
      accuracy: {},
      sources: [],
      ...(asOf ? { asOf } : {}),
    };
    if (!existing) bySlug.set(row.slug, record);

    if (row.displayName && !record.displayName) record.displayName = row.displayName;
    if (row.codingIndex !== undefined) record.codingIndex = row.codingIndex;
    if (row.agenticIndex !== undefined) record.agenticIndex = row.agenticIndex;
    if (row.intelligenceIndex !== undefined) record.intelligenceIndex = row.intelligenceIndex;
    // First measured cost wins; a later row from another suite must not silently
    // overwrite it, because the two are not comparable numbers.
    if (row.avgCostPerTask !== undefined && record.avgCostPerTask === undefined) {
      record.avgCostPerTask = row.avgCostPerTask;
      if (row.benchmarkType) record.costTaskSuite = row.benchmarkType;
    }
    if (row.benchmarkType && row.accuracy !== undefined) {
      record.accuracy[row.benchmarkType] = row.accuracy;
    }
    if (!record.sources.includes(row.source)) record.sources.push(row.source);
  }

  // Alias pass: register each catalog model's canonical slug so ids that carry
  // the date stamp resolve to the record keyed without it.
  const unmatchedSlugs: string[] = [];
  const matched = new Set<string>();
  for (const info of catalog) {
    const idSlug = normalizeModelSlug(info.id);
    const record = bySlug.get(idSlug);
    if (record) {
      matched.add(idSlug);
      continue;
    }
    if (info.canonicalSlug) {
      const canonical = normalizeModelSlug(info.canonicalSlug);
      const viaCanonical = bySlug.get(canonical);
      if (viaCanonical) {
        bySlug.set(idSlug, { ...viaCanonical, slug: idSlug });
        matched.add(canonical);
      }
    }
  }

  for (const slug of bySlug.keys()) {
    if (!matched.has(slug) && catalog.length > 0) unmatchedSlugs.push(slug);
  }

  return {
    bySlug,
    unmatchedSlugs,
    ...(asOf ? { asOf } : {}),
  };
}

/** Looks a model up by any of its published names. */
export function competenceFor(
  index: CompetenceIndex | null | undefined,
  modelId: string
): ModelCompetence | undefined {
  if (!index) return undefined;
  return index.bySlug.get(normalizeModelSlug(modelId));
}

/**
 * The measured competence numbers, in the units the picker needs.
 *
 * Returns `undefined` when the publisher has no score for this task — which is
 * the honest answer for most of the catalog, and exactly why the caller must
 * fall back rather than treat 0 as a score.
 */
export function competenceScore(
  record: ModelCompetence | undefined,
  task: CompetenceTask
): number | undefined {
  if (!record) return undefined;
  const value =
    task === "coding"
      ? record.codingIndex
      : task === "agentic"
        ? record.agenticIndex
        : record.intelligenceIndex;
  return value;
}

/**
 * Formats a score for a reason string — the sentence the user reads when a
 * model is swapped under them. Names the suite, because "74.2" means nothing
 * without knowing what was measured.
 */
export function describeCompetence(record: ModelCompetence, task: CompetenceTask): string {
  const score = competenceScore(record, task);
  if (score === undefined) return record.displayName ?? record.slug;
  const label =
    task === "coding"
      ? "coding index"
      : task === "agentic"
        ? "agentic index"
        : "intelligence index";
  const cost =
    record.avgCostPerTask !== undefined
      ? `, ~$${record.avgCostPerTask.toFixed(3)}/task on ${record.costTaskSuite ?? "its suite"}`
      : "";
  return `${label} ${score}${cost}`;
}
