// ============================================================
// Turn Engine — Lifecycle Seam Tests
// ============================================================
// The engine's contract is a set of promises that are easy to break
// and impossible to see in a screenshot:
//
//  1. no failure path leaves the spinner running (worker killed,
//     port dropped, transport silent);
//  2. a partial reply is never duplicated by a fallback re-stream;
//  3. a survivable transport that dies before producing anything is
//     retried once on the page-local transport, which commits;
//  4. a turn is single-flight.
//
// Each test drives the real engine with injected deps so no network,
// worker, or DOM is involved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTurn, getSessionState } from "./turn-engine";
import { LocalTurnSource, type StartOutcome, type TurnSource } from "./turn-source";
import { getTurnLog, resetTurnLog } from "./turn-log";
import { useChatStore } from "@/stores/chat.store";
import { AGENT_ITERATIONS_DEFAULT } from "../constants";
import type {
  HostEvent,
  HostSnapshot,
  HostStartTurnPayload,
} from "./protocol";
import type { PreparedTurn } from "../services/turn-prep";

// ── Fakes ───────────────────────────────────────────────────

function snapshot(turnId: string, conversationId: string): HostSnapshot {
  return {
    protocolVersion: 1,
    turnId,
    status: "streaming",
    conversationId,
    contentFromOffset: 0,
    content: "",
    reasoning: "",
    seq: 0,
  };
}

/** A transport whose behaviour per round is scripted by the test */
class ScriptedSource implements TurnSource {
  readonly listeners = new Set<(event: HostEvent) => void>();
  readonly  starts: HostStartTurnPayload[] = [];
  aborted: string[] = [];


  constructor(
    readonly label: "host" | "local",
    readonly survivable: boolean,
    private readonly script: (source: ScriptedSource, payload: HostStartTurnPayload) => void
  ) {}

