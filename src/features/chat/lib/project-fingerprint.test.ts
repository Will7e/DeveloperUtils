import { describe, it, expect } from "vitest";
import { buildFingerprint, describeFingerprint } from "./project-fingerprint";

const TREE = [
  "package.json",
  "package-lock.json",
  "src/main.tsx",
  "src/App.tsx",
  "src/a.ts",
  "src/features/chat/lib/skills.ts",
  "src/features/chat/lib/skills.test.ts",
  "src/features/chat/services/turn-prep.test.ts",
  "src/styles/app.css",
  "index.html",
  "README.md",
];

describe("buildFingerprint", () => {
  it("counts languages by file, most first", () => {
    const fp = buildFingerprint(TREE);
    expect(fp.languages[0]!.name).toBe("TypeScript");
    expect(fp.languages[0]!.files).toBe(6);
  });

  it("finds the package manager from the lockfile, not from a guess", () => {
    expect(buildFingerprint(TREE).packageManager).toBe("npm");
    expect(buildFingerprint(["pnpm-lock.yaml"]).packageManager).toBe("pnpm");
    expect(buildFingerprint(["src/a.ts"]).packageManager).toBeNull();
  });

  it("counts test files by path convention", () => {
    // skills.test.ts and turn-prep.test.ts — the tree above holds two.
    expect(buildFingerprint(TREE).testFiles).toBe(2);
  });

  it("names the test framework only when the manifest declares one", () => {
    const manifest = JSON.stringify({ devDependencies: { vitest: "^5.0.1" } });
    expect(buildFingerprint(TREE, manifest).testFramework).toBe("vitest");
    expect(buildFingerprint(TREE).testFramework).toBeNull();
  });

  it("lists entry points that exist", () => {
    expect(buildFingerprint(TREE).entryPoints).toContain("src/main.tsx");
  });

  it("says nothing rather than guessing on an empty tree", () => {
    const fp = buildFingerprint([]);
    expect(fp.languages).toEqual([]);
    expect(describeFingerprint(fp)).toBe("");
  });
});

describe("describeFingerprint", () => {
  it("states languages, manager, tests and entry points on one line", () => {
    const line = describeFingerprint(
      buildFingerprint(TREE, JSON.stringify({ devDependencies: { vitest: "^5" } }))
    );
    expect(line).toContain("TypeScript (6 files)");
    expect(line).toContain("npm");
    expect(line).toContain("vitest");
    expect(line).toContain("2 test files");
    expect(line).toContain("entry: src/main.tsx");
  });

  it("omits a test runner it has not seen declared", () => {
    const line = describeFingerprint(buildFingerprint(TREE));
    expect(line).toContain("runner not declared");
    expect(line).not.toContain("vitest");
  });

  it("is stable for the same tree — that is what lets it sit in a cached prefix", () => {
    expect(describeFingerprint(buildFingerprint(TREE))).toBe(
      describeFingerprint(buildFingerprint([...TREE]))
    );
  });
});
