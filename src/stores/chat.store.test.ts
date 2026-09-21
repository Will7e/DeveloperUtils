// ============================================================
// Chat Store — Conversation Context Clearing (/clear)
// ============================================================
// /clear is the one command that deliberately makes a conversation
// forget. It must do that WITHOUT destroying anything: the session
// log is the audit trail of what the model saw, so clearing hides
// messages (recoverable) and drops the rolling summary (which would
// otherwise keep feeding the model the context being cleared).

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "./chat.store";
import { visibleMessages } from "@/features/chat/types";

function store() {
  return useChatStore.getState();
}

function messagesOf(conversationId: string) {
  return store().conversations.find((c) => c.id === conversationId)?.messages ?? [];
}

let conversationId = "";
let otherId = "";

beforeEach(() => {
  otherId = store().createConversation("model-a");
  store().addMessage(otherId, { role: "user", content: "untouched conversation" });
  conversationId = store().createConversation("model-a");
  store().addMessage(conversationId, { role: "user", content: "first" });
  store().addMessage(conversationId, { role: "assistant", content: "second" });
});

describe("clearConversationContext", () => {
  it("hides every stored message without deleting any", () => {
    const before = messagesOf(conversationId);
    expect(visibleMessages(before)).toHaveLength(2);

    store().clearConversationContext(conversationId);

    const after = messagesOf(conversationId);
    expect(after).toHaveLength(before.length); // nothing destroyed
    expect(visibleMessages(after)).toHaveLength(0); // nothing sent
    expect(after.every((m) => m.hidden === true)).toBe(true);
    // Content survives for the session log / export
    expect(after.map((m) => m.content)).toEqual(["first", "second"]);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
  });

  it("drops the rolling summary that described the cleared history", () => {
    store().applyCompaction(conversationId, {
      text: "Earlier: the user said first, the assistant said second.",
      coversCount: 0,
      createdAt: Date.now(),
      freedTokens: 42,
    });
    expect(store().conversations.find((c) => c.id === conversationId)?.summary).toBeTruthy();

    store().clearConversationContext(conversationId);

    expect(store().conversations.find((c) => c.id === conversationId)?.summary).toBeUndefined();
  });

  it("leaves other conversations alone", () => {
    store().clearConversationContext(conversationId);
    const other = messagesOf(otherId);
    expect(visibleMessages(other)).toHaveLength(1);
    expect(other[0]!.hidden ?? false).toBe(false);
  });
});
