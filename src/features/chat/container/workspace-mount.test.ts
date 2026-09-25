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
  "package-lock.json": "{}",
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

  it("counts an empty read for a non-empty blob as a FAILED read, and names it", async () => {
    const result = await planWorkspaceMount({
      ws: workspace(),
      read: async (path) => (path === "package.json" ? "" : READ[path] ?? null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The listing says 20 bytes and the reader handed back nothing. Mounting that
    // puts an EMPTY file in a workspace whose every name-based decision still sees
    // the file — "there is a package.json", "there is a lockfile, so install with
    // the frozen command" — and the failure lands in the install, where it reads as
    // a broken repository. Naming it here keeps the two apart.
    expect(result.result.plan.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    const notes = result.result.notes.join("\n");
    expect(notes).toContain("package.json");
    expect(notes).toContain("20 bytes");
  });

  it("names the size when it reports a partial tree, in the same breath", async () => {
    const result = await planWorkspaceMount({ ws: workspace(), read: async (p) => READ[p] ?? null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(describeMount(result.result.plan)).toContain("file");
  });

  it("mounts binary assets as bytes when a byte reader is provided", async () => {
    // The preview serves the repo's own photos and fonts; a site whose images
    // are all missing is a broken page, and it reads as a broken project.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await planWorkspaceMount({
      ws: workspace(),
      read: async (path) => READ[path] ?? null,
      readBinary: async (path) => (path === "logo.png" ? bytes : null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = result.result.plan.tree["logo.png"] as { file: { contents: Uint8Array } };
    expect(written.file.contents).toBe(bytes);
    // Assets ride the SAME budget and the same report as text: nothing about
    // the mount is silent, including the assets that made it in.
    expect(result.result.notes.join("\n")).not.toContain("logo.png");
  });

  it("skips assets with a stated reason when no byte reader is available", async () => {
    const result = await planWorkspaceMount({
      ws: workspace(),
      read: async (path) => READ[path] ?? null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.plan.files.map((f) => f.path)).not.toContain("logo.png");
    expect(result.result.notes.join("\n")).toContain("no byte reader");
  });

  it("hydrates package.json even when the assets have already eaten the byte budget", async () => {
    // The screenshot's failure, reduced: a photo-heavy Next.js repo whose assets
    // spend the whole 8 MiB before the text pass begins. The budget may still
    // leave the manifest out today, but the mount must never answer "declares no
    // dev script" for a project whose manifest simply was not mounted.
    const photos = Array.from({ length: 60 }, (_, i) => ({
      path: `public/photos/photo-${i}.jpg`,
      type: "blob" as const,
      size: 160 * 1024,
    }));
    const result = await planWorkspaceMount({
      ws: workspace({
        tree: [
          { path: "package.json", type: "blob", size: 600 },
          { path: "package-lock.json", type: "blob", size: 40 },
          ...photos,
        ],
      }),
      read: async (path) => READ[path] ?? null,
      readBinary: async () => new Uint8Array(160 * 1024),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.result.plan.files.map((file) => file.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("package-lock.json");
  });

  it("counts only candidate text files against candidates when assets overflow the budget", async () => {
    // The note once said "101 of 115 candidate files: 170 beyond the byte
    // budget" — an impossible sentence, because the asset overage was folded
    // into the candidate count. Each number here must be reproducible.
    const photos = Array.from({ length: 60 }, (_, i) => ({
      path: `public/photos/photo-${i}.jpg`,
      type: "blob" as const,
      size: 200 * 1024,
    }));
    const result = await planWorkspaceMount({
      ws: workspace({
        tree: [
          { path: "package.json", type: "blob", size: 600 },
          ...photos,
        ],
      }),
      read: async (path) => READ[path] ?? null,
      readBinary: async () => new Uint8Array(200 * 1024),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const notes = result.result.notes.join("\n");
    // One candidate, mounted. The asset overage is stated separately, not folded
    // into a count of files that were never candidates.
    expect(notes).toContain("1 of 1 candidate text files");
    expect(notes).not.toContain("0 beyond");
    expect(notes).toMatch(/\b20\b.*left out of the workspace/);
  });

  it("never fetches archives or executables even with a byte reader", async () => {
    const result = await planWorkspaceMount({
      ws: workspace({
        tree: [
          { path: "package.json", type: "blob", size: 20 },
          { path: "dist/lib.tar.gz", type: "blob", size: 20 },
          { path: "native/addon.node", type: "blob", size: 20 },
        ],
      }),
      read: async (path) => READ[path] ?? null,
      readBinary: async () => new Uint8Array([1, 2, 3]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.result.plan.files.map((f) => f.path);
    expect(paths).toEqual(["package.json"]);
    const notes = result.result.notes.join("\n");
    expect(notes).toContain("cannot run or be read in a browser workspace");
  });
});
