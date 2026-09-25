// ============================================================
// Difficulty — Tests
// ============================================================
// The assessment is the shared input to the response ladder, so these
// tests pin the two properties the ladder depends on: levels mean what
// the consumers were told they mean, and no single signal class can
// dominate the score on its own.

import { describe, it, expect } from "vitest";
import {
  ELEVATED_THRESHOLD,
  HIGH_THRESHOLD,
  assessDifficulty,
  countAlternationCycles,
  describeDifficulty,
  WEIGHT_STUCK_REFUSAL,
} from "./difficulty";

const empty = {
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

describe("assessDifficulty", () => {
  it("reads low when nothing happened", () => {
    const result = assessDifficulty(empty);
    expect(result.level).toBe("low");
    expect(result.score).toBe(0);
    expect(result.signals).toEqual([]);
  });

  it("reads low for a turn with a single failed call (normal work)", () => {
    const result = assessDifficulty({ ...empty, failedCalls: 1 });
    expect(result.level).toBe("low");
  });

  it("reaches elevated on accumulating friction (repairs + failures)", () => {
    const result = assessDifficulty({ ...empty, argumentRepairs: 4, failedCalls: 2 });
    expect(result.level).toBe("elevated");
    expect(result.score).toBeGreaterThanOrEqual(ELEVATED_THRESHOLD);
    expect(result.signals.map((s) => s.name)).toEqual(
      expect.arrayContaining(["argument-repairs", "failed-calls"])
    );
  });

  it("reaches elevated from a failing check plus failures", () => {
    // 2 failures beyond the first (+4) and one failing check (+3): 7.
    const result = assessDifficulty({ ...empty, freshFailingChecks: 1, failedCalls: 3 });
    expect(result.level).toBe("elevated");
    expect(result.score).toBe(7);
  });

  it("a single stuck refusal is already elevated — the old model-swap trigger", () => {
    // One refusal means the harness told the model, in words, that its
    // call fails and it repeated it. The ladder as a whole must react,
    // exactly as the old `stuckRefusals > 0` path did.
    const result = assessDifficulty({ ...empty, stuckRefusals: 1 });
    expect(result.level).toBe("elevated");
    expect(result.score).toBeGreaterThanOrEqual(ELEVATED_THRESHOLD);
  });

  it("a single refusal alone cannot reach high", () => {
    const result = assessDifficulty({ ...empty, stuckRefusals: 1 });
    expect(result.level).not.toBe("high");
  });

  it("reaches high on three refusals — the old STUCK_FAILING_REPEATS bar", () => {
    // Three refusals = 18 ≥ 14: the same evidence volume that once sent a
    // turn straight to a model swap now reaches the ladder's top rung.
    const result = assessDifficulty({ ...empty, stuckRefusals: 3 });
    expect(result.level).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(HIGH_THRESHOLD);
  });

  it("two refusals plus one failing-check signal reach high", () => {
    // 12 + 3 = 15: refusal-heavy friction plus a failing check.
    const result = assessDifficulty({ ...empty, stuckRefusals: 2, freshFailingChecks: 1 });
    expect(result.level).toBe("high");
  });

  it("reaches high from a mix of medium signals", () => {
    const result = assessDifficulty({
      ...empty,
      failedCalls: 3,
      mostRepeatedCall: 4,
      continuations: 1,
      freshFailingChecks: 1,
    });
    // 4 + 6 + 3 + 3 = 16: repeat weight is 3 per execution beyond two,
    // so four executions of one signature weigh 6. Enough friction that
    // the model rung becomes defensible.
    expect(result.level).toBe("high");
  });

  it("a mix without refusals or repeats stays elevated", () => {
    const result = assessDifficulty({
      ...empty,
      failedCalls: 3,
      continuations: 1,
      freshFailingChecks: 1,
    });
    // 4 + 3 + 3 = 10: friction without a refusal or a repeat loop leaves
    // the cheaper rungs available.
    expect(result.level).toBe("elevated");
  });

  it("caps a single pathological signal so it cannot dominate alone", () => {
    // Eleven repeated executions of one signature would be 27 raw points
    // — past `high` on its own. The cap keeps that from happening: one
    // class of noise must not drive a model swap by itself.
    const result = assessDifficulty({ ...empty, mostRepeatedCall: 13 });
    expect(result.score).toBeLessThan(HIGH_THRESHOLD);
    expect(result.level).toBe("elevated");
  });

  it("ignores one alternation cycle (a read after an edit is normal)", () => {
    const result = assessDifficulty({ ...empty, alternatingPairs: 1 });
    expect(result.level).toBe("low");
  });

  it("weights several alternation cycles", () => {
    const result = assessDifficulty({ ...empty, alternatingPairs: 4 });
    expect(result.level).toBe("elevated");
    expect(result.signals.map((s) => s.name)).toContain("alternating-calls");
  });

  it("sorts signals strongest first", () => {
    const result = assessDifficulty({
      ...empty,
      stuckRefusals: 2,
      argumentRepairs: 6,
    });
    expect(result.signals[0]!.name).toBe("stuck-refusals");
    expect(result.signals[1]!.name).toBe("argument-repairs");
  });

  it("names the refusal basis in words a transcript can quote", () => {
    const result = assessDifficulty({ ...empty, stuckRefusals: 1 });
    expect(result.signals[0]!.detail).toContain("refused");
    expect(describeDifficulty(result)).toContain("difficulty: elevated");
  });
});

describe("countAlternationCycles", () => {
  it("counts nothing on an empty or short order", () => {
    expect(countAlternationCycles([])).toBe(0);
    expect(countAlternationCycles(["a"])).toBe(0);
    expect(countAlternationCycles(["a", "b"])).toBe(0);
  });

  it("counts one cycle for A-B-A", () => {
    expect(countAlternationCycles(["a", "b", "a"])).toBe(1);
  });

  it("counts A-B-A-B as ONE cycle, not two (non-overlapping)", () => {
    expect(countAlternationCycles(["a", "b", "a", "b"])).toBe(1);
  });

  it("counts distinct oscillations separately", () => {
    // a-b-a, then later c-d-c: two distinct oscillations.
    expect(countAlternationCycles(["a", "b", "a", "c", "d", "c"])).toBe(2);
  });

  it("a repeated identical call is not an alternation", () => {
    expect(countAlternationCycles(["a", "a", "a"])).toBe(0);
  });
});

describe("weight invariants", () => {
  it("one refusal at WEIGHT_STUCK_REFUSAL clears ELEVATED_THRESHOLD", () => {
    expect(WEIGHT_STUCK_REFUSAL).toBeGreaterThanOrEqual(ELEVATED_THRESHOLD);
  });
});
