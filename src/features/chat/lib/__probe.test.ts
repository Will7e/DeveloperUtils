import { describe, it, expect } from "vitest";
import { classifyRequest, effortForComplexity } from "./task-complexity";
import { assessDifficulty, countAlternationCycles } from "./difficulty";

describe("edge probes", () => {
  it("classifyRequest never crashes on pathological input", () => {
    expect(() => classifyRequest({ text: "" })).not.toThrow();
    expect(() => classifyRequest({ text: "x".repeat(100_000) })).not.toThrow();
    expect(() => classifyRequest({ text: "a\nb\nc", openPlanSteps: -5 })).not.toThrow();
    expect(() => classifyRequest({ text: "🚀🔥💥 unicode only" })).not.toThrow();
    const r = classifyRequest({ text: "First, do A. Then, do B. Then, do C. Then, do D. Also update the README." });
    console.log("multi-signal:", JSON.stringify(r));
  });

  it("alternation counter is O(n) and safe on large orders", () => {
    const big = Array.from({ length: 10_000 }, (_, i) => `sig${i % 50}`);
    const t0 = Date.now();
    expect(() => countAlternationCycles(big)).not.toThrow();
    console.log("10k alternation scan ms:", Date.now() - t0);
  });

  it("assessDifficulty tolerates weird numbers", () => {
    expect(() => assessDifficulty({ failedCalls: -3, mostRepeatedCall: -1, alternatingPairs: 0, stuckRefusals: -2, argumentRepairs: 0, continuations: 0, completionNudges: 0, freshFailingChecks: 0, freshPreviewErrors: 0 })).not.toThrow();
    const r = assessDifficulty({ failedCalls: -3, mostRepeatedCall: -1, alternatingPairs: 0, stuckRefusals: -2, argumentRepairs: 0, continuations: 0, completionNudges: 0, freshFailingChecks: 0, freshPreviewErrors: 0 });
    expect(r.level).toBe("low");
    expect(r.score).toBe(0);
  });

  it("effortForComplexity survives an unknown rung", () => {
    // @ts-expect-error - deliberately malformed input
    expect(effortForComplexity("deep", "bogus")).toBe("bogus");
  });
});
