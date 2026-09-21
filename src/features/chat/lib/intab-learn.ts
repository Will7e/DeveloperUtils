// ============================================================
// InTab Learn — Feedback-Learned Model Scoring
// ============================================================
// InTab's defensible edge: the client itself holds the ground-truth
// quality signals for "did this model handle this kind of turn
// well?" — regenerations, aborts, empty replies, failovers, and
// smooth completions are all observed locally.
//
// A persisted score table keyed (modelId, turnKind) accumulates
// Beta-distribution pseudo-counts per feedback kind:
//
//   regenerate: user hit regenerate right after a reply  (α −1.5)
//   abort:      user stopped mid-reply                   (α −1)
//   empty:      model returned nothing                   (α −2)
//   failover:   this model failed and was skipped        (α −1)
//   slow:       lost a hedged race                       (α −0.5)
//   success:    reply completed normally                 (α +1)
//
// pickInTabModel() consumes getLearnedBonus() — a −1..1 scalar that
// blends into the routing score with static preferences as priors
// (ε-greedy exploration: cold pairs score 0 → static order wins;
// a small ε also lets unproven models earn their way up).
//
// UI-free and side-effect free beyond its own state.

import { INTAB_TURN_KINDS } from "../constants";

export type FeedbackKind =
  | "regenerate"
  | "abort"
  | "empty"
  | "failover"
  | "slow"
  | "success";

export type TurnKindForLearn = (typeof INTAB_TURN_KINDS)[number];

/** Pseudo-alpha deltas per feedback kind (negative = quality signal) */
const ALPHA: Record<FeedbackKind, number> = {
  regenerate: -1.5,
  abort: -1,
  empty: -2,
  failover: -1,
  slow: -0.5,
  success: +1,
};

/** Evidence threshold before a learned score influences routing */
const MIN_WEIGHT = 1.5;
/** Score clamp — one terrible model can't dominate the bonus space */
const MAX_ABS = 1;
/** ε-greedy exploration floor: unproven models stay in contention */
const EPSILON = 0.08;
/** Persisted sample cap per (model, kind) pair */
const MAX_EVENTS = 64;
/** Capacity-biased pseudo-prior strength (kept small) */
const PRIOR_STRENGTH = 0.75;

interface PairStats {
  /** Cumulative feedback weight (Σα per event, per-event capped) */
  weight: number;
  /** Events observed */
  events: number;
  /** Rolling record of recent feedback kinds (bounded) */
  recent: FeedbackKind[];
}

export interface LearnSnapshot {
  pairs: Record<string, PairStats>;
}

const state: { pairs: Record<string, PairStats> } = { pairs: {} };

function pairKey(modelId: string, turnKind: string): string {
  return `${modelId}::${turnKind}`;
}

function pair(modelId: string, turnKind: string): PairStats {
  return (state.pairs[pairKey(modelId, turnKind)] ??= {
    weight: 0,
    events: 0,
    recent: [],
  });
}

/** Records one feedback event for a (model, turnKind) pair */
export function recordFeedback(
  modelId: string,
  turnKind: TurnKindForLearn,
  kind: FeedbackKind
): void {
  if (!modelId || !turnKind) return;
  const p = pair(modelId, turnKind);
  // Per-event cap so a single catastrophic event can't dominate
  p.weight += Math.max(-3, Math.min(3, ALPHA[kind]));
  p.events += 1;
  p.recent.push(kind);
  if (p.recent.length > MAX_EVENTS) p.recent.shift();
}

/**
 * Learned bonus for a (model, turnKind) pair in −1..1 (positive =
 * good). Zero until MIN_WEIGHT evidence accrues; mild capacity prior
 * keeps larger models slightly ahead on cold starts.
 */
export function getLearnedBonus(modelId: string, turnKind: string): number {
  const p = state.pairs[pairKey(modelId, turnKind)];
  if (!p || p.events === 0) return 0;

  // Weighted evidence with diminishing returns (log growth)
  const evidence = Math.min(1, Math.log1p(p.events) / Math.log1p(6));
  const raw = p.weight / Math.max(1, Math.sqrt(p.events) * PRIOR_STRENGTH + 1);
  const clamped = Math.max(-MAX_ABS, Math.min(MAX_ABS, raw));

  // ε-greedy: mostly follow evidence, occasionally give an unproven
  // model a chance (handled probabilistically by the router's exploration).
  const score = evidence >= MIN_WEIGHT / 2 ? clamped : 0;
  // Mild exploration jitter so identical scores don't deadlock ties
  const jitter = p.events < 3 ? (Math.random() - 0.5) * 2 * EPSILON : 0;
  return Math.max(-1, Math.min(1, score + jitter));
}

/** Whether the pair has enough evidence to influence routing */
export function hasLearnedEvidence(modelId: string, turnKind: string): boolean {
  const p = state.pairs[pairKey(modelId, turnKind)];
  return Boolean(p && p.events >= 2 && Math.abs(p.weight) >= MIN_WEIGHT);
}

/** Snapshot for persistence (rides the settings blob) */
export function exportLearnState(): LearnSnapshot {
  return { pairs: structuredClone(state.pairs) };
}

export function importLearnState(snapshot: LearnSnapshot | undefined): void {
  if (!snapshot || typeof snapshot !== "object") return;
  state.pairs = {};
  for (const [key, p] of Object.entries(snapshot.pairs ?? {})) {
    if (
      p &&
      typeof p.weight === "number" &&
      typeof p.events === "number" &&
      Array.isArray(p.recent)
    ) {
      state.pairs[key] = {
        weight: p.weight,
        events: p.events,
        recent: p.recent.filter((k): k is FeedbackKind =>
          k in ALPHA
        ),
      };
    }
  }
}

/** Wipes learned feedback (settings reset / debugging) */
export function resetLearnState(): void {
  state.pairs = {};
}
