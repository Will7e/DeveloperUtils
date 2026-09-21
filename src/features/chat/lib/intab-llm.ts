// ============================================================
// InTab LLM — Virtual Free-Model Router
// ============================================================
// "intab/intab-llm" is a synthetic model id that never goes on the
// wire. The chat runner resolves it here to a concrete OpenRouter
// free model:
//
//   1. Pool — free models from the live catalog (isFree, ≥32k
//      context), ranked by a curated preference order then by
//      context size. A static fallback pool covers offline/first-run.
//   2. Sticky routing — a conversation keeps the same underlying
//      model across turns so tone/formatting stays consistent; it
//      only moves when the model fails.
//   3. Failure memory — 429s cool a model down for a minute,
//      hard failures (5xx/network/timeout/empty) for 30s plus a
//      strike; two strikes earn a five-minute timeout. Selection
//      skips cooled models, falling back to them (oldest failure
//      first) only when the whole pool is cooling.
//   4. Vision gate — image-bearing turns can only route to pool
//      models advertising "image" input.
//
// Everything here is display-agnostic: the UI masks the underlying
// id as "InTab LLM" (see displayNameFor), while stored messages keep
// the real id for exports and debugging.

import {
  INTAB_FALLBACK_POOL,
  INTAB_MODEL_ID,
  INTAB_MODEL_NAME,
} from "../constants";
import { getCachedModelCatalog } from "./model-catalog";
import type { ModelInfo } from "../types";

/** Minimum context window for a free model to join the pool */
const INTAB_MIN_CONTEXT_TOKENS = 32_000;

/**
 * Preferred pool order (prefix match on the model id). Anything not
 * listed ranks after by context length. DeepSeek/Qwen/Llama free
 * variants were retired from OpenRouter's free tier in 2026, so the
 * preference list leads with the current free-tier flagships.
 */
const INTAB_POOL_PREFERENCE = [
  "nvidia/nemotron",
  "openai/gpt-oss-120b",
  "google/gemma-4-31b",
  "qwen/qwen3-coder",
  "openai/gpt-oss-20b",
  "google/gemma-4-26b",
  "tencent/hunyuan",
  "inclusionai/ling",
];

/** True when the id is the virtual InTab model */
export function isIntabModel(modelId: string | undefined): boolean {
  return modelId === INTAB_MODEL_ID;
}

/** Builds the ranked pool from a catalog (live or fallback) */
export function buildInTabPool(models: ModelInfo[]): ModelInfo[] {
  const free = models.filter(
    (m) =>
      m.isFree &&
      (m.contextLength === undefined || m.contextLength >= INTAB_MIN_CONTEXT_TOKENS)
  );
  if (free.length === 0) return [];

  const rank = (m: ModelInfo): number => {
    const idx = INTAB_POOL_PREFERENCE.findIndex((p) =>
      m.id.toLowerCase().startsWith(p)
    );
    return idx === -1 ? INTAB_POOL_PREFERENCE.length : idx;
  };

  return free.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    // Within a rank (or unranked): larger context first
    return (b.contextLength ?? 0) - (a.contextLength ?? 0);
  });
}

/** Current pool: live catalog when loaded, static fallback otherwise */
export function currentInTabPool(): ModelInfo[] {
  const catalog = getCachedModelCatalog();
  return buildInTabPool(catalog && catalog.length > 0 ? catalog : INTAB_FALLBACK_POOL);
}

// ── Failure memory ──────────────────────────────────────────

interface FailureRecord {
  /** Milliseconds epoch until which the model is skipped */
  cooldownUntil: number;
  /** Consecutive hard failures (reset on success) */
  strikes: number;
  /** When the last failure happened (for least-recently-failed ordering) */
  lastFailureAt: number;
}

const failures = new Map<string, FailureRecord>();

/** Cooldown windows (ms) */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const HARD_FAIL_COOLDOWN_MS = 30_000;
const DEMOTED_COOLDOWN_MS = 5 * 60_000;
/** Hard failures before the model earns the long timeout */
const STRIKES_TO_DEMOTE = 2;

