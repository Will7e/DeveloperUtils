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
 * a real OpenRouter model id. Everything resolves through the live
 * catalog; the curated list covers the offline/first-run window.
 */
export function resolveModelInfo(modelId?: string): ModelInfo | undefined {
  if (!modelId) return undefined;
  const curated = CURATED_FALLBACK_MODELS.find((m) => m.id === modelId);
  if (curated?.contextLength) return curated;

  // Check the fetched catalog cache synchronously if already loaded
  const cached = (modelCatalogCache.models ?? []).find((m) => m.id === modelId);
  return cached ?? curated;
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
