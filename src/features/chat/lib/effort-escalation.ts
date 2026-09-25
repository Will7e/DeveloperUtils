// ============================================================
// Effort Escalation — The Ladder's Thinking Rung
// ============================================================
// When a turn struggles, the responses available to the harness form a
// ladder, cheapest and least disruptive first:
//
//   1. knowledge   — load the procedure the task needs (a skill, an
//                    evidence note) so the model works from facts
//   2. thinking    — the SAME model, more reasoning depth
//   3. capability  — a stronger model (lib/escalation.ts, unchanged)
//
// The thinking rung is new, and it is deliberately a rung and not a
// replacement: it exists so that the response to friction is not
// automatically "switch models". A bump costs thinking tokens on the
// model the user already picked — no new price tier, no cache-invalidating
// system-prompt change, no provider failover — and for the very common
// case of a model that simply did not think hard enough about an
// ambiguous error, it is the response that actually addresses the cause.
//
// The same honesty rules as a model swap apply, one for one:
//
//   • the bump states its BASIS in the transcript (the named difficulty
//     signals), so "why did the effort change" is answerable;
//   • it is bounded — at most ONE bump per turn, never above `max`,
//     never on a model that cannot express effort at all;
//   • it dies with the turn. The conversation's effort setting is the
//     user's; a mid-turn bump is the harness adapting the request, not
//     rewriting their choice (mirrors `modelOverride` exactly).
//
// Pure like every other policy module: the caller resolves model info
// and passes it in, so this file is unit-testable without a catalog.

import type { DifficultyAssessment } from "./difficulty";
import { modelSupportsReasoning } from "./model-state";
import type { ModelInfo, ReasoningEffort } from "../types";

export interface EffortBumpChoice {
  /** The rung the rest of the turn should run at */
  effort: ReasoningEffort;
  /** The rung the turn was running at */
  from: ReasoningEffort;
  /** Why this bump, in words the user reads in the transcript */
  reason: string;
}

export interface EffortBumpOptions {
  /**
   * Model the turn is currently running on. The bump is refused when the
   * catalog cannot describe the model's reasoning support — sending an
   * unsupported effort key 400s strict providers (lib/model-state.ts),
   * and a bump that might kill the turn is worse than no bump.
   */
  modelInfo?: ModelInfo;
  /**
   * Adaptive effort master switch (settings). `undefined` = enabled,
   * matching how `autoEscalate` reads.
   */
  enabled?: boolean;
  /**
   * Already spent this turn. One bump per turn, like one escalation —
   * a policy that can fire repeatedly is a treadmill, and the evidence
   * after one bump (did the loop break?) is what decides the next rung.
   */
  alreadyBumped?: boolean;
  /**
   * True when a model escalation ALREADY happened this turn. The swap is
   * the stronger response; stacking an effort bump on top of it buys
   * thinking depth on a model about to hand the turn off. The rung is
   * skipped, not the policy — the caller evaluates before escalating.
   */
  alreadyEscalated?: boolean;
}

/** The difficulty level at which the thinking rung fires */
export const EFFORT_BUMP_LEVEL: DifficultyAssessment["level"] = "elevated";

/** The four UI rungs, cheapest → deepest (mirrors model-state's ordering) */
const RUNG_ORDER: readonly ReasoningEffort[] = ["low", "medium", "high", "max"];

/**
 * The next rung up, or `null` when the turn is already at `max` — the
 * point where there is no more thinking to buy and only a stronger
 * model can add capability.
 */
export function nextEffortRung(current: ReasoningEffort): ReasoningEffort | null {
  const index = RUNG_ORDER.indexOf(current);
  if (index === -1 || index === RUNG_ORDER.length - 1) return null;
  return RUNG_ORDER[index + 1] ?? null;
}

/**
 * True when the turn's difficulty justifies trying more thinking before
 * anything more expensive. `elevated` and `high` both qualify: at `high`
 * the bump runs FIRST (it is cheaper) and the model swap still follows
 * on the next round if the loop is still stuck.
 */
export function difficultyJustifiesEffortBump(assessment: DifficultyAssessment): boolean {
  return assessment.level === "elevated" || assessment.level === "high";
}

/**
 * Chooses the rung a struggling turn should continue on, or `null` when
 * the honest answer is "no bump available".
 *
 * `null` is one of: adaptive effort is off; this turn already spent its
 * bump; the turn already escalated models; the difficulty does not reach
 * the bump level; the model cannot express reasoning effort; or the rung
 * has no headroom left below `max`.
 */
export function pickEffortBump(
  current: ReasoningEffort,
  difficulty: DifficultyAssessment,
  opts: EffortBumpOptions = {}
): EffortBumpChoice | null {
  if (opts.enabled === false) return null;
  if (opts.alreadyBumped) return null;
  if (opts.alreadyEscalated) return null;
  if (!difficultyJustifiesEffortBump(difficulty)) return null;
  // Unknown model metadata is not evidence of capability here. A bump is
  // a request-body change, and a wrong key is a 400 — the asymmetry
  // between "might not help" and "might kill the turn" resolves to
  // refusing (the same rule `resolveEffortState` applies).
  if (!modelSupportsReasoning(opts.modelInfo)) return null;

  const next = nextEffortRung(current);
  if (!next) return null;

  const topSignals = difficulty.signals
    .slice(0, 3)
    .map((s) => s.detail)
    .join("; ");
  return {
    from: current,
    effort: next,
    reason:
      `struggling turn (${topSignals}) — same model, reasoning effort ` +
      `${current} → ${next} before considering a stronger model`,
  };
}

/**
 * The transcript note committed BEFORE the bump takes effect, mirroring
 * `escalationNote`: names the evidence, the change, and what it means for
 * the rest of the turn.
 */
export function effortEscalationNote(choice: EffortBumpChoice): string {
  return (
    `_Raising this turn's reasoning effort from ${choice.from} to ${choice.effort} — ${choice.reason}. ` +
    "The model is unchanged; the conversation's effort setting is untouched._"
  );
}

/**
 * One-line turn-log basis for the bump.
 */
export function effortBumpLogDetail(choice: EffortBumpChoice): string {
  return `effort bumped ${choice.from} → ${choice.effort} (${choice.reason})`;
}
