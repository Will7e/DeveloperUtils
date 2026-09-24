// ============================================================
// Cost Meter — Tests
// ============================================================

import { describe, it, expect } from "vitest";
import {
  cacheReadRate,
  costShare,
  formatSpend,
  shouldAttributeSpend,
  spendNote,
  summarizeSpend,
} from "./cost-meter";
import type { UsageInfo } from "../types";

function usage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    promptTokens: 1_000,
    completionTokens: 100,
    cost: 0.002,
    cachedTokens: 0,
    ...overrides,
  };
}

describe("summarizeSpend", () => {
  it("returns an empty summary for no messages", () => {
    const summary = summarizeSpend(undefined);
    expect(summary).toMatchObject({ rows: [], totalCost: 0, models: 0, calls: 0, incomplete: false });
  });

  it("ignores messages without usage", () => {
    const summary = summarizeSpend([{ model: "a" }, { model: "b", usage: usage() }]);
    expect(summary.calls).toBe(1);
    expect(summary.rows[0]!.modelId).toBe("b");
  });

  it("attributes spend to the model that actually answered", () => {
    const summary = summarizeSpend([
      { model: "selected/model", usage: usage({ cost: 0.01, completionTokens: 200 }) },
      { model: "selected/model", usage: usage({ cost: 0.01, completionTokens: 200 }) },
      { model: "escalated/model", usage: usage({ cost: 0.05, completionTokens: 500 }) },
    ]);
    expect(summary.models).toBe(2);
    expect(summary.totalCost).toBeCloseTo(0.07);
    // Most expensive first: the escalation is the visible line.
    expect(summary.rows[0]).toMatchObject({ modelId: "escalated/model", calls: 1, cost: 0.05 });
    expect(summary.rows[1]).toMatchObject({ modelId: "selected/model", calls: 2, cost: 0.02 });
    expect(summary.completionTokens).toBe(900);
  });

  it("names an unattributed reply instead of blending it in", () => {
    const summary = summarizeSpend([{ usage: usage() }]);
    expect(summary.rows[0]!.modelId).toBe("unknown model");
  });

  it("reports a floor when a provider gave tokens but no price", () => {
    const summary = summarizeSpend([
      { model: "a", usage: usage({ cost: 0.01 }) },
      { model: "b", usage: usage({ cost: null }) },
    ]);
    expect(summary.incomplete).toBe(true);
    expect(summary.totalCost).toBeCloseTo(0.01);
    expect(spendNote(summary)).toContain("lower bound");
  });

  it("accumulates cached tokens across models", () => {
    const summary = summarizeSpend([
      { model: "a", usage: usage({ cachedTokens: 400 }) },
      { model: "b", usage: usage({ cachedTokens: 600 }) },
    ]);
    expect(summary.cachedTokens).toBe(1_000);
  });

  it("orders equally-priced models by completion tokens, then id", () => {
    const summary = summarizeSpend([
      { model: "z", usage: usage({ cost: 0.01, completionTokens: 10 }) },
      { model: "a", usage: usage({ cost: 0.01, completionTokens: 10 }) },
      { model: "m", usage: usage({ cost: 0.01, completionTokens: 90 }) },
    ]);
    expect(summary.rows.map((r) => r.modelId)).toEqual(["m", "a", "z"]);
  });

  it("tolerates null token counts", () => {
    const summary = summarizeSpend([{ model: "a", usage: usage({ promptTokens: null, completionTokens: null }) }]);
    expect(summary.rows[0]).toMatchObject({ promptTokens: 0, completionTokens: 0 });
  });
});

describe("formatSpend", () => {
  it("never shows a bare zero for real spend", () => {
    expect(formatSpend(0.00042)).toBe("$0.0004");
    expect(formatSpend(0.5)).toBe("$0.500");
    expect(formatSpend(12.3456)).toBe("$12.35");
  });

  it("handles zero and nonsense", () => {
    expect(formatSpend(0)).toBe("$0");
    expect(formatSpend(Number.NaN)).toBe("$0");
    expect(formatSpend(-1)).toBe("$0");
  });
});

describe("shouldAttributeSpend", () => {
  it("is quiet for a single complete model", () => {
    const summary = summarizeSpend([{ model: "a", usage: usage() }]);
    expect(shouldAttributeSpend(summary)).toBe(false);
  });

  it("speaks up when more than one model answered", () => {
    const summary = summarizeSpend([
      { model: "a", usage: usage() },
      { model: "b", usage: usage() },
    ]);
    expect(shouldAttributeSpend(summary)).toBe(true);
  });

  it("speaks up when the total is only a floor", () => {
    const summary = summarizeSpend([{ model: "a", usage: usage({ cost: null }) }]);
    expect(shouldAttributeSpend(summary)).toBe(true);
  });
});

describe("cacheReadRate", () => {
  it("is the conversation's cached share of every prompt token sent", () => {
    const summary = summarizeSpend([
      { model: "a", usage: usage({ promptTokens: 10_000, cachedTokens: 8_000 }) },
      { model: "a", usage: usage({ promptTokens: 10_000, cachedTokens: 6_000 }) },
    ]);
    expect(cacheReadRate(summary)).toBeCloseTo(0.7);
  });

  it("sums across models, because the prefix is cached per provider", () => {
    // Escalation and delegation route work to other models; a rate that only
    // read the selected model's row would report a healthy cache on a
    // conversation where the expensive model never hit one.
    const summary = summarizeSpend([
      { model: "cheap", usage: usage({ promptTokens: 1_000, cachedTokens: 0 }) },
      { model: "strong", usage: usage({ promptTokens: 1_000, cachedTokens: 500 }) },
    ]);
    expect(cacheReadRate(summary)).toBeCloseTo(0.25);
  });

  it("is null when nothing reported a cache read", () => {
    // Not 0: a provider that does not report `cached_tokens` at all is a
    // different fact from a prefix that never matched, and the card says
    // different things about them.
    const summary = summarizeSpend([{ model: "a", usage: usage({ cachedTokens: 0 }) }]);
    expect(cacheReadRate(summary)).toBeNull();
  });

  it("is null with no usage to read", () => {
    expect(cacheReadRate(summarizeSpend([]))).toBeNull();
  });

  it("never exceeds the prompt tokens it divides by", () => {
    // A provider reporting more cached reads than prompt tokens is reporting
    // nonsense; the readout must not print 140%.
    const summary = summarizeSpend([
      { model: "a", usage: usage({ promptTokens: 1_000, cachedTokens: 1_400 }) },
    ]);
    expect(cacheReadRate(summary)).toBe(1);
  });
});

describe("costShare", () => {
  it("is the row's fraction of the total", () => {
    const summary = summarizeSpend([
      { model: "a", usage: usage({ cost: 0.75 }) },
      { model: "b", usage: usage({ cost: 0.25 }) },
    ]);
    expect(costShare(summary.rows[0]!, summary)).toBeCloseTo(0.75);
    expect(costShare(summary.rows[1]!, summary)).toBeCloseTo(0.25);
  });

  it("is zero when nothing was billed", () => {
    const summary = summarizeSpend([{ model: "a", usage: usage({ cost: 0 }) }]);
    expect(costShare(summary.rows[0]!, summary)).toBe(0);
  });
});
