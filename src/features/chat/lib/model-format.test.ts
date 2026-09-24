// ============================================================
// Model Formatting — Tests
// ============================================================
// Two of these formatters exist to stop the picker from stating something
// false, which is why they are tested rather than eyeballed: a router row that
// reads like a model row, and a tiered price that reads like a flat one. Both
// are "correct" strings that mislead the person choosing.

import { describe, it, expect } from "vitest";
import {
  formatContext,
  formatModelLabel,
  formatPrice,
  formatPriceTier,
  priceTierTitle,
  routerNote,
} from "./model-format";

describe("formatPriceTier", () => {
  it("is empty for a flat price", () => {
    expect(formatPriceTier({ promptPrice: 3 })).toBe("");
    expect(formatPriceTier({ promptPrice: 3, priceOverrides: [] })).toBe("");
  });

  it("states the multiple, because that is the decision", () => {
    // The live shape from the catalog fixture: 2× the prompt price above 272k.
    expect(
      formatPriceTier({
        promptPrice: 1.25,
        priceOverrides: [{ minPromptTokens: 272_000, promptPrice: 2.5 }],
      })
    ).toBe("2× over 272k");
  });

  it("takes the lowest threshold when a model has several tiers", () => {
    expect(
      formatPriceTier({
        promptPrice: 1,
        priceOverrides: [
          { minPromptTokens: 500_000, promptPrice: 4 },
          { minPromptTokens: 200_000, promptPrice: 2 },
        ],
      })
    ).toBe("2× over 200k");
  });

  it("says so when the tier rate is the same as the base", () => {
    // A tier that changes only the completion rate is not a prompt-price cliff,
    // and saying "1×" would be noise dressed as a warning.
    expect(
      formatPriceTier({
        promptPrice: 2,
        priceOverrides: [{ minPromptTokens: 100_000, promptPrice: 2 }],
      })
    ).toBe("same rate over 100k tokens");
  });

  it("does not divide by a zero base", () => {
    // Free models can have a paid tier above a threshold; there is no multiple
    // of zero, so the badge names the tier instead of inventing a ratio.
    expect(
      formatPriceTier({
        promptPrice: 0,
        priceOverrides: [{ minPromptTokens: 64_000, promptPrice: 0.5 }],
      })
    ).toBe("tiered over 64k");
    expect(
      formatPriceTier({ priceOverrides: [{ minPromptTokens: 64_000, promptPrice: 0.5 }] })
    ).toBe("tiered over 64k");
  });

  it("stops at 10+ rather than printing a number nobody reads", () => {
    expect(
      formatPriceTier({
        promptPrice: 0.1,
        priceOverrides: [{ minPromptTokens: 32_000, promptPrice: 5 }],
      })
    ).toBe("10+× over 32k");
  });

  it("explains the step in the tooltip, with both rates", () => {
    const title = priceTierTitle({
      promptPrice: 1.25,
      priceOverrides: [{ minPromptTokens: 272_000, promptPrice: 2.5 }],
    });
    expect(title).toContain("272,000");
    expect(title).toContain(formatPrice(2.5));
    expect(title).toContain(formatPrice(1.25));
  });

  it("has no tooltip to give for a flat price", () => {
    expect(priceTierTitle({ promptPrice: 1.25 })).toBe("");
  });
});

describe("routerNote", () => {
  it("names the routing slugs", () => {
    expect(routerNote("openrouter/auto")).toContain("Not a model");
    expect(routerNote("openrouter/pareto-code")).toContain("coding-quality bar");
  });

  it("does not label openrouter's own real models as routers", () => {
    // The org publishes models under the same namespace; matching the prefix
    // would call those routers, which is the same error the other way round.
    expect(routerNote("openrouter/gpt-oss-120b")).toBe("");
    expect(routerNote("anthropic/claude-fable-5.1")).toBe("");
    expect(routerNote("")).toBe("");
  });
});

describe("formatModelLabel", () => {
  it("drops the org prefix the mark already carries", () => {
    expect(formatModelLabel("z-ai/glm-5.3-flash")).toBe("glm-5.3-flash");
  });

  it("keeps a bare id rather than rendering an empty chip", () => {
    expect(formatModelLabel("solo")).toBe("solo");
    expect(formatModelLabel("org/")).toBe("org/");
  });
});

describe("formatContext and formatPrice", () => {
  it("rounds to the size a human compares at a glance", () => {
    expect(formatContext(200_000)).toBe("200k ctx");
    expect(formatContext(1_000_000)).toBe("1M ctx");
    expect(formatContext(1_500_000)).toBe("1.5M ctx");
    expect(formatContext(undefined)).toBe("");
  });

  it("distinguishes free from unpriced", () => {
    expect(formatPrice(0)).toBe("Free");
    expect(formatPrice(1.5)).toBe("$1.50");
    expect(formatPrice(undefined)).toBe("");
  });
});
