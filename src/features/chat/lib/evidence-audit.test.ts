// ============================================================
// Evidence Audit — Gate Tests
// ============================================================
// Two failure modes matter, and they pull in opposite directions:
// missing a "all tests pass" that could never be true, and accusing an
// honest summary of lying. Both are pinned here.

import { describe, it, expect } from "vitest";
import {
  auditClaims,
  evidenceWarnings,
  extractClaimedPaths,
  ranVerification,
  ranVisualVerification,
} from "./evidence-audit";

const CHANGED = ["src/App.tsx", "src/util/format.ts"];

describe("extractClaimedPaths", () => {
  it("picks up paths on lines that make a change claim", () => {
    expect(extractClaimedPaths("Added src/util/format.ts to handle dates.")).toEqual([
      "src/util/format.ts",
    ]);
  });

  it("ignores paths mentioned as context", () => {
    expect(extractClaimedPaths("The build config lives in vite.config.ts.")).toEqual([]);
  });

  it("ignores URLs", () => {
    expect(extractClaimedPaths("See https://github.com/acme/demo/pull/1 for context.")).toEqual([]);
  });
});

describe("auditClaims — file claims", () => {
  it("stays quiet when every claimed file is in the change set", () => {
    const findings = auditClaims({
      claim: "Added src/App.tsx and updated src/util/format.ts.",
      changedPaths: CHANGED,
    });
    expect(findings).toHaveLength(0);
  });

  it("flags a file claimed as changed that is not in the diff", () => {
    const findings = auditClaims({
      claim: "Added src/App.tsx and refactored src/api/client.ts.",
      changedPaths: CHANGED,
    });
    expect(findings.map((f) => f.code)).toEqual(["unbacked-file-claim"]);
    expect(findings[0]!.evidence).toContain("src/api/client.ts");
  });

  it("accepts the partial paths models write", () => {
    const findings = auditClaims({
      claim: "Updated App.tsx and format.ts.",
      changedPaths: CHANGED,
    });
    expect(findings).toHaveLength(0);
  });

  it("does not flag anything when nothing was changed at all", () => {
    const findings = auditClaims({ claim: "Added src/a.ts", changedPaths: [] });
    expect(findings).toHaveLength(0);
  });
});

describe("auditClaims — verification claims", () => {
  it("flags a test-suite claim, because it can never be true here", () => {
    const findings = auditClaims({
      claim: "All tests pass. Added src/App.tsx.",
      changedPaths: CHANGED,
      toolsUsed: ["read_file", "edit_file", "run_in_preview"],
    });
    expect(findings.map((f) => f.code)).toEqual(["unverified-claim"]);
    expect(findings[0]!.evidence).toEqual(["All tests pass"]);
  });

  it("flags a type-check claim", () => {
    const findings = auditClaims({
      claim: "The type-check passes now.",
      changedPaths: CHANGED,
    });
    expect(findings.map((f) => f.code)).toEqual(["unverified-claim"]);
  });

  it("flags a build claim when nothing verified the preview", () => {
    const findings = auditClaims({
      claim: "The build passes.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file"],
    });
    expect(findings.map((f) => f.code)).toEqual(["unverified-claim"]);
  });

  it("accepts a build claim the preview actually confirmed", () => {
    const findings = auditClaims({
      claim: "The build passes now.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "get_preview_feedback"],
    });
    expect(findings).toHaveLength(0);
  });

  it("accepts a plain summary with no check claims", () => {
    const findings = auditClaims({
      claim: "Moved the date helper into src/util/format.ts for reuse.",
      changedPaths: CHANGED,
    });
    expect(findings).toHaveLength(0);
  });
});

describe("ranVerification", () => {
  it("only counts the tools that can actually observe a running app", () => {
    expect(ranVerification(["read_file", "edit_file"])).toBe(false);
    expect(ranVerification(["query_preview_dom"])).toBe(true);
    expect(ranVerification(["get_preview_layout"])).toBe(true);
    expect(ranVerification(["check_preview_visually"])).toBe(true);
    expect(ranVerification(undefined)).toBe(false);
  });

  it("keeps the visual set narrower than the verification set", () => {
    // A DOM query or a geometry map cannot see colour, contrast or paint
    // order, so neither counts as having LOOKED at the page.
    expect(ranVisualVerification(["query_preview_dom"])).toBe(false);
    expect(ranVisualVerification(["get_preview_layout"])).toBe(false);
    expect(ranVisualVerification(["check_preview_visually"])).toBe(true);
    expect(ranVisualVerification(undefined)).toBe(false);
  });
});

