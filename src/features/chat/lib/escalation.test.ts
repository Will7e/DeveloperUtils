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
import { buildCompetenceIndex, normalizeModelSlug } from "./model-benchmarks";
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

// ============================================================
// Measured competence — the basis that replaced the price proxy
// ============================================================
// The rules under test:
//   • a published score outranks the price heuristic, and the switch says which
//     basis it used;
//   • a sub-margin score is measurement noise, not an upgrade;
//   • an unscored current model is a refusal, not a license to guess;
//   • the ranking axis follows what the turn is doing.

function competence(entries: Array<{
  id: string;
  coding?: number;
  agentic?: number;
  intelligence?: number;
  costPerTask?: number;
}>) {
  return buildCompetenceIndex(
    entries.map((e) => ({
      source: "artificial-analysis",
      slug: normalizeModelSlug(e.id),
      rawSlug: e.id,
      displayName: e.id,
      ...(e.coding !== undefined ? { codingIndex: e.coding } : {}),
      ...(e.agentic !== undefined ? { agenticIndex: e.agentic } : {}),
      ...(e.intelligence !== undefined ? { intelligenceIndex: e.intelligence } : {}),
      ...(e.costPerTask !== undefined
        ? { avgCostPerTask: e.costPerTask, benchmarkType: "gpqa_diamond" }
        : {}),
    }))
  );
}

