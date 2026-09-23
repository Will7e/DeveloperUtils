// ============================================================
// Skills — Index, Discovery & Round-trip Tests
// ============================================================
// The skill system has one hard constraint that is easy to break by
// accident: the instruction block must be byte-stable across turns, or
// provider-side prompt caching misses on every message. These tests pin
// that property alongside the discovery behaviour.

import { describe, it, expect } from "vitest";
import {
  RETIRED_BUILTIN_SKILL_IDS,
  buildEffectiveSystemPrompt,
  buildSkillIndex,
  findSkill,
  globToRegExp,
  matchSkills,
  parseSkillFile,
  reconcileBuiltins,
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

describe("reconcileBuiltins — what the settings modal ends up showing", () => {
  // This had no tests, and that is exactly how a retirement gap survived:
  // the function only ever ADDED, so removing a builtin from the shipped
  // list changed nothing for anyone who had already opened the app — which
  // is everyone. It is the single function that decides what a user sees.
  const retired = RETIRED_BUILTIN_SKILL_IDS[0]!;
  const retiredSkill = {
    id: retired,
    name: "Retired",
    description: "gone",
    content: "old instructions",
    enabled: false,
    builtin: true,
  };
  const userSkill = {
    id: "user-1",
    name: "Mine",
    description: "mine",
    content: "my own",
    enabled: true,
  };

  it("returns null when there is nothing to change", () => {
    // The store reads null as "do not write", so this is a persistence guard.
    expect(reconcileBuiltins(BUILTIN_SKILLS.map((s) => ({ ...s })))).toBeNull();
  });

  it("adds a builtin that is missing locally", () => {
    const result = reconcileBuiltins([])!;
    expect(result.length).toBe(BUILTIN_SKILLS.length);
  });

  it("REMOVES a retired builtin the user never touched", () => {
    const result = reconcileBuiltins([retiredSkill])!;
    expect(result.some((s) => s.id === retired)).toBe(false);
  });

  it("keeps a retired builtin the user explicitly ENABLED", () => {
    // Deleting something a user switched on is the harness overruling their
    // choice, which is worse than one stale index line.
    const result = reconcileBuiltins([{ ...retiredSkill, enabled: true }]);
    expect(result === null || result.some((s) => s.id === retired)).toBe(true);
  });

  it("keeps a retired builtin the user EDITED, because that text is theirs", () => {
    const result = reconcileBuiltins([{ ...retiredSkill, updated: true }]);
    expect(result === null || result.some((s) => s.id === retired)).toBe(true);
  });

  it("never touches a skill the user wrote", () => {
    const result = reconcileBuiltins([{ ...userSkill, id: retired }]);
    // Same id, but not a builtin: not ours to remove.
    expect(result === null || result.some((s) => s.id === retired)).toBe(true);
  });

  it("keeps every user skill alongside the shipped ones", () => {
    const result = reconcileBuiltins([userSkill])!;
    expect(result.some((s) => s.id === "user-1")).toBe(true);
  });

  it("adopts a changed shipped default for a builtin the user never touched", () => {
    // A skill the product promotes to on-by-default has to reach the
    // installs that already exist, or the decision only applies to people
    // who had never opened the app.
    const stored = BUILTIN_SKILLS.map((s) => ({ ...s, enabled: false }));
    const result = reconcileBuiltins(stored)!;
    for (const shipped of BUILTIN_SKILLS) {
      expect(result.find((r) => r.id === shipped.id)!.enabled, shipped.id).toBe(shipped.enabled);
    }
  });

  it("never overrules a user who switched a builtin off", () => {
    // `updated` is stamped on ANY patch to a builtin, a plain toggle
    // included, so a switched-off skill is a choice and stays switched off.
    const stored = BUILTIN_SKILLS.map((s) => ({ ...s, enabled: false, updated: true }));
    expect(reconcileBuiltins(stored)).toBeNull();
  });

  it("has no retired id left in the shipped set", () => {
    // Consistency guard: re-adding a retired id would ship a skill that is
    // immediately deleted on load.
    for (const id of RETIRED_BUILTIN_SKILL_IDS) {
      expect(BUILTIN_SKILLS.some((s) => s.id === id), id).toBe(false);
    }
  });

  it("ships a tightened set: every remaining builtin is about this agent's job", () => {
    // Four generic prompt modules and three duplicates were retired. The
    // count is pinned so a future "just add a skill" change has to argue
    // with a test rather than slip in.
    //
    // 7 → 8: Research Outside The Repo. It earns the line by the same rule
    // the retirements were made under — it is a job this agent does with a
    // tool it has (fetch_url), and the tool needs a WHEN: a model that does
    // not know to check a dependency's docs recalls them instead, which is
    // the failure the tool was added to remove.
    // 8 → 9: Finish The Job. Same rule, applied to the loop itself: the
    // agent that stops with its own plan half open is the failure the
    // completion gate (lib/completion-gate.ts) exists to catch, and the
    // harness needs the model working with it rather than against it.
    //
    // 9 → 16: the workstation's own features, one skill per app tool
    // (run_code, format_code, compare_data, diff_text, search_library,
    // http_request/http_write, create_diagram, open_in_tool). They clear the
    // same bar the retirements were made under, and clear it harder: each is
    // a job this agent does with a tool it has, the tool needs a WHEN, and
    // "what a green result does not prove" is exactly the judgement a model
    // supplies wrongly on its own — the failure mode is a confident "tests
    // pass" derived from a snippet that exited 0. They are also the only
    // skills that apply in a chat with no repository attached, which is now
    // the configuration where the app tools are the whole surface.
    expect(BUILTIN_SKILLS.length).toBe(16);
  });
});

describe("the shipped verification skill", () => {
  // The tiers exist (`run_command`, `verify_with_ci`) and the audit enforces
  // them, but a tool the model does not know WHEN to reach for is a tool it
  // will not use. The skill is the part that turns availability into habit,
  // so its discoverability is pinned rather than assumed.
  const skill = BUILTIN_SKILLS.find((s) => s.id === "builtin-verification-discipline");

  it("ships as a builtin, ON by default — the contract is not a lookup", () => {
    // It used to be off, on the theory that the model would load it when a
    // task looked like verification work. The theory lost: a model that
    // has to remember to load the honesty rules is a model that asserts
    // instead of verifying, which is the failure the skill describes.
    expect(skill).toBeTruthy();
    expect(skill!.enabled).toBe(true);
    expect(skill!.content.trim().length).toBeGreaterThan(200);
  });

  it("is discovered by the words a user actually types", () => {
    // "Still broken" is the moment the discipline matters most, and it is
    // not the word "verify".
    for (const phrase of ["verify this", "still broken", "run the tests", "npm test", "it fails"]) {
      expect(matchSkills(phrase, [skill!]).length, phrase).toBe(1);
    }
  });

  it("is injected as an active body, not left for the model to look up", () => {
    // The index exists for the skills that are NOT loaded. An enabled skill
    // rides in the prompt itself, so it must not ALSO sit in the index
    // advertising a body the model would then fetch a second time.
    expect(buildEffectiveSystemPrompt("", [skill!])).toContain("Verification Discipline");
    expect(buildSkillIndex([skill!])).toBeNull();
  });

  it("names every tier, so the model picks one instead of guessing", () => {
    for (const tool of ["run_checks", "run_command", "verify_with_ci"]) {
      expect(skill!.content).toContain(tool);
    }
    // And the two rules that stop a summary from lying.
    expect(skill!.content).toContain("UNVERIFIED");
    expect(skill!.content).toContain("authoritativelyGreen");
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

  it("every builtin reaches the model, active or loadable", () => {
    const prompt = buildEffectiveSystemPrompt("base", BUILTIN_SKILLS);
    const index = buildSkillIndex(BUILTIN_SKILLS);
    expect(index).not.toBeNull();
    for (const s of BUILTIN_SKILLS) {
      // Enabled skills are injected as a body; loadable ones are advertised
      // in the index. A shipped skill in NEITHER is a skill nobody can use,
      // which is the bug this replaced test could no longer see once the
      // first builtins shipped enabled.
      const reachable = s.enabled
        ? prompt.includes(`### Skill: ${s.name}`)
        : index!.includes(s.name);
      expect(reachable, s.id).toBe(true);
    }
  });
});

describe("the shipped persistence skill", () => {
  const skill = BUILTIN_SKILLS.find((s) => s.id === "builtin-persistence-discipline");

  it("ships ON: finishing the job is not a setting the model has to find", () => {
    expect(skill).toBeTruthy();
    expect(skill!.enabled).toBe(true);
    expect(skill!.content.trim().length).toBeLessThan(1_500);
  });

  it("states the contract: finish, keep the plan honest, stop only for a reason", () => {
    for (const phrase of [
      "not done when you stop talking",
      "update_plan",
      "FAILED",
      "Stop early only for a real reason",
    ]) {
      expect(skill!.content, phrase).toContain(phrase);
    }
  });

  it("is discovered by the words a frustrated user types", () => {
    for (const phrase of ["continue", "keep going", "you stopped", "finish the job"]) {
      expect(matchSkills(phrase, [skill!]).length, phrase).toBe(1);
    }
  });
});
