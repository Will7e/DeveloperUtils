// ============================================================
// InTab Flash — Virtual Free-Model Router
// ============================================================
// "intab/intab-llm" is a synthetic model id that never goes on the
// wire. The chat runner resolves it here to a concrete OpenRouter
// free model:
//
//   1. Pool — free models from the live catalog (isFree, ≥32k
//      context), ranked by a curated preference order then by
//      context size. A static fallback pool covers offline/first-run.
//   2. Tiers — the virtual model ships in three flavors (Light /
//      High / Max, see INTAB_MODEL_TIERS in constants.ts). The tier
//      picks WHICH pool order is used; the task classification
//      (quick/code/analysis/vision/agent, see intab-classify.ts)
//      then re-ranks candidates WITHIN the tier. A kind can lift a
//      model inside its tier but never cross tiers.
//   3. Learning loop — a persisted feedback score table
//      (intab-learn.ts) blends into the ranking: regenerations,
//      aborts, and smooth completions per (model, turnKind) shift
//      the order over time. Static preferences act as priors.
//   4. Sticky routing — a conversation keeps the same underlying
//      model across turns *of the same kind* so tone/formatting
//      stays consistent; it only moves when the model fails.
//   5. Failure memory — 429s cool a model down (header-informed
//      when the provider reports a reset), hard failures for 30s
//      plus a strike; two strikes earn a five-minute timeout. Free
//      models that exhaust their daily cap are demoted for the day
//      after a small grace allowance.
//   6. Vision gate — image-bearing turns can only route to pool
//      models advertising "image" input.
//
// Everything here is display-agnostic: the UI masks the underlying
// id as "InTab Flash" (see displayNameFor), while stored messages
// keep the real id for exports and debugging.

import {
  INTAB_DAILY_CAP_GRACE_REQUESTS,
  INTAB_FALLBACK_POOL,
  INTAB_MODEL_ID,
  INTAB_MODEL_NAME,
  INTAB_TIER_DESIRED_STATE,
  intabTierById,
  INTAB_TURN_KINDS,
  INTAB_TURN_KIND_PREFERENCE,
} from "../constants";
import { getCachedModelCatalog } from "./model-catalog";
import { getLearnedBonus, recordFeedback, type FeedbackKind } from "./intab-learn";
import type { ModelInfo } from "../types";
import type { TurnKind } from "./intab-classify";

/** Minimum context window for a free model to join the pool */
const INTAB_MIN_CONTEXT_TOKENS = 32_000;

/**
 * Tier pool definitions — the background answer to "which AI does
 * each tier route to?". Ordered prefix preferences over the free
 * OpenRouter catalog; anything unlisted ranks after by context size.
 *
 * Refreshed Sep 2026: the new-generation free families lead.
 *  · dots-studio/dots-3-note-preview — 280B MoE w/ only 16B active
 *    params → fastest time-to-first-token of the free tier.
 *  · nex-agi/nex-n2.5-pro — 262k ctx, agentic/coding specialist.
 *  · inclusionai/ling-3.0-flash — 262k ctx, fast generalist.
 *  · qwen3-coder, gpt-oss-120b/20b, gemma-4 — proven secondaries.
 * The old heavy-first orders (nemotron-550b leading) were demoted:
 * they queued for tens of seconds on the free tier.
 *
 * LIGHT: raw speed — the smallest/cheapest-to-serve models first.
 * HIGH (default): balanced — strong generalists, coder lifted for
 * code turns via the per-kind table.
 * MAX: strongest reasoning/agentic models, big windows first.
 */
const INTAB_TIER_POOL_PREFERENCE = {
  light: [
    "dots-studio/dots-3-note-preview",
    "nex-agi/nex-n2.5-mini",
    "inclusionai/ling-3.0-flash",
    "openai/gpt-oss-20b",
    "google/gemma-4-26b",
    "qwen/qwen3-coder",
    "openai/gpt-oss-120b",
    "nex-agi/nex-n2.5-pro",
    "google/gemma-4-31b",
  ],
  high: [
    "inclusionai/ling-3.0-flash",
    "qwen/qwen3-coder",
    "nex-agi/nex-n2.5-pro",
    "openai/gpt-oss-120b",
    "dots-studio/dots-3-note-preview",
    "google/gemma-4-31b",
    "nex-agi/nex-n2.5-mini",
    "openai/gpt-oss-20b",
    "google/gemma-4-26b",
  ],
  max: [
    "nex-agi/nex-n2.5-pro",
    "openai/gpt-oss-120b",
    "nvidia/nemotron",
    "inclusionai/ling-3.0-flash",
    "google/gemma-4-31b",
    "qwen/qwen3-coder",
    "dots-studio/dots-3-note-preview",
  ],
} as const;

