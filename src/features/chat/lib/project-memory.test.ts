// ============================================================
// Project Memory — Format & Bounds Tests
// ============================================================
// Memory is a file a human reviews in a pull request, so its two jobs
// are to stay readable (no duplicate noise, one fact per line) and to
// stay bounded (an agent must never be able to grow it without limit).

import { describe, it, expect } from "vitest";
import {
  appendMemory,
  hasFact,
  MEMORY_FACT_MAX_CHARS,
  MEMORY_HEADER,
  MEMORY_MAX_FACTS,
  MEMORY_PATH,
  memoryFactOf,
  parseMemoryFacts,
} from "./project-memory";

describe("memoryFactOf / parseMemoryFacts", () => {
  it("reads entries and ignores prose, headings and comments", () => {
    const text = [
      MEMORY_HEADER,
      "",
      "- Tests run with `npm test` (vitest). (recorded 2026-09-21)",
      "Some prose the agent should not have written",
      "## A heading",
      "- The API layer owns retries. (recorded 2026-09-22)",
    ].join("\n");
    expect(parseMemoryFacts(text)).toEqual([
      "Tests run with `npm test` (vitest).",
      "The API layer owns retries.",
    ]);
  });

  it("tolerates entries without a date", () => {
    expect(memoryFactOf("- A bare fact")).toBe("A bare fact");
    expect(memoryFactOf("not a fact")).toBeNull();
    expect(memoryFactOf("-   ")).toBeNull();
  });

  it("returns nothing for empty input", () => {
    expect(parseMemoryFacts(null)).toEqual([]);
    expect(parseMemoryFacts("")).toEqual([]);
  });
});

describe("appendMemory", () => {
  it("creates the file with its header on first write", () => {
    const { content, added } = appendMemory(null, "Tests run with `npm test`.", 0);
    expect(added).toBe(true);
    expect(content.startsWith(MEMORY_HEADER)).toBe(true);
    expect(parseMemoryFacts(content)).toEqual(["Tests run with `npm test`."]);
    expect(memoryFactOf("- Tests run with `npm test`. (recorded 1970-01-01)")).toBe(
      "Tests run with `npm test`."
    );
  });

  it("appends to an existing file without repeating the header", () => {
    const first = appendMemory(null, "Fact one.", 0).content;
    const second = appendMemory(first, "Fact two.", 0).content;
    expect(second.match(/# Project memory/g)).toHaveLength(1);
    expect(parseMemoryFacts(second)).toEqual(["Fact one.", "Fact two."]);
  });

  it("refuses to record the same fact twice", () => {
    const first = appendMemory(null, "Tests run with `npm test`.", 0).content;
    const again = appendMemory(first, "tests run with `npm test`", 0);
    expect(again.added).toBe(false);
    expect(again.content).toBe(first);
    expect(parseMemoryFacts(again.content)).toHaveLength(1);
  });

  it("collapses a multi-line fact into one line", () => {
    const { content } = appendMemory(null, "First line\n\nsecond line", 0);
    expect(parseMemoryFacts(content)).toEqual(["First line second line"]);
  });

  it("bounds a single fact", () => {
    const { content } = appendMemory(null, "x".repeat(MEMORY_FACT_MAX_CHARS * 3), 0);
    expect(parseMemoryFacts(content)[0]!.length).toBe(MEMORY_FACT_MAX_CHARS);
  });

  it("drops the oldest facts past the cap", () => {
    let text: string | null = null;
    for (let i = 0; i < MEMORY_MAX_FACTS + 5; i++) {
      text = appendMemory(text, `Fact number ${i}.`, 0).content;
    }
    const facts = parseMemoryFacts(text);
    expect(facts).toHaveLength(MEMORY_MAX_FACTS);
    expect(facts).not.toContain("Fact number 0.");
    expect(facts).toContain(`Fact number ${MEMORY_MAX_FACTS + 4}.`);
  });

  it("keeps the header when the cap trims entries", () => {
    let text: string | null = null;
    for (let i = 0; i < MEMORY_MAX_FACTS + 2; i++) {
      text = appendMemory(text, `Fact ${i}.`, 0).content;
    }
    expect(text!.startsWith(MEMORY_HEADER)).toBe(true);
  });
});

describe("hasFact", () => {
  it("ignores case, punctuation and spacing differences", () => {
    const text = appendMemory(null, "Tests run with `npm test`.", 0).content;
    expect(hasFact(text, "  tests   run with `npm test` ")).toBe(true);
    expect(hasFact(text, "Something else entirely")).toBe(false);
    expect(hasFact(null, "anything")).toBe(false);
  });
});

describe("MEMORY_PATH", () => {
  it("is a repo-relative path that will not collide with source", () => {
    expect(MEMORY_PATH).toBe(".intab/memory.md");
    expect(MEMORY_PATH.startsWith("/")).toBe(false);
  });
});
