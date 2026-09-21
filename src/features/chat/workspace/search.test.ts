// ============================================================
// Workspace Search — Local Grep Rules
// ============================================================
// search_workspace is the agent's search while it edits: it must see
// unpushed edits, skip noise (lockfiles, bundles, binaries), and never
// fetch a giant file just to scan it. These tests pin those rules.

import { describe, it, expect } from "vitest";
import {
  isSearchablePath,
  pickSearchCandidates,
  searchContent,
  SEARCH_MAX_MATCHES_PER_FILE,
} from "./search";
import type { WorkspaceState } from "../types";

describe("isSearchablePath", () => {
  it("accepts ordinary source files", () => {
    expect(isSearchablePath("src/App.tsx")).toBe(true);
    expect(isSearchablePath("README.md")).toBe(true);
    expect(isSearchablePath("scripts/deploy.sh")).toBe(true);
  });

  it("rejects dependencies, build output and binaries", () => {
    expect(isSearchablePath("node_modules/react/index.js")).toBe(false);
    expect(isSearchablePath("dist/bundle.js")).toBe(false);
    expect(isSearchablePath("assets/logo.png")).toBe(false);
    expect(isSearchablePath("build/app.min.js")).toBe(false);
    expect(isSearchablePath("vendor/lib.wasm")).toBe(false);
  });

  it("rejects lockfiles", () => {
    expect(isSearchablePath("package-lock.json")).toBe(false);
    expect(isSearchablePath("pnpm-lock.yaml")).toBe(false);
    expect(isSearchablePath("Cargo.lock")).toBe(false);
  });
});

describe("searchContent", () => {
  const content = [
    "function Foo() {",
    "  return 1;",
    "}",
    "// foo again",
    "const FOOBAR = 2;",
  ].join("\n");

  it("matches case-insensitively with line numbers", () => {
    const outcome = searchContent("src/a.ts", content, "foo", "text");
    expect(outcome.matches.map((m) => m.line)).toEqual([1, 4, 5]);
    expect(outcome.matches[0]!.path).toBe("src/a.ts");
    expect(outcome.capped).toBe(false);
  });

  it("supports regex mode", () => {
    const outcome = searchContent("src/a.ts", content, "^const\\s+FOO", "regex");
    expect(outcome.matches).toHaveLength(1);
    expect(outcome.matches[0]!.line).toBe(5);
  });

  it("falls back to no matches on an invalid regex instead of throwing", () => {
    const outcome = searchContent("src/a.ts", content, "([unclosed", "regex");
    expect(outcome.matches).toEqual([]);
  });

  it("caps matches per file and flags truncation", () => {
    const many = Array.from({ length: SEARCH_MAX_MATCHES_PER_FILE + 5 }, () => "hit").join("\n");
    const outcome = searchContent("src/a.ts", many, "hit", "text");
    expect(outcome.matches).toHaveLength(SEARCH_MAX_MATCHES_PER_FILE);
    expect(outcome.capped).toBe(true);
  });

  it("trims and length-caps the echoed line", () => {
    const outcome = searchContent("src/a.ts", `   ${"x".repeat(400)}needle`, "needle", "text");
    expect(outcome.matches[0]!.text.startsWith("x")).toBe(true);
    expect(outcome.matches[0]!.text.length).toBeLessThan(300);
  });
});

function workspace(): WorkspaceState {
  return {
    conversationId: "conv-1",
    owner: "acme",
    repo: "demo",
    branch: "main",
    baseCommitSha: "abc",
    workingBranch: null,
    tree: [
      { path: "src/App.tsx", type: "blob", size: 1_000 },
      { path: "src/big.ts", type: "blob", size: 5_000_000 },
      { path: "node_modules/x/index.js", type: "blob", size: 100 },
      { path: "package-lock.json", type: "blob", size: 900_000 },
      { path: "src/edited.ts", type: "blob", size: 500 },
      { path: "src/removed.ts", type: "blob", size: 500 },
      { path: "src", type: "tree" },
    ],
    files: {
      "src/edited.ts": {
        path: "src/edited.ts",
        content: "local edit",
        baseContent: "base",
        baseSha: "s1",
        status: "modified",
        updatedAt: 1,
      },
      "src/removed.ts": {
        path: "src/removed.ts",
        content: "",
        baseContent: "gone",
        baseSha: "s2",
        status: "deleted",
        updatedAt: 1,
      },
    },
    updatedAt: 1,
  };
}

describe("pickSearchCandidates", () => {
  it("separates loaded files from files worth fetching", () => {
    const candidates = pickSearchCandidates(workspace());
    expect(candidates.loaded).toEqual(["src/edited.ts"]);
    expect(candidates.unloaded).toEqual(["src/App.tsx"]);
    // tree entries and noise kinds are counted as skipped, not returned
    expect(candidates.skipped).toBeGreaterThanOrEqual(3);
  });

  it("skips files above the size budget before fetching them", () => {
    const candidates = pickSearchCandidates(workspace());
    expect(candidates.unloaded).not.toContain("src/big.ts");
    expect(candidates.unloaded).not.toContain("package-lock.json");
  });

  it("never resurrects a locally deleted file", () => {
    const candidates = pickSearchCandidates(workspace());
    expect(candidates.loaded).not.toContain("src/removed.ts");
    expect(candidates.unloaded).not.toContain("src/removed.ts");
  });

  it("narrows to a path prefix", () => {
    const candidates = pickSearchCandidates(workspace(), "node_modules");
    expect(candidates.unloaded).toEqual([]);
    expect(candidates.loaded).toEqual([]);
  });
});
