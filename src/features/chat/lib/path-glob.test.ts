import { describe, it, expect } from "vitest";
import { isWithinSubtree, matchesGlob } from "./path-glob";
import { findMatchingPaths } from "./tools";

/** A tree shaped like this repository, for the listing rules */
const ENTRIES = [
  { path: ".", type: "tree" },
  { path: "src", type: "tree" },
  { path: "src/App.tsx", type: "blob" },
  { path: "src/features/chat/lib/skills.ts", type: "blob" },
  { path: "src/features/chat/lib/skills.test.ts", type: "blob" },
  { path: "src/features/chat/services/turn-prep.test.ts", type: "blob" },
  { path: "src/styles/app.css", type: "blob" },
];

describe("matchesGlob", () => {
  it("matches a filename pattern at any depth when it has no slash", () => {
    // The rule that makes the tool useful: people write `*.test.ts`, not
    // `**/*.test.ts`, and mean "anywhere".
    expect(matchesGlob("src/features/chat/lib/skills.test.ts", "*.test.ts")).toBe(true);
    expect(matchesGlob("skills.test.ts", "*.test.ts")).toBe(true);
    expect(matchesGlob("src/skills.ts", "*.test.ts")).toBe(false);
  });

  it("keeps a starred segment inside its own directory", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/nested/a.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("src/nested/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/**/*.ts")).toBe(true);
  });

  it("supports alternation", () => {
    expect(matchesGlob("src/a.tsx", "*.{ts,tsx}")).toBe(true);
    expect(matchesGlob("src/a.ts", "*.{ts,tsx}")).toBe(true);
    expect(matchesGlob("src/a.css", "*.{ts,tsx}")).toBe(false);
  });

  it("treats ? as one non-separator character", () => {
    expect(matchesGlob("src/a1.ts", "a?.ts")).toBe(true);
    expect(matchesGlob("src/ab.ts", "a?.ts")).toBe(true);
    expect(matchesGlob("src/a12.ts", "a?.ts")).toBe(false);
  });

  it("is case-sensitive by default and case-insensitive on request", () => {
    expect(matchesGlob("README.md", "readme.md")).toBe(false);
    expect(matchesGlob("README.md", "readme.md", { caseSensitive: false })).toBe(true);
  });

  it("ignores a leading ./ and a trailing slash", () => {
    expect(matchesGlob("./src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/a.ts/")).toBe(true);
  });

  it("does not let regex metacharacters in a filename act as regex", () => {
    // A path with a dot must not match arbitrary characters.
    expect(matchesGlob("src/aXts", "src/a.ts")).toBe(false);
    expect(matchesGlob("src/a.ts", "src/a.ts")).toBe(true);
  });

  it("matches nothing for an empty pattern", () => {
    expect(matchesGlob("src/a.ts", "   ")).toBe(false);
  });
});

describe("findMatchingPaths", () => {
  it("finds tests anywhere for a bare filename pattern", () => {
    expect(findMatchingPaths(ENTRIES, "*.test.ts")).toEqual([
      "src/features/chat/lib/skills.test.ts",
      "src/features/chat/services/turn-prep.test.ts",
    ]);
  });

  it("scopes the search with a subtree instead of a longer pattern", () => {
    expect(findMatchingPaths(ENTRIES, "*.test.ts", "src/features/chat/lib")).toEqual([
      "src/features/chat/lib/skills.test.ts",
    ]);
  });

  it("returns files only — a directory is not a match", () => {
    expect(findMatchingPaths(ENTRIES, "src*")).not.toContain("src");
  });

  it("orders matches by depth, shallowest first", () => {
    const depths = findMatchingPaths(ENTRIES, "*.ts").map((p) => p.split("/").length);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });

  it("says nothing matched rather than guessing", () => {
    expect(findMatchingPaths(ENTRIES, "*.py")).toEqual([]);
  });
});

describe("isWithinSubtree", () => {
  it("accepts everything for an empty prefix", () => {
    expect(isWithinSubtree("src/a.ts", "")).toBe(true);
    expect(isWithinSubtree("src/a.ts", "/")).toBe(true);
  });

  it("scopes to a directory without matching a same-named prefix", () => {
    expect(isWithinSubtree("src/features/a.ts", "src/features")).toBe(true);
    expect(isWithinSubtree("src/features-extra/a.ts", "src/features")).toBe(false);
  });
});
