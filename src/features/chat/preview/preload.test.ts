// ============================================================
// Preview Preload — Repo-Loading Regression Tests
// ============================================================
// The workspace is lazy, the bundler is not: a build reaches every
// module it can import, so a fresh workspace used to fail with
// "File not loaded in the workspace" on any repo the conversation
// had not read file by file. These tests pin the fix:
//
//  - the entry and its transitive LOCAL imports are fetched
//  - bare package imports are ignored (the bundler externalizes them)
//  - the fetch budget stops the walk and reports what was skipped
//  - an unloadable file (binary/oversized/error) never aborts the walk

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkspaceState } from "../types";

const { fetchLog, fileMap } = vi.hoisted(() => ({
  fetchLog: [] as string[],
  fileMap: new Map<string, { text: string | null; sha: string | null; isBinary?: boolean }>(),
}));

vi.mock("../lib/github-client", () => ({
  readFileContent: vi.fn(async (_token: string, _o: string, _r: string, path: string) => {
    fetchLog.push(path);
    const file = fileMap.get(path);
    if (!file) throw new Error(`404: ${path} not found`);
    return file;
  }),
}));

vi.mock("@/services/idb-storage.service", () => ({
  readValue: vi.fn(async () => null),
  writeValue: vi.fn(async () => {}),
}));

import { preloadForPreview, preloadSeeds, PREVIEW_PRELOAD_MAX_FILES } from "./preload";
import { createWorkspaceVfs, localImportSpecifiers } from "./vfs";

const FILES: Record<string, string> = {
  "src/main.tsx": `import React from "react";\nimport { App } from "./App";\nimport "./styles.css";\nrender(<App />);`,
  "src/App.tsx": `import { helper } from "./lib/helper";\nimport Button from "./components/Button";\nexport const App = () => <Button />;`,
  "src/lib/helper.ts": `export const helper = () => 1;`,
  "src/components/Button.tsx": `export const Button = () => null;`,
  "src/styles.css": `@import "./theme.css";\nbody { margin: 0 }`,
  "src/theme.css": `:root { color: red }`,
  "index.html": `<div id="root"></div><script type="module" src="/src/main.tsx"></script>`,
};

function workspace(treePaths: string[]): WorkspaceState {
  return {
    conversationId: "conv-1",
    owner: "acme",
    repo: "demo",
    branch: "main",
    baseCommitSha: "abc123",
    workingBranch: null,
    tree: treePaths.map((path) => ({ path, type: "blob" as const, size: 100 })),
    files: {},
    updatedAt: 1,
  };
}

beforeEach(() => {
  fetchLog.length = 0;
  fileMap.clear();
  for (const [path, text] of Object.entries(FILES)) {
    fileMap.set(path, { text, sha: `sha-${path}` });
  }
});

describe("localImportSpecifiers", () => {
  it("finds static, re-export, dynamic and require forms", () => {
    const src = [
      `import a from "./a";`,
      `import { b } from "../b.ts";`,
      `import "/absolute/c";`,
      `export * from "./d";`,
      `export { e } from "./e";`,
      `const f = await import("./f");`,
      `const g = require("./g");`,
      `import react from "react";`,
      `import lodash from "lodash/merge";`,
    ].join("\n");
    expect(localImportSpecifiers(src, "src/x.ts")).toEqual([
      "./a",
      "../b.ts",
      "/absolute/c",
      "./d",
      "./e",
      "./f",
      "./g",
    ]);
  });

  it("scans CSS @import forms", () => {
    const css = `@import "./theme.css";\n@import url("./print.css");\n@import url("https://fonts.example/x.css");`;
    expect(localImportSpecifiers(css, "src/app.css")).toEqual(["./theme.css", "./print.css"]);
  });
});

