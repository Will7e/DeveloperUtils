import { describe, it, expect } from "vitest";
import { planWorkspaceMount } from "./workspace-mount";
import { describeMount } from "./mount-plan";
import { HYDRATE_MAX_BYTES, HYDRATE_MAX_ASSET_BYTES, HYDRATE_MAX_VIDEO_BYTES } from "./tree-source";
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
    expect(paths).toEqual([".env", "package.json", "src/index.ts"]);
    // What was left out is stated, by reason, in the same breath as the size — a
    // command that fails on a missing file would otherwise be reported as a
    // failing CHANGE, which is the expensive mistake here.
    const notes = result.result.notes.join("\n");
    expect(notes).toContain("were not fetched into the browser workspace");
    // npm dependencies and build output are never fetched at all: the install
    // creates one and the commands in this tier regenerate the other.
    expect(paths).not.toContain("node_modules/left-pad/index.js");
  });

  it("fetches the committed env file and SAYS the workspace runs with the repo's own configuration", async () => {
    const result = await planWorkspaceMount({
      ws: workspace(),
      read: async (path) => READ[path] ?? null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The positive counterpart of the omission notes: the agent's standing rule
    // says env files never reach the workspace, so a mounted `.env` must be
    // announced or the agent will keep reporting a configuration that exists.
    const notes = result.result.notes.join("\n");
    expect(notes).toContain("committed env file");
    expect(notes).toContain("mounted");
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
    expect([...contents.keys()]).toEqual([".env", "package.json", "src/index.ts", "src/new.ts"]);
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
    expect(result.result.plan.files.map((file) => file.path)).toEqual([".env", "src/index.ts"]);
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
    // The screenshot's failure, reduced: a photo-heavy Next.js repo. The
    // manifests ride in first by construction now; this pins that guarantee.
    // Sized against the live budget so the test keeps testing the overflow
    // path if the budget is raised again: 60 × 400 KiB out-spends 24 MiB.
    const photoSize = Math.ceil(HYDRATE_MAX_BYTES / 45 / 1024) * 1024;
    const photos = Array.from({ length: 60 }, (_, i) => ({
      path: `public/photos/photo-${i}.jpg`,
      type: "blob" as const,
      size: photoSize,
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
      readBinary: async () => new Uint8Array(photoSize),
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
    // into the candidate count. Each number here must be reproducible. Sized
    // against the live budget so exactly 20 of the 60 drop: 40 × photoSize,
    // plus the text candidate, fits with a KiB to spare, the 41st does not.
    const photoSize = Math.floor((HYDRATE_MAX_BYTES - 1024) / 40);
    const photos = Array.from({ length: 60 }, (_, i) => ({
      path: `public/photos/photo-${i}.jpg`,
      type: "blob" as const,
      size: photoSize,
    }));
    const result = await planWorkspaceMount({
      ws: workspace({
        tree: [
          { path: "package.json", type: "blob", size: 600 },
          ...photos,
        ],
      }),
      read: async (path) => READ[path] ?? null,
      readBinary: async () => new Uint8Array(photoSize),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const notes = result.result.notes.join("\n");
    // One candidate, mounted. The asset overage is stated separately, not folded
    // into a count of files that were never candidates.
    expect(notes).toContain("1 of 1 candidate text files");
    // No empty overage clause — the text budget dropped nothing here.
    expect(notes).not.toContain("(0 beyond");
    expect(notes).toMatch(/\b20\b.*left out of the workspace/);
  });

  it("hydrates the source before the photos, when the two cannot both fit", async () => {
    // The second screenshot's failure, reduced: assets hydrated FIRST spent the
    // whole budget, so the text pass found nothing left, `src/` never mounted,
    // and the preview showed only what was baked into `index.html` while React
    // rendered nothing below it. Source first, photos with the remainder: a page
    // with broken images is damaged, a page whose code never arrived is no app
    // at all. Sized against the live budget: 64 × 600 KiB out-spends 24 MiB.
    const photoSize = Math.ceil(HYDRATE_MAX_BYTES / 30 / 1024) * 1024;
    const photos = Array.from({ length: 64 }, (_, i) => ({
      path: `public/photos/photo-${i}.jpg`,
      type: "blob" as const,
      size: photoSize,
    }));
    const result = await planWorkspaceMount({
      ws: workspace({
        tree: [
          { path: "package.json", type: "blob", size: 600 },
          { path: "src/index.ts", type: "blob", size: 20 },
          ...photos,
        ],
      }),
      read: async (path) => READ[path] ?? null,
      readBinary: async () => new Uint8Array(photoSize),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.result.plan.files.map((file) => file.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/index.ts");
    // The photos the remainder could not hold are stated, not silent — and the
    // text note counts only the candidates, so no asset number bleeds into it.
    const notes = result.result.notes.join("\n");
    expect(notes).toContain("left out of the workspace");
    expect(notes).toContain("2 of 2 candidate text files");
  });

  it("mounts videos like any other asset, under their own ceiling", async () => {
    // The restaurant preview's silence, reduced: video was EXCLUDED by class —
    // every .mp4 skipped with "beyond this workspace's byte budget" — so a hero
    // loop could never appear no matter how small it was. Video rides the same
    // budget as everything now, with the bigger ceiling its shape needs.
    const hero = new Uint8Array(64);
    const result = await planWorkspaceMount({
      ws: workspace({
        tree: [
          { path: "package.json", type: "blob", size: 20 },
          { path: "public/video/hero.mp4", type: "blob", size: 5 * 1024 * 1024 },
          { path: "public/video/giant.webm", type: "blob", size: HYDRATE_MAX_VIDEO_BYTES + 1024 },
        ],
      }),
      read: async (path) => READ[path] ?? null,
      readBinary: async () => hero,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.result.plan.files.map((f) => f.path);
    expect(paths).toContain("public/video/hero.mp4");
    expect(paths).not.toContain("public/video/giant.webm");
    const written = result.result.plan.tree["public"] as { directory: { video: { directory: { "hero.mp4": { file: { contents: Uint8Array } } } } } };
    expect(written.directory.video.directory["hero.mp4"].file.contents).toBe(hero);
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
