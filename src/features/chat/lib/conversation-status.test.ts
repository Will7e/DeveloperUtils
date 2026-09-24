// The precedence is the whole point of this module, so every test is an
// overlap: two facts are true at once and exactly one of them may win. The
// negative cases matter just as much — an errored USER message is not a failed
// turn, and a thread that has never been on screen is not an alert.
import { describe, it, expect } from "vitest";
import {
  conversationStatus,
  groupStatus,
  rollupConversationStatus,
  type ConversationStatusInput,
} from "./conversation-status";
import type { ChatConversation, ChatMessage } from "../types";

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role: "assistant", content: "done", timestamp: 1, ...over };
}

function conversation(over: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: "c1",
    title: "A chat",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function status(over: Partial<ConversationStatusInput> = {}) {
  return conversationStatus({
    conversation: conversation(),
    streamingConversationId: null,
    reconnecting: false,
    checksRunningFor: null,
    isActive: false,
    lastSeenAt: 1,
    ...over,
  });
}

describe("conversationStatus — one glyph, and one reason for it", () => {
  it("is idle when nothing is happening and nothing is new", () => {
    expect(status().kind).toBe("idle");
    expect(status().label).toBe("");
  });

  it("reports a stream in THIS thread as running, and another thread's as not", () => {
    expect(status({ streamingConversationId: "c1" }).kind).toBe("running");
    expect(status({ streamingConversationId: "other" }).kind).toBe("idle");
  });

  it("says a reconnect is a reconnect rather than ordinary work", () => {
    const reconnecting = status({ streamingConversationId: "c1", reconnecting: true });
    expect(reconnecting.kind).toBe("running");
    expect(reconnecting.label).toMatch(/reconnect/i);
  });

  it("counts a user-initiated check run as work", () => {
    expect(status({ checksRunningFor: "c1" }).kind).toBe("running");
    expect(status({ checksRunningFor: "c1" }).label).toMatch(/checks/i);
  });

  it("prefers RUNNING over unread — a live turn is not a history lesson", () => {
    // Both are true: it streamed while we were away, and it is streaming now.
    const s = status({
      conversation: conversation({ updatedAt: 9_000 }),
      streamingConversationId: "c1",
      lastSeenAt: 1,
    });
    expect(s.kind).toBe("running");
  });

  it("prefers RUNNING over a failure in the transcript", () => {
    const s = status({
      conversation: conversation({ messages: [message({ error: true })] }),
      streamingConversationId: "c1",
    });
    expect(s.kind).toBe("running");
  });

  it("parks on a question, and says a person is what it is waiting for", () => {
    const s = status({
      conversation: conversation({
        pendingQuestion: {
          header: "Which?",
          question: "Pick one",
          options: [{ label: "a" }],
          callId: "call-1",
          askedAt: 2,
        },
      }),
    });
    expect(s.kind).toBe("waiting");
    expect(s.needsUser).toBe(true);
  });

  it("parks on an interrupted turn that only a resume can finish", () => {
    const s = status({
      conversation: conversation({ pendingTurn: { startedAt: 2, outcome: "unresumable" } }),
    });
    expect(s.kind).toBe("waiting");
    expect(s.needsUser).toBe(true);
    expect(s.label).toMatch(/interrupted/i);
  });

  it("prefers WAITING over unread — a parked turn is not a notification", () => {
    const s = status({
      conversation: conversation({
        updatedAt: 9_000,
        pendingTurn: { startedAt: 2, outcome: "unresumable" },
      }),
      lastSeenAt: 1,
    });
    expect(s.kind).toBe("waiting");
  });

  it("reports the last assistant reply's error, and only that one", () => {
    const failed = status({
      conversation: conversation({ messages: [message({ id: "m1" }), message({ id: "m2", error: true })] }),
    });
    expect(failed.kind).toBe("failed");
    expect(failed.needsUser).toBe(true);

    // An error that was followed by a good reply is history, not status.
    const recovered = status({
      conversation: conversation({ messages: [message({ id: "m1", error: true }), message({ id: "m2" })] }),
    });
    expect(recovered.kind).toBe("idle");

    // A user's own message cannot fail a turn.
    const userError = status({
      conversation: conversation({ messages: [message({ id: "m1", role: "user", error: true })] }),
    });
    expect(userError.kind).toBe("idle");
  });

  it("only calls a thread unread when it moved after it was last on screen", () => {
    const moved = status({ conversation: conversation({ updatedAt: 50 }), lastSeenAt: 10 });
    expect(moved.kind).toBe("unread");

    // Equal timestamps are not movement: a row must not light up for reading it.
    expect(status({ conversation: conversation({ updatedAt: 10 }), lastSeenAt: 10 }).kind).toBe("idle");
  });

  it("does NOT treat a thread it has never shown as an alert", () => {
    // "Never seen this session" is the honest reading of "was already like this
    // when you arrived". A cold start with thirty chats is not thirty alerts.
    const s = status({ conversation: conversation({ updatedAt: 9_000 }), lastSeenAt: undefined });
    expect(s.kind).toBe("idle");
  });

  it("never marks the thread you are looking at as unread", () => {
    const s = status({
      conversation: conversation({ updatedAt: 9_000 }),
      lastSeenAt: 1,
      isActive: true,
    });
    expect(s.kind).toBe("idle");
  });

  it("prefers UNREAD over idle for a thread that finished while you were elsewhere", () => {
    const s = status({ conversation: conversation({ updatedAt: 9_000 }), lastSeenAt: 1 });
    expect(s.kind).toBe("unread");
    expect(s.needsUser).toBe(false);
    expect(s.label).toMatch(/away/i);
  });
});

describe("rollupConversationStatus — what a folded repo says", () => {
  it("takes the loudest thread: running, then waiting, then failed, then unread", () => {
    expect(rollupConversationStatus(["idle", "unread", "running"])).toBe("running");
    expect(rollupConversationStatus(["unread", "waiting"])).toBe("waiting");
    expect(rollupConversationStatus(["unread", "failed"])).toBe("failed");
    expect(rollupConversationStatus(["idle", "unread"])).toBe("unread");
    expect(rollupConversationStatus(["idle", "idle"])).toBe("idle");
  });

  it("is idle when there is nothing to report, however many nothings", () => {
    expect(rollupConversationStatus([])).toBe("idle");
  });

  it("gives a group header a sentence for its glyph", () => {
    expect(groupStatus(["running"]).label).toMatch(/working/i);
    expect(groupStatus(["waiting"]).needsUser).toBe(true);
    expect(groupStatus(["unread"]).label).toMatch(/away/i);
    expect(groupStatus(["idle"]).label).toBe("");
  });
});
