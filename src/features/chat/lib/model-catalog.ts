// ============================================================
// Model Catalog — Shared Cache for Context Lengths & Pricing
// ============================================================
// Lives in its own module so both the chat runner and the
// compaction service can resolve model metadata without creating
// an import cycle (runner → compaction → runner).

import { listModels } from "../lib/openrouter-client";
import { CURATED_FALLBACK_MODELS, INTAB_MODEL_ID, INTAB_VIRTUAL_MODEL } from "../constants";
import type { ModelInfo } from "../types";

// Populated when the catalog is fetched; consulted synchronously
// by resolveModelInfo without making the function async.
const modelCatalogCache: { models: ModelInfo[] | null } = { models: null };

/** Raw cached catalog (null before the first successful fetch) */
export function getCachedModelCatalog(): ModelInfo[] | null {
  return modelCatalogCache.models;
}

/** Resolves model metadata (context length etc.) for a model id */
export function resolveModelInfo(modelId?: string): ModelInfo | undefined {
  if (!modelId) return undefined;
  // Virtual InTab model: synthetic 128k metadata — the runner swaps
  // in the concrete pool model's info per attempt.
  if (modelId === INTAB_MODEL_ID) return INTAB_VIRTUAL_MODEL;
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
