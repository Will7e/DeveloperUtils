// ============================================================
// Scorecard — Counting A Transcript, And Following The Wording
// ============================================================
// Two properties matter. The counts must reflect what the transcript
// actually contains (tool results are not user turns; a harness notice is
// not a reply), and the detection must follow the harness's own wording —
// a metric that matches a sentence nobody writes any more reports zero
// forever, which is the most expensive kind of wrong number.

import { describe, expect, it } from "vitest";
import { buildScorecard, formatScorecard, scoreConversation, summarizeScorecard } from "./scorecard";
import { completionNudge } from "./completion-gate";
import { continuationExhaustedNotice, isContinuationNudge, isHandoffNotice, TOOL_LIMIT_NOTICE } from "./harness-notices";
import type { ChatConversation, ChatMessage } from "../types";
import type { TurnLogEntry } from "../session/turn-log";

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "role">): ChatMessage {
  return { id: Math.random().toString(36), timestamp: 0, content: "", ...over };
}

function conversation(messages: ChatMessage[]): ChatConversation {
  return { id: "c1", title: "t", messages, createdAt: 0, updatedAt: 0 };
}

const toolRound = (name = "read_file") =>
  msg({ role: "assistant", toolCalls: { kind: "tool_calls", calls: [{ id: "x", name: name as never, arguments: "{}" }] } });

const toolFail = () =>
  msg({
    role: "user",
    toolResult: { kind: "tool_result", callId: "x", name: "read_file", ok: false, content: "{}", durationMs: 1 },
  });

describe("scoreConversation", () => {
  it("counts turns, rounds, failures and questions", () => {
    const score = scoreConversation(
      conversation([
        msg({ role: "user", content: "do the thing" }),
        toolRound(),
        toolFail(),
        toolRound("ask_user"),
        msg({ role: "assistant", content: "done" }),
        msg({ role: "user", content: "and another" }),
      ])
    );
    expect(score).toMatchObject({
      chats: 1,
      turns: 2,
      toolRounds: 2,
      toolFailures: 1,
      questions: 1,
      nudges: 0,
      handoffs: 0,
    });
  });

  it("does not count a tool result as a user turn", () => {
    const score = scoreConversation(conversation([toolFail()]));
    expect(score.turns).toBe(0);
    expect(score.toolFailures).toBe(1);
  });

  it("ignores soft-deleted messages", () => {
    const score = scoreConversation(
      conversation([msg({ role: "user", content: "hidden", hidden: true })])
    );
    expect(score.turns).toBe(0);
  });

  it("separates a harness continuation from a reply the model wrote", () => {
    const score = scoreConversation(
      conversation([
        msg({ role: "user", content: "go" }),
        msg({ role: "assistant", content: "I stopped early." }),
        msg({ role: "assistant", content: completionNudge([{ kind: "check-failing", label: "Tests", summary: "s", details: [] }]) }),
      ])
    );
    expect(score.nudges).toBe(1);
    expect(score.handoffs).toBe(0);
  });
});

describe("harness-notice detection follows the harness", () => {
  it("recognises the nudge the gate actually writes", () => {
    // The drift guard: the sentence and the detector come from the same
    // place, so rewording the nudge cannot silently zero the metric.
    const nudge = completionNudge([{ kind: "plan-unfinished", stepIndex: 1, stepCount: 2, step: "s" }]);
    expect(isContinuationNudge(nudge)).toBe(true);
    expect(isHandoffNotice(continuationExhaustedNotice("plan step 1 of 2 is open"))).toBe(true);
    expect(isHandoffNotice(TOOL_LIMIT_NOTICE)).toBe(true);
    expect(isContinuationNudge("Just a normal answer.")).toBe(false);
  });
});

describe("buildScorecard", () => {
  const conversations = [
    conversation([
      msg({ role: "user", content: "one" }),
      toolRound(),
      msg({ role: "assistant", content: TOOL_LIMIT_NOTICE }),
      msg({ role: "user", content: "two" }),
      msg({ role: "assistant", content: "done properly" }),
      msg({ role: "user", content: "three" }),
      toolRound(),
      toolRound(),
      msg({ role: "assistant", content: "done properly again" }),
    ]),
  ];

  it("reports the handoff rate as a share of turns", () => {
    const card = buildScorecard(conversations);
    expect(card.turns).toBe(3);
    expect(card.handoffs).toBe(1);
    expect(card.handoffRate).toBeCloseTo(33.3, 1);
    expect(card.roundsPerTurn).toBeCloseTo(1.0, 5);
  });

  it("keeps session-only facts separate from the transcript counts", () => {
    const log: TurnLogEntry[] = [
      { at: 1, turnId: "t1", conversationId: "c1", phase: "failover", detail: "stalled on a → b" },
      { at: 2, turnId: "t1", conversationId: "c1", phase: "abort" },
      { at: 3, turnId: null, conversationId: "c1", phase: "completion-gate", detail: "unfinished — x" },
    ];
    const card = buildScorecard(conversations, log);
    expect(card.session).toMatchObject({ events: 3, failovers: 1, aborts: 1, completionGates: 1 });
    // A session fact must NOT leak into the transcript-derived rate.
    expect(card.handoffs).toBe(1);
  });

  it("handles an empty history without dividing by zero", () => {
    const card = buildScorecard([]);
    expect(card.turns).toBe(0);
    expect(card.handoffRate).toBe(0);
    expect(summarizeScorecard(card)).toBe("no turns yet");
    expect(formatScorecard(card)).toMatch(/No finished turns/);
  });

  it("renders a readable report with the rate in it", () => {
    const text = formatScorecard(buildScorecard(conversations));
    expect(text).toContain("Handed back to you");
    expect(text).toContain("33");
    expect(text).toContain("This session");
  });
});
