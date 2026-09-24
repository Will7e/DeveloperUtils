// ============================================================
// Harness Scenarios — "Is the harness still keeping its promises?"
// ============================================================
// The unit suites next to each module prove the modules work. This suite
// is deliberately different: each scenario assembles the REAL pipeline
// from stored transcript to wire payload (and, where a turn is involved,
// drives the real turn engine) and asserts a PROMISE the product makes
// to the user. It is the regression net for harness behaviour — the
// thing that silently rots when a refactor touches one stage.
//
// The promises covered here:
//
//   1. a wire payload is always a valid tool-protocol sequence, even
//      after truncation cut an exchange in half;
//   2. old tool output folds to digests WITHOUT breaking the pairing
//      that strict providers validate;
//   3. a request always fits its budget and always opens on a user turn;
//   4. a runaway agent loop terminates, and says why;
//   5. a credential never reaches a reviewer's Approve button, and an
//      unverifiable claim never reaches them silently.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prepareRequest } from "../context/engine";
import { toolResultDigestText } from "../context/engine";
import { runTurn, getSessionState } from "../session/turn-engine";
import { answerQuestion, sendUserMessage, stopChatStream } from "../services/chat-runner";
import { LocalTurnSource } from "../session/turn-source";
import { resetTurnLog } from "../session/turn-log";
import { useChatStore } from "@/stores/chat.store";
import { assessPushPolicy } from "../lib/push-policy";
import { auditClaims, evidenceWarnings } from "../lib/evidence-audit";
import { AGENT_AUTO_CONTINUATIONS, TOOL_RESULT_FOLD_TURNS } from "../constants";
import type { ChatConversation, ChatMessage, ModelInfo, ToolName } from "../types";
import type { PreparedTurn } from "../services/turn-prep";

// ── Transcript construction helpers ─────────────────────────

let messageSeq = 0;

function msg(over: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  messageSeq += 1;
  return {
    id: `m${messageSeq}`,
    content: "",
    timestamp: messageSeq,
    ...over,
  };
}

/** A user turn whose assistant reply used tools, with results for each */
function agentExchange(userText: string, reply: string, paths: string[]): ChatMessage[] {
  const calls = paths.map((p, i) => ({
    id: `call_${messageSeq}_${i}`,
    name: "read_file" as ToolName,
    arguments: JSON.stringify({ path: p }),
  }));
  return [
    msg({ role: "user", content: userText }),
    msg({ role: "assistant", content: "", toolCalls: { kind: "tool_calls", calls } }),
    ...calls.map((c, i) =>
      msg({
        role: "user",
        content: "",
        toolResult: {
          kind: "tool_result",
          callId: c.id,
          name: "read_file" as ToolName,
          ok: true,
          content: `{"path":"${paths[i]}","content":"${"x".repeat(400)}"}`,
          durationMs: 12,
          summary: paths[i]!,
        },
      })
    ),
    msg({ role: "assistant", content: reply }),
  ];
}

function conversation(messages: ChatMessage[]): ChatConversation {
  return { id: "c1", title: "scenario", messages, createdAt: 0, updatedAt: 0 };
}

// ── 1. Wire protocol validity ───────────────────────────────

describe("promise: a wire payload is always a valid tool-protocol sequence", () => {
  it("drops a dangling tool_calls row whose results were cut away", () => {
    const messages = [
      msg({ role: "user", content: "hello" }),
      // The model asked for tools; the page died before any result
      // committed. Sending this to a strict provider is a 400.
      msg({
        role: "assistant",
        content: "let me look",
        toolCalls: {
          kind: "tool_calls",
          calls: [{ id: "orphan", name: "read_file", arguments: '{"path":"a.ts"}' }],
        },
      }),
    ];

    const prepared = prepareRequest({ conversation: conversation(messages) });
    const payload = prepared.messages;

    // The protocol row is gone; the prose it carried survives.
    expect(payload.some((m) => m.tool_calls)).toBe(false);
    expect(payload.some((m) => m.content === "let me look")).toBe(true);
    // A request never opens on a tool row.
    expect(payload[0]!.role).toBe("user");
  });

  it("never leaves a tool row without its call", () => {
    const messages = [
      msg({
        role: "user",
        content: "",
        toolResult: {
          kind: "tool_result",
          callId: "never-asked",
          name: "read_file",
          ok: true,
          content: "{}",
          durationMs: 1,
        },
      }),
      msg({ role: "user", content: "still there?" }),
    ];

    const prepared = prepareRequest({ conversation: conversation(messages) });
    expect(prepared.messages.some((m) => m.role === "tool")).toBe(false);
    expect(prepared.messages[0]!.role).toBe("user");
  });

  it("keeps every answered exchange paired end to end", () => {
    const prepared = prepareRequest({
      conversation: conversation([
        ...agentExchange("read a and b", "Both look fine.", ["src/a.ts", "src/b.ts"]),
        msg({ role: "user", content: "thanks" }),
      ]),
    });

    const payload = prepared.messages;
    const requested = new Set(
      payload.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id))
    );
    const answered = new Set(
      payload.filter((m) => m.role === "tool").map((m) => m.tool_call_id!)
    );
    expect(requested.size).toBeGreaterThan(0);
    expect([...requested].sort()).toEqual([...answered].sort());
  });
});

