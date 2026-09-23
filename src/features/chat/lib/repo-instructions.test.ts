// ============================================================
// Repo Instructions — What The Repository Gets To Say
// ============================================================
// Two things are worth pinning here. The block must be BYTE-STABLE for a
// given file (it sits in the cached prompt prefix, and a block that varies
// per turn costs real money), and it must state precedence explicitly —
// AGENTS.md is authored by people the user may never have met, so the
// harness's own rules have to win where they conflict.

import { describe, expect, it } from "vitest";
import {
  clearRepoInstructionsCache,
  composeInstructionsBlock,
  ensureRepoInstructions,
  nestedInstructionPaths,
  repoInstructionsCacheKey,
  ROOT_INSTRUCTIONS_MAX_CHARS,
} from "./repo-instructions";
import { releaseScoped, type Transition } from "../identity/scoped-resources";
import type { RepoContext, WorkspaceTreeEntry } from "../types";

/** A `base.moved` for one repository — what a fetched base commit looks like */
function transition(ref: { owner: string; repo: string; branch: string }): Transition {
  return {
    type: "base.moved",
    threadId: "t1",
    previous: null,
    next: null,
    ref,
    baseCommitSha: "sha",
  };
}

const tree: WorkspaceTreeEntry[] = [
  { path: "AGENTS.md", type: "blob" },
  { path: "src/main.ts", type: "blob" },
  { path: "src/features/AGENTS.md", type: "blob" },
  { path: "packages/api/CLAUDE.md", type: "blob" },
];

const repo: RepoContext = { owner: "o", repo: "r", branch: "main", attachedAt: 0 };

describe("composeInstructionsBlock", () => {
  it("puts the repository's prose in and states which rules win", () => {
    const block = composeInstructionsBlock("Run tests with pnpm. Never touch vendor/.", "AGENTS.md", []);
    expect(block).toContain("# Repository Instructions (AGENTS.md)");
    expect(block).toContain("pnpm");
    // Precedence, in the order a weak model reads it.
    expect(block).toMatch(/does not override/);
    expect(block).toMatch(/the user wins/);
  });

  it("is byte-stable for the same file", () => {
    const a = composeInstructionsBlock("Same text.", "AGENTS.md", ["src/AGENTS.md"]);
    const b = composeInstructionsBlock("Same text.", "AGENTS.md", ["src/AGENTS.md"]);
    expect(a).toBe(b);
  });

  it("caps a huge file instead of spending the window on it", () => {
    const block = composeInstructionsBlock("x".repeat(ROOT_INSTRUCTIONS_MAX_CHARS + 500), "AGENTS.md", []);
    expect(block.length).toBeLessThan(ROOT_INSTRUCTIONS_MAX_CHARS + 900);
    expect(block).toContain("[truncated");
  });

  it("advertises directory-scoped files without injecting them", () => {
    const block = composeInstructionsBlock("Root rules.", "AGENTS.md", ["src/features/AGENTS.md"]);
    expect(block).toContain("src/features/AGENTS.md");
    expect(block).toMatch(/read_file/);
  });

  it("says nothing at all when there is nothing to say", () => {
    // Silence, not an empty heading: a heading with nothing under it invites
    // the model to guess at what was omitted.
    expect(composeInstructionsBlock(null, "AGENTS.md", [])).toBe("");
    expect(composeInstructionsBlock("   ", "AGENTS.md", [])).toBe("");
  });

  it("still advertises nested files when the root one is missing", () => {
    const block = composeInstructionsBlock(null, "AGENTS.md", ["packages/api/CLAUDE.md"]);
    expect(block).toContain("no root AGENTS.md");
    expect(block).toContain("packages/api/CLAUDE.md");
  });
});

describe("nestedInstructionPaths", () => {
  it("finds directory-scoped files and skips the root ones", () => {
    expect(nestedInstructionPaths(tree)).toEqual(["src/features/AGENTS.md", "packages/api/CLAUDE.md"]);
  });

  it("is empty without a tree", () => {
    expect(nestedInstructionPaths(undefined)).toEqual([]);
  });
});

describe("ensureRepoInstructions", () => {
  it("caches the miss, so a repo without instructions costs one read", async () => {
    clearRepoInstructionsCache();
    // No token → no read is attempted at all, and the empty answer is cached
    // rather than re-derived on every turn.
    const first = await ensureRepoInstructions(repo, "", tree);
    expect(first).toContain("no root AGENTS.md");
    const second = await ensureRepoInstructions(repo, "", tree);
    expect(second).toBe(first);
  });

  it("drops its cache when that repository moves, and only then", async () => {
    // The instruction file can change under us (a new base commit can ship a
    // new AGENTS.md), so a transition naming this repository has to invalidate
    // it — and a transition naming somebody else's must not, or every thread
    // would re-read on every chat switch.
    clearRepoInstructionsCache();
    await ensureRepoInstructions(repo, "", tree);
    expect(repoInstructionsCacheKey()).toBe("o/r@main");

    await releaseScoped({
      transition: transition({ owner: "someone", repo: "else", branch: "main" }),
      isAttachmentInUse: () => true,
    });
    expect(repoInstructionsCacheKey()).toBe("o/r@main");

    await releaseScoped({
      transition: transition({ owner: "o", repo: "r", branch: "main" }),
      isAttachmentInUse: () => true,
    });
    expect(repoInstructionsCacheKey()).toBeNull();
  });
});
