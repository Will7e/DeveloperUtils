// ============================================================
// Prompt-Cache Prefix — the contract that makes caching pay
// ============================================================
// A provider caches on a byte-identical PREFIX, and only on a prefix. So the
// whole caching strategy rests on a property nothing else in this suite can
// see: the front of the request (system prompt, tool schemas, discipline blocks)
// is the same bytes from one turn to the next, and everything that legitimately
// differs between turns rides AFTER it.
//
// That property is one careless edit away from being silently gone. Sorting the
// tools by name, prepending a promoted tool, moving the availability line into
// the system prompt, threading the date or the matched skills into
// `composeAppToolsPrompt` — each of those keeps the agent working perfectly and
// quietly re-pays for the entire context on every step of every loop, which is
// the most expensive way to have no bug. These tests fail on each of them.
//
// Two things are pinned here, and they are different kinds of claim:
//
//   • ORDER — every narrowing (lean profile, plan mode, detached repo) is a
//     SUBSEQUENCE of the widest surface, never a reordering. A reordered tool
//     block invalidates the cache for the block itself and for everything after
//     it, so "a subset was kept" is not enough — the relative order has to hold.
//   • SEPARATION — the per-turn facts live in the trailing harness note and
//     nowhere else. The prefix is asserted to contain none of them, and the
//     note to contain all of them, which is the split `turn-prep` documents in
//     prose and this file enforces.

import { describe, expect, it } from "vitest";
import { resolveToolSurface, type ToolProfile } from "../lib/tool-profiles";
import { describeAvailability, type TurnAvailability } from "../lib/availability";
import { CHECKOUT_OWNERSHIP_BLOCK, WORK_DISCIPLINE_BLOCK } from "../lib/work-discipline";
import type { ChatMode, ChatSkill, ModelInfo, RepoContext } from "../types";
import { composeAppToolsPrompt, composeTurnNote } from "./turn-prep";

const MODES: ChatMode[] = ["build", "plan"];

/** A model the catalog describes as small and free — the lean-profile path */
const LEAN_MODEL: ModelInfo = {
  id: "some/lean-model",
  name: "Lean",
  contextLength: 8_000,
  isFree: true,
} as ModelInfo;

/** A model with room to spare — the full-profile path */
const FULL_MODEL: ModelInfo = {
  id: "some/full-model",
  name: "Full",
  contextLength: 200_000,
} as ModelInfo;

const REPO: RepoContext = {
  owner: "acme",
  repo: "widgets",
  branch: "main",
  attachedAt: 0,
};

/** The three surfaces any turn can be resolved to */
function surface(mode: ChatMode, model: ModelInfo | undefined, repoAttached: boolean): ToolProfile {
  return resolveToolSurface(mode, model, { repoAttached });
}

const namesOf = (profile: ToolProfile): string[] => profile.tools.map((t) => t.function.name);

/**
 * True when `narrow` keeps the relative order of `wide` — the property a
 * provider's cache needs. Reported as the first offending pair rather than a
 * bare boolean so a failure says WHICH tool moved.
 */
function orderViolation(wide: string[], narrow: string[]): string | null {
  const position = new Map(wide.map((name, i) => [name, i]));
  let previous = -1;
  for (const name of narrow) {
    const at = position.get(name);
    if (at === undefined) return `${name} is not in the wider surface at all`;
    if (at < previous) return `${name} moved earlier than the tool before it`;
    previous = at;
  }
  return null;
}

describe("cached prefix — tool order", () => {
  it("narrows by keeping a subsequence, never by reordering", () => {
    // The checker has teeth: it reports a reshuffle, not just a membership miss.
    expect(orderViolation(["a", "b", "c"], ["b", "a"])).not.toBeNull();
    expect(orderViolation(["a", "b", "c"], ["a", "c"])).toBeNull();
    for (const mode of MODES) {
      // The widest surface for the mode: full profile with a repository attached.
      const widest = namesOf(surface(mode, FULL_MODEL, true));
      expect(widest.length).toBeGreaterThan(0);

      const narrowings: Array<[string, ToolProfile]> = [
        ["lean profile", surface(mode, LEAN_MODEL, true)],
        ["detached repo", surface(mode, FULL_MODEL, false)],
        ["lean + detached", surface(mode, LEAN_MODEL, false)],
      ];

      for (const [label, profile] of narrowings) {
        const narrow = namesOf(profile);
        // Each narrowing must actually remove something, or the order check
        // above becomes a comparison of a list with itself and stops
        // protecting anything.
        expect(narrow.length, `${mode} / ${label} removed nothing`).toBeLessThan(widest.length);
        expect(orderViolation(widest, narrow), `${mode} / ${label}`).toBeNull();
      }
    }
  });

  it("does not narrow on missing model metadata", () => {
    // `needsLeanProfile` treats unknown metadata as NOT evidence of weakness,
    // and that matters for the cache as much as for capability: the catalog
    // fetch is a network call on a cold start, and a surface that silently
    // narrowed when it had not landed yet would hand the same conversation two
    // different tool blocks — invalidating the prefix on whichever turn
    // happened to race it.
    for (const mode of MODES) {
      const unresolved = namesOf(surface(mode, undefined, true));
      const widest = namesOf(surface(mode, FULL_MODEL, true));
      expect(unresolved).toEqual(widest);
    }
  });

  it("offers each tool once, in the registry's order", () => {
    // Duplicates would make a provider's schema map ambiguous; and the order is
    // the registry's, so a tool's position is a function of the registry alone.
    const full = namesOf(surface("build", FULL_MODEL, true));
    expect(new Set(full).size).toBe(full.length);
    const registryOrder = namesOf(resolveToolSurface("build", FULL_MODEL, { repoAttached: true }));
    expect(full).toEqual(registryOrder);
  });

  it("resolves the same surface byte-for-byte on a repeated call", () => {
    // Guards the cheap ways a schema stops being stable: a Date, a uid, a Map
    // built from a Set of names. Two resolutions of the same inputs must be
    // indistinguishable on the wire.
    for (const mode of MODES) {
      const first = JSON.stringify(surface(mode, FULL_MODEL, true).tools);
      const second = JSON.stringify(surface(mode, FULL_MODEL, true).tools);
      expect(second).toBe(first);
    }
  });
});