// ── 2. Tool-result folding ──────────────────────────────────

describe("promise: old tool output folds without breaking the pairing", () => {
  it("replaces stale output with a digest and keeps the call answered", () => {
    const turns = Array.from({ length: TOOL_RESULT_FOLD_TURNS + 3 }, (_, i) =>
      agentExchange(`question ${i}`, `answer ${i}`, [`src/f${i}.ts`])
    ).flat();

    const prepared = prepareRequest({ conversation: conversation(turns) });
    expect(prepared.foldedToolResults).toBeGreaterThan(0);

    // The folded rows are still real `tool` rows bound to their call id.
    const toolRows = prepared.messages.filter((m) => m.role === "tool");
    expect(toolRows.length).toBeGreaterThan(0);
    expect(toolRows.every((m) => typeof m.tool_call_id === "string")).toBe(true);

    // ...but their payload is a digest, not the 400-char body.
    const folded = toolRows.filter(
      (m) => typeof m.content === "string" && m.content.includes("older output folded")
    );
    expect(folded.length).toBeGreaterThan(0);
    expect(String(folded[0]!.content).length).toBeLessThan(400);
  });

  it("keeps recent tool output verbatim", () => {
    const prepared = prepareRequest({
      conversation: conversation([
        ...agentExchange("q1", "a1", ["src/ancient.ts"]),
        ...agentExchange("q2", "a2", ["src/recent.ts"]),
      ].flat()),
    });
    const bodies = prepared.messages
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content));
    expect(bodies.some((b) => b.includes("src/recent.ts"))).toBe(true);
  });

  it("digest text names the tool and keeps the error state visible", () => {
    expect(toolResultDigestText({ name: "read_file", ok: false, durationMs: 5, summary: "a.ts" }))
      .toContain("ERROR");
  });
});

// ── 3. Budget and request shape ─────────────────────────────

describe("promise: a request fits its budget and opens on a user turn", () => {
  const big: ModelInfo = { id: "big", name: "Big", contextLength: 8_000, isFree: false };

  it("trims a history that exceeds the window", () => {
    const huge = Array.from({ length: 40 }, (_, i) =>
      msg({ role: i % 2 === 0 ? "user" : "assistant", content: "y".repeat(2_000) })
    );
    const prepared = prepareRequest({ conversation: conversation(huge), model: big });

    expect(prepared.hiddenCount).toBeGreaterThan(0);
    expect(prepared.sentTokens).toBeLessThan(prepared.budget.available + prepared.budget.systemTokens);
    expect(prepared.messages.length).toBeLessThan(huge.length);
  });

  it("reserves headroom for the system prompt and the reply", () => {
    const prepared = prepareRequest({
      conversation: conversation([msg({ role: "user", content: "hi" })]),
      model: big,
      effectiveSystemPrompt: "S".repeat(400),
    });
    expect(prepared.budget.systemTokens).toBeGreaterThan(0);
    expect(prepared.budget.outputReserve).toBeGreaterThan(0);
    expect(prepared.budget.available).toBeLessThan(prepared.budget.window);
  });

  it("falls back to a conservative window when the model is unknown", () => {
    const prepared = prepareRequest({
      conversation: conversation([msg({ role: "user", content: "hi" })]),
    });
    expect(prepared.budget.window).toBe(128_000);
  });
});

// ── 4. Loop termination ─────────────────────────────────────

