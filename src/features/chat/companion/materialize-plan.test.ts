// ============================================================
// Materialize Plan — Containment Is The Point
// ============================================================
// The change set comes from edits a model produced, and it is about to be
// written to a real directory on someone's machine. So the tests that matter
// are the paths that must NOT be written, and the report that says why —
// a silently skipped file becomes a confusing failure two layers later.
// ============================================================

import { describe, expect, it } from "vitest";
import {
  describeRejections,
  materializeRejection,
  normalizeWorkspacePath,
  planMaterialization,
} from "./materialize-plan";

const base = [
  { path: "package.json", content: "{}" },
  { path: "src/a.ts", content: "export const a = 1;" },
];

describe("normalizeWorkspacePath", () => {
  it("accepts a plain relative path", () => {
    expect(normalizeWorkspacePath("src/lib/a.ts")).toBe("src/lib/a.ts");
  });

  it("folds away a leading ./ and redundant separators", () => {
    expect(normalizeWorkspacePath("./src//a.ts")).toBe("src/a.ts");
  });

  it.each([
    ["../outside.txt", "a parent reference"],
    ["src/../../outside.txt", "a parent reference mid-path"],
    ["/etc/passwd", "an absolute path"],
    ["C:/Windows/system32", "a Windows drive"],
    ["src\\..\\..\\evil", "a backslash separator"],
    ["", "nothing"],
    ["   ", "whitespace"],
    ["a\u0000b", "a NUL byte"],
    [".", "the directory itself"],
  ])("refuses %s (%s)", (path) => {
    expect(normalizeWorkspacePath(path)).toBeNull();
  });
});

describe("materializeRejection", () => {
  it("protects .git, which is executable rather than data", () => {
    // A write to .git/hooks/pre-commit runs on the NEXT git command. That is
    // code execution, and it is the one path a change set must never own.
    const reason = materializeRejection(".git/hooks/pre-commit");
    expect(reason?.code).toBe("protected-path");
  });

  it("allows a normal .gitignore, which is not inside .git", () => {
    expect(materializeRejection(".gitignore")).toBeNull();
  });

  it("allows ordinary source", () => {
    expect(materializeRejection("src/features/a.ts")).toBeNull();
  });
});

describe("planMaterialization", () => {
  it("writes the base tree and applies changes over it", () => {
    const plan = planMaterialization({
      base,
      changes: [
        { path: "src/a.ts", content: "export const a = 2;", status: "modified" },
        { path: "src/new.ts", content: "new", status: "added" },
      ],
    });
    expect(plan.writes.map((w) => w.path)).toEqual([
      "package.json",
      "src/a.ts",
      "src/new.ts",
    ]);
    expect(plan.writes.find((w) => w.path === "src/a.ts")!.content).toBe("export const a = 2;");
    expect(plan.rejected).toEqual([]);
  });

  it("removes a deleted file from the tree rather than writing it empty", () => {
    const plan = planMaterialization({
      base,
      changes: [{ path: "src/a.ts", content: null, status: "deleted" }],
    });
    expect(plan.writes.map((w) => w.path)).toEqual(["package.json"]);
    expect(plan.deletes).toEqual(["src/a.ts"]);
  });

  it("normalizes paths while keeping them inside the root", () => {
    const plan = planMaterialization({
      base: [],
      changes: [{ path: "./src/./deep/x.ts", content: "x", status: "added" }],
    });
    expect(plan.writes[0]!.path).toBe("src/deep/x.ts");
  });

  it("reports an escaping path instead of dropping it silently", () => {
    const plan = planMaterialization({
      base: [],
      changes: [{ path: "../../evil.txt", content: "x", status: "added" }],
    });
    expect(plan.writes).toEqual([]);
    expect(plan.rejected[0]!.code).toBe("unsafe-path");
    expect(describeRejections(plan)).toContain("../../evil.txt");
  });

  it("refuses to materialize a path inside .git", () => {
    const plan = planMaterialization({
      base: [],
      changes: [{ path: ".git/hooks/pre-commit", content: "#!/bin/sh\nrm -rf ~", status: "added" }],
    });
    expect(plan.writes).toEqual([]);
    expect(plan.rejected[0]!.code).toBe("protected-path");
  });

  it("writes parents before children", () => {
    const plan = planMaterialization({
      base: [],
      changes: [
        { path: "a/b/c/d.ts", content: "x", status: "added" },
        { path: "a/b.ts", content: "y", status: "added" },
      ],
    });
    expect(plan.writes.map((w) => w.path)).toEqual(["a/b.ts", "a/b/c/d.ts"]);
  });

  it("stops at the byte ceiling deterministically, and says so", () => {
    const plan = planMaterialization({
      base: [],
      changes: [
        { path: "a.bin", content: "x".repeat(60), status: "added" },
        { path: "b.bin", content: "y".repeat(60), status: "added" },
      ],
      maxBytes: 100,
    });
    expect(plan.writes.map((w) => w.path)).toEqual(["a.bin"]);
    expect(plan.rejected.map((r) => r.code)).toEqual(["too-large"]);
    expect(plan.bytes).toBe(60);
  });

  it("calls an empty plan empty", () => {
    expect(planMaterialization({ base: [], changes: [] }).empty).toBe(true);
  });
});
