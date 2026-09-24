import { describe, it, expect } from "vitest";
import { planWorkspaceMount } from "./workspace-mount";
import { describeMount } from "./mount-plan";
import type { WorkspaceState } from "../types";

function workspace(over: Partial<WorkspaceState> = {}): WorkspaceState {
  // The revision the evidence would be stamped with. It only has to exist: the
  // mount decides nothing from it, and the ledger is not what is under test here.
  const base: WorkspaceState = {
    conversationId: "c1",
    owner: "acme",
    repo: "widgets",
    branch: "main",
    baseCommitSha: "abc",
    workingBranch: null,
    updatedAt: 1,
    tree: [
      { path: "package.json", type: "blob", size: 20 },
      { path: "src/index.ts", type: "blob", size: 20 },
      { path: "node_modules/left-pad/index.js", type: "blob", size: 20 },
      { path: "dist/bundle.js", type: "blob", size: 20 },
      { path: ".env", type: "blob", size: 20 },
      { path: "logo.png", type: "blob", size: 20 },
      { path: "src", type: "tree" },
    ],
    files: {},
  };
  return { ...base, ...over };
}

const READ: Record<string, string> = {
  "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
  "src/index.ts": "export const a = 1;",
  "node_modules/left-pad/index.js": "module.exports = () => {}",
  "dist/bundle.js": "!(function(){})()",
  ".env": "API_KEY=secret",
  "logo.png": "binary-bytes",
};

describe("planWorkspaceMount — what the container actually gets", () => {
  it("mounts the project's text files and reports what it left out, with reasons", async () => {
    const result = await planWorkspaceMount({
      ws: workspace(),
      read: async (path) => READ[path] ?? null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = result.result.plan.files.map((file) => file.path);
    expect(paths).toEqual(["package.json", "src/index.ts"]);
    // What was left out is stated, by reason, in the same breath as the size — a
    // command that fails on a missing file would otherwise be reported as a
    // failing CHANGE, which is the expensive mistake here.
    const notes = result.result.notes.join("\n");
    expect(notes).toContain("were not fetched into the browser workspace");
    // Secret-shaped paths are named rather than counted: that is the omission a
    // dev server would trip over, and the agent has to say so instead of asking
    // for the file to be mounted.
    expect(notes).toContain(".env");
    // npm dependencies and build output are never fetched at all: the install
    // creates one and the commands in this tier regenerate the other.
    expect(paths).not.toContain("node_modules/left-pad/index.js");
  });

  it("refuses rather than mounting a tree with nothing in it", async () => {
    const result = await planWorkspaceMount({
      ws: workspace({ tree: [{ path: "logo.png", type: "blob" }] }),
      read: async () => null,
    });
    // An empty mount would boot a runtime, install nothing and then fail every
    // command for a reason that has nothing to do with the change.
    expect(result).toEqual({
      ok: false,
      error: "no files could be read from this revision, so there is nothing to run against",
    });
  });

  it("carries the change set on top of the repository files", async () => {
    const ws = workspace({
      files: {
        "src/index.ts": {
          path: "src/index.ts",
          content: "export const a = 2;",
          baseContent: "export const a = 1;",
          baseSha: "sha",
          status: "modified",
          updatedAt: 1,
        },
        "src/new.ts": {
          path: "src/new.ts",
          content: "export const b = 1;",
          baseContent: "",
          baseSha: null,
          status: "added",
          updatedAt: 2,
        },
      },
    });
    const result = await planWorkspaceMount({ ws, read: async (path) => READ[path] ?? null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const contents = new Map(result.result.plan.files.map((file) => [file.path, null]));
    expect([...contents.keys()]).toEqual(["package.json", "src/index.ts", "src/new.ts"]);
  });

  it("names the size when it reports a partial tree, in the same breath", async () => {
    const result = await planWorkspaceMount({ ws: workspace(), read: async (p) => READ[p] ?? null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(describeMount(result.result.plan)).toContain("file");
  });
});