describe("createWorkspaceVfs", () => {
  it("resolves extensionless relative imports and index files", () => {
    const ws = workspace(["src/App.tsx", "src/components/Button.tsx", "src/lib/index.ts"]);
    const vfs = createWorkspaceVfs(ws);
    expect(vfs.resolveRel("src/main.tsx", "./App")).toBe("src/App.tsx");
    expect(vfs.resolveRel("src/App.tsx", "./components/Button")).toBe("src/components/Button.tsx");
    expect(vfs.resolveRel("src/main.tsx", "./lib")).toBe("src/lib/index.ts");
    expect(vfs.resolveRel("src/main.tsx", "./missing")).toBeNull();
  });

  it("treats locally deleted files as absent", () => {
    const ws = workspace(["src/App.tsx", "src/legacy.ts"]);
    ws.files["src/legacy.ts"] = {
      path: "src/legacy.ts",
      content: "",
      baseContent: "old",
      baseSha: "s",
      status: "deleted",
      updatedAt: 1,
    };
    const vfs = createWorkspaceVfs(ws);
    expect(vfs.exists("src/legacy.ts")).toBe(false);
    expect(vfs.resolveRel("src/main.tsx", "./legacy")).toBeNull();
  });
});

describe("preloadForPreview", () => {
  it("fetches the entry and its transitive local imports", async () => {
    const ws = workspace(Object.keys(FILES));
    const outcome = await preloadForPreview(ws, ["src/main.tsx"], "token");

    expect(outcome.loaded.sort()).toEqual([
      "src/App.tsx",
      "src/components/Button.tsx",
      "src/lib/helper.ts",
      "src/main.tsx",
      "src/styles.css",
      "src/theme.css",
    ]);
    expect(outcome.failed).toEqual([]);
    // Bare imports never reach the network.
    expect(fetchLog).not.toContain("react");
    expect(fetchLog).not.toContain("lodash/merge");
    // Every fetched file is now readable without another round trip.
    expect(Object.keys(outcome.ws.files).sort()).toEqual(outcome.loaded.sort());
  });

  it("starts from an HTML entry plus its script src", () => {
    const seeds = preloadSeeds({ kind: "html", path: "index.html", scriptSrc: "/src/main.tsx" });
    expect(seeds).toEqual(["index.html", "src/main.tsx"]);
    expect(preloadSeeds({ kind: "js", path: "src/main.tsx" })).toEqual(["src/main.tsx"]);
    expect(preloadSeeds(null)).toEqual([]);
  });

  it("stops at the fetch budget and reports what it skipped", async () => {
    const ws = workspace(Object.keys(FILES));
    const outcome = await preloadForPreview(ws, ["src/main.tsx"], "token", 2);

    expect(outcome.loaded).toHaveLength(2);
    expect(outcome.remaining).toBeGreaterThan(0);
    expect(outcome.remaining + outcome.failed.length + outcome.loaded.length).toBeLessThanOrEqual(
      PREVIEW_PRELOAD_MAX_FILES + outcome.remaining
    );
  });

  it("tolerates files that cannot be loaded without aborting the walk", async () => {
    fileMap.set("src/components/Button.tsx", { text: null, sha: null, isBinary: true });
    const ws = workspace(Object.keys(FILES));
    const outcome = await preloadForPreview(ws, ["src/main.tsx"], "token");

    expect(outcome.failed).toContain("src/components/Button.tsx");
    // The rest of the graph still loads.
    expect(outcome.loaded).toContain("src/lib/helper.ts");
    expect(outcome.loaded).toContain("src/main.tsx");
  });

  it("survives an API error on one dependency", async () => {
    fileMap.delete("src/theme.css");
    const ws = workspace(Object.keys(FILES));
    const outcome = await preloadForPreview(ws, ["src/main.tsx"], "token");
    expect(outcome.failed).toContain("src/theme.css");
    expect(outcome.loaded).toContain("src/styles.css");
  });

  it("never refetches a file that is already in the workspace", async () => {
    const ws = workspace(Object.keys(FILES));
    const first = await preloadForPreview(ws, ["src/main.tsx"], "token");
    fetchLog.length = 0;
    const second = await preloadForPreview(first.ws, ["src/main.tsx"], "token");
    expect(second.loaded).toEqual([]);
    expect(fetchLog).toEqual([]);
  });
});
