// ============================================================
// Model Catalog — Shared Cache for Context Lengths & Pricing
// ============================================================
// Lives in its own module so both the chat runner and the
// compaction service can resolve model metadata without creating
// an import cycle (runner → compaction → runner).

import { listBenchmarks, listModelEndpoints, listModels } from "../lib/openrouter-client";
import {
  buildCompetenceIndex,
  type BenchmarkRow,
  type CompetenceIndex,
} from "../lib/model-benchmarks";
import { summarizeEndpoints, type EndpointSummary } from "../lib/model-endpoints";
import { CURATED_FALLBACK_MODELS } from "../constants";
import type { ModelInfo } from "../types";

// Populated when the catalog is fetched; consulted synchronously
// by resolveModelInfo without making the function async.
const modelCatalogCache: { models: ModelInfo[] | null } = { models: null };

/**
 * The rows the last benchmark fetch produced, retained so a catalog refresh can
 * rebuild the joined index without spending another request.
 */
let competenceRows: BenchmarkRow[] = [];

/**
 * Rebuilds the index against a freshly fetched catalog.
 *
 * The join needs the catalog, so an index built before the catalog arrived can
 * only match by exact slug. Called from `ensureModelCatalog` so the alias pass
 * (canonical slugs) always has rows to work with.
 */
function rejoinCompetence(models: ModelInfo[]): void {
  if (competenceRows.length === 0) return;
  competenceCache.index = buildCompetenceIndex(
    competenceRows,
    models,
    competenceCache.index?.asOf
  );
}

// ── Published competence ─────────────────────────────────────

/**
 * The benchmark index, refreshed rarely on purpose.
 *
 * `/benchmarks` is rate-limited to 30/min and 500/day, and its contents change
 * on a publisher's schedule (daily at most, per the `as_of` it returns), so a
 * six-hour TTL costs at most twelve requests a day while keeping the picker's
 * ranking current. Empty until the first successful fetch — an empty index is
 * the honest state, because `competenceScore` then returns undefined and the
 * escalation path falls back to its documented heuristic instead of ranking
 * every model at zero.
 */
const BENCHMARKS_TTL = 6 * 60 * 60 * 1000;
const competenceCache: { index: CompetenceIndex | null; at: number } = {
  index: null,
  at: 0,
};

/** The competence index as it stands (empty map before the first fetch) */
export function getCompetenceIndex(): CompetenceIndex {
  return competenceCache.index ?? buildCompetenceIndex([]);
}

/** True once real scores are loaded, so callers can say which basis they used */
export function hasCompetenceData(): boolean {
  return (competenceCache.index?.bySlug.size ?? 0) > 0;
}

/**
 * Fetches and memoizes the benchmark index, joined against the cached catalog.
 *
 * Best-effort by design: a benchmark fetch failing must never break a turn, so
 * the caller keeps whatever index it had and escalation keeps working on the
 * old basis.
 */
export async function ensureCompetenceIndex(apiKey: string): Promise<CompetenceIndex> {
  if (
    competenceCache.index &&
    Date.now() - competenceCache.at < BENCHMARKS_TTL
  ) {
    return competenceCache.index;
  }
  try {
    const rows: BenchmarkRow[] = await listBenchmarks(apiKey);
    const index = buildCompetenceIndex(rows, modelCatalogCache.models ?? []);
    if (index.bySlug.size > 0) {
      competenceRows = rows;
      competenceCache.index = index;
      competenceCache.at = Date.now();
      return index;
    }
  } catch {
    /* keep the previous index; a stale score beats no score */
  }
  return getCompetenceIndex();
}

/** Raw cached catalog (null before the first successful fetch) */
export function getCachedModelCatalog(): ModelInfo[] | null {
  return modelCatalogCache.models;
}

// ── Serving endpoints (per model, on demand) ─────────────────

/**
 * Endpoints are cached for MINUTES, not hours, and only for models actually
 * asked about.
 *
 * Three reasons this is not part of the catalog fetch: the catalog is one
 * request for every model and this is one request PER model (so fetching it for
 * 458 ids would be 458 requests); the figures inside it are rolling windows
 * (uptime, p50 latency, throughput) and go stale in hours, not weeks; and it is
 * only ever read for the model currently selected. The TTL is short for the same
 * rolling-window reason — a provider that just went down should not look healthy
 * for the rest of the session.
 */
const ENDPOINTS_TTL = 10 * 60 * 1000;
const endpointsCache = new Map<string, { summary: EndpointSummary; at: number }>();
/**
 * In-flight fetches, keyed by model.
 *
 * A header that re-renders per streaming chunk would otherwise start a request
 * per render for the same model. Coalescing on the promise means the second
 * caller waits on the first request instead of making one.
 */
const endpointsInFlight = new Map<string, Promise<EndpointSummary | null>>();
/**
 * Who to wake when a model's endpoints arrive.
 *
 * A subscriber list rather than a store value, because the reader is a single
 * component: `useSyncExternalStore` reads `getCachedEndpoints` and this tells it
 * when to re-read. It holds callbacks, never state — the answers themselves are
 * in `endpointsCache` above.
 */
const endpointListeners = new Map<string, Set<() => void>>();

