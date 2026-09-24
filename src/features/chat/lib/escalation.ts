// ============================================================
// Escalation — Retry on a Stronger Model When the Chosen One Stalls
// ============================================================
// The harness knows when the model it is holding has demonstrably stopped
// working — the same tool call failing for the third time, or a provider
// refusing the request outright — and it can then hand the round to something
// with more capability instead of printing an error.
//
// "Stronger" is where this file changed. It used to be price per million
// output tokens, because the catalog published prices and nothing else, and the
// header here said so: "the catalog publishes prices, context windows and
// parameter lists, not competence." That was true when it was written and it is
// not true now. `GET /benchmarks` publishes measured capability — a coding
// index, an agentic index, and OpenRouter's own accuracy and cost per completed
// task — so the picker ranks on a measurement when one exists and falls back to
// the price heuristic when one does not.
//
// Two rules keep this honest:
//
//   1. Every automatic switch states its BASIS in the transcript. A swap
//      justified by "coding index 81.6" and one justified by "cheaper than a
//      price difference" are different claims, and the user is told which one
//      happened. The heuristic is also the fallback rather than the default,
//      because a measurement that exists beats a proxy that correlates.
//   2. Automatic escalation stays inside a sane budget
//      (MAX_AUTO_ESCALATION_PRICE), and prefers a measured per-task cost when
//      the publisher reports one. Past that line the harness refuses and names
//      the reason, leaving the choice — and the bill — with the user, who can
//      name a target explicitly in settings.
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

import { getCachedModelCatalog, getCompetenceIndex, hasCompetenceData } from "./model-catalog";
import { effectiveCompletionPrice, effectivePricing } from "./model-pricing";
import {
  competenceFor,
  competenceScore,
  describeCompetence,
  type CompetenceIndex,
  type CompetenceTask,
} from "./model-benchmarks";
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
  /** Competence-index override (tests); defaults to the live cached index */
  competence?: CompetenceIndex;
  /**
   * What this turn is doing, so the picker ranks on the axis that matters.
   * An agent turn lives or dies on tool-loop competence, which is the agentic
   * index; a one-shot generation is better served by the coding index.
   */
  task?: CompetenceTask;
  /**
   * How many prompt tokens the turn will send, when the caller knows.
   *
   * Price is a tiebreaker here, and for a tiered model the price IS a function
   * of this number: past the threshold the tier rate replaces the base rate, so
   * a candidate that looks cheap per million can cost a multiple of the
   * per-token price on the conversation actually being escalated. Without it the
   * ranking falls back to the entry rate — the old behaviour, and correct for
   * anything under the first threshold.
   */
  promptTokens?: number;
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
 *
 * This remains the FALLBACK, not the default. It is a proxy for competence in
 * the same way that a big house is a proxy for a big family — usually true,
 * and not a measurement. `pickByMeasurement` runs first and this answers only
 * when the publisher has no score for the model that stalled.
 */
export function capabilityScore(
  info: ModelInfo | undefined,
  /** Ship size, so a tiered model is scored at the rate it will really charge */
  promptTokens = 0
): number {
  if (!info) return 0;
  const price = effectiveCompletionPrice(info, promptTokens);
  if (!(price > 0)) return 0;
  const reasoning = info.reasoning ? 1.2 : 1;
  return price * reasoning;
}

/**
 * How much better a measured score must be before a swap is worth making.
 *
 * A strict inequality would swap a model for one 0.1 index points higher, which
 * is measurement noise dressed up as an improvement. One point on these indices
 * is a real step; less than that is not a reason to move a user's turn.
 */
const MEASURED_MIN_MARGIN = 1;

interface MeasuredCandidate {
  info: ModelInfo;
  score: number;
  costPerTask?: number;
}

/**
 * Ranks by published measurement, when the publisher has scored both sides.
 *
 * Returns `null` when it cannot make a measured claim — which is the honest
 * answer in two cases: the current model has no score (so "stronger" is
 * unknowable, however good the candidates look), or no candidate clears the
 * margin.
 */