describe("promise: a runaway agent loop terminates and says why", () => {
  let conversationId = "";
  const store = () => useChatStore.getState();

  beforeEach(() => {
    resetTurnLog();
    conversationId = store().createConversation("model-a");
    store().updateSettings({ apiKey: "sk-test" });
  });

  afterEach(() => {
    expect(getSessionState().phase).toBe("idle");
  });

  it("runs its bounded automatic continuations, then stops with an honest notice", async () => {
    // The cap is a checkpoint: the loop continues on its own, but only
    // for a bounded number of cap-sized batches. Runaway cost stays
    // bounded AND a large task no longer needs a human to type
    // "continue" after every cap.
    // A model that asks for a tool on every single round: the classic
    // runaway. Each round's call FAILS validation, which is also how a
    // real stuck model behaves.
    const call = { id: "call_1", name: "read_file" as ToolName, arguments: "src/a.ts" };
    let rounds = 0;
    const source = new LocalTurnSource(async (params) => {
      rounds += 1;
      params.onToolCalls?.([call]);
    });

    await runTurn(conversationId, {
      prepare: async (): Promise<PreparedTurn> => ({
        modelId: "model-a",
        mode: "build",
        effort: "medium",
        systemPrompt: "sys",
        temperature: 0.7,
        messages: [{ role: "user", content: "go" }],
        tools: [{ type: "function", function: { name: "read_file" } }],
        sentTokens: 10,
        candidates: [{ modelId: "model-a" }],
      }),
      resolveSource: async () => source,
      createFallbackSource: () => source,
      inactivityTimeoutMs: 60,
      // The cap is the harness's (AGENT_ITERATIONS); an eval shortens it
      // through the engine's own seam, since no setting can.
      maxIterations: 3,
    });

    expect(rounds).toBe(3 * (1 + AGENT_AUTO_CONTINUATIONS));
    const messages = store().conversations.find((c) => c.id === conversationId)?.messages ?? [];
    expect(messages.some((m) => /tool-use limit/.test(m.content))).toBe(true);
  });
});

// ── 5. The gates a promise reaches ──────────────────────────

describe("promise: nothing dangerous or unsupported reaches Approve silently", () => {
  const changed = ["src/App.tsx", "src/util/format.ts"];

  it("blocks a credential and explains the fix", () => {
    const report = assessPushPolicy({
      files: [
        { path: "src/api.ts", content: 'const key = "AKIA3XQ7ZR2MKP9TUVWY";' },
      ],
    });
    expect(report.blocked).toBe(true);
    expect(report.blockReason).toMatch(/rotate|environment variable/);
  });

  it("warns when a high-impact file rides along", () => {
    const report = assessPushPolicy({
      files: [
        { path: "src/App.tsx", content: "export default 1" },
        { path: ".github/workflows/deploy.yml", content: "on: push" },
      ],
    });
    expect(report.blocked).toBe(false);
    expect(report.findings.some((f) => f.code === "protected-path")).toBe(true);
  });

  it("turns an unverifiable summary into a reviewer warning", () => {
    const findings = auditClaims({
      claim: "Refactored the parser and all tests pass.",
      changedPaths: changed,
      toolsUsed: ["read_file", "edit_file"],
    });
    const warnings = evidenceWarnings(findings);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.kind).toBe("evidence");
    expect(warnings.map((w) => w.message).join(" ")).toMatch(/tests/);
  });

  it("stays quiet for an honest, evidenced summary", () => {
    const findings = auditClaims({
      claim: "Moved the date helper into src/util/format.ts so both callers share it.",
      changedPaths: changed,
      toolsUsed: ["read_file", "edit_file"],
    });
    expect(findings).toHaveLength(0);
  });
});

// ── 6. Asking, and being steered mid-turn ───────────────────

