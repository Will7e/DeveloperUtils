// ============================================================
// Compaction Boundary — Fold Planning Tests
// ============================================================
// The fold planner decides what the summary will cover, so these are
// the properties that made /compact unreliable before:
//
//  · it must ACTUALLY free the window (fold until the kept tail fits),
//  · it must fold SOMETHING when there is history to fold — a huge
//    first message used to make the whole plan a no-op,
//  · it must never cut inside an agent tool exchange,
//  · and an explicit request must fold even when nothing needs folding.

import { describe, expect, it } from "vitest";
import { COMPACTION_KEEP_RECENT } from "../constants";
import { estimateMessageTokens } from "./tokenizer";
import {
  SUMMARY_MESSAGE_CHAR_CAP,
  buildSummaryUserText,
  pickCompactionBoundary,
} from "./summarizer";
import { isTranscriptBoundary, type ChatMessage } from "../types";

const message = (
  id: string,
  role: ChatMessage["role"],
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage => ({ id, role, content, timestamp: 0, ...extra });

/** A message worth roughly `tokens` at the estimator's prose ratio */
const sized = (id: string, role: ChatMessage["role"], tokens: number): ChatMessage =>
  message(id, role, "x".repeat(Math.round(tokens * 3.9)));

/** `turns` user/assistant exchanges, `perTurn` tokens each side */
function conversation(turns: number, perTurn = 100): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(sized(`u${i}`, "user", perTurn));
    out.push(sized(`a${i}`, "assistant", perTurn));
  }
  return out;
}

const tailTokens = (messages: ChatMessage[], foldCount: number): number =>
  messages
    .slice(foldCount)
    .reduce((sum, m) => sum + estimateMessageTokens(m), 0);

