// ============================================================
// Model Pricing — Tests
// ============================================================
// The live catalog shape these encode comes from a captured fixture: a real
// model in the catalog doubles its prompt price above 272k tokens, so a request
// sized from the base rate can be understated by half. The tests below pin the
// resolution order (which tier wins) and the fallbacks (a partial override does
// not become free), because both are easy to get subtly wrong and neither shows
// up as a crash — just as a wrong number in a cost readout or a ranking.

import { describe, it, expect } from "vitest";
import { effectiveCompletionPrice, effectivePricing } from "./model-pricing";
import type { ModelInfo } from "../types";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return { id: "vendor/model", name: "Model", promptPrice: 1, completionPrice: 2, ...overrides };
}

describe("effectivePricing", () => {
  it("uses the base rate below every threshold", () => {
    const info = model({ priceOverrides: [{ minPromptTokens: 272_000, promptPrice: 2 }] });
    expect(effectivePricing(info, 10_000)).toEqual({ promptPrice: 1, completionPrice: 2 });
  });

  it("uses the tier rate AT the threshold, not above it", () => {
    // `>=` is the documented comparison: the tier applies to the request that
    // reaches the number, which is the request that pays for it.
    const info = model({ priceOverrides: [{ minPromptTokens: 272_000, promptPrice: 2 }] });
    expect(effectivePricing(info, 272_000)).toMatchObject({ promptPrice: 2, tier: 272_000 });
  });

  it("takes the highest threshold crossed when several exist", () => {
    // Catalog order is not guaranteed to be ascending, which is why this is a
    // max rather than "the last one that matched in array order".
    const info = model({
      priceOverrides: [
        { minPromptTokens: 500_000, promptPrice: 8 },
        { minPromptTokens: 100_000, promptPrice: 3 },
        { minPromptTokens: 272_000, promptPrice: 5 },
      ],
    });
    expect(effectivePricing(info, 600_000)).toMatchObject({ promptPrice: 8, tier: 500_000 });
    expect(effectivePricing(info, 300_000)).toMatchObject({ promptPrice: 5, tier: 272_000 });
    expect(effectivePricing(info, 150_000)).toMatchObject({ promptPrice: 3, tier: 100_000 });
  });

  it("keeps the base rate for fields a partial override omits", () => {
    // A tier that changes only the cache-read rate must not silently zero the
    // others — a missing field means "unchanged", not "free".
    const info = model({ priceOverrides: [{ minPromptTokens: 100_000, cacheReadPrice: 0.1 }] });
    expect(effectivePricing(info, 200_000)).toMatchObject({
      promptPrice: 1,
      completionPrice: 2,
      cacheReadPrice: 0.1,
      tier: 100_000,
    });
  });

  it("omits fields the catalog never gave", () => {
    const info: ModelInfo = { id: "vendor/bare", name: "Bare" };
    expect(effectivePricing(info, 10)).toEqual({});
  });

  it("has nothing to price without a model", () => {
    expect(effectivePricing(undefined, 10)).toEqual({});
  });

  it("resolves completion price for ranking, defaulting to zero", () => {
    const info = model({ priceOverrides: [{ minPromptTokens: 272_000, completionPrice: 9 }] });
    expect(effectiveCompletionPrice(info, 10_000)).toBe(2);
    expect(effectiveCompletionPrice(info, 300_000)).toBe(9);
    expect(effectiveCompletionPrice(undefined, 300_000)).toBe(0);
  });
});
