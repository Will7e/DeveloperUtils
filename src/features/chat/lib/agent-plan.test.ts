import { describe, expect, it } from "vitest";
import { PlanSpecError, normalizePlan, planProgress, planProgressLine } from "./agent-plan";

const NOW = 1_000;

describe("normalizePlan", () => {
  it("accepts the whole plan and defaults statuses to pending", () => {
    const plan = normalizePlan([{ text: "read the router" }, { text: "add the route", status: "active" }], NOW);
    expect(plan.steps.map((s) => s.status)).toEqual(["pending", "active"]);
    expect(plan.complete).toBe(false);
    expect(plan.updatedAt).toBe(NOW);
    expect(plan.steps[0]?.id).toContain("read-the-router");
  });

  it("accepts { steps: [...] } as well as a bare array", () => {
    const plan = normalizePlan({ steps: [{ text: "one", status: "done" }] }, NOW);
    expect(plan.steps).toHaveLength(1);
    expect(plan.complete).toBe(true);
  });

  it("treats an empty plan as complete rather than an error", () => {
    expect(normalizePlan([], NOW)).toMatchObject({ steps: [], complete: true });
  });

  it("rejects a plan whose steps have no text", () => {
    expect(() => normalizePlan([{ status: "pending" }], NOW)).toThrow(/step 1: needs non-empty "text"/);
  });

  it("rejects an unknown status by name", () => {
    expect(() => normalizePlan([{ text: "x", status: "in-progress" }], NOW)).toThrow(/not one of pending, active, done/);
  });

  it("refuses more than one active step", () => {
    expect(() =>
      normalizePlan([{ text: "a", status: "active" }, { text: "b", status: "active" }], NOW)
    ).toThrow(PlanSpecError);
  });

  it("can never be complete while a step is still running", () => {
    // Completeness is derived from the statuses, so this combination is
    // unrepresentable rather than merely rejected.
    const plan = normalizePlan([{ text: "a", status: "active" }, { text: "b", status: "done" }], NOW);
    expect(plan.complete).toBe(false);
  });

  it("caps a long step text instead of failing the whole plan", () => {
    const plan = normalizePlan([{ text: "x".repeat(500) }], NOW);
    expect(plan.steps[0]?.text.endsWith("…")).toBe(true);
    expect(plan.steps[0]?.text.length).toBeLessThanOrEqual(201);
  });

  it("refuses a plan too long to read", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ text: `step ${i}` }));
    expect(() => normalizePlan(many, NOW)).toThrow(/max 12/);
  });

  it("de-duplicates colliding ids so the UI keys stay unique", () => {
    const plan = normalizePlan([{ text: "same" }, { text: "same" }], NOW);
    expect(new Set(plan.steps.map((s) => s.id)).size).toBe(2);
  });

  it("rejects a payload that is not a plan at all", () => {
    expect(() => normalizePlan("do the thing", NOW)).toThrow(/Provide "steps"/);
  });
});

describe("progress", () => {
  const plan = normalizePlan(
    [
      { text: "read the router", status: "done" },
      { text: "add the route", status: "active" },
      { text: "verify the build" },
    ],
    NOW
  );

  it("counts done steps and finds the current one", () => {
    const p = planProgress(plan);
    expect(p).toMatchObject({ total: 3, done: 1 });
    expect(p.active?.text).toBe("add the route");
    expect(p.next?.text).toBe("add the route");
  });

  it("renders one line a header can hold", () => {
    expect(planProgressLine(plan)).toBe("Step 2 of 3 · add the route");
  });

  it("says so when everything is done", () => {
    const done = normalizePlan([{ text: "a", status: "done" }, { text: "b", status: "done" }], NOW);
    expect(planProgressLine(done)).toBe("All 2 steps done");
  });

  it("handles a missing plan", () => {
    expect(planProgressLine(undefined)).toBe("No plan");
    expect(planProgress(null).total).toBe(0);
  });
});
