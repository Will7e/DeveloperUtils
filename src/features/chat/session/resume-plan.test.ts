import { describe, it, expect } from "vitest";
import { planResume, danglingToolRange, PENDING_TURN_MAX_AGE_MS } from "./resume-plan";
import type { ChatMessage } from "../types";

function userMsg(content = "hi", id = "u1"): ChatMessage {
  return { id, role: "user", content, timestamp: 1 };
}

function assistantMsg(content: string, id = "a1", extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "assistant", content, timestamp: 2, ...extra };
}

const NOW = 1_000_000_000_000;
const freshMarker = { startedAt: NOW - 60_000 };

describe("planResume", () => {
  it("returns keep when no marker is present", () => {
    const plan = planResume([userMsg(), assistantMsg("done")], undefined, NOW);
    expect(plan.action).toBe("keep");
  });

  it("cleans up stale markers (>24h)", () => {
    const stale = { startedAt: NOW - PENDING_TURN_MAX_AGE_MS - 1 };
    const plan = planResume([userMsg()], stale, NOW);
    expect(plan.action).toBe("cleanup");
  });

  it("restreams a trailing plain user message", () => {
    const plan = planResume([userMsg(), assistantMsg("earlier"), userMsg("again", "u2")], freshMarker, NOW);
    expect(plan.action).toBe("restream");
  });

  it("restreams after a committed partial reply", () => {
    const plan = planResume(
      [userMsg(), assistantMsg("partial", "a2", { resumedPartial: true })],
      freshMarker,
      NOW
    );
    expect(plan.action).toBe("restream-after-partial");
    expect(plan.partialMessageId).toBe("a2");
  });

  it("continues the tool loop after trailing tool results", () => {
    const conv: ChatMessage[] = [
      userMsg(),
      {
        id: "tc1",
        role: "assistant",
        content: "",
        timestamp: 2,
        toolCalls: { kind: "tool_calls", calls: [{ id: "call_1", name: "read_file", arguments: "{}" }] },
      },
      {
        id: "tr1",
        role: "user",
        content: "",
        timestamp: 3,
        toolResult: { kind: "tool_result", callId: "call_1", name: "read_file", ok: true, content: "...", durationMs: 5 },
      },
    ];
    const plan = planResume(conv, freshMarker, NOW);
    expect(plan.action).toBe("continue-tool-loop");
    expect(plan.trimToCallId).toBeUndefined();
  });

  it("trims dangling tool calls interrupted before execution", () => {
    const conv: ChatMessage[] = [
      userMsg(),
      {
        id: "tc1",
        role: "assistant",
        content: "",
        timestamp: 2,
        toolCalls: {
          kind: "tool_calls",
          calls: [
            { id: "call_1", name: "read_file", arguments: "{}" },
            { id: "call_2", name: "search_code", arguments: "{}" },
          ],
        },
      },
    ];
    const plan = planResume(conv, freshMarker, NOW);
    expect(plan.action).toBe("continue-tool-loop");
    expect(plan.trimToCallId).toBe("call_2");
  });

  it("cleans up when the turn completed but the marker survived", () => {
    const plan = planResume([userMsg(), assistantMsg("full reply")], freshMarker, NOW);
    expect(plan.action).toBe("cleanup");
  });

  it("marks error tails as needing user action", () => {
    const plan = planResume([userMsg(), assistantMsg("boom", "a2", { error: true })], freshMarker, NOW);
    expect(plan.action).toBe("needs-user-action");
  });

  it("cleans up a marker over an empty transcript", () => {
    const plan = planResume([], freshMarker, NOW);
    expect(plan.action).toBe("cleanup");
  });

  it("treats a trailing plain assistant reply as complete (marker cleanup)", () => {
    const plan = planResume([userMsg(), assistantMsg("x", "a2", { resumedPartial: false })], freshMarker, NOW);
    expect(plan.action).toBe("cleanup");
  });
});

describe("danglingToolRange", () => {
  it("counts trailing results plus the calls message", () => {
    const conv: ChatMessage[] = [
      userMsg(),
      {
        id: "tc1",
        role: "assistant",
        content: "",
        timestamp: 2,
        toolCalls: { kind: "tool_calls", calls: [{ id: "call_1", name: "read_file", arguments: "{}" }] },
      },
      {
        id: "tr1",
        role: "user",
        content: "",
        timestamp: 3,
        toolResult: { kind: "tool_result", callId: "call_1", name: "read_file", ok: true, content: "...", durationMs: 1 },
      },
    ];
    expect(danglingToolRange(conv, "call_1")).toBe(2);
  });

  it("returns 0 when the tail has no matching calls message", () => {
    const conv: ChatMessage[] = [userMsg(), assistantMsg("no tools")];
    expect(danglingToolRange(conv, "call_9")).toBe(0);
  });
});
