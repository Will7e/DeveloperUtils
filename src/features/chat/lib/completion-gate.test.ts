// ============================================================
// Completion Gate — regression tests
// ============================================================
// The property that matters is that the gate is TIGHT. A gate that fires
// on an honest stop trains the model (and the user) to ignore it, so most
// of these cases are about what must NOT count as unfinished: chat mode,
// plan mode, an aborted turn, a cleared plan, a stale result, and a pass.

import { describe, expect, it } from "vitest";
import {
  completionNudge,
  completionSummary,
  describeReason,
  evaluateCompletion,
  type CompletionInput,
} from "./completion-gate";
import type { VerificationEvidence, VerificationKind } from "./verification-ledger";
import type { AgentPlan, PlanStatus } from "../types";

function plan(steps: Array<[string, PlanStatus]>): AgentPlan {
  const built = steps.map(([text, status], i) => ({ id: `s${i}`, text, status }));
  return { steps: built, updatedAt: 1, complete: built.every((s) => s.status === "done") };
}

function evidence(
  kind: VerificationKind,
  status: VerificationEvidence["status"],
  over: Partial<VerificationEvidence> = {}
): VerificationEvidence {
  return {
    kind,
    at: 1_000,
    workspaceUpdatedAt: 7,
    ok: status === "fresh-pass",
    summary: "`npm test` exited 0 in 812ms",
    status,
    ageMs: 4_000,
    ...over,
  };
}

function input(over: Partial<CompletionInput> = {}): CompletionInput {
  return { evidence: [], agentTools: true, aborted: false, ...over };
}

// ============================================================
// The one rule that reaches past "unfinished" into "not proven"
// ============================================================
// `untested-change` fires only where the agent demonstrably COULD write the
// test: a green test command is in the evidence. Every condition below is a way
// of NOT firing, because a gate that asks for a test the turn had no way to run
// is the kind of nudge that teaches everyone to ignore the gate.

describe("untested-change — source changed while the suite went green", () => {
  const testRun = [evidence("command", "fresh-pass", { summary: "`npm test` exited 0 in 2100ms" })];
  const changed = (paths: Array<[string, string]>) =>
    paths.map(([path, status]) => ({ path, status }));

  it("fires when source changed, the suite is green, and no test did", () => {
    const verdict = evaluateCompletion(
      input({ evidence: testRun, changeSet: changed([["src/api.ts", "modified"]]), projectHasTests: true })
    );
    expect(verdict.complete).toBe(false);
    const reason = !verdict.complete ? verdict.reasons.find((r) => r.kind === "untested-change") : undefined;
    expect(reason).toBeDefined();
    if (reason?.kind === "untested-change") {
      expect(reason.files).toEqual(["src/api.ts"]);
      expect(reason.run).toBe("npm test");
      expect(describeReason(reason)).toContain("src/api.ts");
    }
    expect(!verdict.complete && verdict.summary).toMatch(/npm test/);
  });

  it("stays silent when a test file changed with it", () => {
    const verdict = evaluateCompletion(
      input({
        evidence: testRun,
        changeSet: changed([
          ["src/api.ts", "modified"],
          ["src/api.test.ts", "modified"],
        ]),
        projectHasTests: true,
      })
    );
    expect(verdict.complete).toBe(true);
  });

  it("stays silent when no test command ran, because the agent could not run one", () => {
    const verdict = evaluateCompletion(
      input({
        // A type check is not a test run: it proves the code compiles, not that
        // its behaviour is covered — and it does not tell us the agent could
        // have written a test it never ran.
        evidence: [evidence("typecheck", "fresh-pass", { summary: "0 errors across 41 file(s)" })],
        changeSet: changed([["src/api.ts", "modified"]]),
        projectHasTests: true,
      })
    );
    expect(verdict.complete).toBe(true);
  });

  it("stays silent when the test run FAILED (that is the check-failing rule)", () => {
    const verdict = evaluateCompletion(
      input({
        evidence: [evidence("command", "fresh-fail", { ok: false, summary: "`npm test` exited 1 in 2100ms" })],
        changeSet: changed([["src/api.ts", "modified"]]),
        projectHasTests: true,
      })
    );
    expect(!verdict.complete && verdict.reasons.map((r) => r.kind)).toEqual(["check-failing"]);
  });

  it("stays silent for documentation and manifest changes", () => {
    const verdict = evaluateCompletion(
      input({
        evidence: testRun,
        changeSet: changed([
          ["README.md", "modified"],
          ["docs/usage.mdx", "added"],
          ["package.json", "modified"],
        ]),
        projectHasTests: true,
      })
    );
    expect(verdict.complete).toBe(true);
  });

  it("stays silent for a deletion, which is its own proof", () => {
    const verdict = evaluateCompletion(
      input({
        evidence: testRun,
        changeSet: changed([["src/dead-code.ts", "deleted"]]),
        projectHasTests: true,
      })
    );
    expect(verdict.complete).toBe(true);
  });

  it("stays silent when the project has no tests at all", () => {
    const verdict = evaluateCompletion(
      input({
        evidence: testRun,
        changeSet: changed([["src/api.ts", "modified"]]),
        projectHasTests: false,
      })
    );
    expect(verdict.complete).toBe(true);
  });

  it("stays silent with no workspace to judge", () => {
    const verdict = evaluateCompletion(input({ evidence: testRun }));
    expect(verdict.complete).toBe(true);
  });

  it("does not mistake a test-shaped file path in a command for a test run", () => {
    // "test" appears in branch names, file paths and script names. The rule
    // matches the COMMAND the agent ran, so a build that merely mentions a test
    // path is not evidence that tests ran.
    const verdict = evaluateCompletion(
      input({
        evidence: [evidence("command", "fresh-pass", { summary: "`npm run build` exited 0 in 2100ms" })],
        changeSet: changed([["src/api.ts", "modified"]]),
        projectHasTests: true,
      })
    );
    expect(verdict.complete).toBe(true);
  });

  it("names the test in the nudge, so the model knows what was green", () => {
    const nudge = completionNudge([
      { kind: "untested-change", files: ["src/api.ts"], run: "npx vitest run" },
    ]);
    expect(nudge).toContain("npx vitest run");
    expect(nudge).toMatch(/must fail without your change/);
  });
});

