import { describe, it, expect, beforeEach } from "vitest";
import type { FileSystemTree } from "@webcontainer/api";
import {
  MAX_PREVIEW_ISSUES,
  detectDevServer,
  notePreviewMessageForTest,
  packageJsonOf,
  previewEvidenceNote,
  previewState,
  resetPreview,
} from "./preview-bridge";
import { planMount } from "./mount-plan";

const PKG = JSON.stringify({
  name: "demo",
  scripts: { build: "vite build", test: "vitest run" },
});

describe("detectDevServer — declared scripts only", () => {
  it("finds the dev script and runs it through npm", () => {
    const pkg = JSON.stringify({ scripts: { dev: "vite", build: "vite build" } });
    expect(detectDevServer({ packageJson: pkg })).toEqual({ command: "npm run dev", script: "dev" });
  });

  it("prefers `dev` over a generic `start`, and any of them over `preview`", () => {
    const both = JSON.stringify({ scripts: { start: "node server.js", dev: "vite" } });
    expect(detectDevServer({ packageJson: both })?.script).toBe("dev");
    const previewOnly = JSON.stringify({ scripts: { preview: "vite preview" } });
    expect(detectDevServer({ packageJson: previewOnly })?.script).toBe("preview");
  });

  it("honours the declared package manager rather than assuming npm", () => {
    const pkg = JSON.stringify({ scripts: { dev: "vite" }, packageManager: "pnpm@9.0.0" });
    expect(detectDevServer({ packageJson: pkg })?.command).toBe("pnpm dev");
    const yarn = JSON.stringify({ scripts: { start: "vite" }, packageManager: "yarn@4.1.1" });
    expect(detectDevServer({ packageJson: yarn })?.command).toBe("yarn start");
  });

  it("returns null rather than guessing when no server script is declared", () => {
    // The whole point: `npx vite` would be this app guessing from a dependency
    // list, and a guess that starts the wrong thing gets blamed on the project.
    expect(detectDevServer({ packageJson: PKG })).toBeNull();
    expect(detectDevServer({ packageJson: "not json" })).toBeNull();
    expect(detectDevServer({ packageJson: null })).toBeNull();
  });
});

describe("packageJsonOf", () => {
  it("reads the manifest out of the tree that is about to be mounted", () => {
    const plan = planMount({
      base: [{ path: "package.json", content: PKG }],
      changes: [],
    });
    expect(packageJsonOf(plan)).toBe(PKG);
  });

  it("is null when the revision has no manifest", () => {
    const plan = planMount({ base: [{ path: "README.md", content: "# hi" }], changes: [] });
    expect(packageJsonOf(plan)).toBeNull();
  });
});

describe("preview evidence", () => {
  beforeEach(() => resetPreview());

  it("is silent when nothing has gone wrong", () => {
    expect(previewEvidenceNote()).toBe("");
  });

  it("reports runtime problems as evidence about the RUNNING app", () => {
    notePreviewMessageForTest({ type: "PREVIEW_CONSOLE_ERROR", args: ["Failed to fetch /api"] });
    notePreviewMessageForTest({ type: "PREVIEW_UNCAUGHT_EXCEPTION", message: "TypeError: x is not a function" });
    const note = previewEvidenceNote();
    expect(note).toContain("2 problem(s)");
    expect(note).toContain("1 exception(s)");
    expect(note).toContain("TypeError: x is not a function");
    expect(note).toContain("not the build");
  });

  it("keeps only the newest console entries, so hot reload cannot unbounded-grow it", () => {
    for (let i = 0; i < MAX_PREVIEW_ISSUES + 10; i += 1) {
      notePreviewMessageForTest({ type: "PREVIEW_CONSOLE_ERROR", args: [`error ${i}`] });
    }
    const issues = previewState().issues;
    expect(issues).toHaveLength(MAX_PREVIEW_ISSUES);
    expect(issues[issues.length - 1]?.message).toBe(`error ${MAX_PREVIEW_ISSUES + 9}`);
  });
});

describe("the mounted tree is what the plan says it is", () => {
  it("mounts nested paths as directories", () => {
    const plan = planMount({
      base: [
        { path: "src/a.ts", content: "export const a = 1;" },
        { path: "package.json", content: PKG },
      ],
      changes: [],
    });
    const tree = plan.tree as FileSystemTree;
    const src = tree.src as { directory: FileSystemTree };
    expect(Object.keys(src.directory)).toEqual(["a.ts"]);
  });
});