type TierKey = "light" | "high" | "max";

/**
 * Resolves a synthetic InTab model id to its tier key. The legacy
 * id (INTAB_MODEL_ID) IS the High tier — kept for backwards
 * compatibility with stored conversations and settings.
 */
function tierKeyForId(modelId: string): TierKey {
  if (modelId === INTAB_MODEL_ID) return "high";
  if (modelId.endsWith("-light")) return "light";
  if (modelId.endsWith("-max")) return "max";
  return "high";
}

/**
 * True when the id is a virtual InTab model (any tier). Matches the
 * legacy exact id plus the tier-suffixed ids.
 */
export function isIntabModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return modelId === INTAB_MODEL_ID || intabTierById(modelId) !== undefined;
}

/** Prefix preference index for a model id (−1 when unlisted) */
function preferenceIndex(list: readonly string[], id: string): number {
  const lower = id.toLowerCase();
  return list.findIndex((p) => lower.startsWith(p));
}

/** Learned-feedback weight inside the composite ranking score */
const LEARN_WEIGHT = 1.2;
/** Daily-cap penalty applied to models believed near/at their free cap */
const DAILY_CAP_PENALTY = 10;

/** Builds the ranked pool from a catalog (live or fallback) for a tier */
export function buildInTabPool(models: ModelInfo[], tier: TierKey = "high"): ModelInfo[] {
  const free = models.filter(
    (m) =>
      m.isFree &&
      (m.contextLength === undefined || m.contextLength >= INTAB_MIN_CONTEXT_TOKENS)
  );
  if (free.length === 0) return [];

  const prefs = INTAB_TIER_POOL_PREFERENCE[tier];
  const rank = (m: ModelInfo): number => {
    const idx = preferenceIndex(prefs, m.id);
    return idx === -1 ? prefs.length : idx;
  };

  return free.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    // Within a rank (or unranked): larger context first
    return (b.contextLength ?? 0) - (a.contextLength ?? 0);
  });
}

/** Current pool for a tier: live catalog when loaded, static fallback otherwise */
export function currentInTabPool(tier: TierKey = "high"): ModelInfo[] {
  const catalog = getCachedModelCatalog();
  return buildInTabPool(
    catalog && catalog.length > 0 ? catalog : INTAB_FALLBACK_POOL,
    tier
  );
}

// ── Failure memory ──────────────────────────────────────────

interface FailureRecord {
  /** Milliseconds epoch until which the model is skipped */
  cooldownUntil: number;
  /** Consecutive hard failures (reset on success) */
  strikes: number;
  /** When the last failure happened (for least-recently-failed ordering) */
  lastFailureAt: number;
  /** True when this failure was a daily-cap exhaustion (long demotion) */
  dailyCap?: boolean;
}

const failures = new Map<string, FailureRecord>();

// ── Daily-cap accounting (free models reset daily) ───────────

/**
 * Requests served per model in the current UTC day, plus the day
 * they belong to. Free OpenRouter models cap per day (not per
 * minute), so the router deprioritizes models believed near their
 * cap before they hard-fail.
 */
const dailyUsage = new Map<string, { day: string; count: number }>();

function utcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Records one request dispatched to a pool model (for cap proximity) */
export function recordDailyRequest(modelId: string): void {
  const day = utcDayKey();
  const entry = dailyUsage.get(modelId);
  if (entry && entry.day === day) {
    entry.count += 1;
  } else {
    dailyUsage.set(modelId, { day, count: 1 });
  }
}

/** Clears the day's request counters (debug/tests) */
export function resetDailyUsage(): void {
  dailyUsage.clear();
}

