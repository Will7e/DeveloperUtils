// ============================================================
// Model Catalog — Shared Cache for Context Lengths & Pricing
// ============================================================
// Lives in its own module so both the chat runner and the
// compaction service can resolve model metadata without creating
// an import cycle (runner → compaction → runner).

import { listModels } from "../lib/openrouter-client";
import { CURATED_FALLBACK_MODELS } from "../constants";
import type { ModelInfo } from "../types";

// Populated when the catalog is fetched; consulted synchronously
// by resolveModelInfo without making the function async.
const modelCatalogCache: { models: ModelInfo[] | null } = { models: null };

/** Raw cached catalog (null before the first successful fetch) */
export function getCachedModelCatalog(): ModelInfo[] | null {
  return modelCatalogCache.models;
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
    return models;
  } catch {
    return CURATED_FALLBACK_MODELS;
  }
}