  async startTurn(payload: HostStartTurnPayload): Promise<StartOutcome> {
    this.starts.push(payload);
    this.script(this, payload);
    return { kind: "started", snapshot: snapshot(payload.turnId, payload.conversationId) };
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abortTurn(turnId: string): void {
    this.aborted.push(turnId);
  }

  emit(event: HostEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function preparedTurn(): PreparedTurn {
  return {
    modelId: "model-a",
    mode: "build",
    effort: "medium",
    systemPrompt: "sys",
    temperature: 0.7,
    messages: [{ role: "user", content: "hi" }],
    sentTokens: 10,
    candidates: [{ modelId: "model-a" }],
  };
}

/** A turn that was sent tool definitions (agent mode with a repo) */
function preparedTurnWithTools(): PreparedTurn {
  return {
    ...preparedTurn(),
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "read a file",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };
}

/** Streams a plain reply and ends the round normally */
function replySource(text: string): ScriptedSource {
  return new ScriptedSource("local", false, (source, payload) => {
    queueMicrotask(() => {
      source.emit({ type: "DELTA", delta: { turnId: payload.turnId, seq: 1, content: text } });
      source.emit({ type: "END", payload: { turnId: payload.turnId, reason: "done" } });
    });
  });
}

/**
 * Streams the SAME tool call every round for the first `rounds` starts,
 * then a plain reply. Models the loop a weak model gets stuck in.
 */
function repeatingCallSource(
  rounds: number,
  call: { id: string; name: string; arguments: string }
): ScriptedSource {
  return new ScriptedSource("local", false, (source, payload) => {
    const n = source.starts.length;
    queueMicrotask(() => {
      if (n <= rounds) {
        source.emit({
          type: "TOOL_CALLS",
          payload: { turnId: payload.turnId, calls: [{ ...call }] },
        });
        source.emit({ type: "END", payload: { turnId: payload.turnId, reason: "tool-calls" } });
        return;
      }
      source.emit({ type: "DELTA", delta: { turnId: payload.turnId, seq: 1, content: "stopped" } });
      source.emit({ type: "END", payload: { turnId: payload.turnId, reason: "done" } });
    });
  });
}

function toolResultMessages() {
  const conv = store().conversations.find((c) => c.id === conversationId);
  return (conv?.messages ?? []).filter((m) => m.toolResult !== undefined);
}

// ── Harness ─────────────────────────────────────────────────

let conversationId = "";

/** Streams text immediately, then keeps the round open (silent) */
function silentSource(label: "host" | "local", survivable: boolean, text?: string): ScriptedSource {
  return new ScriptedSource(label, survivable, (source, payload) => {
    queueMicrotask(() => {
      const turnId = payload.turnId;
      if (text) {
        source.emit({ type: "DELTA", delta: { turnId, seq: 1, content: text } });
      }
      // ...and then nothing. The stream is never ended: this is the
      // killed-worker / dropped-port shape.
    });
  });
}

function store() {
  return useChatStore.getState();
}

function assistantMessages() {
  const conv = store().conversations.find((c) => c.id === conversationId);
  return (conv?.messages ?? []).filter((m) => m.role === "assistant");
}

beforeEach(() => {
  resetTurnLog();
  conversationId = store().createConversation("model-a");
  store().updateSettings({ apiKey: "sk-test" });
});

afterEach(() => {
  // No marker may survive a turn, whatever path it took.
  expect(getSessionState().phase).toBe("idle");
  expect(store().isStreaming).toBe(false);
});

describe("turn engine — transport failure", () => {
  it(
    "falls back in-page when the survivable transport goes silent, and commits its reply",
    { timeout: 5000 },
    async () => {
      const host = silentSource("host", true);
      const local = new LocalTurnSource(async (params) => {
        params.onChunk("local reply");
      });

      await runTurn(conversationId, {
        prepare: async () => preparedTurn(),
        resolveSource: async () => host,
        createFallbackSource: () => local,
        inactivityTimeoutMs: 40,
      });

      // The host was asked once; it never answered, so the round moved
      // to the page-local transport exactly once.
      expect(host.starts).toHaveLength(1);
      expect(local.currentTurn).toBeNull();

      // The committed reply is the local one, and the partial host
      // text does not leak in — the round was discarded, not merged.
      const messages = assistantMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe("local reply");
      expect(messages[0]!.error ?? false).toBe(false);
    }
  );

  it(
    "keeps a partial host reply and does NOT duplicate it with a fallback stream",
    { timeout: 5000 },
    async () => {
      const host = silentSource("host", true, "half an answer");
      let fallbackStarts = 0;
      const local = new ScriptedSource("local", false, () => {
        fallbackStarts += 1;
      });

      await runTurn(conversationId, {
        prepare: async () => preparedTurn(),
        resolveSource: async () => host,
        createFallbackSource: () => local,
        inactivityTimeoutMs: 40,
      });

      const messages = assistantMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toContain("half an answer");
      // Already-visible text is never re-streamed by a second engine.
      expect(fallbackStarts).toBe(0);
    }
  );

  it(
    "ends a silent page-local turn instead of spinning forever",
    { timeout: 5000 },
    async () => {
      const local = silentSource("local", false);

      await runTurn(conversationId, {
        prepare: async () => preparedTurn(),
        resolveSource: async () => local,
        createFallbackSource: () => local,
        inactivityTimeoutMs: 40,
      });

      const messages = assistantMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.error ?? false).toBe(true);
      expect(messages[0]!.content).toMatch(/response engine/i);
    }
  );

  it(
    "retries a round that died with nothing rendered instead of asking the user to resend",
    { timeout: 5000 },
    async () => {
      // First attempt drops before its first token; the second works.
      const source = new ScriptedSource("local", false, (s, payload) => {
        const attempt = s.starts.length;
        queueMicrotask(() => {
          if (attempt === 1) return; // nothing rendered: the retryable case
          s.emit({ type: "DELTA", delta: { turnId: payload.turnId, seq: 1, content: "second try" } });
          s.emit({ type: "END", payload: { turnId: payload.turnId, reason: "done" } });
        });
      });

      await runTurn(conversationId, {
        prepare: async () => preparedTurn(),
        resolveSource: async () => source,
        createFallbackSource: () => source,
        inactivityTimeoutMs: 40,
      });

      expect(source.starts).toHaveLength(2);
      const messages = assistantMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe("second try");
      expect(messages[0]!.error ?? false).toBe(false);
    }
  );

  it("clears the pending-turn marker on every exit path", async () => {
    const local = new LocalTurnSource(async (params) => {
      params.onChunk("done");
    });
    // Pre-set a stale marker for this conversation
    store().markPendingTurn(conversationId);
    expect(store().conversations.find((c) => c.id === conversationId)?.pendingTurn).toBeTruthy();

    await runTurn(conversationId, {
      prepare: async () => preparedTurn(),
      resolveSource: async () => local,
      createFallbackSource: () => local,
      inactivityTimeoutMs: 200,
    });

    const conv = store().conversations.find((c) => c.id === conversationId);
    expect(conv?.pendingTurn ?? null).toBeNull();
  });
});

describe("turn engine — weak-model recovery", () => {
  it(
    "recovers a tool call the model wrote as text and runs it as a real call",
    { timeout: 5000 },
    async () => {
      const source = replySource(
        'Let me look at the file:\n\n```json\n{"name":"read_file","arguments":{"path":"src/a.ts"}}\n```\n\nThat should do it.'
      );

      await runTurn(conversationId, {
        prepare: async () => preparedTurnWithTools(),
        resolveSource: async () => source,
        createFallbackSource: () => source,
        inactivityTimeoutMs: 60,
      });

      const toolCalls = (store().conversations.find((c) => c.id === conversationId)?.messages ?? [])
        .filter((m) => m.toolCalls !== undefined);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.toolCalls!.calls[0]!.name).toBe("read_file");
      // The correction is visible in the transcript, not silent.
      expect(toolCalls[0]!.content).toMatch(/described tool calls in text/);
      // Recovery happens once: the second round's identical text is not re-run.
      expect(source.starts).toHaveLength(2);
    }
  );

  it(
    "does not invent calls when tools were never sent",
    { timeout: 5000 },
    async () => {
      const source = replySource('{"name":"read_file","arguments":{"path":"src/a.ts"}}');

      await runTurn(conversationId, {
        prepare: async () => preparedTurn(),
        resolveSource: async () => source,
        createFallbackSource: () => source,
        inactivityTimeoutMs: 60,
      });

      const toolCalls = (store().conversations.find((c) => c.id === conversationId)?.messages ?? [])
        .filter((m) => m.toolCalls !== undefined);
      expect(toolCalls).toHaveLength(0);
      expect(source.starts).toHaveLength(1);
    }
  );

  it(
    "stops re-running a call that has already failed twice",
    { timeout: 5000 },
    async () => {
      // The shape a cheap model produces when it stops emitting JSON:
      // a known tool with unparseable arguments.
      const source = repeatingCallSource(6, {
        id: "call_1",
        name: "read_file",
        arguments: "src/a.ts",
      });

      await runTurn(conversationId, {
        prepare: async () => preparedTurnWithTools(),
        resolveSource: async () => source,
        createFallbackSource: () => source,
        inactivityTimeoutMs: 60,
      });

      const results = toolResultMessages().map((m) => m.toolResult!);
      // The first two attempts ran for real and failed on validation.
      expect(results.filter((r) => r.summary === "invalid arguments")).toHaveLength(2);
      // From the third attempt on the ledger refuses instead of retrying,
      // and the refusal text tells the model what to do differently.
      const refusals = results.filter((r) => r.summary === "repeated failing call refused");
      expect(refusals.length).toBeGreaterThan(0);
      expect(refusals[0]!.content).toMatch(/Change your approach/);
    }
  );
});

describe("turn engine — tool-use checkpoints", () => {
  it(
    "keeps working past the iteration cap instead of stopping mid-task",
    { timeout: 5000 },
    async () => {
      store().updateSettings({ agentMaxIterations: 1, autoEscalate: false });
      // Two tool rounds, then the model is finished.
      const source = repeatingCallSource(2, {
        id: "call_1",
        name: "read_file",
        arguments: "src/a.ts",
      });

      await runTurn(conversationId, {
        prepare: async () => preparedTurnWithTools(),
        resolveSource: async () => source,
        createFallbackSource: () => source,
        inactivityTimeoutMs: 60,
      });

      // The cap of 1 is a checkpoint: the turn ran the model three
      // times and finished on the model's own terms.
      expect(source.starts).toHaveLength(3);
      expect(assistantMessages().some((m) => /tool-use limit/i.test(m.content))).toBe(false);

      // …and the extra rounds are on the record, not silent.
      const autoContinued = getTurnLog().filter((e) => /auto-continuing/.test(e.detail ?? ""));
      expect(autoContinued).toHaveLength(2);
      store().updateSettings({ agentMaxIterations: AGENT_ITERATIONS_DEFAULT, autoEscalate: true });
    }
  );

  it(
    "asks the user to continue only once the continuation budget is spent",
    { timeout: 5000 },
    async () => {
      store().updateSettings({ agentMaxIterations: 1, autoEscalate: false });
      // A model that never stops calling tools — the shape that used to
      // end every large task with "Ask me to continue".
      const source = repeatingCallSource(99, {
        id: "call_1",
        name: "read_file",
        arguments: "src/a.ts",
      });

      await runTurn(conversationId, {
        prepare: async () => preparedTurnWithTools(),
        resolveSource: async () => source,
        createFallbackSource: () => source,
        inactivityTimeoutMs: 60,
      });

      // Three cap-sized batches in total: the cap, then the bounded
      // automatic continuations. A runaway loop costs a bounded budget.
      expect(source.starts).toHaveLength(3);
      expect(assistantMessages().some((m) => /tool-use limit/i.test(m.content))).toBe(true);
      store().updateSettings({ agentMaxIterations: AGENT_ITERATIONS_DEFAULT, autoEscalate: true });
    }
  );
});

describe("turn engine — escalation", () => {
  /** The stalled-model shape: the same unparseable call, round after round */
  function stalledSource() {
    return repeatingCallSource(6, { id: "call_1", name: "read_file", arguments: "src/a.ts" });
  }

  it(
    "continues a stalled turn on a stronger model, names it, and keeps the choice to one turn",
    { timeout: 5000 },
    async () => {
      const source = stalledSource();
      const overrides: Array<string | undefined> = [];

      await runTurn(conversationId, {
        prepare: async (_id, opts) => {
          overrides.push(opts?.modelOverride);
          return preparedTurnWithTools();
        },
        resolveSource: async () => source,
        createFallbackSource: () => source,
        inactivityTimeoutMs: 60,
        pickEscalation: () => ({ modelId: "strong/model", reason: "test ladder", explicit: false }),
      });

      // The turn started on the user's model…
      expect(overrides[0]).toBeUndefined();
      // …and continued on the stronger one once the loop proved it was stuck.
      expect(overrides).toContain("strong/model");

      // The switch is announced in the transcript, not silent, and only once.
      const notes = assistantMessages().filter((m) => m.content.includes("Switching this turn"));
      expect(notes).toHaveLength(1);
      expect(notes[0]!.content).toContain("strong/model");
      expect(notes[0]!.content).toContain("test ladder");

      // The conversation's own model is untouched: the swap dies with the turn.
      const conv = store().conversations.find((c) => c.id === conversationId);
      expect(conv?.model).toBe("model-a");
    }
  );

  it(
    "stays on the selected model when escalation is switched off",
    { timeout: 5000 },
    async () => {
      store().updateSettings({ autoEscalate: false });
      const source = stalledSource();
      const overrides: Array<string | undefined> = [];

      await runTurn(conversationId, {
        prepare: async (_id, opts) => {
          overrides.push(opts?.modelOverride);
          return preparedTurnWithTools();
        },
        resolveSource: async () => source,
        createFallbackSource: () => source,
        inactivityTimeoutMs: 60,
        pickEscalation: () => ({ modelId: "strong/model", reason: "test ladder", explicit: false }),
      });

      expect(overrides.every((m) => m === undefined)).toBe(true);
      expect(assistantMessages().some((m) => m.content.includes("Switching this turn"))).toBe(false);
      store().updateSettings({ autoEscalate: true });
    }
  );

  it(
    "says nothing rather than swapping sideways when no stronger model is known",
    { timeout: 5000 },
    async () => {
      const source = stalledSource();
      const overrides: Array<string | undefined> = [];

      await runTurn(conversationId, {
        prepare: async (_id, opts) => {
          overrides.push(opts?.modelOverride);
          return preparedTurnWithTools();
        },
        resolveSource: async () => source,
        createFallbackSource: () => source,
        inactivityTimeoutMs: 60,
        pickEscalation: () => null,
      });

      expect(overrides.every((m) => m === undefined)).toBe(true);
      expect(assistantMessages().some((m) => m.content.includes("Switching this turn"))).toBe(false);
    }
  );
});

describe("turn engine — single flight", () => {
  it("refuses a second turn while one is running", { timeout: 5000 }, async () => {
    const first = silentSource("host", true);
    let secondStarts = 0;
    const second = new ScriptedSource("host", true, () => {
      secondStarts += 1;
    });

    // Both fallbacks are inert scripts — no network, no real streams.
    const inFlight = runTurn(conversationId, {
      prepare: async () => preparedTurn(),
      resolveSource: async () => first,
      createFallbackSource: () => silentSource("local", false),
      inactivityTimeoutMs: 60,
    });

    // Second call lands while the first is still rendering.
    await runTurn(conversationId, {
      prepare: async () => preparedTurn(),
      resolveSource: async () => second,
      createFallbackSource: () => silentSource("local", false),
      inactivityTimeoutMs: 60,
    });

    await inFlight;
    expect(secondStarts).toBe(0);
  });
});