describe("evaluateCompletion — what counts as finished", () => {
  it("never gates a turn the user stopped", () => {
    const verdict = evaluateCompletion(
      input({
        aborted: true,
        plan: plan([["wire the route", "active"]]),
        evidence: [evidence("command", "fresh-fail", { ok: false })],
      })
    );
    expect(verdict.complete).toBe(true);
  });

  it("never gates a turn with no write tools", () => {
    // Chat mode and plan mode: the prose IS the deliverable, and the
    // plan is the artifact the user asked for.
    const verdict = evaluateCompletion(
      input({
        agentTools: false,
        plan: plan([["write the plan", "active"]]),
        evidence: [evidence("command", "fresh-fail", { ok: false })],
      })
    );
    expect(verdict.complete).toBe(true);
  });

  it("is complete when the agent made no promises and nothing failed", () => {
    expect(evaluateCompletion(input()).complete).toBe(true);
  });
});

describe("evaluateCompletion — the agent's own plan", () => {
  it("refuses to finish with a step still open", () => {
    const verdict = evaluateCompletion(
      input({
        plan: plan([
          ["read the router", "done"],
          ["wire the new route", "active"],
          ["update the docs", "pending"],
        ]),
      })
    );
    expect(verdict.complete).toBe(false);
    if (verdict.complete) return;
    expect(verdict.reasons).toEqual([
      {
        kind: "plan-unfinished",
        stepIndex: 2,
        stepCount: 3,
        step: "wire the new route",
      },
    ]);
  });

  it("falls back to the next pending step when none is active", () => {
    const verdict = evaluateCompletion(
      input({ plan: plan([["one", "done"], ["two", "pending"]]) })
    );
    expect(verdict.complete).toBe(false);
    if (verdict.complete) return;
    expect(verdict.reasons[0]).toMatchObject({ stepIndex: 2, step: "two" });
  });

  it("is complete when every step is done", () => {
    const verdict = evaluateCompletion(input({ plan: plan([["a", "done"], ["b", "done"]]) }));
    expect(verdict.complete).toBe(true);
  });

  it("is complete when the plan was cleared", () => {
    // update_plan with no steps is the documented "nothing to do / I am
    // done" signal, and the model's way out of the gate.
    const verdict = evaluateCompletion(input({ plan: plan([]) }));
    expect(verdict.complete).toBe(true);
  });
});