/** The summary as it stands, or null when this model has not been asked about */
export function getCachedEndpoints(modelId?: string): EndpointSummary | null {
  if (!modelId) return null;
  const entry = endpointsCache.get(modelId);
  if (!entry || Date.now() - entry.at >= ENDPOINTS_TTL) return null;
  return entry.summary;
}

/**
 * Fetches and memoizes the endpoints of one model.
 *
 * Best-effort, like the benchmark index: serving facts are worth showing and
 * never worth failing a turn over, so an error resolves to null and the previous
 * answer (if any) is left in place.
 */
export function ensureModelEndpoints(
  apiKey: string,
  modelId: string
): Promise<EndpointSummary | null> {
  const cached = getCachedEndpoints(modelId);
  if (cached) return Promise.resolve(cached);
  const inFlight = endpointsInFlight.get(modelId);
  if (inFlight) return inFlight;

  const request = (async () => {
    try {
      const endpoints = await listModelEndpoints(apiKey, modelId);
      const summary = summarizeEndpoints(endpoints);
      // An empty list is NOT an answer, and it is not cached: the route returned
      // nothing for a model that exists, so the honest report is "unknown" — and
      // holding it for ten minutes would keep saying "nobody serves this" long
      // after the API recovered. Returning a zeroed summary instead would give
      // callers a third state to handle, and the one they would get wrong is a
      // check like `providers === 1` reading true on nothing at all.
      if (summary.endpoints === 0) return null;
      endpointsCache.set(modelId, { summary, at: Date.now() });
      notifyEndpoints(modelId);
      return summary;
    } catch {
      return null;
    } finally {
      endpointsInFlight.delete(modelId);
    }
  })();
  endpointsInFlight.set(modelId, request);
  return request;
}

/**
 * Subscribes to a model's endpoints arriving.
 *
 * The callback fires when a fetch for THAT model lands; a model with no request
 * in flight never wakes anyone, which is why the map is keyed and not a single
 * listener list.
 */
export function subscribeModelEndpoints(modelId: string, listener: () => void): () => void {
  let set = endpointListeners.get(modelId);
  if (!set) {
    set = new Set();
    endpointListeners.set(modelId, set);
  }
  set.add(listener);
  return () => {
    const current = endpointListeners.get(modelId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) endpointListeners.delete(modelId);
  };
}

function notifyEndpoints(modelId: string): void {
  const listeners = endpointListeners.get(modelId);
  if (!listeners) return;
  for (const listener of [...listeners]) listener();
}

/** Test seam: forget cached endpoints and any in-flight request */
export function resetEndpointsCache(): void {
  endpointsCache.clear();
  endpointsInFlight.clear();
}

/**
 * UI-facing model name: the live catalog's label for the id, then the
 * curated list, then the raw slug. Lives here (a leaf module) so both
 * the UI and the turn engine can name a model without import cycles.
 * There is no masking — the name shown is the model that answered.
 */
export function modelDisplayName(modelId?: string, models?: ModelInfo[]): string {
  if (!modelId) return "Model";
  const catalog =
    models && models.length > 0 ? models : (modelCatalogCache.models ?? []);
  return (
    catalog.find((m) => m.id === modelId)?.name ??
    CURATED_FALLBACK_MODELS.find((m) => m.id === modelId)?.name ??
    modelId
  );
}

/**
 * Resolves model metadata (context length, pricing, capabilities) for
 * a real OpenRouter model id. The live catalog is the truth; the curated
 * list covers the offline/first-run window.
 *
 * "The live catalog is the truth" is the part that used to be false for the
 * six curated ids: `if (curated?.contextLength) return curated` returned the
 * hand-written stub the moment the id matched, and every curated stub is a
 * bare name + context length with NO `supportedParameters` and NO
 * `reasoning` block. So for exactly those models the app never learned what
 * they could do — the reasoning control stayed hidden and no reasoning key
 * was ever sent, however clearly the fetched catalog described the model.
 * Whatever the catalog declares now wins, field by field, with the stub
 * filling only the fields the live entry omits.
 */
export function resolveModelInfo(modelId?: string): ModelInfo | undefined {
  if (!modelId) return undefined;
  const curated = CURATED_FALLBACK_MODELS.find((m) => m.id === modelId);
  const live = (modelCatalogCache.models ?? []).find((m) => m.id === modelId);

  // Cold start, or a model the catalog does not list: the stub is all there is.
  if (!live) return curated;

  const merged: ModelInfo = { ...curated, ...live };
  // `{...curated, ...live}` lets an explicitly-undefined live field erase a
  // curated one; the context window is the field that matters, and a model
  // without one cannot be budgeted at all.
  if (merged.contextLength == null && curated?.contextLength != null) {
    merged.contextLength = curated.contextLength;
  }
  return merged;
}

/** Fetches and memoizes the live model catalog (best-effort) */
export async function ensureModelCatalog(apiKey: string): Promise<ModelInfo[]> {
  try {
    const models = await listModels(apiKey);
    modelCatalogCache.models = models;
    // The competence index is keyed by normalized slug and aliased by canonical
    // slug, so it can only be completed once the catalog exists. Rebuilding it
    // here (from rows already in memory) means the first turn after a catalog
    // load ranks by measurement rather than by price.
    rejoinCompetence(models);
    return models;
  } catch {
    return CURATED_FALLBACK_MODELS;
  }
}
