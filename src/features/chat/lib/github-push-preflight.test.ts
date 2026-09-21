// ============================================================
// Push Preflight — Stale Base / Scope Regression Tests
// ============================================================
// A push lands on top of whatever the base branch is NOW, so an
// agent that edited files from an older commit can overwrite work it
// never saw, and a read-only token fails only after the user has
// approved a whole change set. The preflight surfaces both before
// the gate opens. These tests pin the findings — and that no
// finding can throw, because a probe must never block a legitimate
// push.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { router, calls } = vi.hoisted(() => ({
  router: new Map<string, () => unknown | Promise<unknown>>(),
  calls: [] as string[],
}));

vi.mock("./github-client", () => ({
  githubFetch: vi.fn(async (path: string) => {
    calls.push(path);
    const handler = router.get(path);
    if (!handler) {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => handler() } as unknown as Response;
  }),
}));

import { inspectPushPreconditions } from "./github-write";

const BASE = {
  owner: "acme",
  repo: "demo",
  baseBranch: "main",
  baseCommitSha: "head-old",
  files: [
    { path: "src/App.tsx", baseSha: "blob-app" },
    { path: "src/new.ts", baseSha: null },
  ],
};

function head(sha: string) {
  router.set("/repos/acme/demo/git/ref/heads/main", () => ({ object: { sha, type: "commit" } }));
}

function commit(sha: string, treeSha: string) {
  router.set(`/repos/acme/demo/commits/${sha}`, () => ({ sha, commit: { tree: { sha: treeSha } } }));
}

function tree(treeSha: string, entries: Array<{ path: string; sha: string }>) {
  router.set(`/repos/acme/demo/git/trees/${treeSha}?recursive=1`, () => ({
    tree: entries.map((e) => ({ path: e.path, sha: e.sha, type: "blob" })),
  }));
}

function repoPermissions(push: boolean | undefined) {
  router.set("/repos/acme/demo", () => ({ permissions: { push, admin: false, pull: true } }));
}

beforeEach(() => {
  router.clear();
  calls.length = 0;
});

describe("inspectPushPreconditions", () => {
  it("reports a clean base as not moved", async () => {
    head("head-old");
    repoPermissions(true);
    const result = await inspectPushPreconditions("token", BASE);

    expect(result.baseMoved).toBe(false);
    expect(result.currentHeadSha).toBe("head-old");
    expect(result.upstreamChanged).toEqual([]);
    expect(result.canPush).toBe(true);
    // A clean base costs one ref lookup plus the permission probe,
    // not a tree walk.
    expect(calls.some((c) => c.includes("/git/trees/"))).toBe(false);
  });

  it("detects that the base branch moved", async () => {
    head("head-new");
    commit("head-new", "tree-new");
    tree("tree-new", [{ path: "src/App.tsx", sha: "blob-app" }]);
    repoPermissions(true);

    const result = await inspectPushPreconditions("token", BASE);
    expect(result.baseMoved).toBe(true);
    expect(result.currentHeadSha).toBe("head-new");
    // The file still matches what the agent read.
    expect(result.upstreamChanged).toEqual([]);
  });

  it("names files that changed upstream after the agent read them", async () => {
    head("head-new");
    commit("head-new", "tree-new");
    tree("tree-new", [
      { path: "src/App.tsx", sha: "blob-app-EDITED-UPSTREAM" },
      { path: "src/other.ts", sha: "blob-other" },
    ]);
    repoPermissions(true);

    const result = await inspectPushPreconditions("token", BASE);
    expect(result.upstreamChanged).toEqual(["src/App.tsx"]);
  });

  it("does not flag a file the push only adds (no base blob)", async () => {
    head("head-new");
    commit("head-new", "tree-new");
    tree("tree-new", [{ path: "src/App.tsx", sha: "blob-app" }]);
    repoPermissions(true);

    const result = await inspectPushPreconditions("token", BASE);
    expect(result.upstreamChanged).toEqual([]);
  });

  it("reports a token that cannot write", async () => {
    head("head-old");
    repoPermissions(false);
    const result = await inspectPushPreconditions("token", BASE);
    expect(result.canPush).toBe(false);
  });

  it("leaves write capability unknown when the API omits it", async () => {
    head("head-old");
    repoPermissions(undefined);
    const result = await inspectPushPreconditions("token", BASE);
    expect(result.canPush).toBeNull();
  });

  it("survives a failing permission probe without failing the push path", async () => {
    head("head-old");
    // No /repos/acme/demo route → the probe 404s.
    const result = await inspectPushPreconditions("token", BASE);
    expect(result.canPush).toBeNull();
    expect(result.baseMoved).toBe(false);
  });

  it("propagates a ref lookup failure (the caller treats it as advisory)", async () => {
    await expect(inspectPushPreconditions("token", BASE)).rejects.toThrow();
  });

  it("skips the tree walk when the workspace has no base commit", async () => {
    head("head-new");
    repoPermissions(true);
    const result = await inspectPushPreconditions("token", { ...BASE, baseCommitSha: "" });
    expect(result.baseMoved).toBe(false);
    expect(calls.some((c) => c.includes("/git/trees/"))).toBe(false);
  });
});
