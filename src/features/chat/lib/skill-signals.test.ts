// ============================================================
// Skill Signals — Environment-Triggered Selection Tests
// ============================================================
// The invariants the turn depends on: user matches keep priority over
// environment matches, the caps cannot be doubled by matching two
// sources, a body injected on an earlier round is never re-paid, and an
// enabled skill is never injected twice (it already lives in the cached
// system prompt).

import { describe, it, expect } from "vitest";
import {
  renderEnvironmentSignals,
  renderSignalSkillBlock,
  selectAutoSkillsFromSignals,
} from "./skill-signals";
import type { ChatSkill } from "../types";

function skill(over: Partial<ChatSkill> & { id: string; name: string }): ChatSkill {
  return {
    description: "",
    content: "body text",
    enabled: false,
    ...over,
  } as ChatSkill;
}

const debug = skill({
  id: "s-debug",
  name: "Debug A Failing Build",
  triggers: ["npm test", "typecheck"],
  content: "debug steps",
});
const tests = skill({
  id: "s-tests",
  name: "Add Tests For Change",
  // `**` crosses directories: `*.test.ts` alone stays within one path
  // segment, so "src/parser.test.ts" would not match it.
  globs: ["**/*.test.ts", "**/*.spec.ts", "*.test.ts"],
  content: "test steps",
});
const web = skill({
  id: "s-web",
  name: "Research A Dependency",
  triggers: ["docs", "changelog"],
  content: "web steps",
});

describe("renderEnvironmentSignals", () => {
  it("renders each signal class on its own line", () => {
    const text = renderEnvironmentSignals({
      failingChecks: ["`npm test` exited 1 — 2 failed"],
      changedPaths: ["src/a.ts", "src/a.test.ts"],
      previewErrors: ["TypeError: x is not a function"],
    });
    expect(text).toContain("failing check: `npm test` exited 1 — 2 failed");
    expect(text).toContain("  src/a.test.ts");
    expect(text).toContain("runtime error: TypeError: x is not a function");
  });

  it("renders changed paths independently of failing checks", () => {
    const text = renderEnvironmentSignals({
      failingChecks: [],
      changedPaths: ["src/b.test.ts"],
      previewErrors: [],
    });
    expect(text).toContain("src/b.test.ts");
  });

  it("is empty when nothing happened", () => {
    const text = renderEnvironmentSignals({
      failingChecks: [],
      changedPaths: [],
      previewErrors: [],
    });
    expect(text).toBe("");
  });
});

describe("selectAutoSkillsFromSignals", () => {
  it("loads from the user's message", () => {
    const { loaded, deferred } = selectAutoSkillsFromSignals(
      "run npm test and fix it",
      "",
      [debug, tests]
    );
    expect(loaded.map((s) => s.name)).toContain("Debug A Failing Build");
    expect(deferred.map((s) => s.name)).not.toContain("Debug A Failing Build");
  });

  it("loads from the environment when the message matched nothing", () => {
    const { loaded } = selectAutoSkillsFromSignals(
      "please look into it",
      "failing check: `npm test` exited 1",
      [debug, tests]
    );
    expect(loaded.map((s) => s.name)).toContain("Debug A Failing Build");
  });

  it("matches skill globs against changed file paths, one path at a time", () => {
    // The glob regexes are ^…$ anchored, so paths must be matched
    // individually — a whole-list blob never fires a globs skill.
    const { loaded } = selectAutoSkillsFromSignals(
      "ship it",
      "changed files:\n  src/parser.test.ts",
      [debug, tests, web],
      [],
      { environmentPaths: ["src/parser.test.ts"] }
    );
    expect(loaded.map((s) => s.name)).toContain("Add Tests For Change");
  });

  it("user matches keep priority over environment matches under the cap", () => {
    const a = skill({ id: "s-a", name: "Aaa", triggers: ["alpha"] });
    const b = skill({ id: "s-b", name: "Bbb", triggers: ["beta"] });
    const c = skill({ id: "s-c", name: "Ccc", triggers: ["gamma"] });
    // Two match from the user's message, one from the environment; with a
    // cap of 2 the environment match is the one that defers.
    const { loaded, deferred } = selectAutoSkillsFromSignals(
      "alpha and beta",
      "gamma",
      [a, b, c],
      [],
      { max: 2 }
    );
    expect(loaded.map((s) => s.name)).toEqual(["Aaa", "Bbb"]);
    expect(deferred.map((s) => s.name)).toEqual(["Ccc"]);
  });

  it("does not double-count one skill matched by both sources", () => {
    const { loaded } = selectAutoSkillsFromSignals(
      "run npm test",
      "failing check: `npm test` exited 1",
      [debug, tests]
    );
    expect(loaded.filter((s) => s.id === "s-debug")).toHaveLength(1);
  });

  it("excludes prior-loaded skills and reports them as alreadyActive", () => {
    const { loaded, alreadyActive } = selectAutoSkillsFromSignals(
      "run npm test",
      "failing check: `npm test` exited 1",
      [debug],
      ["Debug A Failing Build"]
    );
    expect(loaded).toEqual([]);
    expect(alreadyActive).toEqual(["Debug A Failing Build"]);
  });

  it("excludes enabled skills — they already ride the system prompt", () => {
    const on = skill({ id: "s-on", name: "Always On", triggers: ["npm test"], enabled: true });
    const { loaded } = selectAutoSkillsFromSignals("run npm test", "", [on]);
    expect(loaded).toEqual([]);
  });

  it("a skill over the char budget defers rather than suppressing smaller matches", () => {
    const huge = skill({
      id: "s-huge",
      name: "Huge",
      triggers: ["alpha"],
      content: "x".repeat(10_000),
    });
    const small = skill({ id: "s-small", name: "Small", triggers: ["beta"] });
    const { loaded, deferred } = selectAutoSkillsFromSignals(
      "alpha and beta",
      "",
      [huge, small]
    );
    expect(loaded.map((s) => s.name)).toEqual(["Small"]);
    expect(deferred.map((s) => s.name)).toEqual(["Huge"]);
  });
});

describe("renderSignalSkillBlock", () => {
  it("renders fresh bodies as active instructions", () => {
    const block = renderSignalSkillBlock({
      loaded: [debug],
      deferred: [],
      alreadyActive: [],
    });
    expect(block).toContain("ALREADY ACTIVE");
    expect(block).toContain("### Skill: Debug A Failing Build");
  });

  it("names prior bodies without re-rendering them", () => {
    const block = renderSignalSkillBlock({
      loaded: [],
      deferred: [],
      alreadyActive: ["Debug A Failing Build"],
    });
    expect(block).toContain("still in force from earlier in this turn");
    expect(block).toContain("Debug A Failing Build");
    expect(block).not.toContain("### Skill:");
  });

  it("renders nothing when nothing is in play", () => {
    const block = renderSignalSkillBlock({
      loaded: [],
      deferred: [],
      alreadyActive: [],
    });
    expect(block).toBe("");
  });
});
