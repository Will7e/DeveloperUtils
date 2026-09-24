// ============================================================
// Cost Meter — What the Conversation Actually Cost, Per Model
// ============================================================
// A single "conversation spend" number is the wrong shape for this
// product. InTab deliberately runs MORE THAN ONE model per conversation:
// a nested research agent on the cheapest free tool-capable model, a
// delegate on a cheap model, an escalated model when the selected one
// stalls. The interesting question is no longer "how much
// has this cost" but "what did I spend it on, and was the cheap model
// doing the work" — because that is the entire economic argument for a
// harness that arbitrages models.
//
// So the meter is attribution, not a total:
//
//   • spend is read from the transcript's provider-reported usage, which
//     is the only number nobody can disagree with — no estimates, no
//     local price table to go stale;
//   • rows are keyed by the model that ACTUALLY answered, so a failover
//     or an escalation shows up as its own line instead of hiding inside
//     a blended figure;
//   • when a provider reports tokens but no cost, the total is reported
//     as a FLOOR rather than as a bill.
//
// Pure: takes stored messages, returns numbers.

import type { UsageInfo } from "../types";

/** One model's contribution to the conversation */
export interface ModelSpend {
  modelId: string;
  /** Assistant replies attributed to it */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's cache (billed cheaper) */
  cachedTokens: number;
  cost: number;
}

export interface SpendSummary {
  /** Per-model rows, most expensive first */
  rows: ModelSpend[];
  /** Sum of reported cost across every model */
  totalCost: number;
  completionTokens: number;
  cachedTokens: number;
  /** Replies that reported usage at all */
  calls: number;
  /** Distinct models that produced a reply */
  models: number;
  /**
   * True when at least one reply reported tokens without a cost — the
   * provider gave no price, so `totalCost` is a floor, not a bill.
   */
  incomplete: boolean;
}

/** The minimal message shape the meter needs */
export interface SpendSourceMessage {
  model?: string;
  usage?: UsageInfo;
}

/**
 * Aggregates a conversation's spend by model.
 *
 * Rows are ordered by cost (then by completion tokens, then id) so the
 * model doing the expensive work is the one you see — which is usually
 * not the one the user selected.
 */
export function summarizeSpend(messages: SpendSourceMessage[] | undefined): SpendSummary {
  const byModel = new Map<string, ModelSpend>();
  let totalCost = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let calls = 0;
  let incomplete = false;

  for (const message of messages ?? []) {
    const usage = message.usage;
    if (!usage) continue;
    calls += 1;

    const modelId = message.model?.trim() || "unknown model";
    const row = byModel.get(modelId) ?? {
      modelId,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
    };
    row.calls += 1;

    if (typeof usage.promptTokens === "number") row.promptTokens += usage.promptTokens;
    if (typeof usage.completionTokens === "number") {
      row.completionTokens += usage.completionTokens;
      completionTokens += usage.completionTokens;
    }
    if (typeof usage.cachedTokens === "number") {
      row.cachedTokens += usage.cachedTokens;
      cachedTokens += usage.cachedTokens;
    }
    if (typeof usage.cost === "number") {
      row.cost += usage.cost;
      totalCost += usage.cost;
    } else {
      // Tokens but no price: the total can only be a lower bound.
      incomplete = true;
    }

    byModel.set(modelId, row);
  }

  const rows = [...byModel.values()].sort(
    (a, b) =>
      b.cost - a.cost ||
      b.completionTokens - a.completionTokens ||
      a.modelId.localeCompare(b.modelId)
  );

  return {
    rows,
    totalCost,
    completionTokens,
    cachedTokens,
    calls,
    models: rows.length,
    incomplete,
  };
}

/** `$0.0042` for fractions of a cent, `$1.23` above — never `$0.00` */
export function formatSpend(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Empty when the conversation has nothing worth attributing */
export function shouldAttributeSpend(summary: SpendSummary): boolean {
  return summary.rows.length > 1 || summary.incomplete;
}

/**
 * Share of this conversation's prompt tokens that the provider served from its
 * cache (0–1), or null when there is nothing honest to report.
 *
 * The per-reply figure says "this request reused the prefix"; this one says
 * whether the conversation is benefiting from it at all. That distinction is the
 * whole point: a prefix that quietly stopped matching still shows a cache hit on
 * the odd reply, and only the aggregate over many turns shows the rate is near
 * zero. Null (not 0) when no reply ever reported a cache read — "we have no
 * evidence either way" and "caching is not working" are different claims, and a
 * provider that never reports `cached_tokens` would otherwise look broken.
 */
export function cacheReadRate(summary: SpendSummary): number | null {
  let promptTokens = 0;
  for (const row of summary.rows) promptTokens += row.promptTokens;
  if (promptTokens <= 0 || summary.cachedTokens <= 0) return null;
  return Math.min(1, summary.cachedTokens / promptTokens);
}

/** One-line honesty note for the spend card (empty when there is none) */
export function spendNote(summary: SpendSummary): string {
  if (summary.rows.length === 0) return "";
  if (summary.incomplete) {
    return "At least one reply reported tokens without a price, so the total is a lower bound, not a bill. Cached prompt reads are billed at a discount and are already reflected in each cost.";
  }
  return "Provider-reported cost, exactly as OpenRouter billed it — no estimates and no local price table.";
}

/** Share of the cost each model is responsible for (0-1), for a bar */
export function costShare(row: ModelSpend, summary: SpendSummary): number {
  if (summary.totalCost <= 0) return 0;
  return row.cost / summary.totalCost;
}