describe("pickEscalationTarget — ranked by measurement", () => {
  it("prefers a model the publisher measured as stronger, and says so", () => {
    const catalog = [
      model("weak/current", { price: 1 }),
      model("strong/bigger", { price: 8 }),
      model("strong/best", { price: 15 }),
    ];
    const index = competence([
      { id: "weak/current", agentic: 40 },
      { id: "strong/bigger", agentic: 52 },
      { id: "strong/best", agentic: 60 },
    ]);

    const choice = pickEscalationTarget("weak/current", {
      catalog,
      competence: index,
      needTools: true,
    });
    // Cheapest real upgrade, the same philosophy as the price path — the
    // smaller of the two scored upgrades, not the strongest model available.
    expect(choice?.modelId).toBe("strong/bigger");
    expect(choice?.reason).toContain("agentic index");
    expect(choice?.reason).toContain("52");
    // And it must NOT claim to be guessing.
    expect(choice?.reason).not.toContain("heuristic, not a measurement");
  });

  it("ranks on the coding index for a turn that is not calling tools", () => {
    const catalog = [
      model("weak/current", { price: 1 }),
      model("a/good-tools", { price: 2 }),
      model("b/good-code", { price: 3 }),
    ];
    // Exactly one candidate clears the margin on each axis, so the pick can only
    // be explained by which index was consulted and not by price.
    const index = competence([
      { id: "weak/current", coding: 30, agentic: 30 },
      { id: "a/good-tools", coding: 30.2, agentic: 70 },
      { id: "b/good-code", coding: 55, agentic: 30 },
    ]);

    expect(
      pickEscalationTarget("weak/current", { catalog, competence: index })?.modelId
    ).toBe("b/good-code");
    expect(
      pickEscalationTarget("weak/current", {
        catalog,
        competence: index,
        needTools: true,
      })?.modelId
    ).toBe("a/good-tools");
  });

  it("refuses a difference inside the noise margin", () => {
    const catalog = [model("weak/current", { price: 1 }), model("barely/better", { price: 9 })];
    const index = competence([
      { id: "weak/current", coding: 50 },
      { id: "barely/better", coding: 50.4 },
    ]);
    // 0.4 index points is not an upgrade; swapping the user's model for it would
    // be dressing up measurement noise as an improvement. It must fall through
    // to the price heuristic rather than return the near-identical model.
    const choice = pickEscalationTarget("weak/current", { catalog, competence: index });
    expect(choice?.modelId).toBe("barely/better");
    expect(choice?.reason).toContain("heuristic, not a measurement");
  });

  it("refuses to call anything stronger when the CURRENT model is unscored", () => {
    const catalog = [model("unscored/current", { price: 1 }), model("scored/good", { price: 9 })];
    const index = competence([{ id: "scored/good", coding: 90 }]);
    const choice = pickEscalationTarget("unscored/current", { catalog, competence: index });
    // A score for the candidate says nothing about whether it beats the model
    // that stalled, so the answer is the heuristic — stated as one.
    expect(choice?.reason).toContain("heuristic, not a measurement");
  });

  it("orders by measured cost per task when every candidate has one", () => {
    const catalog = [
      model("weak/current", { price: 1 }),
      model("pricey/tokens-cheap-tasks", { price: 3 }),
      model("cheap/tokens-pricey-tasks", { price: 12 }),
    ];
    const index = competence([
      { id: "weak/current", coding: 40, costPerTask: 0.4 },
      { id: "pricey/tokens-cheap-tasks", coding: 60, costPerTask: 0.1 },
      { id: "cheap/tokens-pricey-tasks", coding: 61, costPerTask: 3.5 },
    ]);
    const choice = pickEscalationTarget("weak/current", { catalog, competence: index });
    // Per-token price would pick the other one. Cost per TASK accounts for how
    // many tokens a model actually needs, which is the point of the measurement.
    expect(choice?.modelId).toBe("pricey/tokens-cheap-tasks");
    expect(choice?.reason).toContain("cost per task");
  });

  it("falls back to token price rather than mixing two units", () => {
    const catalog = [
      model("weak/current", { price: 1 }),
      model("a/measured-cost", { price: 9 }),
      model("b/no-measured-cost", { price: 2 }),
    ];
    const index = competence([
      { id: "weak/current", coding: 40 },
      { id: "a/measured-cost", coding: 70, costPerTask: 0.05 },
      { id: "b/no-measured-cost", coding: 60 },
    ]);
    const choice = pickEscalationTarget("weak/current", { catalog, competence: index });
    // Sorting a per-task dollar figure against a per-million-token one is not a
    // comparison, so the mixed case uses the one unit every candidate shares.
    expect(choice?.modelId).toBe("b/no-measured-cost");
    expect(choice?.reason).toContain("cheapest model measured stronger");
  });

  it("still honours the automatic budget ceiling over a better score", () => {
    const catalog = [
      model("weak/current", { price: 1 }),
      model("costly/best", { price: MAX_AUTO_ESCALATION_PRICE + 5 }),
      model("affordable/good", { price: 4 }),
    ];
    const index = competence([
      { id: "weak/current", coding: 40 },
      { id: "costly/best", coding: 99 },
      { id: "affordable/good", coding: 60 },
    ]);
    expect(
      pickEscalationTarget("weak/current", { catalog, competence: index })?.modelId
    ).toBe("affordable/good");
  });

  it("lets an explicit settings target win over the measurement", () => {
    const catalog = [model("weak/current", { price: 1 }), model("chosen/by-user", { price: 2 })];
    const index = competence([
      { id: "weak/current", coding: 40 },
      { id: "chosen/by-user", coding: 41 },
    ]);
    const choice = pickEscalationTarget("weak/current", {
      catalog,
      competence: index,
      preferred: "chosen/by-user",
    });
    expect(choice?.modelId).toBe("chosen/by-user");
    expect(choice?.explicit).toBe(true);
  });

  it("copes with a benchmark id that carries the date suffix the catalog omits", () => {
    const catalog = [model("weak/current", { price: 1 }), model("strong/bigger", { price: 4 })];
    // The join that 308 of 459 catalog ids need: the benchmark names the model
    // with a date stamp, the catalog names it without one.
    const index = competence([
      { id: "weak/current-20260901", coding: 40 },
      { id: "strong/bigger-20260815", coding: 70 },
    ]);
    expect(
      pickEscalationTarget("weak/current", { catalog, competence: index })?.modelId
    ).toBe("strong/bigger");
  });
});

// ============================================================
// Escalation — ranked at the size the turn will actually send
// ============================================================
// `pricing.overrides` is a step function, so the price a candidate charges is a
// function of how big the request is. Ranking on the ENTRY rate therefore picks
// the dearer model on exactly the conversations where the difference is largest:
// a long context is where a tier kicks in, and a long context is what a stalled
// agent turn has. These tests use the same shape as the live catalog — a model
// that doubles past a threshold.