function pickByMeasurement(
  from: string,
  eligible: ModelInfo[],
  index: CompetenceIndex,
  task: CompetenceTask,
  /** The size this turn will send, so the tiebreak uses the applicable tier */
  promptTokens: number
): EscalationTargetChoice | null {
  const fromRecord = competenceFor(index, from);
  const fromScore = competenceScore(fromRecord, task);
  if (fromScore === undefined || !fromRecord) return null;

  const scored: MeasuredCandidate[] = [];
  for (const info of eligible) {
    const record = competenceFor(index, info.id);
    const score = competenceScore(record, task);
    if (score === undefined) continue;
    if (score < fromScore + MEASURED_MIN_MARGIN) continue;
    scored.push({
      info,
      score,
      ...(record?.avgCostPerTask !== undefined ? { costPerTask: record.avgCostPerTask } : {}),
    });
  }
  if (scored.length === 0) return null;

  // Cheapest real upgrade, the same rule the price heuristic uses — the goal is
  // to get unstuck, not to buy the strongest model on the list.
  //
  // Cost per TASK is the better ordering (it accounts for how many tokens a
  // model needs to finish, which per-token price cannot) but it is only
  // comparable when every candidate has one, so the mixed case falls back to
  // token price rather than sorting two units against each other.
  const everyCandidateHasTaskCost = scored.every((c) => c.costPerTask !== undefined);
  // The tiebreak is the tier this request lands in, not the list price: with
  // measured candidates that differ only slightly in cost per task, the entry
  // rate is exactly the number that can be wrong by 2×.
  const size = promptTokens;
  scored.sort((a, b) =>
    everyCandidateHasTaskCost
      ? a.costPerTask! - b.costPerTask! || a.info.id.localeCompare(b.info.id)
      : effectiveCompletionPrice(a.info, size) - effectiveCompletionPrice(b.info, size) ||
        a.info.id.localeCompare(b.info.id)
  );

  const pick = scored[0];
  if (!pick) return null;
  const pickRecord = competenceFor(index, pick.info.id)!;
  const basis = everyCandidateHasTaskCost
    ? "cheapest measured cost per task"
    : "cheapest model measured stronger";
  return {
    modelId: pick.info.id,
    reason:
      `${basis} on the ${task} index (${pick.info.name}: ` +
      `${describeCompetence(pickRecord, task)}) against ${fromRecord.displayName ?? from}` +
      ` (${describeCompetence(fromRecord, task)})`,
    explicit: false,
  };
}

function label(info: ModelInfo, promptTokens = 0): string {
  // The rate for THIS request, and the tier named when one applies — a reason
  // line quoting a price the turn will not be billed at is worse than no reason.
  const tier = effectivePricing(info, promptTokens);
  const price = tier.completionPrice;
  if (typeof price !== "number") return info.name;
  const suffix = tier.tier !== undefined ? `, tier from ${tier.tier.toLocaleString()}` : "";
  return `${info.name} ($${price}/M out${suffix})`;
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

  // Filters shared by both bases: it must be able to do this turn's job.
  const eligible = catalog
    .filter((m) => m.id !== from)
    .filter((m) => (opts.needTools ? modelSupportsTools(m) : true))
    .filter((m) => (opts.minContext ? (m.contextLength ?? 0) >= opts.minContext : true))
    // The ceiling is on what this turn would pay, so a model whose base rate is
    // under it but whose TIER is over it is excluded rather than noticed later.
    .filter(
      (m) => effectiveCompletionPrice(m, opts.promptTokens ?? 0) <= MAX_AUTO_ESCALATION_PRICE
    );

  // ── Basis 1: published measurement ──
  // Ranked on the axis this turn actually needs. An agent turn lives and dies
  // on tool-loop competence, which is what the agentic index measures; a
  // one-shot generation is better served by the coding index.
  const task: CompetenceTask = opts.task ?? (opts.needTools ? "agentic" : "coding");
  const competenceIndex = opts.competence ?? getCompetenceIndex();
  const measured = pickByMeasurement(from, eligible, competenceIndex, task, opts.promptTokens ?? 0);
  if (measured) return measured;

  // ── Basis 2: the price heuristic (fallback) ──
  // Scored at the size this turn will actually send, so a tiered model is
  // compared on what it will charge rather than on its entry rate.
  const size = opts.promptTokens ?? 0;
  const currentScore = capabilityScore(current, size);
  const threshold = Math.max(
    currentScore > 0 ? currentScore * MIN_UPGRADE_FACTOR : 0,
    currentScore + MIN_UPGRADE_MARGIN
  );

  const candidates = eligible
    .map((m) => ({ info: m, score: capabilityScore(m, size) }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => a.score - b.score || a.info.id.localeCompare(b.info.id));

  const pick = candidates[0];
  if (!pick) return null;

  const fromLabel = label(current, size);
  // The basis is stated, and the reason it is not a measurement is stated with
  // it: `hasCompetenceData()` is false when no scores loaded, and true when
  // scores loaded but this particular pair is unscored. Both end up here, and
  // the user deserves to know which of those two situations they are in — the
  // first is a fetch away from being fixed.
  const why =
    competenceIndex.bySlug.size > 0
      ? "neither model has a published benchmark score"
      : "no benchmark scores were loaded";
  return {
    modelId: pick.info.id,
    reason:
      `cheapest capably stronger model by published price and reasoning support ` +
      `(${label(pick.info, size)} vs ${fromLabel}) — a heuristic, not a measurement (${why})`,
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
  if (hasCompetenceData()) {
    return (
      "the benchmark index has no score for a model that is stronger AND inside the " +
      `automatic budget ($${MAX_AUTO_ESCALATION_PRICE}/M output). Pick one in Chat Settings if you want escalation.`
    );
  }
  return (
    "no model in the catalog is known to be stronger within the automatic budget " +
    `($${MAX_AUTO_ESCALATION_PRICE}/M output) — and no benchmark scores are loaded, so the ` +
    "pick would have been a price heuristic. Pick one in Chat Settings if you want escalation."
  );
}
