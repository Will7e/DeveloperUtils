// ============================================================
// Cost Meter — Tests
// ============================================================

import { describe, it, expect } from "vitest";
import {
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
