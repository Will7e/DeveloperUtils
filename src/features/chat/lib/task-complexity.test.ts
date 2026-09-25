// ============================================================
// Task Complexity — Tests
// ============================================================
// The classifier sets the rung a turn STARTS at, so its two failure
// modes are opposite: over-raising wastes thinking tokens on trivial
// requests, and mis-reading `low` starves a debugging turn. Both are
// pinned here, along with the one-rung-per-direction bound.

import { describe, it, expect } from "vitest";
import { classifyRequest, effortForComplexity } from "./task-complexity";

describe("classifyRequest", () => {
  it("reads a greeting as standard", () => {
    const { complexity } = classifyRequest({ text: "hello there" });
    expect(complexity).toBe("standard");
  });

  it("reads a long multi-step instruction as deep", () => {
    const text =
      "First, update the parser in src/lib/parser.ts to handle quoted strings. " +
      "Then, add tests in tests/parser.test.ts for the new cases. Also update " +
      "the README with the new behaviour, and make sure the build still passes " +
      "after that. We should also handle the unicode edge case in src/lib/scan.ts " +
      "while we are in there, and run the full suite before you finish.";
    const { complexity, reasons } = classifyRequest({ text });
    expect(complexity).toBe("deep");
    expect(reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("reads debugging phrasing as deep even when short", () => {
    const { complexity } = classifyRequest({ text: "why does the login still fail?" });
    expect(complexity).toBe("deep");
  });

  it("reads a pasted stack trace as deep even when terse", () => {
    const text = "getting this:\nError: cannot read properties of undefined\n    at render (src/App.tsx:42:11)";
    const { complexity } = classifyRequest({ text });
    expect(complexity).toBe("deep");
  });

  it("reads a refactor request as deep", () => {
    const { complexity } = classifyRequest({
      text: "refactor the auth module, it has grown unwieldy and the root cause is unclear",
    });
    expect(complexity).toBe("deep");
  });

  it("reads a short rename as low when nothing is failing", () => {
    const { complexity } = classifyRequest({ text: "rename the helper function getUser to fetchUser" });
    expect(complexity).toBe("low");
  });

  it("refuses low when failing evidence exists — friction disqualifies triviality", () => {
    const { complexity } = classifyRequest({
      text: "rename the helper function getUser to fetchUser",
      failingEvidence: true,
    });
    expect(complexity).toBe("standard");
  });

  it("refuses low when the message itself carries debug phrasing", () => {
    const { complexity } = classifyRequest({ text: "fix the typo where the test fails on empty input" });
    expect(complexity).not.toBe("low");
  });

  it("counts open plan steps toward deep", () => {
    const { complexity } = classifyRequest({ text: "continue", openPlanSteps: 4 });
    expect(complexity).toBe("deep");
  });

  it("two open plan steps alone are not deep", () => {
    const { complexity } = classifyRequest({ text: "continue", openPlanSteps: 2 });
    expect(complexity).toBe("standard");
  });
});

describe("effortForComplexity", () => {
  it("moves deep up one rung", () => {
    expect(effortForComplexity("deep", "medium")).toBe("high");
    expect(effortForComplexity("deep", "low")).toBe("medium");
  });

  it("caps deep at max", () => {
    expect(effortForComplexity("deep", "max")).toBe("max");
    expect(effortForComplexity("deep", "high")).toBe("max");
  });

  it("moves low down one rung", () => {
    expect(effortForComplexity("low", "medium")).toBe("low");
    expect(effortForComplexity("low", "high")).toBe("medium");
  });

  it("floors low at low — never below", () => {
    expect(effortForComplexity("low", "low")).toBe("low");
  });

  it("leaves standard alone", () => {
    expect(effortForComplexity("standard", "medium")).toBe("medium");
  });
});
