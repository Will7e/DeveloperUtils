// ============================================================
// Skill Activity — The UI's View Of What A Turn Activated
// ============================================================
// The header card is only as honest as this record, so the properties that
// matter are pinned here: it is per-conversation, it reflects the LATEST turn
// (a turn that matched nothing must clear the previous names rather than let
// them read as current), and it does not churn subscribers when nothing
// visible changed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getSkillActivity,
  recordSkillActivity,
  recordSkillLoaded,
  resetSkillActivity,
  subscribeSkillActivity,
} from "./skill-activity";

beforeEach(() => {
  resetSkillActivity();
});

describe("skill activity", () => {
  it("returns null before any turn has been prepared", () => {
    expect(getSkillActivity("conv-1")).toBeNull();
  });

  it("records the names a turn activated, and reads them back", () => {
    recordSkillActivity("conv-1", { auto: ["Add Tests"], deferred: ["Deep Review"] });
    const activity = getSkillActivity("conv-1");
    expect(activity?.auto).toEqual(["Add Tests"]);
    expect(activity?.deferred).toEqual(["Deep Review"]);
    expect(activity?.at).toBeTypeOf("number");
  });

  it("keeps conversations separate", () => {
    recordSkillActivity("conv-1", { auto: ["A"], deferred: [] });
    recordSkillActivity("conv-2", { auto: ["B"], deferred: [] });
    expect(getSkillActivity("conv-1")?.auto).toEqual(["A"]);
    expect(getSkillActivity("conv-2")?.auto).toEqual(["B"]);
  });

  it("replaces the previous turn rather than merging with it", () => {
    recordSkillActivity("conv-1", { auto: ["Add Tests"], deferred: [] });
    recordSkillActivity("conv-1", { auto: ["Probe An API"], deferred: [] });
    expect(getSkillActivity("conv-1")?.auto).toEqual(["Probe An API"]);
  });

  it("clears the names when a turn activates nothing", () => {
    // The stale-name bug this guards: an empty selection still has to be
    // RECORDED, or the card keeps describing the turn before it.
    recordSkillActivity("conv-1", { auto: ["Add Tests"], deferred: ["Deep Review"] });
    recordSkillActivity("conv-1", { auto: [], deferred: [] });
    expect(getSkillActivity("conv-1")?.auto).toEqual([]);
    expect(getSkillActivity("conv-1")?.deferred).toEqual([]);
  });

  it("copies the arrays it is given, so a caller cannot mutate the record", () => {
    const auto = ["Add Tests"];
    recordSkillActivity("conv-1", { auto, deferred: [] });
    auto.push("Sneaky");
    expect(getSkillActivity("conv-1")?.auto).toEqual(["Add Tests"]);
  });

  it("starts a new turn's record with an empty mid-turn bucket", () => {
    // A freshly prepared turn has not run read_skill yet — the previous
    // turn's mid-turn loads are history, not current state.
    recordSkillActivity("conv-1", { auto: ["Add Tests"], deferred: ["Deep Review"] });
    recordSkillLoaded("conv-1", "Deep Review");
    recordSkillActivity("conv-1", { auto: ["Add Tests"], deferred: ["Deep Review"] });
    expect(getSkillActivity("conv-1")?.loaded).toEqual([]);
  });

  it("records a mid-turn read_skill load into the current turn", () => {
    recordSkillActivity("conv-1", { auto: [], deferred: ["Deep Review"] });
    recordSkillLoaded("conv-1", "Deep Review");
    const activity = getSkillActivity("conv-1");
    expect(activity?.loaded).toEqual(["Deep Review"]);
    expect(activity?.deferred).toEqual(["Deep Review"]);
  });

  it("does not duplicate a skill loaded twice in one turn", () => {
    recordSkillActivity("conv-1", { auto: [], deferred: [] });
    recordSkillLoaded("conv-1", "Deep Review");
    recordSkillLoaded("conv-1", "Deep Review");
    expect(getSkillActivity("conv-1")?.loaded).toEqual(["Deep Review"]);
  });

  it("does not record a mid-turn load without a prepared turn", () => {
    // No record = no turn to attribute the load to (e.g. a resumed session
    // replaying history). Inventing one would misdate the activity.
    recordSkillLoaded("conv-1", "Deep Review");
    expect(getSkillActivity("conv-1")).toBeNull();
  });

  it("notifies subscribers when a mid-turn load changes the record", () => {
    recordSkillActivity("conv-1", { auto: [], deferred: [] });
    const listener = vi.fn();
    const unsubscribe = subscribeSkillActivity(listener);
    recordSkillLoaded("conv-1", "Deep Review");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("notifies subscribers when the record changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSkillActivity(listener);
    recordSkillActivity("conv-1", { auto: ["A"], deferred: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    recordSkillActivity("conv-1", { auto: ["B"], deferred: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the record would render identically", () => {
    // A long conversation prepares a turn on every send; re-rendering the
    // header for an unchanged card would be pure churn.
    recordSkillActivity("conv-1", { auto: ["A"], deferred: ["B"] });
    const listener = vi.fn();
    const unsubscribe = subscribeSkillActivity(listener);
    recordSkillActivity("conv-1", { auto: ["A"], deferred: ["B"] });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("ignores an empty conversation id", () => {
    recordSkillActivity("", { auto: ["A"], deferred: [] });
    expect(getSkillActivity("")).toBeNull();
    expect(getSkillActivity(null)).toBeNull();
    expect(getSkillActivity(undefined)).toBeNull();
  });

  it("forgets everything on reset", () => {
    recordSkillActivity("conv-1", { auto: ["A"], deferred: [] });
    resetSkillActivity();
    expect(getSkillActivity("conv-1")).toBeNull();
  });
});
