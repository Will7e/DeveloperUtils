import { describe, expect, it } from "vitest";
import {
  readToolResultPayload,
  summarizeToolStep,
  sumStepChanges,
} from "./tool-step-summary";

describe("readToolResultPayload", () => {
  it("parses a plain JSON object payload", () => {
    expect(readToolResultPayload('{"path":"src/App.tsx","status":"modified"}')).toEqual({
      path: "src/App.tsx",
      status: "modified",
    });
  });

  it("unwraps an untrusted-content wrapper before parsing", () => {
    const content = [
      '<untrusted-content source="read_file">',
      '{"path":"README.md","lines":3}',
      "</untrusted-content>",
    ].join("\n");
    expect(readToolResultPayload(content)).toEqual({ path: "README.md", lines: 3 });
  });

  it("returns null instead of throwing on malformed JSON", () => {
    expect(readToolResultPayload("{not json")).toBeNull();
    expect(readToolResultPayload("")).toBeNull();
    expect(readToolResultPayload(undefined)).toBeNull();
  });

  it("rejects JSON that is not an object", () => {
    expect(readToolResultPayload("[1,2,3]")).toBeNull();
    expect(readToolResultPayload("42")).toBeNull();
    expect(readToolResultPayload("null")).toBeNull();
  });

  it("survives a wrapper whose body is not JSON", () => {
    const content = '<untrusted-content source="read_file">\nplain text\n</untrusted-content>';
    expect(readToolResultPayload(content)).toBeNull();
  });
});

describe("summarizeToolStep", () => {
  it("reports nothing for a missing payload", () => {
    expect(summarizeToolStep(null)).toEqual({ additions: 0, deletions: 0, facts: [] });
  });

  it("describes an added file with its additions", () => {
    const summary = summarizeToolStep({ status: "added", additions: 42, deletions: 0 });
    expect(summary.additions).toBe(42);
    expect(summary.deletions).toBe(0);
    expect(summary.facts).toEqual(["new file"]);
  });

  it("summarises a multi-replacement edit with its line delta", () => {
    const summary = summarizeToolStep({
      status: "modified",
      replacements: 2,
      lineDelta: -3,
      additions: 7,
      deletions: 3,
    });
    expect(summary.facts).toEqual(["modified", "2×"]);
    expect(summary.additions).toBe(7);
  });

  it("keeps the failure text as the last fact", () => {
    const summary = summarizeToolStep({ error: "typecheck failed: bad types" });
    expect(summary.facts).toEqual(["typecheck failed: bad types"]);
  });

  it("drops a blank error and non-numeric counts", () => {
    // A whitespace-only error must not consume the fact slot.
    const summary = summarizeToolStep({ error: "   ", additions: "nope", status: "added" });
    expect(summary.facts).toEqual(["new file"]);
    expect(summary.additions).toBe(0);
  });

  it("keeps a failure's message inside the two-fact cap", () => {
    const summary = summarizeToolStep({
      status: "modified",
      replacements: 4,
      lineDelta: 9,
      error: "partial failure",
    });
    expect(summary.facts).toEqual(["modified", "partial failure"]);
  });
});

describe("sumStepChanges", () => {
  it("totals additions and deletions across steps", () => {
    expect(
      sumStepChanges([
        { additions: 10, deletions: 2, facts: [] },
        { additions: 5, deletions: 0, facts: [] },
      ])
    ).toEqual({ additions: 15, deletions: 2 });
  });

  it("is zero for no steps", () => {
    expect(sumStepChanges([])).toEqual({ additions: 0, deletions: 0 });
  });
});
