// ============================================================
// Escalation — Tests
// ============================================================
// The policy has one job: never invent a "stronger" model, and never
// quietly spend beyond the automatic budget. Most of these cases are
// refusals, because a refusal is the correct answer more often than
// the feature is.

import { describe, it, expect } from "vitest";
import {
  MAX_AUTO_ESCALATION_PRICE,
  STUCK_FAILING_REPEATS,
  canEscalate,
  capabilityScore,
  escalationEnabled,
  escalationNote,
  noEscalationReason,
  pickEscalationTarget,
} from "./escalation";
import type { ModelInfo } from "../types";

function model(
  id: string,
  opts: { price?: number; free?: boolean; tools?: boolean; context?: number; reasoning?: boolean } = {}
): ModelInfo {
  const { price, free, tools = true, context, reasoning } = opts;
  return {
    id,
    name: id,
    ...(context !== undefined ? { contextLength: context } : {}),
    ...(price !== undefined ? { completionPrice: price } : {}),
    ...(free ? { isFree: true } : {}),
    ...(tools ? { supportedParameters: ["tools"] } : { supportedParameters: ["temperature"] }),
    ...(reasoning ? { reasoning: { mandatory: false } } : {}),
  } as ModelInfo;
}

describe("escalationEnabled", () => {
  it("defaults on", () => {
    expect(escalationEnabled(undefined)).toBe(true);
    expect(escalationEnabled(true)).toBe(true);
  });

  it("is off only when explicitly disabled", () => {
    expect(escalationEnabled(false)).toBe(false);
  });
});

describe("capabilityScore", () => {
  it("is zero without a published price", () => {
    expect(capabilityScore(undefined)).toBe(0);
    expect(capabilityScore(model("free/host", { price: 0, free: true }))).toBe(0);
  });

  it("follows the output price", () => {
    expect(capabilityScore(model("a", { price: 5 }))).toBe(5);
  });

  it("credits declared reasoning support", () => {
    expect(capabilityScore(model("a", { price: 5, reasoning: true }))).toBeCloseTo(6);
  });
});

describe("pickEscalationTarget", () => {
  const ladder: ModelInfo[] = [
    model("cheap", { price: 1, context: 128_000 }),
    model("mid", { price: 5, context: 128_000 }),
    model("dear", { price: 15, context: 128_000 }),
  ];

  it("picks the cheapest real upgrade", () => {
    const choice = pickEscalationTarget("cheap", { catalog: ladder });
    expect(choice?.modelId).toBe("mid");
    expect(choice?.explicit).toBe(false);
    expect(choice?.reason).toContain("mid");
    expect(choice?.reason).toContain("heuristic");
  });

  it("refuses a lateral or cheaper swap", () => {
    const catalog = [model("current", { price: 5 }), model("lower", { price: 4 }), model("equal", { price: 5 })];
    expect(pickEscalationTarget("current", { catalog })).toBeNull();
  });

  it("refuses when the only upgrades are past the automatic budget", () => {
    const catalog = [model("cheap", { price: 1 }), model("huge", { price: MAX_AUTO_ESCALATION_PRICE + 5 })];
    expect(pickEscalationTarget("cheap", { catalog })).toBeNull();
  });

  it("upgrades a free model to the cheapest paid one", () => {
    const catalog = [model("freebie", { price: 0, free: true }), model("paid", { price: 3 })];
    expect(pickEscalationTarget("freebie", { catalog })?.modelId).toBe("paid");
  });

  it("honours an explicit target over the heuristic", () => {
    const choice = pickEscalationTarget("cheap", { catalog: ladder, preferred: "dear" });
    expect(choice).toEqual({
      modelId: "dear",
      reason: expect.stringContaining("escalation model you set"),
      explicit: true,
    });
  });

  it("ignores an explicit target equal to the current model", () => {
    const choice = pickEscalationTarget("cheap", { catalog: ladder, preferred: "cheap" });
    expect(choice?.modelId).toBe("mid");
    expect(choice?.explicit).toBe(false);
  });

  it("refuses a target that cannot call tools on a tools turn", () => {
    const catalog = [model("cheap", { price: 1 }), model("no-tools", { price: 9, tools: false })];
    expect(pickEscalationTarget("cheap", { catalog, preferred: "no-tools", needTools: true })).toBeNull();
  });

  it("filters automatic candidates that cannot call tools or are too small", () => {
    const catalog = [
      model("cheap", { price: 1, context: 128_000 }),
      model("no-tools", { price: 9, tools: false }),
      model("tiny", { price: 8, context: 8_000 }),
      model("fit", { price: 12, context: 200_000 }),
    ];
    const choice = pickEscalationTarget("cheap", { catalog, needTools: true, minContext: 100_000 });
    expect(choice?.modelId).toBe("fit");
  });

  it("returns null when disabled, when the catalog is empty, or when the model is unknown", () => {
    expect(pickEscalationTarget("cheap", { catalog: ladder, enabled: false })).toBeNull();
    expect(pickEscalationTarget("cheap", { catalog: [] })).toBeNull();
    expect(pickEscalationTarget("unknown", { catalog: ladder })).toBeNull();
  });
});

describe("canEscalate", () => {
  it("allows one escalation per turn", () => {
    expect(canEscalate({})).toBe(true);
    expect(canEscalate({ enabled: true })).toBe(true);
    expect(canEscalate({ alreadyEscalated: true })).toBe(false);
    expect(canEscalate({ enabled: false })).toBe(false);
  });
});

describe("escalationNote", () => {
  const choice = { modelId: "mid", reason: "cheapest stronger model", explicit: false };

  it("names both models, the evidence, and the reason for this model", () => {
    const note = escalationNote(choice, "cheap");
    expect(note).toContain("cheap");
    expect(note).toContain("mid");
    expect(note).toContain(`${STUCK_FAILING_REPEATS} times`);
    expect(note).toContain(choice.reason);
    expect(note).toContain("the conversation is unchanged");
  });
});

describe("noEscalationReason", () => {
  it("says when the feature is off", () => {
    expect(noEscalationReason(null, { enabled: false })).toContain("off");
  });

  it("names the automatic budget when nothing qualifies", () => {
    const reason = noEscalationReason(null, {});
    expect(reason).toContain(`$${MAX_AUTO_ESCALATION_PRICE}`);
    expect(reason).toContain("Chat Settings");
  });
});
