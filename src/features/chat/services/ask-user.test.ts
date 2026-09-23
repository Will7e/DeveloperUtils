// ============================================================
// Ask User — Parking, Answering, Stopping
// ============================================================
// The property under test is that a question PARKS the turn rather than
// ending it: the call does not resolve until an answer arrives, the question
// is on the conversation while it waits, and stopping the turn settles it
// with no answer instead of leaving it hanging forever.

import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "@/stores/chat.store";
import { isWaitingForAnswer, runAskUser, runSuggestNext, settlePendingQuestion, waitingCallId } from "./ask-user";
import { answerQuestion } from "./chat-runner";
import { waitForIdle } from "../session/turn-engine";
import type { AgentQuestionAnswer } from "../types";

const ARGS = {
  header: "Auth strategy",
  question: "Should sessions live in a cookie or in a signed token?",
  options: [{ label: "Signed cookie (Recommended)" }, { label: "Server session" }],
};

let conversationId = "";

beforeEach(() => {
  useChatStore.setState({ conversations: [] });
  conversationId = useChatStore.getState().createConversation("test/model");
});

function pendingQuestion() {
  return useChatStore.getState().conversations.find((c) => c.id === conversationId)?.pendingQuestion;
}

describe("runAskUser", () => {
  it("parks on the question and resolves with the answer", async () => {
    const result = runAskUser(conversationId, ARGS, { callId: "call_1" });

    // Parked, not finished: the question is published and the call is still
    // in flight, which is what makes the loop wait instead of guessing.
    expect(pendingQuestion()?.header).toBe("Auth strategy");
    expect(pendingQuestion()?.callId).toBe("call_1");
    expect(waitingCallId(conversationId)).toBe("call_1");
    expect(isWaitingForAnswer(conversationId)).toBe(true);

    const answer: AgentQuestionAnswer = { selected: ["Signed cookie (Recommended)"], answeredAt: 1 };
    expect(settlePendingQuestion(conversationId, answer)).toBe(true);
    // Answering clears the card…
    expect(pendingQuestion()).toBeUndefined();

    const settled = await result;
    expect(settled.ok).toBe(true);
    expect(settled.name).toBe("ask_user");
    expect(settled.summary).toContain("Signed cookie");
    expect(settled.data).toMatchObject({ answer: { selected: ["Signed cookie (Recommended)"] } });
    expect(isWaitingForAnswer(conversationId)).toBe(false);
  });

  it("carries a typed answer through, with nothing picked", async () => {
    const result = runAskUser(conversationId, ARGS, { callId: "call_2" });
    settlePendingQuestion(conversationId, { selected: [], note: "use OAuth", answeredAt: 1 });
    const settled = await result;
    expect(settled.summary).toBe("answered: use OAuth");
    expect(settled.data).toMatchObject({ answer: { note: "use OAuth" } });
  });

  it("returns a cancelled result when the turn is stopped", async () => {
    const controller = new AbortController();
    const result = runAskUser(conversationId, ARGS, { callId: "call_3", signal: controller.signal });
    controller.abort();

    const settled = await result;
    // A stop is not an answer: the model must not read consent into it.
    expect(settled.ok).toBe(false);
    expect(settled.data).toMatchObject({ cancelled: true });
    expect(settled.summary).toContain("unanswered");
    expect(pendingQuestion()).toBeUndefined();
  });

  it("never parks when the turn was already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const settled = await runAskUser(conversationId, ARGS, { callId: "call_4", signal: controller.signal });
    expect(settled.ok).toBe(false);
    expect(pendingQuestion()).toBeUndefined();
    expect(isWaitingForAnswer(conversationId)).toBe(false);
  });

  it("refuses a malformed question without parking anything", async () => {
    const settled = await runAskUser(
      conversationId,
      { ...ARGS, options: [{ label: "Other" }] },
      { callId: "call_5" }
    );
    expect(settled.ok).toBe(false);
    expect(String((settled.data as { error: string }).error)).toMatch(/catch-all/);
    expect(pendingQuestion()).toBeUndefined();
  });

  it("supersedes a question the model replaced before it was answered", async () => {
    // Two open questions would let one answer resolve a card that is no
    // longer on screen.
    const first = runAskUser(conversationId, ARGS, { callId: "call_6" });
    const second = runAskUser(conversationId, { ...ARGS, header: "Second" }, { callId: "call_7" });

    expect(pendingQuestion()?.header).toBe("Second");
    const firstSettled = await first;
    expect(firstSettled.ok).toBe(false);
    expect(settlePendingQuestion(conversationId, { selected: [], note: "go", answeredAt: 1 })).toBe(
      true
    );
    expect((await second).ok).toBe(true);
  });
});

describe("answering a question whose turn died with the page", () => {
  it("commits the answer as the dangling call's result, and not also as a prompt", async () => {
    // The reload path: the question survived (it is persisted) but the turn
    // and its promise did not. The call is still dangling in the transcript,
    // so the answer becomes ITS result and the loop restarts from stored
    // history — the model reads the same exchange either way.
    const store = useChatStore.getState();
    store.addMessage(conversationId, {
      role: "assistant",
      content: "",
      toolCalls: {
        kind: "tool_calls",
        calls: [{ id: "call_reload", name: "ask_user", arguments: "{}" }],
      },
    });
    store.setPendingQuestion(conversationId, {
      header: "Auth",
      question: "Which one?",
      options: [{ label: "A" }, { label: "B" }],
      callId: "call_reload",
      askedAt: Date.now(),
    });

    // No live waiter: this is exactly the post-reload state.
    expect(isWaitingForAnswer(conversationId)).toBe(false);

    answerQuestion(conversationId, { selected: ["B"] });
    await waitForIdle(2_000);

    const messages = useChatStore
      .getState()
      .conversations.find((c) => c.id === conversationId)?.messages ?? [];
    const result = messages.find((m) => m.toolResult?.callId === "call_reload")?.toolResult;
    expect(result?.ok).toBe(true);
    expect(result?.content).toContain('"B"');
    // One representation of the answer, not two.
    expect(messages.filter((m) => m.content.includes("Answered")).length).toBe(0);
    expect(pendingQuestion()).toBeUndefined();
  });
});

describe("runSuggestNext", () => {
  it("publishes chips on the conversation and returns immediately", () => {
    const result = runSuggestNext(conversationId, {
      suggestions: [
        { label: "Add tests", prompt: "Add unit tests for the parser." },
        { label: "Ship it", prompt: "Push the change and open a pull request." },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("2 next step(s)");
    const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId);
    expect(conv?.suggestions?.map((s) => s.label)).toEqual(["Add tests", "Ship it"]);
  });

  it("refuses a payload the card cannot render", () => {
    const result = runSuggestNext(conversationId, { suggestions: [] });
    expect(result.ok).toBe(false);
    const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId);
    expect(conv?.suggestions).toBeUndefined();
  });
});