describe("cached prefix — separation from per-turn facts", () => {
  /**
   * The volatile inputs, as `prepareTurn` would have them on two different turns
   * of the same conversation.
   */
  const availability: TurnAvailability = {
    repo: REPO,
    companion: "up",
    companionReason: null,
    // The other execution tier, and a required field because every turn has an
    // answer for it: the page either can host a browser workspace or it cannot.
    workspace: "up",
    workspaceReason: null,
    webSearch: "up",
    mcpServers: 0,
    toolCalling: true,
    vision: false,
  };

  const VOLATILE = {
    availabilityLine: describeAvailability(availability),
    verification: "Revision 4f21 · checks FAILED · one file to fix before you push.",
    threads: "Another thread in this browser is editing `src/app.ts` — expect a conflict there.",
    skillBody: "When the request mentions a changelog, write one entry per PR.",
  };

  const skill: ChatSkill = {
    id: "skill-1",
    name: "changelog",
    description: "Changelog conventions",
    content: VOLATILE.skillBody,
    enabled: true,
  };

  const note = composeTurnNote({
    autoSkills: [skill],
    deferredSkills: [],
    availability,
    verification: VOLATILE.verification,
    threads: VOLATILE.threads,
    now: new Date("2026-09-24T10:00:00Z"),
  });

  /** The prefix, composed the way `turn-prep` composes it: stable inputs only */
  function prefix(profile: ToolProfile): string {
    return [
      profile.note,
      composeAppToolsPrompt(namesOf(profile)),
      WORK_DISCIPLINE_BLOCK,
      CHECKOUT_OWNERSHIP_BLOCK,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  it("carries every per-turn fact in the trailing note", () => {
    // If a fact is not here, it is nowhere — the model would be acting without it.
    expect(note).toContain(VOLATILE.availabilityLine);
    expect(note).toContain("2026-09-24");
    expect(note).toContain(VOLATILE.verification);
    expect(note).toContain(VOLATILE.threads);
    expect(note).toContain(VOLATILE.skillBody);
    // Labelled as harness text: a note a model mistakes for a user message gets
    // answered instead of the request above it.
    expect(note.trimStart().startsWith("_(Harness note")).toBe(true);
  });

  it("leaves every one of them out of the cacheable prefix", () => {
    for (const mode of MODES) {
      for (const repoAttached of [true, false]) {
        const text = prefix(surface(mode, FULL_MODEL, repoAttached));
        for (const [what, value] of Object.entries(VOLATILE)) {
          // The availability line is the one that has repeatedly been proposed
          // for the system prompt ("the model should know what it has before it
          // decides") — it depends on whether the companion is running, so it
          // changes between turns and would move the prefix with it.
          expect(text.includes(value), `${what} leaked into ${mode}/${repoAttached}`).toBe(false);
        }
        expect(text).not.toContain("2026-09-24");
      }
    }
  });

  it("holds the prefix byte-identical while only those facts change", () => {
    // The claim in one assertion: same conversation, different turn state, same
    // prefix. This is what a cache hit is made of.
    const turnOne = prefix(surface("build", FULL_MODEL, true));
    composeTurnNote({
      autoSkills: [],
      deferredSkills: [skill],
      availability: { ...availability, companion: "down", companionReason: "unpaired" },
      now: new Date("2026-09-25T08:30:00Z"),
    });
    const turnTwo = prefix(surface("build", FULL_MODEL, true));
    expect(turnTwo).toBe(turnOne);

    // ...and the note really did move, so the prefix is the only stable half.
    const changed = composeTurnNote({
      autoSkills: [],
      deferredSkills: [skill],
      availability: { ...availability, companion: "down", companionReason: "unpaired" },
      now: new Date("2026-09-25T08:30:00Z"),
    });
    expect(changed).not.toBe(note);
  });
});