export function recordModelFailure(
  modelId: string,
  kind: "rate" | "hard"
): void {
  const now = Date.now();
  const prev = failures.get(modelId);
  const strikes = kind === "hard" ? (prev?.strikes ?? 0) + 1 : 0;
  const cooldownMs =
    kind === "rate"
      ? RATE_LIMIT_COOLDOWN_MS
      : strikes >= STRIKES_TO_DEMOTE
        ? DEMOTED_COOLDOWN_MS
        : HARD_FAIL_COOLDOWN_MS;
  failures.set(modelId, {
    cooldownUntil: now + cooldownMs,
    strikes,
    lastFailureAt: now,
  });
}

/** A completed stream proves the model is healthy again */
export function recordModelSuccess(modelId: string): void {
  failures.delete(modelId);
}

/** Test/debug helper: wipe all failure memory */
export function resetInTabFailures(): void {
  failures.clear();
}

// ── Sticky per-conversation routing ─────────────────────────

const stickyModel = new Map<string, string>();

/** Forgets a conversation's binding (conversation deleted) */
export function clearInTabSticky(conversationId: string): void {
  stickyModel.delete(conversationId);
}

export interface PickInTabModelParams {
  conversationId: string;
  /** Turn carries image attachments — restrict to vision-capable models */
  needsVision?: boolean;
  /** Models to skip entirely (already failed this turn) */
  exclude?: Set<string>;
}

export interface PickInTabModelResult {
  modelId: string;
  /** True when cooldowns were ignored (whole pool was cooling) */
  relaxed: boolean;
}

/**
 * Chooses the underlying model for an InTab turn: the conversation's
 * sticky binding while it's healthy, otherwise the highest-ranked
 * pool model not cooling down. When every model is cooling (rate
 * limit storms), relaxes cooldowns and picks the least-recently-
 * failed candidate — trying is always better than refusing.
 * Returns null only when the pool is empty and nothing is excluded.
 */
export function pickInTabModel(
  params: PickInTabModelParams
): PickInTabModelResult | null {
  const { conversationId, needsVision = false, exclude } = params;
  const pool = currentInTabPool();

  const visionOk = (m: ModelInfo): boolean =>
    !needsVision || !m.inputModalities || m.inputModalities.includes("image");

  const eligible = pool.filter((m) => !exclude?.has(m.id) && visionOk(m));
  const candidates = eligible.length > 0 ? eligible : pool.filter((m) => !exclude?.has(m.id));
  if (candidates.length === 0) return null;

  const now = Date.now();
  const record = (m: ModelInfo) => failures.get(m.id);
  const isCooling = (m: ModelInfo): boolean => (record(m)?.cooldownUntil ?? 0) > now;

  // 1. Sticky binding — keep the conversation's model while it works
  const stickyId = stickyModel.get(conversationId);
  const sticky = stickyId ? candidates.find((m) => m.id === stickyId) : undefined;
  if (sticky && !isCooling(sticky)) {
    return { modelId: sticky.id, relaxed: false };
  }

  // 2. Fresh pick — highest-ranked healthy candidate
  const healthy = candidates.find((m) => !isCooling(m));
  if (healthy) {
    stickyModel.set(conversationId, healthy.id);
    return { modelId: healthy.id, relaxed: false };
  }

  // 3. Everything cooling — relax, oldest failure first
  const relaxed = [...candidates].sort(
    (a, b) => (record(a)?.lastFailureAt ?? 0) - (record(b)?.lastFailureAt ?? 0)
  )[0]!;
  stickyModel.set(conversationId, relaxed.id);
  return { modelId: relaxed.id, relaxed: true };
}

/** Binds a conversation to a model without consulting health (for callers that already validated) */
export function bindInTabModel(conversationId: string, modelId: string): void {
  stickyModel.set(conversationId, modelId);
}

// ── Display mask ────────────────────────────────────────────

/**
 * UI-facing name for a model id. InTab-routed ids render as
 * "InTab LLM"; everything else resolves through the catalog names
 * supplied by the caller, then falls back to the raw id.
 */
export function displayNameFor(
  modelId: string | undefined,
  catalog: ModelInfo[]
): string {
  if (!modelId) return INTAB_MODEL_NAME;
  if (isIntabModel(modelId)) return INTAB_MODEL_NAME;
  return (
    catalog.find((m) => m.id === modelId)?.name ??
    INTAB_FALLBACK_POOL.find((m) => m.id === modelId)?.name ??
    modelId
  );
}
