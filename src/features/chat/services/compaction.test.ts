// ============================================================
// Compaction Service — Orchestration Tests
// ============================================================
// The service decides which stored messages leave, what the model is
// told instead, and what the user is told happened. The properties
// pinned here are the ones that made /compact untrustworthy:
//
//  · cleared (/clear) history is never summarized and never destroyed,
//  · coversCount is cumulative, not "the last fold's size",
//  · the fold is measured against the REAL request (prompt + schemas),
//  · a big history is folded in stages rather than skipped,
//  · and every "nothing happened" has its own honest reason — including
//    "nothing happened because a reply is streaming".

import { beforeEach, describe, expect, it, vi } from "vitest";

const completeChat = vi.fn<(params: unknown) => Promise<{ content: string }>>();
const addToast = vi.fn();

vi.mock("../lib/openrouter-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/openrouter-client")>();
  return { ...actual, completeChat: (params: unknown) => completeChat(params) };
});

vi.mock("@/stores/app.store", () => ({
  useAppStore: { getState: () => ({ addToast }) },
}));

// A tiny, tool-free window keeps the arithmetic in these tests legible.
vi.mock("../lib/model-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/model-catalog")>();
  return {
    ...actual,
    resolveModelInfo: (id?: string) =>
      id === "test-small"
        ? { id, name: "Test Small", contextLength: 4_000, supportedParameters: ["temperature"] }
        : id === "test-tools"
          ? { id, name: "Test Tools", contextLength: 20_000, supportedParameters: ["tools"] }
          : actual.resolveModelInfo(id),
  };
});

import { COMPACTION_MAX_PASSES } from "../constants";
import { useChatStore } from "@/stores/chat.store";
import { OpenRouterError } from "../lib/openrouter-client";
import { conversationBudget, ensureCompaction, runCompactCommand } from "./compaction";
import { bindingKey } from "../identity/identity";
import type { ChatMessage, ChatSettings, ToolName } from "../types";

const message = (role: ChatMessage["role"], content: string): Partial<ChatMessage> => ({
  role,
  content,
});
const sized = (role: ChatMessage["role"], tokens: number): Partial<ChatMessage> =>
  message(role, "x".repeat(Math.round(tokens * 3.9)));

let conversationId = "";

function seed(
  messages: Array<Partial<ChatMessage>>,
  options: { model?: string; repoAttached?: boolean } = {}
): void {
  const store = useChatStore.getState();
  conversationId = store.createConversation(options.model ?? "test-small");
  for (const m of messages) store.addMessage(conversationId, m as Omit<ChatMessage, "id">);
  if (options.repoAttached) {
    store.setConversationRepo(conversationId, {
      owner: "acme",
      repo: "demo",
      branch: "main",
      attachedAt: 0,
    });
    store.updateSettings({ github: { token: "ghp_test" } as ChatSettings["github"] });
  }
}

const visible = () =>
  (useChatStore.getState().conversations.find((c) => c.id === conversationId)?.messages ?? []).filter(
    (m) => !m.hidden
  );
const stored = () =>
  useChatStore.getState().conversations.find((c) => c.id === conversationId)?.messages ?? [];
const summaryOf = () =>
  useChatStore.getState().conversations.find((c) => c.id === conversationId)?.summary;

beforeEach(() => {
  vi.clearAllMocks();
  completeChat.mockResolvedValue({ content: "GOAL: keep folding\nFILES: src/a.ts" });
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    isStreaming: false,
    streamingConversationId: null,
  });
  useChatStore.getState().updateSettings({ apiKey: "sk-test", systemPrompt: "" });
});