describe("evaluateCompletion — recorded evidence", () => {
  it("refuses to finish over a failure recorded against the current code", () => {
    const verdict = evaluateCompletion(
      input({
        evidence: [
          evidence("command", "fresh-pass"),
          evidence("command", "fresh-fail", {
            ok: false,
            summary: "`npm test` exited 1 in 900ms",
            details: ["FAIL src/a.test.ts > adds", "1 failing"],
          }),
        ],
      })
    );
    // One entry per kind in the real ledger; the point here is the fail.
    expect(verdict.complete).toBe(false);
    if (verdict.complete) return;
    const reason = verdict.reasons[0]!;
    expect(reason.kind).toBe("check-failing");
    expect(describeReason(reason)).toContain("FAILED");
    expect(describeReason(reason)).toContain("`npm test` exited 1");
    expect(describeReason(reason)).toContain("FAIL src/a.test.ts > adds");
  });

  it("is complete with a stale failure — it describes older code", () => {
    const verdict = evaluateCompletion(
      input({ evidence: [evidence("command", "stale", { ok: false })] })
    );
    expect(verdict.complete).toBe(true);
  });

  it("is complete with a fresh pass", () => {
    const verdict = evaluateCompletion(input({ evidence: [evidence("ci", "fresh-pass")] }));
    expect(verdict.complete).toBe(true);
  });

  it("is NOT gated by absent verification", () => {
    // Editing without running anything is not a broken promise — a
    // one-line rename does not owe the user a build. Only a result that
    // ran and said no is a reason to keep working.
    const verdict = evaluateCompletion(
      input({ plan: plan([["rename the helper", "done"]]) })
    );
    expect(verdict.complete).toBe(true);
  });
});

describe("the wording a stopped turn leaves behind", () => {
  it("reports every open reason, plan first", () => {
    const verdict = evaluateCompletion(
      input({
        plan: plan([["ship it", "active"]]),
        evidence: [evidence("ci", "fresh-fail", { ok: false, summary: "Verify — failed" })],
      })
    );
    if (verdict.complete) throw new Error("expected an unfinished verdict");
    expect(verdict.reasons.map((r) => r.kind)).toEqual(["plan-unfinished", "check-failing"]);
    expect(verdict.summary).toContain("still open");
    expect(verdict.summary).toContain("GitHub Actions");
  });

  it("tells the model to continue, and how to stop deliberately", () => {
    const verdict = evaluateCompletion(input({ plan: plan([["wire it", "active"]]) }));
    if (verdict.complete) throw new Error("expected an unfinished verdict");
    expect(verdict.nudge).toContain("wire it");
    expect(verdict.nudge).toContain("Do not restate");
    // The two exits: ask for a decision, or clear the plan. The question
    // exit names the TOOL, because "ask that question directly" used to be
    // an instruction with nothing to carry it out — which is how a model
    // ends a turn narrating uncertainty instead of parking it.
    expect(verdict.nudge).toContain("update_plan");
    expect(verdict.nudge).toContain("ask_user");
  });

  it("treats a parked question as a deliberate stop, not unfinished work", () => {
    // The model did exactly what the nudge asks for: it asked. Nagging it
    // while the answer is on screen is how a loop learns to guess instead.
    const verdict = evaluateCompletion(
      input({ plan: plan([["wire it", "active"]]), pendingQuestion: true })
    );
    expect(verdict.complete).toBe(true);
  });

  it("keeps the summary to a single line for the notice", () => {
    const reasons = [
      { kind: "plan-unfinished", stepIndex: 1, stepCount: 2, step: "wire it" } as const,
    ];
    expect(completionSummary([...reasons])).not.toContain("\n");
    expect(completionNudge([...reasons])).toContain("\n");
  });
});
