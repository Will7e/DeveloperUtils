import { describe, it, expect, beforeEach } from "vitest";
import { HostTurnController, type HostEventSink } from "./host-controller";
import { OpenRouterError } from "../lib/openrouter-client";
import { resetTurnLog } from "./turn-log";
import type { HostStartTurnPayload, HostSnapshot } from "./protocol";

interface SinkRecord {
  events: unknown[];
  pageCount: number;
}

function makeSink(pageCount = 1): SinkRecord & HostEventSink {
  const events: unknown[] = [];
  return {
    events,
    pageCount,
    post(event: unknown) {
      events.push(event);
    },
  };
}

const basePayload: HostStartTurnPayload = {
  turnId: "turn_test",
  conversationId: "conv1",
  apiKey: "sk-test",
  systemPrompt: "sys",
  temperature: 0.7,
  messages: [{ role: "user", content: "hello" }],
  candidates: [
    { modelId: "model-a", contextLength: 128000 },
    { modelId: "model-b", contextLength: 128000 },
  ],
};

/** The pieces of the wire events these tests read */
interface AnyEvent {
  type: string;
  turnId?: string;
  payload: { reason?: string; modelId?: string; turnId?: string; error?: string };
  delta?: { seq: number; content?: string; reasoning?: string };
}

/** Waits until predicate lands on the sink (bounded) */
async function waitFor(
  sink: SinkRecord,
  predicate: (event: AnyEvent) => boolean,
  timeoutMs = 2000
): Promise<AnyEvent | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = sink.events.find((e) => predicate(e as AnyEvent));
    if (hit) return hit as AnyEvent;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

beforeEach(() => {
  resetTurnLog();
});

describe("HostTurnController", () => {
  it("constructs idle with an empty snapshot", () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async () => {});
    const snap: HostSnapshot = controller.snapshot();
    expect(snap.turnId).toBeNull();
    expect(controller.currentTurn).toBeNull();
  });

  it("streams a successful turn: deltas fan out, END(done) emitted, state cleared", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async (params) => {
      params.onChunk("Hello");
      params.onChunk(" world");
    });

    controller.startTurn({ ...basePayload });
    const end = await waitFor(sink, (e) => e.type === "END");
    expect(end).not.toBeNull();
    expect(end!.payload.reason).toBe("done");
    expect(end!.payload.modelId).toBe("model-a");

    const deltas = sink.events.filter((e) => (e as AnyEvent).type === "DELTA");
    const total = deltas.reduce(
      (acc, d) => acc + ((d as AnyEvent).delta?.content ?? ""),
      ""
    );
    expect(total).toBe("Hello world");
    expect(controller.currentTurn).toBeNull();
    expect(controller.snapshot().turnId).toBeNull();
  });

  it("passes the candidate's per-request state (reasoning effort) to the stream", async () => {
    const sink = makeSink();
    let seen: unknown;
    const controller = new HostTurnController(sink, async (params) => {
      seen = params.requestState;
      params.onChunk("ok");
    });

    controller.startTurn({
      ...basePayload,
      candidates: [{ modelId: "model-a", requestState: { reasoning_effort: "high" } }],
    });
    await waitFor(sink, (e) => e.type === "END");
    expect(seen).toEqual({ reasoning_effort: "high" });
  });

  it("fails over to the next candidate on a retryable error", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async (params) => {
      if (params.model === "model-a") {
        throw new TypeError("network down");
      }
      params.onChunk("recovered");
    });

    controller.startTurn({ ...basePayload });
    const end = await waitFor(sink, (e) => e.type === "END");
    expect(end!.payload.reason).toBe("done");
    expect(end!.payload.modelId).toBe("model-b");
  });

  it("surfaces non-retryable errors as END(failed)", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async () => {
      throw new OpenRouterError("Your OpenRouter API key is invalid or expired.", 401);
    });

    controller.startTurn({ ...basePayload });
    const end = await waitFor(sink, (e) => e.type === "END");
    expect(end!.payload.reason).toBe("failed");
    expect(controller.currentTurn).toBeNull();
  });

  it("ends with exhausted (and the real reason) when every candidate fails", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async () => {
      throw new TypeError("network down");
    });

    controller.startTurn({ ...basePayload });
    const end = await waitFor(sink, (e) => e.type === "END");
    expect(end!.payload.reason).toBe("exhausted");
    // The underlying error is surfaced, not swallowed by a generic give-up
    expect(String(end!.payload.error)).toContain("network down");
    expect(controller.currentTurn).toBeNull();
  });

  it("aborts a streaming turn on ABORT_TURN", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async (params) => {
      params.onChunk("partial");
      await new Promise<void>((_resolve, reject) => {
        params.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      });
    });

    controller.startTurn({
      ...basePayload,
      candidates: [{ modelId: "model-a", contextLength: 128000 }],
    });
    await waitFor(sink, (e) => e.type === "DELTA");
    controller.abortTurn("turn_test");
    const end = await waitFor(sink, (e) => e.type === "END");
    expect(end!.payload.reason).toBe("aborted");
  });

  it("ends with tool-calls when the stream requested tools", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async (params) => {
      params.onToolCalls?.([{ id: "call_1", name: "read_file", arguments: "{}" }]);
    });

    controller.startTurn({ ...basePayload });
    const end = await waitFor(sink, (e) => e.type === "END");
    expect(end!.payload.reason).toBe("tool-calls");
  });

  it("ignores a second START_TURN while a turn is active", async () => {
    const sink = makeSink();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const controller = new HostTurnController(sink, () => gate);

    controller.startTurn({ ...basePayload, turnId: "turn_1" });
    expect(controller.snapshot().turnId).toBe("turn_1");
    // Second request on a busy host is a no-op inside the controller
    controller.startTurn({ ...basePayload, turnId: "turn_2" });
    expect(controller.snapshot().turnId).toBe("turn_1");
    release();
    const end = await waitFor(sink, (e) => e.type === "END");
    expect(end!.payload.turnId).toBe("turn_1");
  });

  it("snapshot exposes buffered content while streaming", async () => {
    const sink = makeSink();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const controller = new HostTurnController(sink, async (params) => {
      params.onChunk("streaming text");
      await gate;
    });

    controller.startTurn({ ...basePayload });
    await waitFor(sink, (e) => e.type === "DELTA");
    const snap = controller.snapshot();
    expect(snap.turnId).toBe("turn_test");
    expect(snap.content).toBe("streaming text");
    expect(snap.seq).toBe(1);
    release();
    await waitFor(sink, (e) => e.type === "END");
  });

  it("emits one delta per chunk, in order", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async (params) => {
      params.onChunk("a");
      params.onChunk("b");
      params.onReasoning?.("think");
    });
    controller.startTurn({ ...basePayload });
    await waitFor(sink, (e) => e.type === "END");
    const deltas = sink.events
      .filter((e) => (e as AnyEvent).type === "DELTA")
      .map((d) => (d as AnyEvent).delta!);
    expect(deltas.map((d) => d.seq)).toEqual([1, 2, 3]);
    expect(deltas.map((d) => d.content ?? d.reasoning)).toEqual(["a", "b", "think"]);
  });
});
