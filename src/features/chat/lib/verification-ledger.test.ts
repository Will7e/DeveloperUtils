// ============================================================
// Verification ledger — regression tests
// ============================================================
// The property that matters is the one an implementation gets wrong by
// accident: evidence must go stale the INSTANT the code it describes
// changes, without anything having to remember to invalidate it. These
// tests pin that, plus the wording the reviewer reads at the gate.

import { beforeEach, describe, expect, it } from "vitest";
import {
  VERIFICATION_KIND_LABEL,
  clearVerification,
  formatAge,
  proofSection,
  recordVerification,
  verificationEvent,
  verificationEvidence,
  verificationLines,
  verificationWarnings,
} from "./verification-ledger";
import {
  clearAttachment,
  pinBase,
  resetBindings,
  setAttachment,
} from "../identity/bindings";
import type { RepoRef } from "../identity/identity";

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

function command(over: Partial<Parameters<typeof recordVerification>[1]> = {}) {
  return {
    kind: "command" as const,
    at: 3_000,
    workspaceUpdatedAt: 50,
    ok: true,
    summary: "`npm test` exited 0 in 812ms",
    source: "run_command",
    ...over,
  };
}

function ci(over: Partial<Parameters<typeof recordVerification>[1]> = {}) {
  return {
    kind: "ci" as const,
    at: 4_000,
    workspaceUpdatedAt: 50,
    ok: true,
    summary: "Verify — passed",
    source: "verify_with_ci",
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
    recordVerification(CONV, command());
    recordVerification(CONV, typecheck());
    expect(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }).map((e) => e.kind)).toEqual([
      "typecheck",
      "command",
    ]);
  });

  it("ignores an empty conversation id", () => {
    recordVerification("", typecheck());
    expect(verificationEvidence("", { workspaceUpdatedAt: 50 })).toEqual([]);
  });

  it("caps stored failure details", () => {
    recordVerification(CONV, command({ details: Array.from({ length: 40 }, (_, i) => `f${i}`) }));
    expect(verificationEvent(CONV, "command")?.details).toHaveLength(20);
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
    recordVerification(CONV, command({ ok: true, summary: "`npm test` exited 0" }));
    const lines = verificationLines(verificationEvidence(CONV, { workspaceUpdatedAt: 99, now: 9_000 }));
    expect(lines[0]).toMatch(/workspace changed afterwards/);
    expect(lines[0]).toMatch(/does not describe the current code/);
  });
});

describe("gate warnings", () => {
  it("warns loudly about a fresh failure and quotes the first failures", () => {
    recordVerification(
      CONV,
      command({ ok: false, summary: "`npm test` exited 1", details: ["FAIL src/a.test.ts"] })
    );
    const warnings = verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("checks");
    expect(warnings[0]?.message).toMatch(/FAILED/);
    expect(warnings[0]?.message).toContain("FAIL src/a.test.ts");
  });

  it("warns that a stale pass cannot back the current diff", () => {
    recordVerification(CONV, typecheck());
    const warnings = verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 51 }));
    expect(warnings[0]?.message).toMatch(/workspace has changed since/);
    expect(warnings[0]?.kind).toBe("checks");
  });

  it("stays quiet for a fresh pass — evidence is not a nag", () => {
    recordVerification(CONV, typecheck());
    recordVerification(CONV, command({ ok: true, summary: "`npm test` exited 0" }));
    expect(verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }))).toEqual([]);
  });

  it("does not warn about a stale failure (it is superseded, not evidence)", () => {
    recordVerification(CONV, command({ ok: false, summary: "`npm test` exited 1" }));
    expect(verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 51 }))).toEqual([]);
  });
});

