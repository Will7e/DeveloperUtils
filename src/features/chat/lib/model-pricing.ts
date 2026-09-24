// ============================================================
// Model Pricing — the rate that applies to a request OF A GIVEN SIZE
// ============================================================
// One function, in its own module, because two very different callers need it
// and neither should have to import the other's world to get it:
//
//   • the request path, which wants to know what a prompt is going to cost;
//   • the routing path (`lib/escalation.ts`), which ranks candidate models by
//     price and must rank them by the price THIS conversation will pay — a
//     tiered model is not the cheap option on a 300k-token context.
//
// Reading `info.promptPrice` directly is the mistake this exists to prevent.
// `pricing.overrides` is a step function, not a gradient: past the threshold the
// override rates REPLACE the base ones, and the first override in catalog order
// is not necessarily the one that applies. Live on 76 of the 459 models in the
// catalog at the time of writing, so it is a real cliff on a real fraction of
// the list, not a theoretical one.
//
// Import-free apart from the types, so it stays usable from anywhere.

import type { ModelInfo, ModelPriceOverride } from "../types";

/** The rates that apply to a prompt of `promptTokens` tokens */
export interface EffectivePricing {
  promptPrice?: number;
  completionPrice?: number;
  cacheReadPrice?: number;
  /** The threshold of the tier that applied, when one did (not the count) */
  tier?: number;
}

/**
 * Resolves the tier that applies, or null when the base rate does.
 *
 * Highest qualifying threshold wins, so a model with several steps is priced by
 * the last one it crossed. An override with a missing field falls back to the
 * base value for that field rather than becoming free — a partial override is
 * the catalog saying "this rate changed", not "the others vanished".
 */
function tierFor(info: ModelInfo, promptTokens: number): ModelPriceOverride | null {
  let tier: ModelPriceOverride | null = null;
  for (const override of info.priceOverrides ?? []) {
    if (promptTokens >= override.minPromptTokens) {
      if (!tier || override.minPromptTokens >= tier.minPromptTokens) tier = override;
    }
  }
  return tier;
}

/**
 * The rates that actually apply to a request of this size.
 *
 * Every consumer of `promptPrice`/`completionPrice` should go through here
 * instead of reading the base fields directly — a cost readout, a price ranking
 * or a budget guard built on the base rate becomes a pleasant lie above the
 * threshold, and the lie is largest exactly where it matters most.
 */
export function effectivePricing(
  info: ModelInfo | undefined,
  promptTokens: number
): EffectivePricing {
  if (!info) return {};
  const tier = tierFor(info, promptTokens);
  if (!tier) {
    return {
      ...(info.promptPrice !== undefined ? { promptPrice: info.promptPrice } : {}),
      ...(info.completionPrice !== undefined ? { completionPrice: info.completionPrice } : {}),
      ...(info.cacheReadPrice !== undefined ? { cacheReadPrice: info.cacheReadPrice } : {}),
    };
  }
  const cacheRead = tier.cacheReadPrice ?? info.cacheReadPrice;
  return {
    promptPrice: tier.promptPrice ?? info.promptPrice,
    completionPrice: tier.completionPrice ?? info.completionPrice,
    ...(cacheRead !== undefined ? { cacheReadPrice: cacheRead } : {}),
    tier: tier.minPromptTokens,
  };
}

/**
 * Completion rate for a request of this size — the figure routing ranks on.
 *
 * A separate function rather than a call-and-pick at each site, because the
 * ranking code reads it four times and `effectivePricing(info, size).completionPrice ?? 0`
 * at each of them is how one of the four ends up reading the base price.
 */
export function effectiveCompletionPrice(
  info: ModelInfo | undefined,
  promptTokens: number
): number {
  return effectivePricing(info, promptTokens).completionPrice ?? 0;
}
