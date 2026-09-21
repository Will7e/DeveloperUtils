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
import { resetTurnLog } from "./turn-log";
import { useChatStore } from "@/stores/chat.store";
import type {
  HostCandidate,
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
  readonly starts: HostStartTurnPayload[] = [];
  aborted: string[] = [];
  reroutes: Array<{ turnId: string; candidates: HostCandidate[] }> = [];

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

  sendReroute(turnId: string, candidates: HostCandidate[]): void {
    this.reroutes.push({ turnId, candidates });
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
    turnKind: "analysis",
    intab: false,
    needsVision: false,
    ranked: [{ modelId: "model-a" }],
    systemPrompt: "sys",
    temperature: 0.7,
    messages: [{ role: "user", content: "hi" }],
    sentTokens: 10,
  };
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