describe("promise: the agent asks instead of guessing, and a running turn stays steerable", () => {
  let conversationId = "";
  const store = () => useChatStore.getState();

  const ASK_CALL = {
    id: "call_ask",
    name: "ask_user" as ToolName,
    arguments: JSON.stringify({
      header: "Strategy",
      question: "Which approach should I take?",
      options: [{ label: "A" }, { label: "B" }],
    }),
  };

  const READ_CALL = {
    id: "call_read",
    name: "read_file" as ToolName,
    arguments: JSON.stringify({ path: "src/a.ts" }),
  };

  /** The live transcript — what every request is built from */
  const transcript = (): ChatMessage[] =>
    store().conversations.find((c) => c.id === conversationId)?.messages ?? [];

  const userTexts = (): string[] =>
    transcript()
      .filter((m) => m.role === "user" && !m.toolResult && !m.toolCalls)
      .map((m) => m.content);

  const preparedTurn = (): PreparedTurn => ({
    modelId: "model-a",
    mode: "build",
    effort: "medium",
    systemPrompt: "sys",
    temperature: 0.7,
    messages: [{ role: "user", content: "go" }],
    // The surface this stub turn OFFERS. The engine refuses a call for a tool
    // the round did not send (session/turn-engine's sentToolNames), so a fixture
    // that emits an ask must declare `ask_user` — and it belongs here anyway,
    // since both tool profiles carry it on every tool-capable turn.
    tools: [
      { type: "function", function: { name: "read_file" } },
      { type: "function", function: { name: "ask_user" } },
      { type: "function", function: { name: "suggest_next" } },
    ],
    sentTokens: 10,
    candidates: [{ modelId: "model-a" }],
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out waiting for the harness");
  }

  beforeEach(() => {
    resetTurnLog();
    conversationId = store().createConversation("model-a");
    store().updateSettings({ apiKey: "sk-test" });
  });

  afterEach(() => {
    expect(getSessionState().phase).toBe("idle");
  });

  it("parks on the question and continues from the answer", async () => {
    let rounds = 0;
    const source = new LocalTurnSource(async (params) => {
      rounds += 1;
      if (rounds === 1) {
        params.onToolCalls?.([ASK_CALL]);
        return;
      }
      params.onChunk?.("Starting with A.");
    });

    const turn = runTurn(conversationId, {
      prepare: async () => preparedTurn(),
      resolveSource: async () => source,
      createFallbackSource: () => source,
      inactivityTimeoutMs: 60,
    });

    await waitFor(() => Boolean(store().conversations.find((c) => c.id === conversationId)?.pendingQuestion));
    expect(rounds).toBe(1);

    answerQuestion(conversationId, { selected: ["A"] });
    await turn;

    // The answer came back as an ordinary tool result, and the turn continued
    // in place: no second user prompt, no lost tool results.
    expect(rounds).toBe(2);
    expect(
      transcript().some((m) => m.toolResult?.name === "ask_user" && m.toolResult.ok)
    ).toBe(true);
    expect(transcript().some((m) => m.content === "Starting with A.")).toBe(true);
    expect(transcript().some((m) => m.content.includes("harness is continuing"))).toBe(false);
    expect(store().conversations.find((c) => c.id === conversationId)?.pendingQuestion).toBeUndefined();
  });

  it("settles a parked question when the user stops the turn", async () => {
    let rounds = 0;
    const source = new LocalTurnSource(async (params) => {
      rounds += 1;
      params.onToolCalls?.([ASK_CALL]);
    });

    const turn = runTurn(conversationId, {
      prepare: async () => preparedTurn(),
      resolveSource: async () => source,
      createFallbackSource: () => source,
      inactivityTimeoutMs: 60,
    });

    await waitFor(() => Boolean(store().conversations.find((c) => c.id === conversationId)?.pendingQuestion));
    stopChatStream();
    await turn;

    // A stop is not an answer: the result says cancelled, the card is gone,
    // and the model is told not to assume anything.
    const result = transcript().find((m) => m.toolResult?.name === "ask_user")?.toolResult;
    expect(result?.ok).toBe(false);
    expect(result?.content).toContain("cancelled");
    expect(store().conversations.find((c) => c.id === conversationId)?.pendingQuestion).toBeUndefined();
    expect(rounds).toBe(1);
  });

  it("delivers a message sent mid-turn at the next round boundary, exactly once", async () => {
    let rounds = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seenByPrepare: string[][] = [];

    const source = new LocalTurnSource(async (params) => {
      rounds += 1;
      if (rounds === 1) {
        params.onToolCalls?.([READ_CALL]);
        // Holds round 1 open so the user has a real window to type into.
        await held;
        return;
      }
      params.onChunk?.("done");
    });

    const turn = runTurn(conversationId, {
      prepare: async () => {
        seenByPrepare.push(userTexts());
        return preparedTurn();
      },
      resolveSource: async () => source,
      createFallbackSource: () => source,
      inactivityTimeoutMs: 60,
    });

    await waitFor(() => rounds === 1);
    sendUserMessage(conversationId, "also update the docs");

    // It is not sent yet, and it is not lost: it is queued, visibly.
    expect(userTexts()).not.toContain("also update the docs");
    expect(
      store().conversations.find((c) => c.id === conversationId)?.queued?.map((q) => q.text)
    ).toEqual(["also update the docs"]);

    release();
    await turn;

    // Delivered at the boundary: the SECOND request carries it, the first
    // did not (so it never sat in front of results the model had not read),
    // and the queue is empty afterwards.
    expect(seenByPrepare[0]).not.toContain("also update the docs");
    expect(seenByPrepare[1]).toContain("also update the docs");
    expect(userTexts().filter((t) => t === "also update the docs")).toHaveLength(1);
    expect(store().conversations.find((c) => c.id === conversationId)?.queued).toEqual([]);
  });
});