describe("auditClaims — visual claims", () => {
  it("flags a rendering claim nothing looked at", () => {
    const findings = auditClaims({
      claim: "The header now renders correctly on narrow screens.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "query_preview_dom"],
    });
    expect(findings.map((f) => f.code)).toEqual(["unverified-claim"]);
    expect(findings[0]!.message).toMatch(/rendered pixels|check_preview_visually/);
  });

  it("accepts a rendering claim a visual check backed", () => {
    const findings = auditClaims({
      claim: "The header now renders correctly on narrow screens.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "check_preview_visually"],
    });
    expect(findings).toHaveLength(0);
  });

  it("catches the softer ways a model says the same thing", () => {
    for (const claim of [
      "That looks right now.",
      "The card is styled correctly.",
      "Visually verified the new dialog.",
      "The page renders cleanly.",
    ]) {
      const findings = auditClaims({ claim, changedPaths: CHANGED, toolsUsed: ["edit_file"] });
      expect(findings.length, claim).toBeGreaterThan(0);
    }
  });

  it("stays quiet about layout work that makes no rendering claim", () => {
    const findings = auditClaims({
      claim: "Replaced the flex row with a grid and updated the breakpoint in src/App.tsx.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file"],
    });
    expect(findings).toHaveLength(0);
  });
});

describe("claims weighed against real verification", () => {
  const failedProbes = {
    status: "fresh-fail" as const,
    summary: "1/3 probes passed",
    details: ['counter increments: text of "#n" is "0" but expected "1"'],
  };

  it("flags a summary that contradicts failing probes, quoting them", () => {
    const findings = auditClaims({
      claim: "Added the increment button in src/App.tsx and the counter works now.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "verify_behavior"],
      probes: failedProbes,
    });
    const contradicted = findings.filter((f) => f.code === "contradicted-claim");
    expect(contradicted).toHaveLength(1);
    expect(contradicted[0]!.message).toMatch(/FAILED/);
    expect(contradicted[0]!.message).toContain('expected "1"');
  });

  it("is quiet when nothing asserts an outcome, even if probes failed", () => {
    const findings = auditClaims({
      claim: "Updated src/App.tsx to use the new hook.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "verify_behavior"],
      probes: failedProbes,
    });
    expect(findings.filter((f) => f.code === "contradicted-claim")).toHaveLength(0);
  });

  it("does not contradict a claim with a failed type check the model already owned", () => {
    const findings = auditClaims({
      claim: "The type check reports 2 errors in src/App.tsx that I did not fix.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "run_checks"],
      typecheck: { status: "fresh-fail", summary: "2 error(s)", details: ["TS2322"] },
    });
    // "did not fix" is not an outcome assertion, so nothing is added.
    expect(findings.filter((f) => f.code === "contradicted-claim")).toHaveLength(0);
  });

  it("calls out leaning on a pass that predates the last edit", () => {
    const findings = auditClaims({
      claim: "The login flow works now — src/App.tsx handles the redirect.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "verify_behavior"],
      probes: { status: "stale", summary: "4/4 probes passed" },
    });
    expect(findings.map((f) => f.code)).toContain("unverified-claim");
    expect(findings.some((f) => /describes older code/.test(f.message))).toBe(true);
  });

  it("accepts a fresh passing probe run as backing for an outcome claim", () => {
    const findings = auditClaims({
      claim: "The counter works now — src/App.tsx increments on click.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "verify_behavior"],
      probes: { status: "fresh-pass", summary: "3/3 probes passed" },
    });
    expect(findings.filter((f) => f.code === "contradicted-claim")).toHaveLength(0);
  });

  it("counts verify_behavior as verification", () => {
    expect(ranVerification(["verify_behavior"])).toBe(true);
  });
});

describe("evidenceWarnings", () => {
  it("produces approval-gate warnings", () => {
    const warnings = evidenceWarnings(
      auditClaims({ claim: "All tests pass.", changedPaths: CHANGED })
    );
    expect(warnings[0]!.kind).toBe("evidence");
  });
});
