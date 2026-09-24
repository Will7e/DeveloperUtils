// ============================================================
// Tool Choice — The Reported Failure, End To End
// ============================================================
// The scenario this file exists for, exactly as it reached the user:
//
//   "fetch data from this endpoint" was answered by calling `http_write` on a
//   turn whose surface (a free model's lean profile) did not offer it; the
//   call was executed anyway and came back as
//   `Argument "headers" must be of type object, got string.`; the model
//   repeated it; the user had to step in and say "use our tools".
//
// Three promises are asserted here, and each one was broken:
//
//   1. a call for a tool the turn did NOT offer is refused, and the refusal
//      names what to use instead;
//   2. the refusal is a RESULT the model can act on — the turn continues
//      rather than ending on the failure;
//   3. a second identical failure carries the tool's own contract, so the same
//      mistake cannot cost two rounds.
//
// It drives the real turn engine through a stubbed transport, like the rest of
// this suite: the harness behaviour under test is the engine's, not a mock's.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The visible side effect of `open_in_tool` is applied through the same bridge
// the dashboard's demo handoffs use. Observing it here is how the file proves
// a withheld call stays OUT of execution rather than merely looking refused.
const applyHandoff = vi.fn<(payload: unknown) => boolean>(() => true);
vi.mock("@/services/handoff-bridge", () => ({
  applyHandoff: (payload: unknown) => applyHandoff(payload),
}));

import { runTurn, getSessionState } from "../session/turn-engine";
import { LocalTurnSource } from "../session/turn-source";
import { resetTurnLog } from "../session/turn-log";
import { useChatStore } from "@/stores/chat.store";
import type { ChatMessage, ToolName } from "../types";
import type { PreparedTurn } from "../services/turn-prep";

const HTTP_WRITE_CALL = {
  id: "call_write",
  name: "http_write" as ToolName,
  arguments: JSON.stringify({
    method: "POST",
    url: "https://api.example.com/orders",
    headers: '{"Accept":"application/json"}',
  }),
};

const REPEATED_BAD_CALL = {
  id: "call_read_missing",
  name: "read_file" as ToolName,
  arguments: JSON.stringify({ path: "src/does-not-exist.ts" }),
};

describe("tool choice", () => {
  let conversationId = "";

  const store = () => useChatStore.getState();

  const transcript = (): ChatMessage[] =>
    store().conversations.find((c) => c.id === conversationId)?.messages ?? [];

  /** Every tool result the model has been given, as raw text */
  const toolResultText = (): string =>
    transcript()
      .map((m) => m.toolResult?.content ?? "")
      .join("\n");

  /** A hand-built narrow surface for the refusal tests — http_write and the
   *  diagram pair are deliberately absent (this is no longer the real lean
   *  profile, which now carries create_diagram/open_in_tool) */
  const leanTurn = (): PreparedTurn => ({
    modelId: "model-a",
    mode: "build",
    effort: "medium",
    systemPrompt: "sys",
    temperature: 0.7,
    messages: [{ role: "user", content: "fetch data from this endpoint" }],
    tools: [
      { type: "function", function: { name: "http_request" } },
      { type: "function", function: { name: "read_file" } },
      { type: "function", function: { name: "ask_user" } },
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

  it("refuses a tool the turn never offered, and names the sibling", async () => {
    let rounds = 0;
    const source = new LocalTurnSource(async (params) => {
      rounds += 1;
      if (rounds === 1) {
        params.onToolCalls?.([HTTP_WRITE_CALL]);
        return;
      }
      // The model corrects itself and answers; the turn must still be alive.
      params.onChunk?.("The endpoint answers 200 with an order list.");
    });

    await runTurn(conversationId, {
      prepare: async () => leanTurn(),
      resolveSource: async () => source,
      createFallbackSource: () => source,
      inactivityTimeoutMs: 60,
    });

    const text = toolResultText();
    expect(text, "the withheld call must be refused").toContain("NOT in the tool list");
    expect(text, "the refusal must name what to use").toContain("http_request");
    expect(rounds, "the turn must continue after the refusal").toBe(2);
    expect(
      transcript().some((m) => m.role === "assistant" && m.content.includes("order list")),
      "the corrected answer must be committed"
    ).toBe(true);
  });

  it("tells the model what the failed tool is for when it repeats the call", async () => {
    let rounds = 0;
    const source = new LocalTurnSource(async (params) => {
      rounds += 1;
      if (rounds <= 2) {
        // The same failing read twice: the second may not come back with the
        // bare error alone.
        params.onToolCalls?.([{ ...REPEATED_BAD_CALL, id: `call_read_${rounds}` }]);
        return;
      }
      params.onChunk?.("Could not read that path.");
    });

    await runTurn(conversationId, {
      prepare: async () => leanTurn(),
      resolveSource: async () => source,
      createFallbackSource: () => source,
      inactivityTimeoutMs: 60,
    });

    const text = toolResultText();
    expect(text).toMatch(/read_file/);
    // The contract's own corrective text, not merely the same error again.
    expect(text, "the repeat must carry the tool's contract").toMatch(/already failed once/);
  });

  it("keeps a withheld call out of execution entirely", async () => {
    // The strongest form of the promise: `open_in_tool` is not in this surface,
    // so its side effect (moving the user's screen) must not happen at all —
    // the call is answered, never performed.
    let rounds = 0;
    const source = new LocalTurnSource(async (params) => {
      rounds += 1;
      if (rounds === 1) {
        params.onToolCalls?.([
          { id: "c1", name: "open_in_tool" as ToolName, arguments: JSON.stringify({ target: "api-tester" }) },
        ]);
        return;
      }
      params.onChunk?.("The API Tester is not something I can open on this turn.");
    });

    await runTurn(conversationId, {
      prepare: async () => leanTurn(),
      resolveSource: async () => source,
      createFallbackSource: () => source,
      inactivityTimeoutMs: 60,
    });

    await waitFor(() => !getSessionState().inToolPhase);
    const rows = transcript().filter((m) => m.toolResult);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.toolResult!.ok, "the call must be a refusal, not a success").toBe(false);
    expect(String(rows[0]!.toolResult!.content)).toContain("open_in_tool");
    // The refusal is actionable: it names a tool this turn DID offer.
    expect(String(rows[0]!.toolResult!.content)).toContain("http_request");
    // And the user's screen did not move — the side effect never ran.
    expect(applyHandoff).not.toHaveBeenCalled();
  });
});
