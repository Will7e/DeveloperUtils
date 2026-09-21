// ============================================================
// Workspace Edit — Exact-String Replacement Rules
// ============================================================
// edit_file is the default way the agent changes code, so its
// failure modes matter as much as its success path: an edit that
// silently touches the wrong region (or silently does nothing)
// corrupts a repository. These tests pin:
//
//  - a unique match is replaced, everything else untouched
//  - an ambiguous match REFUSES unless replaceAll is set
//  - an empty oldString is refused (that is write_file's job)
//  - a miss reports the nearest candidate lines to correct with
//  - no-op edits (identical strings) are refused, not reported as done

import { describe, it, expect } from "vitest";
import { applyStringEdit, countOccurrences, findCandidateLines } from "./edit";

const FILE = [
  "export function greet(name: string) {",
  "  const upper = name.toUpperCase();",
  "  return `Hello ${upper}`;",
  "}",
  "",
  "export function shout(name: string) {",
  "  const upper = name.toUpperCase();",
  "  return upper;",
  "}",
].join("\n");

describe("countOccurrences / findCandidateLines", () => {
  it("counts non-overlapping occurrences", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences(FILE, "  const upper = name.toUpperCase();")).toBe(2);
    expect(countOccurrences(FILE, "nope")).toBe(0);
  });

  it("points at the lines a near miss should have come from", () => {
    // First line of oldString exists, the rest does not — exactly the
    // signature of a whitespace/content mismatch inside a region.
    const nearMiss = [
      "  const upper = name.toUpperCase();",
      "  return `Hello ${upper}`;",
      "  // trailing line that is not in the file",
    ].join("\n");
    expect(findCandidateLines(FILE, nearMiss)).toEqual([2, 7]);
    expect(findCandidateLines(FILE, "completely absent")).toEqual([]);
    expect(findCandidateLines(FILE, "")).toEqual([]);
  });
});

describe("applyStringEdit", () => {
  it("replaces a unique match and leaves the rest byte-identical", () => {
    const outcome = applyStringEdit({
      current: FILE,
      oldString: "  return `Hello ${upper}`;",
      newString: "  return `Hi ${upper}!`;",
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.replacements).toBe(1);
    expect(outcome.content).toContain("  return `Hi ${upper}!`;");
    expect(outcome.content).toContain("export function shout(name: string) {");
    // Untouched regions are preserved exactly.
    expect(outcome.content.split("\n")[1]).toBe("  const upper = name.toUpperCase();");
  });

  it("supports deletion by replacing with an empty string", () => {
    const outcome = applyStringEdit({
      current: FILE,
      oldString: "\n\nexport function shout(name: string) {\n  const upper = name.toUpperCase();\n  return upper;\n}",
      newString: "",
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).not.toContain("shout");
  });

  it("refuses an ambiguous match and says how many places matched", () => {
    const outcome = applyStringEdit({
      current: FILE,
      oldString: "  const upper = name.toUpperCase();",
      newString: "  const upper = name.toLocaleUpperCase();",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.occurrences).toBe(2);
    expect(outcome.error).toContain("matches 2 places");
    expect(outcome.content).toBe(FILE);
  });

  it("applies an ambiguous match everywhere when replaceAll is set", () => {
    const outcome = applyStringEdit({
      current: FILE,
      oldString: "  const upper = name.toUpperCase();",
      newString: "  const upper = name.toLocaleUpperCase();",
      replaceAll: true,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.replacements).toBe(2);
    expect(outcome.content).not.toContain("name.toUpperCase()");
  });

  it("refuses an empty oldString", () => {
    const outcome = applyStringEdit({ current: FILE, oldString: "", newString: "x" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("oldString must not be empty");
    expect(outcome.content).toBe(FILE);
  });

  it("refuses a no-op edit instead of reporting success", () => {
    const outcome = applyStringEdit({
      current: FILE,
      oldString: "export function greet",
      newString: "export function greet",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("identical");
  });

  it("explains a miss and suggests the nearest lines", () => {
    const outcome = applyStringEdit({
      current: FILE,
      oldString: [
        "  const upper = name.toUpperCase();",
        "  return `Hello ${upper}`;",
        "  // not in the file",
      ].join("\n"),
      newString: "  const upper = name.toLowerCase();",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("not found");
    expect(outcome.error).toContain("lines 2, 7");
  });

  it("keeps a $-bearing replacement literal ($&, $`, $' and $n expand in strings)", () => {
    for (const replacement of ["price = `${cost}$`", "echo $'", "regex $&", "backtick $` + ", "$1$2"]) {
      const outcome = applyStringEdit({
        current: "price = 1",
        oldString: "price = 1",
        newString: replacement,
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.content).toBe(replacement);
    }
  });

  it("does not rewrite line endings", () => {
    const crlf = "a\r\nb\r\nc";
    const outcome = applyStringEdit({ current: crlf, oldString: "b", newString: "B" });
    expect(outcome.content).toBe("a\r\nB\r\nc");
  });
});
