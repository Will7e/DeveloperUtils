// ============================================================
// Skills — Index, Discovery & Round-trip Tests
// ============================================================
// The skill system has one hard constraint that is easy to break by
// accident: the instruction block must be byte-stable across turns, or
// provider-side prompt caching misses on every message. These tests pin
// that property alongside the discovery behaviour.

import { describe, it, expect } from "vitest";
import {
  buildEffectiveSystemPrompt,
  buildSkillIndex,
  findSkill,
  globToRegExp,
  matchSkills,
  parseSkillFile,
  serializeSkillFile,
  skillFromParsed,
} from "./skills";
import { BUILTIN_SKILLS } from "../constants";
import type { ChatSkill } from "../types";

function skill(over: Partial<ChatSkill> & { id: string }): ChatSkill {
  return {
    name: over.id,
    description: "",
    content: "body",
    enabled: false,
    ...over,
  };
}

describe("buildSkillIndex", () => {
  it("lists loadable skills with their triggers and globs", () => {
    const index = buildSkillIndex([
      skill({ id: "a", name: "Aaa", description: "does aaa", triggers: ["alpha"] }),
      skill({ id: "b", name: "Bbb", globs: ["src/**/*.ts"] }),
    ]);
    expect(index).toContain("**Aaa**");
    expect(index).toContain("does aaa");
    expect(index).toContain("triggers: alpha");
    expect(index).toContain("files: src/**/*.ts");
    expect(index).toContain("`load`");
  });

  it("omits enabled skills — their bodies are already in the prompt", () => {
    expect(buildSkillIndex([skill({ id: "a", enabled: true })])).toBeNull();
  });

  it("returns null when there is nothing to load", () => {
    expect(buildSkillIndex([])).toBeNull();
    expect(buildSkillIndex([skill({ id: "a", content: "   " })])).toBeNull();
  });
});

describe("buildEffectiveSystemPrompt", () => {
  const active = skill({ id: "active", name: "Active", content: "follow me", enabled: true });
  const loadable = skill({ id: "loadable", name: "Loadable", content: "later" });

  it("inlines enabled bodies and lists the rest as an index", () => {
    const prompt = buildEffectiveSystemPrompt("BASE", [active, loadable]);
    expect(prompt).toContain("BASE");
    expect(prompt).toContain("# Active Skills");
    expect(prompt).toContain("follow me");
    expect(prompt).toContain("# Available Skills");
    expect(prompt).toContain("**Loadable**");
    // The loadable body is NOT shipped until asked for.
    expect(prompt).not.toContain("later");
  });

  it("is byte-stable regardless of input order (prompt caching)", () => {
    const a = skill({ id: "aaa", name: "A", content: "one", enabled: true });
    const b = skill({ id: "bbb", name: "B", content: "two", enabled: true });
    const c = skill({ id: "ccc", name: "C" });
    const d = skill({ id: "ddd", name: "D" });
    expect(buildEffectiveSystemPrompt("BASE", [a, b, c, d])).toBe(
      buildEffectiveSystemPrompt("BASE", [d, c, b, a])
    );
  });

  it("can omit the index (non-agent turns)", () => {
    const prompt = buildEffectiveSystemPrompt("BASE", [loadable], { includeIndex: false });
    expect(prompt).toBe("BASE");
  });

  it("returns the bare base prompt when there are no skills at all", () => {
    expect(buildEffectiveSystemPrompt("BASE", [])).toBe("BASE");
    expect(buildEffectiveSystemPrompt("", [])).toBe("");
  });
});

describe("findSkill", () => {
  const skills = [
    skill({ id: "builtin-code-reviewer", name: "Code Reviewer" }),
    skill({ id: "x", name: "Ship It" }),
  ];

  it("finds by id", () => {
    expect(findSkill(skills, "builtin-code-reviewer")?.name).toBe("Code Reviewer");
  });

  it("finds by name case-insensitively", () => {
    expect(findSkill(skills, "code reviewer")?.id).toBe("builtin-code-reviewer");
  });

  it("finds by slugified name", () => {
    expect(findSkill(skills, "code-reviewer")?.id).toBe("builtin-code-reviewer");
  });

  it("falls back to substring, then gives up cleanly", () => {
    expect(findSkill(skills, "ship")?.id).toBe("x");
    expect(findSkill(skills, "nope")).toBeUndefined();
    expect(findSkill(skills, "  ")).toBeUndefined();
  });
});

describe("globToRegExp / matchSkills", () => {
  it("matches a glob across directories", () => {
    expect(globToRegExp("src/**/*.tsx").test("src/a/b/C.tsx")).toBe(true);
    expect(globToRegExp("src/**/*.tsx").test("lib/a.tsx")).toBe(false);
  });

  it("matches a trigger keyword", () => {
    const s = skill({ id: "fix", name: "Fix Failing Build", triggers: ["failing build"] });
    expect(matchSkills("my build fails / why is the failing build red", [s])).toHaveLength(1);
    expect(matchSkills("write me a poem", [s])).toHaveLength(0);
  });

  it("ignores empty text and body-less skills", () => {
    expect(matchSkills("", [skill({ id: "a", triggers: ["x"] })])).toEqual([]);
    expect(matchSkills("x", [skill({ id: "a", content: "", triggers: ["x"] })])).toEqual([]);
  });
});

describe("skill files", () => {
  it("parses triggers and globs from frontmatter", () => {
    const parsed = parseSkillFile(
      "---\nname: Ship It\ndescription: prep\ntriggers: push, ship\nglobs: src/**/*.ts\n---\n\nDo the thing."
    );
    expect(parsed).toEqual({
      name: "Ship It",
      description: "prep",
      content: "Do the thing.",
      triggers: ["push", "ship"],
      globs: ["src/**/*.ts"],
    });
  });

  it("round-trips through serialize → parse", () => {
    const original = {
      ...skill({
        id: "x",
        name: "Ship It",
        description: "prep",
        content: "Do the thing.",
        triggers: ["push", "ship"],
        globs: ["src/**/*.ts"],
      }),
    };
    const parsed = parseSkillFile(serializeSkillFile(original));
    expect(parsed.name).toBe("Ship It");
    expect(parsed.description).toBe("prep");
    expect(parsed.content).toBe("Do the thing.");
    expect(parsed.triggers).toEqual(["push", "ship"]);
    expect(parsed.globs).toEqual(["src/**/*.ts"]);
  });

  it("keeps imported skills disabled and carries their triggers", () => {
    const made = skillFromParsed({
      name: "N",
      description: "D",
      content: "C",
      triggers: ["t"],
      globs: [],
    });
    expect(made.enabled).toBe(false);
    expect(made.triggers).toEqual(["t"]);
    expect(made.globs).toBeUndefined();
  });
});

describe("shipped task-shaped builtins", () => {
  it("each declares triggers and a substantial body", () => {
    const taskShaped = BUILTIN_SKILLS.filter((s) =>
      ["builtin-fix-failing-build", "builtin-verify-before-push", "builtin-add-tests-for-change", "builtin-review-this-diff", "builtin-explore-unknown-repo"].includes(s.id)
    );
    expect(taskShaped).toHaveLength(5);
    for (const s of taskShaped) {
      expect(s.enabled).toBe(false);
      expect(s.triggers?.length).toBeGreaterThan(2);
      expect(s.content.length).toBeGreaterThan(200);
    }
  });

  it("every builtin is discoverable through the index", () => {
    const index = buildSkillIndex(BUILTIN_SKILLS);
    expect(index).not.toBeNull();
    for (const s of BUILTIN_SKILLS) {
      expect(index).toContain(s.name);
    }
  });
});