describe("ensureCompaction", () => {
  it("reports the missing API key instead of 'nothing to compact'", async () => {
    seed([message("user", "hello"), message("assistant", "hi")]);
    useChatStore.getState().updateSettings({ apiKey: "" });

    const outcome = await ensureCompaction(conversationId, { force: true });

    expect(outcome.mode).toBe("noop");
    expect(outcome.reason).toBe("no-api-key");
    expect(completeChat).not.toHaveBeenCalled();
  });

  it("says there is nothing to fold when there is only one exchange", async () => {
    seed([message("user", "hello"), message("assistant", "hi")]);

    const outcome = await ensureCompaction(conversationId, { force: true });

    expect(outcome.reason).toBe("nothing-foldable");
    expect(completeChat).not.toHaveBeenCalled();
  });

  it("summarizes the oldest exchange on an explicit request", async () => {
    seed([
      message("user", "first question"),
      message("assistant", "first answer"),
      message("user", "second question"),
      message("assistant", "second answer"),
    ]);

    const outcome = await ensureCompaction(conversationId, { force: true });

    expect(outcome.mode).toBe("summary");
    expect(outcome.foldedCount).toBe(2);
    expect(visible().map((m) => m.content)).toEqual(["second question", "second answer"]);
    // The summary replaces their memory, cumulatively.
    expect(summaryOf()?.coversCount).toBe(2);
    expect(summaryOf()?.text).toContain("GOAL: keep folding");
    // The summarizer saw what was folded, and nothing else.
    const sent = completeChat.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(sent.messages[1]!.content).toContain("first question");
    expect(sent.messages[1]!.content).not.toContain("second question");
  });

  it("does not measure, fold or evict another repository's history", async () => {
    // The fold reads the transcript outside the repository boundary, and the
    // reading that bites is the MEASUREMENT: a chat that just left a repository
    // keeps that repository's rows in storage, and counting them made this
    // service see a window far fuller than the next request (which scopes
    // them out) would ever be — then fold history that did not need folding.
    //
    // Here the only history this repository has is one small exchange; the
    // previous repository left one large row behind. Scoped, the windown is
    // comfortable and nothing is folded — which is the truth: the next request
    // carries two short rows.
    seed([message("user", "read it"), message("assistant", "ok")], { model: "test-small" });
    const onA = bindingKey(conversationId, "acme/api@main");
    const onB = bindingKey(conversationId, "acme/web@main");
    const row = (over: Partial<ChatMessage>, timestamp: number): ChatMessage =>
      ({ id: `m${timestamp}`, role: "user", content: "", timestamp, ...over }) as ChatMessage;

    useChatStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id !== conversationId
          ? c
          : {
              ...c,
              bindingMove: { at: 20, from: "acme/api@main" },
              messages: [
                row({ role: "user", content: "what is the session helper?", bindingId: onA }, 1),
                row(
                  {
                    role: "assistant",
                    bindingId: onA,
                    toolCalls: {
                      kind: "tool_calls",
                      calls: [
                        {
                          id: "c1",
                          name: "read_file" as ToolName,
                          arguments: '{"path":"src/auth/session.ts"}',
                        },
                      ],
                    },
                  },
                  2
                ),
                row(
                  {
                    role: "user",
                    bindingId: onA,
                    toolResult: {
                      kind: "tool_result",
                      callId: "c1",
                      name: "read_file" as ToolName,
                      ok: true,
                      // Deliberately enormous: unscoped, this one row makes the
                      // old repository look like most of the window.
                      content: "SECRET_SOURCE_FROM_REPO_A".repeat(400),
                      durationMs: 1,
                      summary: "",
                    },
                  },
                  3
                ),
                row({ role: "assistant", content: "It mints a signed cookie.", bindingId: onA }, 4),
                row({ role: "user", content: "now the web app", bindingId: onB }, 40),
                row({ role: "assistant", content: "Sure.", bindingId: onB }, 41),
              ],
            }
      ),
    }));

    const outcome = await ensureCompaction(conversationId);

    // Unscoped, that one row made the window look full and this service folded
    // history that the request would never carry.
    expect(outcome.mode).toBe("noop");
    expect(outcome.reason).toBe("already-fits");
    // Nothing was summarized, so nothing — not one line — of that repository
    // reached the ledger the model reads on every later turn.
    expect(completeChat).not.toHaveBeenCalled();
    // And the rows themselves are still STORED: this service declines to fold
    // them, it does not delete the record of what happened on the old checkout.
    expect(stored().map((m) => m.bindingId)).toContain(onA);
  });

  it("accumulates coversCount and freedTokens across runs", async () => {
    seed([
      sized("user", 400),
      sized("assistant", 400),
      sized("user", 400),
      sized("assistant", 400),
      sized("user", 400),
      sized("assistant", 400),
    ]);

    await ensureCompaction(conversationId, { force: true });
    const first = summaryOf()!;
    await ensureCompaction(conversationId, { force: true });
    const second = summaryOf()!;

    expect(first.coversCount).toBeGreaterThan(0);
    expect(second.coversCount).toBeGreaterThan(first.coversCount);
    expect(second.freedTokens).toBeGreaterThan(first.freedTokens);
  });

  it("never summarizes or destroys cleared history", async () => {
    seed([
      message("user", "cleared-secret"),
      message("assistant", "cleared-reply"),
      message("user", "live one"),
      message("assistant", "live two"),
      message("user", "live three"),
      message("assistant", "live four"),
    ]);
    useChatStore.getState().clearConversationContext(conversationId);
    useChatStore.getState().addMessage(conversationId, message("user", "after the clear") as never);
    useChatStore
      .getState()
      .addMessage(conversationId, message("assistant", "and its reply") as never);
    useChatStore.getState().addMessage(conversationId, message("user", "one more") as never);
    useChatStore.getState().addMessage(conversationId, message("assistant", "sure") as never);

    const clearedIds = stored()
      .filter((m) => m.hidden)
      .map((m) => m.id);

    const outcome = await ensureCompaction(conversationId, { force: true });

    expect(outcome.mode).toBe("summary");
    // Summarized: only what the model could actually see.
    const sent = completeChat.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(sent.messages[1]!.content).toContain("after the clear");
    expect(sent.messages[1]!.content).not.toContain("cleared-secret");
    // Destroyed: nothing. /clear stays non-destructive through a compaction.
    expect(stored().map((m) => m.id)).toEqual(
      expect.arrayContaining(clearedIds)
    );
    expect(stored().filter((m) => m.hidden)).toHaveLength(clearedIds.length);
  });

  it("folds a history far larger than the window in stages", async () => {
    // ~24k tokens against a 4k window: one summarization call cannot read
    // it, so the run has to fold, commit, and fold again.
    const big: Array<Partial<ChatMessage>> = [];
    for (let i = 0; i < 12; i++) {
      big.push(sized("user", 1_000), sized("assistant", 1_000));
    }
    seed(big);

    const outcome = await ensureCompaction(conversationId, { force: true });

    expect(outcome.mode).toBe("summary");
    // More than one stage, bounded by the pass cap.
    expect(completeChat.mock.calls.length).toBeGreaterThan(1);
    expect(completeChat.mock.calls.length).toBeLessThanOrEqual(COMPACTION_MAX_PASSES);
    expect(outcome.foldedCount).toBeGreaterThan(1);
    expect(visible().length).toBeLessThan(big.length);
    // Each stage appended to the same ledger rather than starting over.
    const second = completeChat.mock.calls[1]![0] as { messages: Array<{ content: string }> };
    expect(second.messages[1]!.content).toContain("PREVIOUS LEDGER");
    // 24k tokens cannot be folded inside three stages: the outcome says so
    // instead of implying the window was freed.
    expect(outcome.incomplete).toBe(true);
  });

  it("falls back to truncation with a note when the summarizer refuses", async () => {
    completeChat.mockRejectedValue(new OpenRouterError("bad request", 400));
    const history: Array<Partial<ChatMessage>> = [];
    for (let i = 0; i < 6; i++) {
      history.push(sized("user", 300), sized("assistant", 300));
    }
    seed(history);

    const outcome = await ensureCompaction(conversationId, { force: true });

    expect(outcome.mode).toBe("truncated");
    expect(outcome.foldedCount).toBeGreaterThan(0);
    expect(outcome.fallbackReason).toContain("bad request");
    // The model is told a gap exists rather than meeting a mid-thread list.
    expect(summaryOf()?.text).toContain("TRUNCATED");
    expect(summaryOf()?.coversCount).toBe(outcome.foldedCount);
  });

  it("counts the real request — prompt, skills and tool schemas", () => {
    seed([message("user", "hello")], { model: "test-tools", repoAttached: true });
    const store = useChatStore.getState();
    const conversation = store.conversations.find((c) => c.id === conversationId)!;

    const withTools = conversationBudget(conversation, store.settings, {
      id: "test-tools",
      name: "Test Tools",
      contextLength: 20_000,
      supportedParameters: ["tools"],
    });
    const withoutTools = conversationBudget(conversation, store.settings, {
      id: "test-small",
      name: "Test Small",
      contextLength: 20_000,
      supportedParameters: ["temperature"],
    });

    // Tool schemas ride in the prompt, so a fold measured without them
    // under-folds by exactly their size.
    expect(withTools.budget.toolTokens).toBeGreaterThan(0);
    expect(withoutTools.budget.toolTokens).toBe(0);
    expect(withTools.budget.available).toBeLessThan(withoutTools.budget.available);

    // And the base prompt is in the same number.
    const withPrompt = conversationBudget(
      { ...conversation, systemPrompt: "x".repeat(4_000) },
      store.settings,
      { id: "test-small", name: "Test Small", contextLength: 20_000 }
    );
    expect(withPrompt.budget.systemTokens).toBeGreaterThan(0);
  });
});

describe("runCompactCommand", () => {
  it("refuses while this conversation is streaming", async () => {
    seed([message("user", "a"), message("assistant", "b"), message("user", "c"), message("assistant", "d")]);
    useChatStore.setState({ isStreaming: true, streamingConversationId: conversationId });

    await runCompactCommand(conversationId);

    expect(completeChat).not.toHaveBeenCalled();
    expect(summaryOf()).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Stop the reply"), type: "error" })
    );
  });

  it("still runs while ANOTHER conversation streams", async () => {
    seed([message("user", "a"), message("assistant", "b"), message("user", "c"), message("assistant", "d")]);
    useChatStore.setState({ isStreaming: true, streamingConversationId: "some-other-chat" });

    await runCompactCommand(conversationId);

    expect(completeChat).toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" })
    );
  });

  it("tells the user which of the noop causes actually happened", async () => {
    seed([message("user", "a"), message("assistant", "b")]);

    await runCompactCommand(conversationId);

    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Not enough history"),
        type: "info",
      })
    );
  });
});
