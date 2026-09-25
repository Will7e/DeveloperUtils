// ============================================================
// Effort Escalation — Tests
// ============================================================
// The thinking rung's contract: fire on real friction, refuse on
// everything else, and never fire twice. Most of these cases are
// refusals — by design, mirroring lib/escalation.test.ts, because a
// policy that spends on a guess is worse than one that waits for
// evidence.

import { describe, it, expect } from "vitest";
import {
  EFFORT_BUMP_LEVEL,
  difficultyJustifiesEffortBump,
  effortBumpLogDetail,
  effortEscalationNote,
  nextEffortRung,
  pickEffortBump,
} from "./effort-escalation";
import { assessDifficulty } from "./difficulty";
import type { DifficultyInput } from "./difficulty";
import type { ModelInfo } from "../types";

const empty: DifficultyInput = {
  failedCalls: 0,
  mostRepeatedCall: 0,
  alternatingPairs: 0,
  stuckRefusals: 0,
  argumentRepairs: 0,
  continuations: 0,
  completionNudges: 0,
  freshFailingChecks: 0,
  freshPreviewErrors: 0,
};

const elevated = assessDifficulty({ ...empty, stuckRefusals: 1 });
const high = assessDifficulty({ ...empty, stuckRefusals: 2 });
const low = assessDifficulty(empty);

const reasoningModel: ModelInfo = {
  id: "m/reasoner",
  name: "Reasoner",
  supportedParameters: ["tools", "reasoning"],
  reasoning: { supportedEfforts: ["low", "medium", "high", "max"] },
} as ModelInfo;

const plainModel: ModelInfo = {
  id: "m/plain",
  name: "Plain",
  supportedParameters: ["tools"],
} as ModelInfo;

describe("nextEffortRung", () => {
  it("walks the rungs upward", () => {
    expect(nextEffortRung("low")).toBe("medium");
    expect(nextEffortRung("medium")).toBe("high");
    expect(nextEffortRung("high")).toBe("max");
  });

  it("returns null at max — there is no more thinking to buy", () => {
    expect(nextEffortRung("max")).toBeNull();
  });
});

describe("difficultyJustifiesEffortBump", () => {
  it("fires on elevated and high, not on low", () => {
    expect(difficultyJustifiesEffortBump(low)).toBe(false);
    expect(difficultyJustifiesEffortBump(elevated)).toBe(true);
    expect(difficultyJustifiesEffortBump(high)).toBe(true);
    expect(EFFORT_BUMP_LEVEL).toBe("elevated");
  });
});

describe("pickEffortBump", () => {
  it("bumps one rung on an elevated assessment", () => {
    const choice = pickEffortBump("medium", elevated, { modelInfo: reasoningModel });
    expect(choice).not.toBeNull();
    expect(choice!.from).toBe("medium");
    expect(choice!.effort).toBe("high");
  });

  it("names the difficulty signals as the reason", () => {
    const choice = pickEffortBump("medium", elevated, { modelInfo: reasoningModel });
    expect(choice!.reason).toContain("refused");
    expect(choice!.reason).toContain("medium → high");
  });

  it("refuses when difficulty is low", () => {
    expect(pickEffortBump("medium", low, { modelInfo: reasoningModel })).toBeNull();
  });

  it("refuses when the turn already spent its bump", () => {
    expect(
      pickEffortBump("medium", elevated, {
        modelInfo: reasoningModel,
        alreadyBumped: true,
      })
    ).toBeNull();
  });

  it("refuses when the turn already escalated models", () => {
    expect(
      pickEffortBump("medium", elevated, {
        modelInfo: reasoningModel,
        alreadyEscalated: true,
      })
    ).toBeNull();
  });

  it("refuses when adaptive effort is off", () => {
    expect(
      pickEffortBump("medium", elevated, {
        modelInfo: reasoningModel,
        enabled: false,
      })
    ).toBeNull();
  });

  it("refuses a model the catalog cannot describe as reasoning-capable", () => {
    // Sending an unsupported effort key is a 400 on strict providers, so
    // unknown capability must refuse rather than gamble the turn.
    expect(pickEffortBump("medium", elevated, { modelInfo: plainModel })).toBeNull();
    expect(pickEffortBump("medium", elevated, {})).toBeNull();
  });

  it("refuses at max — no headroom left", () => {
    expect(pickEffortBump("max", elevated, { modelInfo: reasoningModel })).toBeNull();
  });
});

describe("transcript note", () => {
  it("states the change, the basis, and that the setting is untouched", () => {
    const choice = pickEffortBump("medium", elevated, { modelInfo: reasoningModel })!;
    const note = effortEscalationNote(choice);
    expect(note).toContain("medium to high");
    expect(note).toContain("The model is unchanged");
    expect(note).toContain("untouched");
    expect(effortBumpLogDetail(choice)).toContain("effort bumped");
  });
});
