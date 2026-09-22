// ============================================================
// Verification ledger — regression tests
// ============================================================
// The property that matters is the one an implementation gets wrong by
// accident: evidence must go stale the INSTANT the code it describes
// changes, without anything having to remember to invalidate it. These
// tests pin that, plus the wording the reviewer reads at the gate.

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearVerification,
  formatAge,
  proofSection,
  recordVerification,
  verificationEvent,
  verificationEvidence,
  verificationLines,
  verificationWarnings,
} from "./verification-ledger";

const CONV = "conv-1";

function typecheck(over: Partial<Parameters<typeof recordVerification>[1]> = {}) {
  return {
    kind: "typecheck" as const,
    at: 1_000,
    workspaceUpdatedAt: 50,
    ok: true,
    summary: "0 errors across 12 files",
    source: "run_checks",
    ...over,
  };
}

function probes(over: Partial<Parameters<typeof recordVerification>[1]> = {}) {
  return {
    kind: "probes" as const,
    at: 2_000,
    workspaceUpdatedAt: 50,
    ok: false,
    summary: "1/3 probes passed",
    details: ["counter increments: text of \"#n\" is \"0\" but expected \"1\""],
    ...over,
  };
}

beforeEach(() => {
  clearVerification();
});

describe("recording", () => {
  it("keeps one event per kind and replaces it on a newer run", () => {
    recordVerification(CONV, typecheck());
    recordVerification(CONV, typecheck({ ok: false, at: 3_000, summary: "2 errors" }));
    const evidence = verificationEvidence(CONV, { workspaceUpdatedAt: 50, now: 3_100 });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.summary).toBe("2 errors");
    expect(evidence[0]?.status).toBe("fresh-fail");
  });

  it("returns both kinds in a stable order", () => {
    recordVerification(CONV, probes());
    recordVerification(CONV, typecheck());
    expect(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }).map((e) => e.kind)).toEqual([
      "typecheck",
      "probes",
    ]);
  });

  it("ignores an empty conversation id", () => {
    recordVerification("", typecheck());
    expect(verificationEvidence("", { workspaceUpdatedAt: 50 })).toEqual([]);
  });

  it("caps stored failure details", () => {
    recordVerification(CONV, probes({ details: Array.from({ length: 40 }, (_, i) => `f${i}`) }));
    expect(verificationEvent(CONV, "probes")?.details).toHaveLength(20);
  });
});

describe("staleness is derived, not maintained", () => {
  it("is fresh only while the verified revision is the current one", () => {
    recordVerification(CONV, typecheck());
    expect(verificationEvidence(CONV, { workspaceUpdatedAt: 50 })[0]?.status).toBe("fresh-pass");
    // No edit hook ran, nothing was invalidated — the revision moved.
    expect(verificationEvidence(CONV, { workspaceUpdatedAt: 51 })[0]?.status).toBe("stale");
  });

  it("reports age so a reviewer can weigh the result", () => {
    recordVerification(CONV, typecheck({ at: 10_000 }));
    const evidence = verificationEvidence(CONV, { workspaceUpdatedAt: 50, now: 70_000 });
    expect(evidence[0]?.ageMs).toBe(60_000);
    expect(formatAge(60_000)).toBe("1 min ago");
    expect(formatAge(5_000)).toBe("5s ago");
    expect(formatAge(7_200_000)).toBe("2h ago");
  });
});

describe("reviewer-facing lines", () => {
  it("names the check, the verdict and the age", () => {
    recordVerification(CONV, typecheck({ at: 1_000 }));
    const lines = verificationLines(verificationEvidence(CONV, { workspaceUpdatedAt: 50, now: 5_000 }));
    expect(lines[0]).toContain("Type check");
    expect(lines[0]).toContain("passed");
    expect(lines[0]).toContain("0 errors across 12 files");
    expect(lines[0]).toContain("4s ago");
  });

  it("says a stale pass does NOT describe the current code", () => {
    recordVerification(CONV, probes({ ok: true, summary: "3/3 probes passed" }));
    const lines = verificationLines(verificationEvidence(CONV, { workspaceUpdatedAt: 99, now: 9_000 }));
    expect(lines[0]).toMatch(/workspace changed afterwards/);
    expect(lines[0]).toMatch(/does not describe the current code/);
  });
});

describe("gate warnings", () => {
  it("warns loudly about a fresh failure and quotes the first failures", () => {
    recordVerification(CONV, probes());
    const warnings = verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("probes");
    expect(warnings[0]?.message).toMatch(/FAILED/);
    expect(warnings[0]?.message).toContain('expected "1"');
  });

  it("warns that a stale pass cannot back the current diff", () => {
    recordVerification(CONV, typecheck());
    const warnings = verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 51 }));
    expect(warnings[0]?.message).toMatch(/workspace has changed since/);
    expect(warnings[0]?.kind).toBe("checks");
  });

  it("stays quiet for a fresh pass — evidence is not a nag", () => {
    recordVerification(CONV, typecheck());
    recordVerification(CONV, probes({ ok: true, summary: "3/3 probes passed" }));
    expect(verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }))).toEqual([]);
  });

  it("does not warn about a stale failure (it is superseded, not evidence)", () => {
    recordVerification(CONV, probes());
    expect(verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 51 }))).toEqual([]);
  });
});

describe("proof section", () => {
  it("is null when nothing was verified", () => {
    expect(proofSection([])).toBeNull();
  });

  it("carries the evidence and names what was NOT run", () => {
    recordVerification(CONV, typecheck());
    recordVerification(CONV, probes({ ok: true, summary: "4/4 probes passed" }));
    const section = proofSection(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }));
    expect(section).toContain("### In-browser verification");
    expect(section).toContain("4/4 probes passed");
    expect(section).toMatch(/Not run in this workspace/);
  });
});
