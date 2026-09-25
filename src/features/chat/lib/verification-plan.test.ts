// ============================================================
// Verification Plan — The Tier Matrix
// ============================================================
// The property under test is not "the plan renders" but "the recommendation is
// the one that gets the most proof for the least waste". Two ways it can be
// wrong, and both were witnessed in the loop before this existed:
//
//   • recommending a tier that already ran against this revision (a round
//     burned re-running `npm test` on code nobody touched), and
//   • recommending nothing / spinning while a real failure sits in the ledger
//     (the turn reports progress on failing code).
//
// So the cases below are the matrix, stated once each, plus the two sentences
// that must never be swallowed: a fresh failure, and an unverified change.
// ============================================================

import { describe, expect, it } from "vitest";
import {
  planVerification,
  representativeEvidence,
  strongestPass,
  verificationLabel,
  verificationState,
  type VerificationPlanInput,
} from "./verification-plan";
import type {
  VerificationEvidence,
  VerificationKind,
  VerificationStatus,
} from "./verification-ledger";

const BASE: VerificationPlanInput = {
  repoAttached: true,
  hasChanges: true,
  pushed: false,
};

function evidence(
  kind: VerificationKind,
  status: VerificationStatus,
  extra: { ok?: boolean; summary?: string; details?: string[] } = {}
): VerificationEvidence {
  return {
    kind,
    status,
    at: 0,
    workspaceUpdatedAt: 1,
    ageMs: 0,
    ok: status === "fresh-pass",
    summary: `${kind} ${status}`,
    ...extra,
  };
}

describe("planVerification — the tier matrix", () => {
  it("recommends nothing when there is no repository to verify", () => {
    const plan = planVerification({ ...BASE, repoAttached: false });
    expect(plan.recommended).toBeNull();
    expect(plan.steps.every((s) => !s.available)).toBe(true);
    // And says nothing in the note: there is no project and no action to take.
    expect(plan.summary).toBe("");
  });

  it("recommends the real command over the type check when the workspace is up", () => {
    const plan = planVerification({ ...BASE, workspace: "up" });
    expect(plan.recommended?.tier).toBe("workspace");
    expect(plan.recommended?.tool).toBe("run_command");
    // The weakest tier is still OFFERED — it is real, it is just not the pick.
    expect(plan.steps.find((s) => s.tier === "typecheck")?.available).toBe(true);
  });

  it("withholds CI until the change is pushed, and names the push", () => {
    const plan = planVerification(BASE);
    const ci = plan.steps.find((s) => s.tier === "ci");
    expect(ci?.available).toBe(false);
    expect(ci?.needs).toBe("push");
    expect(ci?.blockedBy).toMatch(/pushed/);
  });

  it("prefers CI once the branch is pushed — it is the strongest tier there is", () => {
    const plan = planVerification({ ...BASE, pushed: true });
    expect(plan.recommended?.tier).toBe("ci");
    expect(plan.recommended?.tool).toBe("verify_with_ci");
  });
});

describe("planVerification — evidence against the current revision", () => {
  it("stops recommending a tier that already passed this revision", () => {
    const plan = planVerification({
      ...BASE,
      workspace: "up",
      evidence: [evidence("workspace", "fresh-pass")],
    });
    expect(plan.recommended?.tier).toBe("typecheck");
    expect(plan.alreadyProven).toContain("workspace");
    expect(plan.summary).toMatch(/Do not re-run/);
  });

  it("does not recommend re-running a tier that just FAILED the same revision", () => {
    // Re-running the identical command on unmodified bytes reproduces the same
    // failure. The evidence is stamped with the revision, so the moment the
    // agent edits the file this tier becomes recommendable again — which is the
    // behaviour that makes "fix, then re-run" the honest loop.
    const plan = planVerification({
      ...BASE,
      workspace: "up",
      evidence: [evidence("workspace", "fresh-fail", { ok: false, details: ["2 tests failed"] })],
    });
    expect(plan.recommended?.tier).toBe("typecheck");
    expect(plan.summary).toMatch(/FAILED/);
  });

  it("leads with a fresh failure, quoting the actual failure lines", () => {
    const plan = planVerification({
      ...BASE,
      pushed: true,
      evidence: [
        evidence("ci", "fresh-fail", { ok: false, summary: "workflow failed", details: ["lint: 3 errors", "tsc: 1 error"] }),
      ],
    });
    // The failure block comes before the tier summary it belongs to.
    expect(plan.summary.indexOf("FAILED")).toBeLessThan(plan.summary.indexOf("Strongest tier"));
    expect(plan.summary).toMatch(/lint: 3 errors/);
    expect(plan.summary).toMatch(/do not describe the failure as a limitation/i);
  });

  it("says the reachable tiers are done rather than that nothing can prove anything", () => {
    // The false-negative case: every reachable tier already ran, so there is no
    // recommendation — but "nothing can prove a change this turn" would be a
    // lie that sends the model hunting for a tier it already used.
    const plan = planVerification({
      ...BASE,
      workspace: "up",
      evidence: [
        evidence("typecheck", "fresh-pass"),
        evidence("workspace", "fresh-pass"),
      ],
    });
    expect(plan.recommended).toBeNull();
    expect(plan.summary).toMatch(/already run against this exact revision/);
    expect(plan.summary).not.toMatch(/Nothing can prove a change/);
  });

  it("ignores STALE evidence: it describes code that is no longer here", () => {
    const plan = planVerification({
      ...BASE,
      workspace: "up",
      evidence: [evidence("workspace", "stale")],
    });
    expect(plan.recommended?.tier).toBe("workspace");
    expect(plan.alreadyProven).toEqual([]);
  });
});

