// ============================================================
// CI Plan — Failing Closed, And Never Calling A Skip A Pass
// ============================================================
// The two ways this tier can lie are both pinned here: dispatching a
// workflow that cannot be dispatched (then waiting for a run that never
// appears), and reading a neutral or skipped run as verification.
// ============================================================

import { describe, expect, it } from "vitest";
import {
  ciWorkflowPaths,
  interpretCiRun,
  parseCiWorkflow,
  planCiVerification,
  type CiRun,
} from "./ci-plan";

const workflow = (path: string, content: string) => ({ path, content });

const ON_PUSH = workflow(
  ".github/workflows/ci.yml",
  ["name: CI", "on:", "  push:", "    branches: [main]", "jobs:", "  test:", "    runs-on: ubuntu-latest"].join("\n")
);

const ON_DISPATCH = workflow(
  ".github/workflows/verify.yml",
  ["name: Verify", "on:", "  workflow_dispatch:", "  schedule:", "    - cron: '0 3 * * *'", "jobs:", "  verify:", "    runs-on: ubuntu-latest", "  lint:", "    runs-on: ubuntu-latest"].join("\n")
);

const ON_DISPATCH_INLINE = workflow(
  ".github/workflows/quick.yaml",
  ["name: Quick", "on: [workflow_dispatch]", "jobs:", "  quick:", "    runs-on: ubuntu-latest"].join("\n")
);

describe("ciWorkflowPaths", () => {
  it("finds workflow files and nothing else", () => {
    const paths = [
      ".github/workflows/ci.yml",
      "nested/.github/workflows/deploy.yaml",
      ".github/workflows/README.md",
      ".github/ISSUE_TEMPLATE/bug.yml",
      "src/a.ts",
    ];
    expect(ciWorkflowPaths(paths)).toEqual([
      ".github/workflows/ci.yml",
      "nested/.github/workflows/deploy.yaml",
    ]);
  });
});

describe("parseCiWorkflow", () => {
  it("reads the name and the jobs", () => {
    const parsed = parseCiWorkflow(ON_DISPATCH);
    expect(parsed.label).toBe("Verify");
    expect(parsed.jobs).toEqual(["verify", "lint"]);
  });

  it("sees a map-form trigger", () => {
    expect(parseCiWorkflow(ON_DISPATCH).dispatchable).toBe(true);
    expect(parseCiWorkflow(ON_DISPATCH).scheduled).toBe(true);
  });

  it("sees a list-form trigger", () => {
    expect(parseCiWorkflow(ON_DISPATCH_INLINE).dispatchable).toBe(true);
  });

  it("does not claim a push-only workflow is dispatchable", () => {
    // Failing CLOSED matters: the alternative is dispatching, then waiting
    // ten minutes for a run that was never created.
    expect(parseCiWorkflow(ON_PUSH).dispatchable).toBe(false);
  });

  it("falls back to the file name when there is no name:", () => {
    expect(parseCiWorkflow(workflow(".github/workflows/x.yml", "on: push")).label).toBe("x.yml");
  });
});

describe("planCiVerification", () => {
  it("refuses without a ref, since CI runs against one", () => {
    const plan = planCiVerification({ workflows: [ON_DISPATCH], ref: "  " });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("no-branch");
  });

  it("refuses when the repository has no workflows", () => {
    const plan = planCiVerification({ workflows: [], ref: "agent/x" });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("no-workflows");
  });

  it("names the missing trigger instead of dispatching a push-only workflow", () => {
    const plan = planCiVerification({ workflows: [ON_PUSH], ref: "agent/x" });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("no-dispatchable-workflow");
      expect(plan.message).toContain("workflow_dispatch");
      expect(plan.candidates).toEqual([".github/workflows/ci.yml"]);
    }
  });

  it("prefers the workflow whose name reads like verification", () => {
    const other = workflow(
      ".github/workflows/release.yml",
      ["name: Release", "on:", "  workflow_dispatch:", "jobs:", "  release:", "    runs-on: ubuntu-latest"].join("\n")
    );
    const plan = planCiVerification({ workflows: [other, ON_DISPATCH], ref: "agent/x" });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.workflow.label).toBe("Verify");
  });

  it("honours a workflow the caller named", () => {
    const plan = planCiVerification({
      workflows: [ON_DISPATCH_INLINE, ON_DISPATCH],
      ref: "agent/x",
      preferredPath: ".github/workflows/quick.yaml",
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.workflow.path).toBe(".github/workflows/quick.yaml");
  });

  it("refuses a preferred workflow that is not there", () => {
    const plan = planCiVerification({
      workflows: [ON_DISPATCH],
      ref: "agent/x",
      preferredPath: ".github/workflows/nope.yml",
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("preferred-not-found");
  });

  it("refuses a named workflow that cannot be dispatched", () => {
    const plan = planCiVerification({
      workflows: [ON_PUSH, ON_DISPATCH],
      ref: "agent/x",
      preferredPath: ".github/workflows/ci.yml",
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("no-dispatchable-workflow");
      // The refusal offers what WOULD work.
      expect(plan.candidates).toEqual([".github/workflows/verify.yml"]);
    }
  });

  it("dispatches on the working branch", () => {
    const plan = planCiVerification({ workflows: [ON_DISPATCH], ref: " agent/fix-thing " });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.ref).toBe("agent/fix-thing");
  });
});

describe("interpretCiRun", () => {
  const run = (over: Partial<CiRun>): CiRun => ({
    id: 42,
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/acme/web/actions/runs/42",
    name: "Verify",
    headBranch: "agent/x",
    createdAt: "2026-09-22T00:00:00Z",
    ...over,
  });

  it("calls a success a pass, and only then is it authoritative", () => {
    const verdict = interpretCiRun(run({}), 1_000);
    expect(verdict.status).toBe("passed");
    expect(verdict.authoritativelyGreen).toBe(true);
    expect(verdict.evidence).toContain("#42");
  });

  it("refuses to call a skipped or neutral run verification", () => {
    // A workflow that skipped every step checked nothing. Reporting it green
    // is the exact false confidence the tier exists to remove.
    for (const conclusion of ["skipped", "neutral"] as const) {
      const verdict = interpretCiRun(run({ conclusion }), 1_000);
      expect(verdict.status).toBe("unknown");
      expect(verdict.authoritativelyGreen).toBe(false);
      expect(verdict.evidence).toContain("NOT verification");
    }
  });

  it("reads a failure as failed", () => {
    const verdict = interpretCiRun(run({ conclusion: "failure" }), 1_000);
    expect(verdict.status).toBe("failed");
    expect(verdict.authoritativelyGreen).toBe(false);
  });

  it("reports a cancelled run as failed, not as pending", () => {
    expect(interpretCiRun(run({ conclusion: "cancelled" }), 1_000).status).toBe("failed");
  });

  it("distinguishes a timeout", () => {
    expect(interpretCiRun(run({ conclusion: "timed_out" }), 1_000).status).toBe("timed-out");
  });

  it("flags a run waiting on a human", () => {
    const verdict = interpretCiRun(run({ conclusion: "action_required" }), 1_000);
    expect(verdict.status).toBe("failed");
    expect(verdict.evidence).toContain("approve");
  });

  it("is neither pass nor fail while the run is going", () => {
    const verdict = interpretCiRun(run({ status: "in_progress", conclusion: null }), 125_000);
    expect(verdict.status).toBe("running");
    expect(verdict.authoritativelyGreen).toBe(false);
    expect(verdict.evidence).toContain("2m");
  });
});