describe("proof section", () => {
  it("is null when nothing was verified", () => {
    expect(proofSection([])).toBeNull();
  });

  it("carries the evidence and names what was NOT run", () => {
    recordVerification(CONV, typecheck());
    const section = proofSection(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }));
    expect(section).toContain("### In-browser verification");
    expect(section).toContain("0 errors across 12 files");
    expect(section).toMatch(/Not run in this workspace/);
    // What ran is not in the caveat; what did not run is.
    expect(section).not.toContain("The workspace type check.");
    expect(section).toContain("Test suite, linter and build commands");
  });

  it("never says the test suite was not run when a command ran", () => {
    // The "not run" line was written down, not derived, and it named the test
    // suite unconditionally — because nothing here could run one. A PR body
    // claiming "tests were not run" underneath a passing `npm test` is worse
    // than having no proof section at all.
    recordVerification(CONV, command({ ok: true, summary: "`npm test` exited 0 in 812ms" }));
    const section = proofSection(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }))!;
    expect(section).toContain("### Verification");
    expect(section).not.toContain("Test suite, linter and build commands");
    // It still says what genuinely did not happen.
    expect(section).toContain("The repository's CI on this branch");
  });

  it("drops only the lines something actually ran, and keeps the rest", () => {
    recordVerification(CONV, command({ ok: true, summary: "`npm test` exited 0" }));
    recordVerification(CONV, ci({ ok: true, summary: "Verify — passed" }));
    const section = proofSection(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }))!;
    expect(section).not.toContain("Test suite, linter and build commands");
    expect(section).not.toContain("The repository's CI on this branch");
    // Nothing type-checked the workspace, so that caveat has to stay. The
    // line is derived per kind, not deleted wholesale.
    expect(section).toContain("The workspace type check");
  });
});

describe("execution evidence (run_command and CI)", () => {
  it("keeps every kind, in a stable cheapest-first order", () => {
    recordVerification(CONV, typecheck());
    recordVerification(CONV, command());
    recordVerification(CONV, ci());
    expect(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }).map((e) => e.kind)).toEqual([
      "typecheck",
      "command",
      "ci",
    ]);
  });

  it("describes a command as one that ran on the user's machine", () => {
    recordVerification(CONV, command({ ok: true, summary: "`npm test` exited 0" }));
    const lines = verificationLines(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }));
    expect(lines[0]).toContain("your machine");
  });

  it("warns the gate when a command failed on the current revision", () => {
    recordVerification(
      CONV,
      command({ ok: false, summary: "`npm test` exited 1", details: ["FAIL src/a.test.ts"] })
    );
    const warnings = verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("FAIL src/a.test.ts");
    expect(warnings[0]!.message).toContain("Do not merge this as a fix");
  });

  it("warns the gate when a CI pass no longer describes the diff", () => {
    recordVerification(CONV, ci({ ok: true, summary: "Verify — passed" }));
    const warnings = verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 51 }));
    expect(warnings[0]!.message).toContain("workspace has changed since");
  });

  it("stays quiet about a fresh command pass, because evidence is not a nag", () => {
    recordVerification(CONV, command({ ok: true, summary: "`npm test` exited 0" }));
    expect(verificationWarnings(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }))).toEqual([]);
  });
});

// ============================================================
// Evidence Belongs To A Repository, Not Just A Thread
// ============================================================
// The ledger keyed evidence by conversation and judged freshness against the
// workspace's own `updatedAt`. Both of those describe a THREAD — and a thread
// can change repository. So a run made against one repository could be read as
// current proof about another, and the push gate would say "verified" over code
// nobody had run anything against. That is the sharpest failure in this family:
// not a pane showing the wrong app, but a merge approved on the wrong evidence.

const REF_A: RepoRef = { owner: "acme", repo: "storefront", branch: "main" };
const REF_B: RepoRef = { owner: "acme", repo: "billing", branch: "main" };

