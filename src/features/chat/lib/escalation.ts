// ============================================================
// Escalation — Retry on a Stronger Model When the Chosen One Stalls
// ============================================================
// The harness does not know which model is good. It cannot: the catalog
// publishes prices, context windows and parameter lists, not competence.
// What it CAN know is when the model it is holding has demonstrably
// stopped working — the same tool call failing for the third time, or a
// provider refusing the request outright — and it can then hand the
// round to something with more capability instead of printing an error.
//
// Two rules keep this honest:
//
//   1. "Stronger" is defined by evidence the catalog actually publishes.
//      Price per million output tokens, adjusted for declared reasoning
//      support, is the only competence signal available for a model we
//      have never called. That is a HEURISTIC, and every automatic
//      switch says so, because a silent upgrade to a $75/M model is a
//      worse bug than the one it fixes.
//   2. Automatic escalation stays inside a sane budget
//      (MAX_AUTO_ESCALATION_PRICE). Past that line the harness refuses
//      and names the reason, leaving the choice — and the bill — with
//      the user, who can name a target explicitly in settings.
//
// Nothing here touches the store or the network: the decision is pure so
// it can be tested, and the CALLER announces the result in the
// transcript.
//
// Two ways the same choice gets used, with different visibility:
//
//   • as a FAILOVER CANDIDATE (services/turn-prep.ts), where the host's
//     existing candidate walk retries a provider-rejected request on the
//     stronger model, and the answering model is recorded on the message;
//   • as a MID-TURN SWITCH (session/turn-engine.ts), taken when the model
//     proves itself stuck, announced in the transcript before the next
//     round because the user's chosen model is changing under them.
//
// A model swap the user cannot see would be a betrayal of the thing that
// makes a multi-model harness trustworthy.

import { getCachedModelCatalog } from "./model-catalog";
import { modelSupportsTools } from "./model-state";
import type { ModelInfo } from "../types";

/**
 * Ceiling for an AUTOMATIC upgrade, in USD per 1M completion tokens.
 * Beyond this, escalation is refused and the user is told to name a
 * target themselves: the harness will not discover that a $75/M model is
 * strong by putting it on someone's invoice.
 */
export const MAX_AUTO_ESCALATION_PRICE = 20;

/** A real upgrade must beat the current model by at least this factor */
const MIN_UPGRADE_FACTOR = 1.5;
/** …or by this absolute margin, when the current model is free */
const MIN_UPGRADE_MARGIN = 1;

export interface EscalationTargetChoice {
  modelId: string;
  /** Why this model, in words the user reads in the transcript */
  reason: string;
  /** True when the choice came from settings rather than the heuristic */
  explicit: boolean;
}

export interface EscalationOptions {
  /** Automatic escalation enabled (undefined = enabled) */
  enabled?: boolean;
  /** Explicit target from settings (wins over the automatic pick) */
  preferred?: string;
  /** The turn will carry tool definitions */
  needTools?: boolean;
  /** Minimum context window the target must offer */
  minContext?: number;
  /** Catalog override (tests); defaults to the live cached catalog */
  catalog?: ModelInfo[];
}

/** True unless the user turned it off (default on) */
export function escalationEnabled(flag: boolean | undefined): boolean {
  return flag !== false;
}

/**
 * Capability proxy from published catalog facts. Price per 1M output
 * tokens, with a bump for models that declare reasoning support and a
 * discount for free tiers (a free model's $0 price is not a claim about
 * anything except its price).
 */
export function capabilityScore(info: ModelInfo | undefined): number {
  if (!info) return 0;
  const price = info.completionPrice ?? 0;
  if (!(price > 0)) return 0;
  const reasoning = info.reasoning ? 1.2 : 1;
  return price * reasoning;
}

function label(info: ModelInfo): string {
  const price = info.completionPrice;
  return typeof price === "number" ? `${info.name} ($${price}/M out)` : info.name;
}

