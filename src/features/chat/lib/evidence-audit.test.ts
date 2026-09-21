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
    expect(ranVerification(undefined)).toBe(false);
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