describe("pickEscalationTarget — tiered pricing", () => {
  /** `strong/mid` is nominally cheapest, until the tier at 200k applies */
  function tieredCatalog(): ModelInfo[] {
    return [
      { ...model("weak/current", { price: 1 }), completionPrice: 1 },
      {
        ...model("strong/mid", { price: 2 }),
        completionPrice: 2,
        priceOverrides: [{ minPromptTokens: 200_000, completionPrice: 40 }],
      },
      { ...model("steady/other", { price: 6 }), completionPrice: 6 },
    ] as ModelInfo[];
  }

  const index = () =>
    competence([
      { id: "weak/current", coding: 40 },
      { id: "strong/mid", coding: 70 },
      { id: "steady/other", coding: 75 },
    ]);

  it("takes the entry rate under the threshold", () => {
    const choice = pickEscalationTarget("weak/current", {
      catalog: tieredCatalog(),
      competence: index(),
      promptTokens: 10_000,
    });
    expect(choice?.modelId).toBe("strong/mid");
  });

  it("takes the tier rate over it, and so picks the other model", () => {
    // Same catalog, same order, 2× the context: `strong/mid` now costs $40/M
    // output where it read as $2/M, so the honest cheapest upgrade is the one
    // the entry-rate ranking would have called 3× dearer. This is the measured
    // path, where price is the tiebreak between two models both measured
    // stronger — the swap a stale entry rate would have made wrongly.
    const choice = pickEscalationTarget("weak/current", {
      catalog: tieredCatalog(),
      competence: index(),
      promptTokens: 250_000,
    });
    expect(choice?.modelId).toBe("steady/other");
  });

  it("names the tier it priced with, in the reason line", () => {
    // The heuristic path, and a pick that IS tiered, so the explanation can be
    // checked: whoever reads "why this model" is being told a price, and a price
    // quoted from the wrong tier is a reason that misleads.
    const catalog = [
      { ...model("weak/current", { price: 1 }), completionPrice: 1 },
      {
        ...model("tiered/candidate", { price: 3 }),
        completionPrice: 3,
        priceOverrides: [{ minPromptTokens: 200_000, completionPrice: 5 }],
      },
      { ...model("dear/other", { price: 20 }), completionPrice: 20 },
    ] as ModelInfo[];

    const small = pickEscalationTarget("weak/current", { catalog, promptTokens: 1_000 });
    expect(small?.modelId).toBe("tiered/candidate");
    expect(small?.reason).toContain("heuristic");
    // No tier applied, so none is named — the label describes this request.
    expect(small?.reason).not.toContain("tier from");

    const large = pickEscalationTarget("weak/current", { catalog, promptTokens: 250_000 });
    expect(large?.modelId).toBe("tiered/candidate");
    expect(large?.reason).toContain("tier from 200,000");
  });

  it("applies the ceiling to the tier, not the list price", () => {
    // A model whose entry rate clears the automatic budget but whose tier does
    // not must be excluded — otherwise the guard is spent on the cheap half of a
    // request that is billed at the expensive half.
    const catalog = [
      { ...model("weak/current", { price: 1 }), completionPrice: 1 },
      {
        ...model("over/budget", { price: 1 }),
        completionPrice: 1,
        priceOverrides: [
          { minPromptTokens: 100_000, completionPrice: MAX_AUTO_ESCALATION_PRICE * 4 },
        ],
      },
      { ...model("under/budget", { price: 6 }), completionPrice: 6 },
    ] as ModelInfo[];
    const competenceIndex = competence([
      { id: "weak/current", coding: 40 },
      { id: "over/budget", coding: 90 },
      { id: "under/budget", coding: 70 },
    ]);

    // Small context: the entry rate is what it pays, so it is eligible — and it
    // is both the cheapest and the stronger of the two candidates.
    expect(
      pickEscalationTarget("weak/current", {
        catalog,
        competence: competenceIndex,
        promptTokens: 1_000,
      })?.modelId
    ).toBe("over/budget");

    // Large context: the tier is what it pays, and it is out.
    expect(
      pickEscalationTarget("weak/current", {
        catalog,
        competence: competenceIndex,
        promptTokens: 150_000,
      })?.modelId
    ).toBe("under/budget");
  });

  it("scores capability at the request's size in the heuristic too", () => {
    const tiered = {
      ...model("tiered/model", { price: 2 }),
      completionPrice: 2,
      priceOverrides: [{ minPromptTokens: 100_000, completionPrice: 20 }],
    } as ModelInfo;
    expect(capabilityScore(tiered, 1_000)).toBe(2);
    expect(capabilityScore(tiered, 200_000)).toBe(20);
    // The default keeps every existing caller's behaviour: the entry rate.
    expect(capabilityScore(tiered)).toBe(2);
  });
});