/**
 * Chooses the model a stalled turn should continue on.
 *
 * An explicit target from settings is honoured first — the user's choice
 * is not second-guessed, only validity-checked (it must be a different
 * model, and one that can call tools when the turn needs tools).
 *
 * Otherwise: among models that can do this turn's job, keep those whose
 * capability score is a REAL step up (≥1.5× the current, or ≥1 point
 * more when the current model is free), then take the CHEAPEST of them.
 * The cheapest real upgrade is the right default: the goal is to get
 * unstuck, not to buy the most expensive model on the list.
 *
 * `null` means the honest answer — nothing in the catalog is known to be
 * stronger within budget — and the caller then reports the failure it
 * already had rather than pretending it retried. A current model the
 * catalog does not describe is one of those refusals: without published
 * facts about it there is no way to know that the next model is a step
 * UP, and a swap that might be a downgrade is worse than the original
 * failure, because it is invisible.
 */
export function pickEscalationTarget(
  from: string,
  opts: EscalationOptions = {}
): EscalationTargetChoice | null {
  if (!escalationEnabled(opts.enabled)) return null;

  const catalog = opts.catalog ?? getCachedModelCatalog() ?? [];
  const current = catalog.find((m) => m.id === from);

  // ── An explicit target (settings) ──
  const preferred = opts.preferred?.trim();
  if (preferred && preferred !== from) {
    const info = catalog.find((m) => m.id === preferred);
    if (info && opts.needTools && !modelSupportsTools(info)) {
      return null; // a tools turn cannot continue on a model that cannot call them
    }
    return {
      modelId: preferred,
      reason: `the escalation model you set (${info ? info.name : preferred})`,
      explicit: true,
    };
  }

  if (catalog.length === 0) return null;
  // No published facts about the model that stalled → no basis for calling
  // anything else stronger. (An explicit target was handled above.)
  if (!current) return null;

  const currentScore = capabilityScore(current);
  const threshold = Math.max(
    currentScore > 0 ? currentScore * MIN_UPGRADE_FACTOR : 0,
    currentScore + MIN_UPGRADE_MARGIN
  );

  const candidates = catalog
    .filter((m) => m.id !== from)
    .filter((m) => (opts.needTools ? modelSupportsTools(m) : true))
    .filter((m) => (opts.minContext ? (m.contextLength ?? 0) >= opts.minContext : true))
    .map((m) => ({ info: m, score: capabilityScore(m) }))
    .filter((c) => c.score >= threshold)
    .filter((c) => (c.info.completionPrice ?? 0) <= MAX_AUTO_ESCALATION_PRICE)
    .sort((a, b) => a.score - b.score || a.info.id.localeCompare(b.info.id));

  const pick = candidates[0];
  if (!pick) return null;

  const fromLabel = label(current);
  return {
    modelId: pick.info.id,
    reason:
      `cheapest capably stronger model by published price and reasoning support ` +
      `(${label(pick.info)} vs ${fromLabel}) — a heuristic, not a measurement`,
    explicit: false,
  };
}

// ── Triggers ─────────────────────────────────────────────────

/** Whether the turn may spend one automatic escalation right now */
export function canEscalate(state: {
  /** Automatic escalation enabled (undefined = enabled) */
  enabled?: boolean;
  /** An escalation already happened this turn */
  alreadyEscalated?: boolean;
}): boolean {
  return escalationEnabled(state.enabled) && state.alreadyEscalated !== true;
}

/**
 * A repeated FAILING call is the clearest evidence the model is stuck:
 * the harness has already told it, in words, to change approach, and it
 * repeated the call anyway. Three identical failures is the same bar the
 * repair layer uses, deliberately — one policy, one number.
 */
export const STUCK_FAILING_REPEATS = 3;

/**
 * One-line explanation committed to the transcript before the switch. It
 * names the evidence, the model being swapped in, and the reason for that
 * particular model — a switch the user cannot explain is a switch they
 * cannot trust.
 */
export function escalationNote(choice: EscalationTargetChoice, fromLabel: string): string {
  return [
    `_Switching this turn from ${fromLabel} to ${choice.modelId} — it repeated the same failing tool call ${STUCK_FAILING_REPEATS} times.`,
    `Why this model: ${choice.reason}.`,
    `Answers from here on come from it; the conversation is unchanged._`,
  ].join(" ");
}

/** Why escalation did not happen (shown when a swap was expected) */
export function noEscalationReason(choice: null, opts: EscalationOptions): string {
  if (!escalationEnabled(opts.enabled)) return "automatic escalation is off in Chat Settings.";
  return (
    "no model in the catalog is known to be stronger within the automatic budget " +
    `($${MAX_AUTO_ESCALATION_PRICE}/M output). Pick one in Chat Settings if you want escalation.`
  );
}