/** Extracts a retry/reset delay in ms from rate-limit headers */
function retryDelayFromHeaders(headers: Headers | Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const get = (k: string): string | null | undefined => {
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(k);
    }
    return (headers as Record<string, string>)[k];
  };
  const resetHeader = get("x-ratelimit-reset") ?? get("retry-after");
  if (!resetHeader) return undefined;

  // Absolute ISO timestamp or seconds-to-reset
  const iso = Date.parse(resetHeader);
  if (!Number.isNaN(iso)) {
    return Math.max(0, iso - Date.now());
  }
  const secs = parseFloat(resetHeader);
  if (Number.isFinite(secs)) {
    return Math.max(0, secs * 1000);
  }
  return undefined;
}

/** Cooldown windows (ms) */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const HARD_FAIL_COOLDOWN_MS = 30_000;
const DEMOTED_COOLDOWN_MS = 5 * 60_000;
/** Hard failures before the model earns the long timeout */
const STRIKES_TO_DEMOTE = 2;
/**
 * Free daily caps span hours — after the grace allowance is spent
 * (see INTAB_DAILY_CAP_GRACE_REQUESTS usage in pickInTabModel), the
 * model sits out the rest of the UTC day.
 */
const DAILY_CAP_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Records a model failure. `headers` (from a 429 response) refines
 * the cooldown to the provider's actual reset window; a daily-cap
 * failure (`kind: "daily"`) demotes the model for hours.
 */
