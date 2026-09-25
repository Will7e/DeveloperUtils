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
  it("flags a test-suite claim nothing ran", () => {
    const findings = auditClaims({
      claim: "All tests pass. Added src/App.tsx.",
      changedPaths: CHANGED,
      toolsUsed: ["read_file", "edit_file"],
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

  it("flags a build claim when nothing ran it", () => {
    const findings = auditClaims({
      claim: "The build passes.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file"],
    });
    expect(findings.map((f) => f.code)).toEqual(["unverified-claim"]);
  });

  it("accepts a build claim a real command backs", () => {
    const findings = auditClaims({
      claim: "The build passes now.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "run_command"],
      workspace: { status: "fresh-pass", summary: "`npm run build` exited 0 in 3.1s" },
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
  it("only counts the tools that actually execute something", () => {
    expect(ranVerification(["read_file", "edit_file"])).toBe(false);
    expect(ranVerification(["run_command"])).toBe(true);
    expect(ranVerification(["verify_with_ci"])).toBe(true);
    expect(ranVerification(undefined)).toBe(false);
  });
});

describe("claims weighed against real verification", () => {
  const failedCommand = {
    status: "fresh-fail" as const,
    summary: "`npm test` exited 1 in 900ms",
    details: ["FAIL src/a.test.ts > adds numbers"],
  };

  it("flags a summary that contradicts a failing command, quoting it", () => {
    const findings = auditClaims({
      claim: "Added the increment button in src/App.tsx and the counter works now.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "run_command"],
      workspace: failedCommand,
    });
    const contradicted = findings.filter((f) => f.code === "contradicted-claim");
    expect(contradicted).toHaveLength(1);
    expect(contradicted[0]!.message).toMatch(/FAILED/);
    expect(contradicted[0]!.message).toContain("FAIL src/a.test.ts");
  });

  it("is quiet when nothing asserts an outcome, even if the command failed", () => {
    const findings = auditClaims({
      claim: "Updated src/App.tsx to use the new hook.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "run_command"],
      workspace: failedCommand,
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
      toolsUsed: ["edit_file", "run_command"],
      workspace: { status: "stale", summary: "`npm test` exited 0 in 812ms" },
    });
    expect(findings.map((f) => f.code)).toContain("unverified-claim");
    expect(findings.some((f) => /describes older code/.test(f.message))).toBe(true);
  });

  it("accepts a fresh passing command as backing for an outcome claim", () => {
    const findings = auditClaims({
      claim: "The counter works now — src/App.tsx increments on click.",
      changedPaths: CHANGED,
      toolsUsed: ["edit_file", "run_command"],
      workspace: { status: "fresh-pass", summary: "`npm test` exited 0 in 812ms" },
    });
    expect(findings.filter((f) => f.code === "contradicted-claim")).toHaveLength(0);
  });
});

describe("auditClaims — real execution changes what is provable", () => {
  const COMMAND_PASS = { status: "fresh-pass" as const, summary: "`npm test` exited 0 in 812ms" };
  const COMMAND_FAIL = {
    status: "fresh-fail" as const,
    summary: "`npm test` exited 1 in 900ms",
    details: ["FAIL src/a.test.ts > adds numbers"],
  };

  it("does not flag a test claim that a real command backs", () => {
    // The rule used to be unconditional because the workspace genuinely had
    // no shell. It has one now (run_command, verify_with_ci), so flagging a
    // passing test run would be a false alarm — and a false alarm is how a
    // reviewer learns to ignore the audit.
    const findings = auditClaims({
      claim: "All tests pass. Fixed src/App.tsx.",
      changedPaths: CHANGED,
      toolsUsed: ["run_command"],
      workspace: COMMAND_PASS,
    });
    expect(findings.filter((f) => f.code === "unverified-claim")).toHaveLength(0);
  });

  it("still flags a test claim with nothing behind it, and names the tiers that could", () => {
    const finding = auditClaims({ claim: "All tests pass.", changedPaths: CHANGED }).find(
      (f) => f.code === "unverified-claim"
    );
    expect(finding).toBeTruthy();
    expect(finding!.message).toContain("run_command");
    expect(finding!.message).toContain("verify_with_ci");
    // The old wording asserted a shell was impossible here, which is now false.
    expect(finding!.message).not.toContain("no shell");
  });

  it("counts a real command, and CI, as verification", () => {
    expect(ranVerification(["run_command"])).toBe(true);
    expect(ranVerification(["verify_with_ci"])).toBe(true);
  });

  it("contradicts the summary when the command FAILED", () => {
    const contradicted = auditClaims({
      claim: "Fixed the parser and all tests pass.",
      changedPaths: CHANGED,
      toolsUsed: ["run_command"],
      workspace: COMMAND_FAIL,
    }).find((f) => f.code === "contradicted-claim");
    expect(contradicted).toBeTruthy();
    expect(contradicted!.message).toContain("A command run in the browser workspace");
    expect(contradicted!.evidence[0]).toContain("FAIL");
  });

  it("contradicts the summary when CI failed", () => {
    const findings = auditClaims({
      claim: "All tests pass.",
      changedPaths: CHANGED,
      toolsUsed: ["verify_with_ci"],
      ci: { status: "fresh-fail", summary: "Verify — failed", details: ["run #42 failed"] },
    });
    expect(findings.some((f) => f.code === "contradicted-claim")).toBe(true);
  });

  it("counts BOTH failures when the command and CI both failed", () => {
    const contradicted = auditClaims({
      claim: "All tests pass.",
      changedPaths: CHANGED,
      toolsUsed: ["run_command", "verify_with_ci"],
      workspace: COMMAND_FAIL,
      ci: { status: "fresh-fail", summary: "Verify — failed" },
    }).find((f) => f.code === "contradicted-claim");
    expect(contradicted!.message).toContain("1 other result(s) also failed");
  });

  it("treats a pass that predates the last edit as stale, not as proof", () => {
    const finding = auditClaims({
      claim: "All tests pass.",
      changedPaths: CHANGED,
      toolsUsed: ["run_command"],
      workspace: { status: "stale", summary: "`npm test` exited 0 in 812ms" },
    }).find((f) => f.code === "unverified-claim");
    expect(finding).toBeTruthy();
    expect(finding!.message).toContain("before the last edit");
  });

  it("stays quiet for an honest summary that claims no outcome", () => {
    expect(
      auditClaims({
        claim: "Updated src/App.tsx to pass the new prop through.",
        changedPaths: CHANGED,
      })
    ).toEqual([]);
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