describe("planVerification — wording follows what the project declares", () => {
  it("asks for a named command when the project declares no checks", () => {
    const plan = planVerification({ ...BASE, workspace: "up", declaresChecks: false });
    expect(plan.recommended?.proves).toMatch(/name the command/);
  });
});

describe("verificationState — the four states, shared by the chip and the pane", () => {
  it("reports nothing-run when the ledger is empty", () => {
    expect(verificationState([])).toBe("none");
  });

  it("reports stale when something ran and the code has since moved on", () => {
    expect(verificationState([evidence("workspace", "stale")])).toBe("stale");
  });

  it("lets a failure outrank a pass, whichever order they arrived in", () => {
    // The turn that ran the suite, broke it, then re-ran the types: a fresh pass
    // and a fresh failure describe the same bytes, and the safe reading is the
    // failure. A green tick here is how a user stops reading.
    expect(
      verificationState([evidence("workspace", "fresh-fail", { ok: false }), evidence("typecheck", "fresh-pass")])
    ).toBe("fail");
    expect(
      verificationState([evidence("typecheck", "fresh-pass"), evidence("workspace", "fresh-fail", { ok: false })])
    ).toBe("fail");
  });

  it("lets a pass outrank staleness: a stale failure is about older bytes", () => {
    expect(verificationState([evidence("workspace", "stale"), evidence("ci", "fresh-pass")])).toBe("pass");
  });
});

describe("verificationLabel — naming the tier, not just the state", () => {
  it("names the strongest passing tier, not the most recent one", () => {
    // CI ordered after a command run is still the stronger proof, and labelling
    // with the weaker one would understate what is known.
    const label = verificationLabel([
      evidence("typecheck", "fresh-pass"),
      evidence("ci", "fresh-pass"),
      evidence("workspace", "fresh-pass"),
    ]);
    expect(label).toBe("Verified · CI");
  });

  it("falls back to the state word for every non-pass state", () => {
    expect(verificationLabel([])).toBe("Unverified");
    expect(verificationLabel([evidence("ci", "stale")])).toBe("Stale");
    expect(verificationLabel([evidence("ci", "fresh-fail", { ok: false })])).toBe("Checks failed");
  });

  it("ignores a stale pass when choosing the tier to name", () => {
    expect(verificationLabel([evidence("ci", "stale")])).not.toMatch(/CI/);
  });
});

describe("strongestPass", () => {
  it("returns undefined when nothing passed against this revision", () => {
    expect(strongestPass([evidence("ci", "stale")])).toBeUndefined();
  });
});

describe("representativeEvidence — the age a badge shows belongs to its claim", () => {
  it("dates the failure when there is one, even if a stronger tier passed", () => {
    const failing = evidence("typecheck", "fresh-fail", { ok: false });
    const entry = representativeEvidence([evidence("ci", "fresh-pass"), failing]);
    expect(entry).toBe(failing);
  });

  it("dates the strongest pass when nothing failed", () => {
    const ci = evidence("ci", "fresh-pass");
    expect(representativeEvidence([evidence("typecheck", "fresh-pass"), ci])).toBe(ci);
  });

  it("dates the NEWEST run when everything is stale — that is the one to repeat", () => {
    const older = { ...evidence("typecheck", "stale"), at: 10 };
    const newer = { ...evidence("workspace", "stale"), at: 99 };
    expect(representativeEvidence([older, newer])).toBe(newer);
  });

  it("returns undefined for no evidence", () => {
    expect(representativeEvidence([])).toBeUndefined();
  });
});

describe("planVerification — the browser workspace tier", () => {
  // The one tier that can run the project's own commands without a push, and
  // the one the matrix used to be blind to: it once offered only a type check
  // while the app could in fact run the project's own suite in the tab.
  // Under-offering is the safe direction to be wrong in, and it is still
  // wrong — it turns a runnable verification into UNVERIFIED.

  it("is the recommended tier when the workspace is up and nothing is pushed", () => {
    const plan = planVerification({ ...BASE, workspace: "up" });
    const step = plan.steps.find((s) => s.tier === "workspace");
    expect(step?.available).toBe(true);
    expect(step?.tool).toBe("run_command");
    expect(plan.recommended?.tier).toBe("workspace");
  });

  it("says WHY when the page cannot host one, rather than staying silent", () => {
    const plan = planVerification({ ...BASE, workspace: "down" });
    const step = plan.steps.find((s) => s.tier === "workspace");
    expect(step?.available).toBe(false);
    expect(step?.blockedBy).toMatch(/not cross-origin isolated/);
  });

  it("never offers a tier whose support has not been checked", () => {
    // `unknown` is not `up`: a tier promised on a guess is how a model reports a
    // command it never ran.
    const plan = planVerification({ ...BASE, workspace: "unknown" });
    const step = plan.steps.find((s) => s.tier === "workspace");
    expect(step?.available).toBe(false);
    expect(step?.blockedBy).toMatch(/has not been checked/);
    expect(plan.recommended?.tier).toBe("typecheck");
  });

  it("names the workspace tier in the plan block so the model can say where it ran", () => {
    const plan = planVerification({ ...BASE, workspace: "up" });
    expect(plan.summary).toContain("browser workspace");
  });
});
