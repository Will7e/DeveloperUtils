// ============================================================
// Repo Base Cache — Fetched Once, Shared By Every Chat
// ============================================================
// A workspace holds what the REPO says (the tree, pristine file contents) and
// what THIS CHAT did to it (edits, undo log). Both used to be created per
// conversation, so a second chat on the same repo re-fetched the tree,
// re-downloaded files the first chat had already read, and rebuilt its
// preview from nothing.
//
// What these tests pin is the sharing, and its limits:
//
//   • one fetch per (repo, branch), however many chats ask;
//   • never reused across base commits — a push moves the base, and bytes
//     from before it would make a changed file look unmodified, which is
//     what a diff, a revert and a push all decide on;
//   • never reused across branches;
//   • and it is a CACHE: dropping it costs speed, never correctness.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Records every tree fetch, so "once per repo" is a fact and not a hope */
const treeFetches: string[] = [];
/** The fake IndexedDB: one map, exactly like the real service's contract */
const idb = new Map<string, string>();

vi.mock("../lib/github-client", () => ({
  getRepoTree: vi.fn(async (_token: string, owner: string, repo: string, branch: string) => {
    treeFetches.push(`${owner}/${repo}@${branch}`);
    return [
      { path: "index.html", type: "blob" as const, size: 120 },
      { path: "src/main.tsx", type: "blob" as const, size: 80 },
      { path: "src", type: "tree" as const },
    ];
  }),
}));

vi.mock("@/services/idb-storage.service", () => ({
  readValue: vi.fn(async (key: string) => idb.get(key) ?? null),
  writeValue: vi.fn(async (key: string, value: string | null) => {
    if (value === null) idb.delete(key);
    else idb.set(key, value);
  }),
}));

import {
  getRepoBaseFile,
  getRepoBaseTree,
  invalidateRepoBase,
  rememberRepoBaseFile,
  resetRepoBaseCache,
  type RepoIdentity,
} from "./repo-base";

const REPO: RepoIdentity = { owner: "acme", repo: "web", branch: "main" };
const SHA = "sha-1";

beforeEach(() => {
  treeFetches.length = 0;
  idb.clear();
  resetRepoBaseCache();
});

describe("repo base — one fetch, every chat", () => {
  it("fetches the tree once for repeated asks (a second chat pays nothing)", async () => {
    const first = await getRepoBaseTree(REPO, "token", SHA);
    const second = await getRepoBaseTree(REPO, "token", SHA);

    expect(treeFetches).toEqual(["acme/web@main"]);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.tree).toEqual(first.tree);
  });

  it("still serves the tree after a reload, from storage rather than GitHub", async () => {
    await getRepoBaseTree(REPO, "token", SHA);
    // A reload drops everything resident and nothing else.
    resetRepoBaseCache();
    treeFetches.length = 0;

    const afterReload = await getRepoBaseTree(REPO, "token", SHA);
    expect(afterReload.cached).toBe(true);
    expect(treeFetches).toEqual([]);
  });

  it("never reuses a tree from an older base commit", async () => {
    // A push moves the base. A tree from before it would name files that are
    // gone, and miss the ones that were added.
    await getRepoBaseTree(REPO, "token", SHA);
    await getRepoBaseTree(REPO, "token", "sha-2");
    expect(treeFetches).toEqual(["acme/web@main", "acme/web@main"]);
  });

  it("treats another branch as another base", async () => {
    await getRepoBaseTree(REPO, "token", SHA);
    const other = await getRepoBaseTree({ ...REPO, branch: "release" }, "token", "sha-rel");
    expect(other.cached).toBe(false);
    expect(treeFetches).toEqual(["acme/web@main", "acme/web@release"]);
  });

  it("survives eviction from memory by reading storage", async () => {
    // Five repos, four resident: the first is evicted, not lost.
    const repos: RepoIdentity[] = Array.from({ length: 5 }, (_, i) => ({
      owner: "acme",
      repo: `svc-${i}`,
      branch: "main",
    }));
    for (const repo of repos) await getRepoBaseTree(repo, "token", SHA);
    treeFetches.length = 0;

    const evicted = await getRepoBaseTree(repos[0]!, "token", SHA);
    expect(evicted.cached).toBe(true);
    expect(treeFetches).toEqual([]);
  });

  it("re-fetches after an explicit invalidation", async () => {
    await getRepoBaseTree(REPO, "token", SHA);
    await invalidateRepoBase(REPO);
    const after = await getRepoBaseTree(REPO, "token", SHA);
    expect(after.cached).toBe(false);
    expect(treeFetches).toHaveLength(2);
  });
});

describe("repo base — file contents", () => {
  it("shares pristine contents with every chat at the same base commit", async () => {
    await getRepoBaseTree(REPO, "token", SHA);
    await rememberRepoBaseFile(REPO, "src/main.tsx", SHA, { content: "export const a = 1;", sha: "blob-1" });

    const fromSecondChat = await getRepoBaseFile(REPO, "src/main.tsx", SHA);
    expect(fromSecondChat).toEqual({ content: "export const a = 1;", sha: "blob-1" });
  });

  it("refuses contents cached at a different base commit", async () => {
    // The failure this prevents is silent: after a push, a file the push
    // changed must not come back as its pre-push bytes, because "unmodified"
    // is the answer a diff and a revert both act on.
    await rememberRepoBaseFile(REPO, "src/main.tsx", SHA, { content: "old", sha: "blob-1" });
    expect(await getRepoBaseFile(REPO, "src/main.tsx", "sha-2")).toBeNull();
    expect(await getRepoBaseFile(REPO, "src/main.tsx", SHA)).not.toBeNull();
  });

  it("returns nothing for a file it has never seen instead of inventing it", async () => {
    // A miss has to be a miss: the caller then fetches from GitHub, and the
    // workspace's \"is this modified?\" decision depends on real bytes.
    expect(await getRepoBaseFile(REPO, "src/never-read.ts", SHA)).toBeNull();
  });

  it("keeps the first copy of a file, so a later write cannot rewrite history", async () => {
    await rememberRepoBaseFile(REPO, "a.ts", SHA, { content: "pristine", sha: "1" });
    await rememberRepoBaseFile(REPO, "a.ts", SHA, { content: "someone-edited-this", sha: "2" });
    expect(await getRepoBaseFile(REPO, "a.ts", SHA)).toEqual({ content: "pristine", sha: "1" });
  });

  it("forgets a repo's contents when the base moves", async () => {
    await rememberRepoBaseFile(REPO, "a.ts", SHA, { content: "old", sha: "1" });
    await getRepoBaseTree(REPO, "token", "sha-2");
    expect(await getRepoBaseFile(REPO, "a.ts", "sha-2")).toBeNull();
  });
});