describe("pickCompactionBoundary", () => {
  it("folds until the kept tail fits the target, not merely half a budget", () => {
    const messages = conversation(6, 100); // ~1.25k tokens
    const budget = 1_000; // target = 500

    const { foldCount, foldTokens } = pickCompactionBoundary(messages, budget, 0.5);

    expect(foldCount).toBeGreaterThan(0);
    expect(tailTokens(messages, foldCount)).toBeLessThanOrEqual(500);
    expect(foldTokens).toBeGreaterThan(0);
  });

  it("folds a giant oldest message instead of refusing to compact", () => {
    // The shape that used to answer "Nothing to compact yet" on a full
    // window: the first message alone is bigger than half the budget, so
    // the old accumulator broke before its first iteration.
    const messages = [
      message("paste", "user", "x".repeat(200_000)), // ~51k tokens
      ...conversation(5, 20),
    ];

    const { foldCount } = pickCompactionBoundary(messages, 100_000, 0.5);

    expect(foldCount).toBeGreaterThan(0);
    expect(tailTokens(messages, foldCount)).toBeLessThanOrEqual(50_000);
  });

  it("never cuts between a tool_calls turn and its result", () => {
    const toolCall = (id: string): ChatMessage =>
      message(id, "assistant", "", {
        toolCalls: {
          kind: "tool_calls",
          calls: [{ id: `c-${id}`, name: "read_file", arguments: "{}" }],
        },
      });
    const result = (id: string): ChatMessage =>
      // Tool results are stored as role "user" rows — the trap here.
      message(id, "user", "", {
        toolResult: {
          kind: "tool_result",
          callId: `c-${id.replace("t", "a")}`,
          name: "read_file",
          ok: true,
          content: "file body",
          durationMs: 1,
        },
      });

    const history: ChatMessage[] = [sized("u0", "user", 40), toolCall("a0"), result("t0")];
    for (let i = 1; i < 6; i++) {
      history.push(toolCall(`a${i}`), result(`t${i}`));
    }
    history.push(sized("u9", "user", 40), sized("a9", "assistant", 40));

    for (const budget of [10, 40, 100, 400, 2_000, 50_000]) {
      const { foldCount } = pickCompactionBoundary(history, budget, 0.5);
      const tail = history.slice(foldCount);
      expect(foldCount).toBeLessThanOrEqual(history.length - COMPACTION_KEEP_RECENT);
      // A kept result whose call was folded is a protocol orphan.
      expect(tail[0]?.toolResult).toBeUndefined();
      expect(tail[0] ? isTranscriptBoundary(tail[0]) || !tail[0].toolResult : true).toBe(true);
    }
  });

  it("prefers to start the kept tail on a fresh turn", () => {
    const messages = conversation(8, 100);
    const { foldCount } = pickCompactionBoundary(messages, 1_000, 0.5);
    expect(isTranscriptBoundary(messages[foldCount])).toBe(true);
    expect(messages[foldCount]!.role).toBe("user");
  });

  it("keeps the most recent messages verbatim", () => {
    const messages = conversation(20, 500);
    const { foldCount } = pickCompactionBoundary(messages, 1_000, 0.5);
    expect(foldCount).toBeLessThanOrEqual(messages.length - COMPACTION_KEEP_RECENT);
  });

  it("does nothing when the history already fits — unless asked", () => {
    const messages = conversation(2, 50); // ~250 tokens

    expect(pickCompactionBoundary(messages, 10_000, 0.5).foldCount).toBe(0);

    const forced = pickCompactionBoundary(messages, 10_000, 0.5, undefined, { force: true });
    // The oldest exchange, and no more: a comfortable chat is not nuked
    // down to the last two messages because someone pressed /compact.
    expect(forced.foldCount).toBe(2);
    expect(isTranscriptBoundary(messages[forced.foldCount])).toBe(true);
  });

  it("cannot force a fold out of a single exchange", () => {
    const messages = [sized("u0", "user", 50), sized("a0", "assistant", 50)];
    const { foldCount } = pickCompactionBoundary(messages, 10_000, 0.5, undefined, {
      force: true,
    });
    expect(foldCount).toBe(0);
  });

  it("respects the ceiling one summarization call can read", () => {
    const messages = conversation(20, 500); // ~20k tokens
    const uncapped = pickCompactionBoundary(messages, 1_000, 0.5);
    const capped = pickCompactionBoundary(messages, 1_000, 0.5, undefined, {
      maxFoldTokens: 1_000,
    });

    expect(capped.foldCount).toBeGreaterThan(0);
    expect(capped.foldCount).toBeLessThan(uncapped.foldCount);
    expect(capped.foldTokens).toBeLessThanOrEqual(1_100);
  });

  it("still makes progress when the ceiling cannot hold the oldest message", () => {
    // One 30k-token paste, a 20k budget and a 1k read ceiling: no fold fits
    // the ceiling, so the planner folds the paste alone and lets the next
    // pass handle what is left. Refusing here is what "nothing to compact"
    // on a full window looked like from the outside.
    const messages = [sized("paste", "user", 30_000), ...conversation(4, 100)];
    const { foldCount, foldTokens } = pickCompactionBoundary(messages, 20_000, 0.5, undefined, {
      maxFoldTokens: 1_000,
    });
    expect(foldCount).toBe(1);
    expect(foldTokens).toBeGreaterThan(1_000);
  });
});

describe("buildSummaryUserText", () => {
  it("numbers the transcript from the memory already covered", () => {
    const text = buildSummaryUserText([message("m0", "user", "newest thing")], {
      text: "GOAL: ship it",
      coversCount: 12,
      createdAt: 1,
      freedTokens: 10,
    });
    expect(text).toContain("PREVIOUS LEDGER");
    expect(text).toContain("[12] You: newest thing");
  });

  it("clips a single oversized message so one paste cannot blow the call", () => {
    const text = buildSummaryUserText([
      message("m0", "user", "y".repeat(SUMMARY_MESSAGE_CHAR_CAP + 5_000)),
    ]);
    expect(text).toContain("characters elided");
    expect(text.length).toBeLessThan(SUMMARY_MESSAGE_CHAR_CAP + 500);
  });
});