describe("verification ledger — evidence is per binding", () => {
  beforeEach(() => {
    clearVerification();
    resetBindings();
  });

  it("reads a run recorded on another repository as stale at the SAME revision", () => {
    // The revision is deliberately identical: the workspace's updatedAt is a
    // per-thread number, and a chat that moved repository can present the same
    // one. Only the binding distinguishes the two.
    return (async () => {
      await setAttachment(CONV, REF_A);
      recordVerification(CONV, typecheck({ ok: true, workspaceUpdatedAt: 50 }));
      expect(
        verificationEvidence(CONV, { workspaceUpdatedAt: 50 }).map((e) => e.status)
      ).toEqual(["fresh-pass"]);

      await setAttachment(CONV, REF_B);
      expect(
        verificationEvidence(CONV, { workspaceUpdatedAt: 50 }).map((e) => e.status)
      ).toEqual(["stale"]);
    })();
  });

  it("does not raise the gate on a pass that describes another repository", () => {
    return (async () => {
      await setAttachment(CONV, REF_A);
      recordVerification(CONV, command({ ok: true, summary: "`npm test` exited 0" }));
      await setAttachment(CONV, REF_B);
      const evidence = verificationEvidence(CONV, { workspaceUpdatedAt: 50 });
      // It says out loud that the result is about older code, rather than
      // staying silent — silence is what a reader fills in as "fine".
      expect(verificationLines(evidence)[0]).toContain("does not describe the current code");
      expect(verificationWarnings(evidence)[0]!.message).toContain("workspace has changed since");
    })();
  });

  it("drops a binding's evidence when a push moves its base", () => {
    // A push changes the code underneath, so every entry describes a parent
    // commit. `base.moved` is what says so, and the registry is what hears it.
    return (async () => {
      await setAttachment(CONV, REF_A);
      recordVerification(CONV, typecheck({ ok: true, workspaceUpdatedAt: 50 }));
      expect(verificationEvidence(CONV, { workspaceUpdatedAt: 50 })).toHaveLength(1);

      await pinBase(CONV, REF_A, "sha-after-the-push");
      expect(verificationEvidence(CONV, { workspaceUpdatedAt: 50 })).toEqual([]);
    })();
  });

  it("keeps evidence for a thread that merely detached and came back", () => {
    return (async () => {
      await setAttachment(CONV, REF_A);
      recordVerification(CONV, typecheck({ ok: true, workspaceUpdatedAt: 50 }));
      // Detaching and re-attaching the SAME repository is the same binding, so
      // it is the same code — and the evidence is still about it.
      await clearAttachment(CONV);
      await setAttachment(CONV, REF_A);
      expect(
        verificationEvidence(CONV, { workspaceUpdatedAt: 50 }).map((e) => e.status)
      ).toEqual(["fresh-pass"]);
    })();
  });
});

describe("the browser workspace kind", () => {
  // A browser workspace and the user's machine both answer "did the suite pass",
  // and they are not the same claim: one is a WASM runtime in a tab, the other is
  // the environment the code will actually run in. The ledger keeps them apart so
  // a reviewer can tell which one produced a green.

  it("is its own kind, ordered between the type check and the user's machine", () => {
    recordVerification(CONV, typecheck());
    recordVerification(CONV, command({ kind: "workspace", summary: "`npm test` exited 0 in the browser workspace" }));
    expect(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }).map((e) => e.kind)).toEqual([
      "typecheck",
      "workspace",
    ]);
    expect(VERIFICATION_KIND_LABEL.workspace).toMatch(/browser workspace/);
  });

  it("counts as a run of the suite in the pull request's proof section", () => {
    recordVerification(CONV, command({ kind: "workspace", summary: "`npm test` exited 0 in the browser workspace" }));
    const section = proofSection(verificationEvidence(CONV, { workspaceUpdatedAt: 50 }));
    expect(section).toContain("browser workspace");
    // The caveat is DERIVED: something did run the commands, so saying otherwise
    // would undersell the evidence the PR carries.
    expect(section).not.toContain("Test suite, linter and build commands");
  });
});
