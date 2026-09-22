// ============================================================
// Tool Profiles — Surface Selection Tests
// ============================================================

import { describe, it, expect } from "vitest";
import { LEAN_TOOL_NAMES, needsLeanProfile, resolveToolProfile } from "./tool-profiles";
import { getToolMeta } from "./tool-registry";
import type { ModelInfo } from "../types";

const full: ModelInfo = { id: "big", name: "Big", contextLength: 200_000, isFree: false };
const small: ModelInfo = { id: "small", name: "Small", contextLength: 32_000, isFree: false };
const free: ModelInfo = { id: "free", name: "Free", contextLength: 131_000, isFree: true };

describe("needsLeanProfile", () => {
  it("is false for a large paid model", () => {
    expect(needsLeanProfile(full)).toBe(false);
  });

  it("is true for a small window", () => {
    expect(needsLeanProfile(small)).toBe(true);
  });

  it("is true for any free model, whatever its window", () => {
    expect(needsLeanProfile(free)).toBe(true);
  });

  it("does not treat missing metadata as weakness", () => {
    expect(needsLeanProfile(undefined)).toBe(false);
    expect(needsLeanProfile({ id: "x", name: "X" })).toBe(false);
  });
});

describe("resolveToolProfile", () => {
  it("gives a capable model the whole surface", () => {
    const profile = resolveToolProfile("build", full);
    expect(profile.id).toBe("full");
    expect(profile.tools.length).toBeGreaterThan(10);
    expect(profile.note).toBe("");
  });

  it("gives a weak model the lean surface only", () => {
    const profile = resolveToolProfile("build", small);
    expect(profile.id).toBe("lean");
    const names = profile.tools.map((t) => t.function.name);
    expect(names).toEqual(LEAN_TOOL_NAMES.filter((n) => names.includes(n)));
    expect(names).not.toContain("run_tool_program");
    expect(names).not.toContain("delegate");
    expect(names).toContain("edit_file");
    expect(profile.note).toMatch(/Keep the loop small/);
  });

  it("keeps every lean tool a real registry tool", () => {
    for (const name of LEAN_TOOL_NAMES) {
      expect(getToolMeta(name as never), name).toBeDefined();
    }
  });

  it("narrows to plan-safe tools LAST, so a profile never adds a mutating tool", () => {
    for (const id of ["full", "lean"] as const) {
      const info = id === "lean" ? small : full;
      const names = resolveToolProfile("plan", info).tools.map((t) => t.function.name);
      expect(names).toContain("read_file");
      expect(names).not.toContain("edit_file");
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("push_changes");
      expect(names).not.toContain("remember");
    }
  });

  it("gives a weak model the single-argument task tools but not the program interpreter", () => {
    const names = resolveToolProfile("build", small).tools.map((t) => t.function.name);
    // A one-argument tool that loads task-shaped discipline is exactly what a
    // weak model needs; a schemas-in-schemas tool is not.
    expect(names).toContain("read_skill");
    expect(names).not.toContain("run_tool_program");
  });

  it("declares the observation tools plan-safe", () => {
    for (const name of ["search_workspace", "get_workspace_diff", "run_checks"]) {
      expect(getToolMeta(name as never)?.planSafe, name).toBe(true);
    }
  });

  it("preserves registry order in the lean surface", () => {
    const names = resolveToolProfile("build", small).tools.map((t) => t.function.name);
    const ordered = [...names].sort(
      (a, b) => LEAN_TOOL_NAMES.indexOf(a) - LEAN_TOOL_NAMES.indexOf(b)
    );
    // list_repo_files is first in the registry and first in the lean list
    expect(names[0]).toBe("list_repo_files");
    expect(ordered).toEqual(names);
  });
});
