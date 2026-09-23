// ============================================================
// Agent Question — Argument Rules and Answer Reading
// ============================================================
// These are the rules that decide whether a question is worth showing a
// person. The interesting cases are the REJECTIONS: a catch-all option, a
// pile of options, a question that is really a paragraph. Each one is a card
// that would waste the user's attention, and the executor can only refuse it
// because this module says so.

import { describe, expect, it } from "vitest";
import {
  answerSummary,
  isEmptyAnswer,
  isCatchAllOption,
  parseQuestionArgs,
  parseSuggestionArgs,
  questionResultPayload,
  readStoredQuestionResult,
  sanitizeAnswer,
} from "./agent-question";
import type { AgentQuestion, AgentQuestionAnswer } from "../types";

const valid = {
  header: "Auth strategy",
  question: "Should sessions live in a cookie or in a signed token?",
  options: [
    { label: "Signed cookie (Recommended)", description: "Fewer moving parts." },
    { label: "Server session", description: "Revocable centrally." },
  ],
};

describe("parseQuestionArgs", () => {
  it("accepts a well-formed question and trims it", () => {
    const parsed = parseQuestionArgs({ ...valid, header: "  Auth strategy  " });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.header).toBe("Auth strategy");
    expect(parsed.value.options).toHaveLength(2);
    expect(parsed.value.multiSelect).toBeUndefined();
  });

  it("keeps a description but never lets one bloat the card", () => {
    const parsed = parseQuestionArgs({
      ...valid,
      options: [{ label: "Yes", description: "x".repeat(500) }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.options[0]!.description!.length).toBe(200);
  });

  it("refuses a catch-all option, and says what to send instead", () => {
    // The free-text box is always there, so "Other" spends one of four slots
    // describing the thing the user would do anyway.
    for (const label of ["Other", "None of the above", "something else"]) {
      const parsed = parseQuestionArgs({ ...valid, options: [{ label }] });
      expect(parsed.ok, label).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).toMatch(/catch-all|type their own answer/);
    }
    expect(isCatchAllOption("Other")).toBe(true);
    expect(isCatchAllOption("Signed cookie")).toBe(false);
  });

  it("refuses more options than the card can show", () => {
    const parsed = parseQuestionArgs({
      ...valid,
      options: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("maximum");
  });

  it("refuses an empty option list and duplicate labels", () => {
    expect(parseQuestionArgs({ ...valid, options: [] }).ok).toBe(false);
    const dup = parseQuestionArgs({
      ...valid,
      options: [{ label: "Same" }, { label: "same" }],
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.error).toContain("duplicates");
  });

  it("refuses a question that is really a paragraph", () => {
    const parsed = parseQuestionArgs({ ...valid, question: "Why? ".repeat(80) });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/ONE thing/);
  });

  it("requires a header and a question", () => {
    expect(parseQuestionArgs({ options: valid.options }).ok).toBe(false);
    expect(parseQuestionArgs({ header: "Hi", options: valid.options }).ok).toBe(false);
  });

  it("refuses multiSelect on a single option", () => {
    const parsed = parseQuestionArgs({
      ...valid,
      options: [{ label: "Only one" }],
      multiSelect: true,
    });
    expect(parsed.ok).toBe(false);
  });

  it("accepts a plain string option, because models emit that", () => {
    const parsed = parseQuestionArgs({ ...valid, options: ["Ship it", "Wait"] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.options.map((o) => o.label)).toEqual(["Ship it", "Wait"]);
  });
});

describe("sanitizeAnswer", () => {
  const question: Pick<AgentQuestion, "options"> = {
    options: [{ label: "Ship it" }, { label: "Wait" }],
  };

  it("keeps only labels the question actually offered", () => {
    // A stale card must not be able to decide with a label the model never
    // proposed — the model treats the answer as a decision it can act on.
    const answer = sanitizeAnswer(question, { selected: ["Ship it", "Delete prod"], note: "go" });
    expect(answer.selected).toEqual(["Ship it"]);
    expect(answer.note).toBe("go");
  });

  it("accepts a typed answer with nothing picked", () => {
    const answer = sanitizeAnswer(question, { note: "  neither — use OAuth  " });
    expect(answer.selected).toEqual([]);
    expect(answer.note).toBe("neither — use OAuth");
    expect(isEmptyAnswer(answer)).toBe(false);
    expect(answerSummary(answer)).toBe("answered: neither — use OAuth");
  });

  it("marks an empty click as no answer at all", () => {
    const answer = sanitizeAnswer(question, {});
    expect(isEmptyAnswer(answer)).toBe(true);
    expect(answerSummary(answer)).toBe("answer not given");
  });
});

describe("questionResultPayload / readStoredQuestionResult", () => {
  const question: AgentQuestion = {
    header: "Auth strategy",
    question: "Cookie or token?",
    options: [
      { label: "Signed cookie", description: "Fewer moving parts." },
      { label: "Server session", description: "Revocable centrally." },
    ],
    callId: "call_1",
    askedAt: 5,
  };
  const answer: AgentQuestionAnswer = { selected: ["Signed cookie"], answeredAt: 9 };

  it("round-trips through a stored transcript row", () => {
    // This is what lets an answered card render from persisted history
    // rather than needing the question to still be in memory.
    const stored = readStoredQuestionResult(questionResultPayload(question, answer));
    expect(stored?.question.header).toBe("Auth strategy");
    expect(stored?.question.options).toHaveLength(2);
    expect(stored?.answer.selected).toEqual(["Signed cookie"]);
  });

  it("tells the model not to ask the same thing twice", () => {
    const payload = questionResultPayload(question, answer);
    expect(String(payload.note)).toContain("do not ask the same question again");
  });

  it("degrades to null on a hand-edited row instead of throwing", () => {
    expect(readStoredQuestionResult(null)).toBeNull();
    expect(readStoredQuestionResult({ nope: true })).toBeNull();
    expect(readStoredQuestionResult("{}")).toBeNull();
  });
});

describe("parseSuggestionArgs", () => {
  it("accepts two to four self-contained next steps", () => {
    const parsed = parseSuggestionArgs({
      suggestions: [
        { label: "Add tests", prompt: "Add unit tests for the new parser." },
        { label: "Ship it", prompt: "Push the change and open a pull request." },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(2);
  });

  it("refuses one lonely chip and an over-long label", () => {
    expect(parseSuggestionArgs({ suggestions: [{ label: "a", prompt: "b" }] }).ok).toBe(false);
    expect(
      parseSuggestionArgs({
        suggestions: [
          { label: "This label is far too long for a chip", prompt: "x" },
          { label: "ok", prompt: "y" },
        ],
      }).ok
    ).toBe(false);
  });

  it("requires both halves of a suggestion", () => {
    expect(
      parseSuggestionArgs({ suggestions: [{ label: "No prompt" }, { label: "b", prompt: "y" }] }).ok
    ).toBe(false);
  });
});