export function recordModelFailure(
  modelId: string,
  kind: "rate" | "hard" | "daily" | "slow",
  headers?: Headers | Record<string, string>
): void {
  const now = Date.now();
  const prev = failures.get(modelId);

  if (kind === "daily") {
    failures.set(modelId, {
      cooldownUntil: now + DAILY_CAP_COOLDOWN_MS,
      strikes: prev?.strikes ?? 0,
      lastFailureAt: now,
      dailyCap: true,
    });
    return;
  }

  if (kind === "rate") {
    // Header-informed cooldown when the provider tells us the reset
    const headerDelay = retryDelayFromHeaders(headers);
    const cooldownMs =
      headerDelay !== undefined
        ? Math.min(Math.max(headerDelay, 1_000), 6 * 60 * 60_000)
        : RATE_LIMIT_COOLDOWN_MS;
    failures.set(modelId, {
      cooldownUntil: now + cooldownMs,
      strikes: 0,
      lastFailureAt: now,
      dailyCap: prev?.dailyCap,
    });
    return;
  }

  if (kind === "slow") {
    // Lost a hedged race — no cooldown (the model works, just slowly),
    // only a strike so the learning loop sees the signal.
    failures.set(modelId, {
      cooldownUntil: prev?.cooldownUntil ?? 0,
      strikes: (prev?.strikes ?? 0) + 1,
      lastFailureAt: now,
      dailyCap: prev?.dailyCap,
    });
    return;
  }

  // "hard": 5xx / network / timeout / empty
  const strikes = (prev?.strikes ?? 0) + 1;
  const cooldownMs =
    strikes >= STRIKES_TO_DEMOTE ? DEMOTED_COOLDOWN_MS : HARD_FAIL_COOLDOWN_MS;
  failures.set(modelId, {
    cooldownUntil: now + cooldownMs,
    strikes,
    lastFailureAt: now,
    dailyCap: prev?.dailyCap,
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

// ── Sticky per-conversation routing ─────────────────

/** Sticky bindings keyed (conversationId, turnKind, tier) */
const stickyModel = new Map<string, string>();

function stickyKey(conversationId: string, turnKind: TurnKind, tier: TierKey): string {
  return `${conversationId}::${turnKind}::${tier}`;
}

/** Forgets a conversation's bindings (conversation deleted) */
export function clearInTabSticky(conversationId: string): void {
  const prefix = `${conversationId}::`;
  for (const key of stickyModel.keys()) {
    if (key.startsWith(prefix)) stickyModel.delete(key);
  }
}

export interface PickInTabModelParams {
  conversationId: string;
  /** Models to skip entirely (already failed this turn) */
  exclude?: Set<string>;
  /** Task kind from the turn classifier (default: base order) */
  turnKind?: TurnKind;
  /** Turn carries image attachments — restrict to vision-capable models */
  needsVision?: boolean;
  /** "summary" picks don't update the last-turn routing record */
  purpose?: "turn" | "summary";
  /**
   * Synthetic InTab model id of the conversation (Light/High/Max
   * tier selector). Defaults to the legacy id → High tier.
   */
  tierModelId?: string;
}

export interface PickInTabModelResult {
  modelId: string;
  /** True when cooldowns were ignored (whole pool was cooling) */
  relaxed: boolean;
  /** The turn kind used for routing (echoed for logging/learn keys) */
  turnKind: TurnKind;
}

/** Last routed model per conversation (for regenerate/abort feedback) */
const lastRouting = new Map<string, { modelId: string; turnKind: TurnKind; tier: TierKey }>();

/** The model+kind that served this conversation's most recent turn */
export function getLastRouting(
  conversationId: string
): { modelId: string; turnKind: TurnKind; tier: TierKey } | undefined {
  return lastRouting.get(conversationId);
}

/** Records a regenerate against the conversation's last routed model */
export function recordRegenerateFeedback(conversationId: string): void {
  const last = lastRouting.get(conversationId);
  if (!last) return;
  recordFeedback(last.modelId, last.turnKind, "regenerate");
}

/** True when the model is demoted for daily-cap exhaustion */
export function isModelDailyCapCooling(modelId: string): boolean {
  const f = failures.get(modelId);
  return Boolean(f?.dailyCap && f.cooldownUntil > Date.now());
}

/**
 * Composite routing score (lower = better). The tier's base order
 * dominates; the turn kind refines within the tier; health
 * (cooldowns, strikes), daily-cap proximity, and learned feedback
 * adjust on top.
 */
function scoreCandidate(
  m: ModelInfo,
  turnKind: TurnKind,
  tier: TierKey,
  now: number
): number {
  const tierPrefs = INTAB_TIER_POOL_PREFERENCE[tier];
  const kindPrefs = INTAB_TURN_KIND_PREFERENCE[turnKind];
  const tierIdx = preferenceIndex(tierPrefs, m.id);
  const baseIdx = tierIdx === -1 ? tierPrefs.length : tierIdx;
  // Kind refinement (within-tier lift): a strong kind match climbs
  // up to ~2.5 tier ranks — enough for the coder specialist to
  // overtake the tier's generalist on code turns — but never enough
  // to pull a model in from outside the tier's pool.
  const KIND_LIFT_MAX = 2.5;
  const kindIdx = preferenceIndex(kindPrefs, m.id);
  const kindRefinement =
    kindIdx === -1
      ? KIND_LIFT_MAX
      : (kindIdx / Math.max(1, kindPrefs.length)) * KIND_LIFT_MAX;
  const learned = getLearnedBonus(m.id, turnKind); // −1..1, positive = good
  const f = failures.get(m.id);
  const cooling = f && f.cooldownUntil > now ? 1 : 0;
  // Mild intra-day load spreading: prefer less-used models as a
  // tiebreaker so one workhorse doesn't burn its daily cap alone.
  const usedToday = dailyUsage.get(m.id);
  const requestsToday =
    usedToday && usedToday.day === utcDayKey() ? usedToday.count : 0;
  const capSpread =
    Math.min(2, Math.max(0, requestsToday - INTAB_DAILY_CAP_GRACE_REQUESTS) * 0.1);
  return (
    baseIdx +
    kindRefinement +
    cooling * 100 +
    (f?.dailyCap && f.cooldownUntil > now ? DAILY_CAP_PENALTY : 0) +
    capSpread -
    LEARN_WEIGHT * learned
  );
}

/**
 * Ranks the eligible pool for a turn by composite score — healthy
 * models first (score ascending), cooling models after. No sticky
 * side effects; used by the hedged racer for hedge candidates.
 */
export function rankInTabCandidates(
  params: PickInTabModelParams & { count?: number }
): ModelInfo[] {
  const { exclude, needsVision = false } = params;
  const turnKind: TurnKind = params.turnKind ?? "analysis";
  const tier = tierKeyForId(params.tierModelId ?? INTAB_MODEL_ID);
  const pool = currentInTabPool(tier);

  const visionOk = (m: ModelInfo): boolean =>
    !needsVision || !m.inputModalities || m.inputModalities.includes("image");

  const candidates = pool.filter(
    (m) => !exclude?.has(m.id) && visionOk(m)
  );
  const now = Date.now();
  const isCooling = (m: ModelInfo): boolean =>
    (failures.get(m.id)?.cooldownUntil ?? 0) > now;

  const ranked = [...candidates].sort(
    (a, b) => scoreCandidate(a, turnKind, tier, now) - scoreCandidate(b, turnKind, tier, now)
  );
  const healthy = ranked.filter((m) => !isCooling(m));
  const cooling = ranked.filter(isCooling);
  return [...healthy, ...cooling].slice(0, params.count ?? ranked.length);
}

/**
 * Chooses the underlying model for an InTab turn: sticky
 * per-(conversation, kind, tier) binding while healthy, otherwise
 * the best composite score among healthy candidates. When every
 * model is cooling (rate-limit storms), relaxes cooldowns and picks
 * the least-recently-failed candidate — trying is always better
 * than refusing. Returns null only when the pool is empty and
 * nothing is excluded.
 */
export function pickInTabModel(
  params: PickInTabModelParams
): PickInTabModelResult | null {
  const { conversationId, exclude, needsVision = false, purpose = "turn" } = params;
  const turnKind: TurnKind = params.turnKind ?? "analysis";
  const tier = tierKeyForId(params.tierModelId ?? INTAB_MODEL_ID);
  const pool = currentInTabPool(tier);

  const visionOk = (m: ModelInfo): boolean =>
    !needsVision || !m.inputModalities || m.inputModalities.includes("image");

  const eligible = pool.filter((m) => !exclude?.has(m.id) && visionOk(m));
  const candidates = eligible.length > 0 ? eligible : pool.filter((m) => !exclude?.has(m.id));
  if (candidates.length === 0) return null;

  const now = Date.now();
  const isCooling = (m: ModelInfo): boolean =>
    (failures.get(m.id)?.cooldownUntil ?? 0) > now;

  const commit = (modelId: string, relaxed: boolean): PickInTabModelResult => {
    if (purpose === "turn") {
      stickyModel.set(stickyKey(conversationId, turnKind, tier), modelId);
      lastRouting.set(conversationId, { modelId, turnKind, tier });
    }
    return { modelId, relaxed, turnKind };
  };

  // Sticky binding per (conversation, kind, tier) — keep the model
  // while it works and isn't heavily penalized.
  const stickyId = stickyModel.get(stickyKey(conversationId, turnKind, tier));
  const sticky = stickyId ? candidates.find((m) => m.id === stickyId) : undefined;
  if (sticky && !isCooling(sticky)) {
    const stickyScore = scoreCandidate(sticky, turnKind, tier, now);
    // Re-bind only when a non-sticky candidate beats it clearly
    // (learned drift, cap proximity) — small deltas keep stability.
    const better = candidates
      .filter((m) => m.id !== sticky.id)
      .map((m) => ({ m, s: scoreCandidate(m, turnKind, tier, now) }))
      .filter(({ s }) => s < stickyScore - 1.0)
      .sort((a, b) => a.s - b.s)[0];
    if (better) return commit(better.m.id, false);
    return commit(sticky.id, false);
  }

  // Fresh pick — best composite score among healthy candidates
  const healthy = candidates.filter((m) => !isCooling(m));
  if (healthy.length > 0) {
    const pick = [...healthy].sort(
      (a, b) => scoreCandidate(a, turnKind, tier, now) - scoreCandidate(b, turnKind, tier, now)
    )[0]!;
    return commit(pick.id, false);
  }

  // Everything cooling — relax, least-penalized / oldest failure first
  const relaxed = [...candidates].sort((a, b) => {
    const la = failures.get(a.id)?.lastFailureAt ?? 0;
    const lb = failures.get(b.id)?.lastFailureAt ?? 0;
    if (la !== lb) return la - lb;
    return scoreCandidate(a, turnKind, tier, now) - scoreCandidate(b, turnKind, tier, now);
  })[0]!;
  return commit(relaxed.id, true);
}

/** Binds a conversation to a model without consulting health (for callers that already validated) */
export function bindInTabModel(conversationId: string, modelId: string): void {
  const tier = tierKeyForId(INTAB_MODEL_ID); // caller-validated; default tier key
  for (const kind of INTAB_TURN_KINDS) {
    stickyModel.set(`${conversationId}::${kind}::${tier}`, modelId);
  }
}

// ── Display mask ────────────────────────────────────────

/**
 * UI-facing name for a model id. InTab-routed ids (any tier) render
 * as the product model — "InTab Flash 5.5" — since the tier is a
 * background state, not a separate model. Everything else resolves
 * through the catalog names supplied by the caller, then falls back
 * to the raw id.
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

/** Re-export so runner code can import FeedbackKind from one place */
export type { FeedbackKind };

// ── Capability-aware tier state ─────────────────────────

/** Effort levels ordered from least to most compute */
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

function effortDistance(a: string, b: string): number {
  const ia = EFFORT_ORDER.indexOf(a);
  const ib = EFFORT_ORDER.indexOf(b);
  if (ia === -1 || ib === -1) return Number.POSITIVE_INFINITY;
  return Math.abs(ia - ib);
}

/**
 * Snaps the tier's DESIRED per-request state to what the concrete
 * model actually accepts, per the OpenRouter catalog
 * (`supported_parameters` + `reasoning.supported_efforts`).
 *
 * Returns the JSON body fragment to merge into the request — `{}`
 * when the model declares no reasoning capability at all (or the
 * catalog hasn't loaded yet, in which case we stay conservative:
 * no unsupported keys on the wire).
 *
 * Effort snapping: exact match passes through; otherwise the closest
 * supported level wins; unknown/unparseable effort lists fall back
 * to omitting the key (provider default applies).
 */
export function snapRequestStateForModel(
  tierModelId: string | undefined,
  modelInfo?: ModelInfo
): Record<string, unknown> {
  if (!tierModelId) return {};
  const tier = intabTierById(tierModelId);
  if (!tier) return {}; // real OpenRouter model — no InTab state
  const desired = INTAB_TIER_DESIRED_STATE[tier.id as keyof typeof INTAB_TIER_DESIRED_STATE];
  if (!desired) return {};

  const params = modelInfo?.supportedParameters;
  const reasoningMeta = modelInfo?.reasoning;

  // No catalog data (offline / fallback pool): send nothing — the
  // provider default (often "reasoning on at default_effort") is a
  // safe, always-valid request.
  if (!params || params.length === 0) return {};

  const supportsEffort = params.includes("reasoning_effort");
  const supportsReasoning = params.includes("reasoning");

  // Model accepts neither reasoning knob: plain request
  if (!supportsEffort && !supportsReasoning) return {};

  const state: Record<string, unknown> = {};

  if (supportsEffort) {
    const supported = reasoningMeta?.supportedEfforts ?? [];
    if (supported.length === 0) {
      // Parameter advertised without an effort list — send the exact
      // desire; the provider applies its own accepted values.
      state.reasoning_effort = desired.reasoningEffort;
    } else if (supported.includes(desired.reasoningEffort)) {
      state.reasoning_effort = desired.reasoningEffort;
    } else {
      // Snap to the closest supported effort (ties → the deeper one,
      // matching the tier's intent);
      const best = [...supported]
        .sort(
          (a, b) =>
            effortDistance(a, desired.reasoningEffort) -
              effortDistance(b, desired.reasoningEffort) ||
            EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a)
        )[0];
      if (best) state.reasoning_effort = best;
    }
  }

  // `reasoning.exclude` only rides models that accept the reasoning
  // map at all; exclusion is only meaningful when effort was tuned.
  if (supportsReasoning && desired.excludeThinking) {
    state.reasoning = { exclude: true };
  }

  return state;
}

// ── Dev-only router introspection ────────────────────────
// Exposes the background routing definition ("which AI does each
// tier route to, and why?") for debugging in the devtools console.
// Dev build only — stripped by the Vite define below.
if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as unknown as { __INTAB_ROUTER__: unknown }).__INTAB_ROUTER__ = {
    /** The tier → pool-order definition (the routing ground truth) */
    tiers: INTAB_TIER_POOL_PREFERENCE,
    /** Per-turn-kind refinement orders (within-tier lifts) */
    kindOrders: INTAB_TURN_KIND_PREFERENCE,
    /** Ranked pool a tier would route through right now */
    pool: (tierModelId: string = INTAB_MODEL_ID) =>
      currentInTabPool(tierKeyForId(tierModelId)).map((m) => m.id),
    /** Cooldowns, strikes, and daily-cap demotions */
    failures: () => Object.fromEntries(failures),
    /** Requests served per model today */
    dailyUsage: () => Object.fromEntries(dailyUsage),
    /** Sticky (conversation, kind, tier) bindings */
    sticky: () => Object.fromEntries(stickyModel),
    /** What the last turn of each conversation routed to */
    lastRouting: () => Object.fromEntries(lastRouting),
  };
}
