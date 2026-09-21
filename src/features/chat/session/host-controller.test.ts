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
  turnKind: "code",
};

/** Host events are untyped on the wire; tests read them loosely */
type AnyEvent = Record<string, any>;

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

function endEvent(sink: SinkRecord): { payload: Record<string, unknown> } | null {
  const end = sink.events.find((e) => (e as { type: string }).type === "END");
  return end ? (end as { payload: Record<string, unknown> }) : null;
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

    const deltas = sink.events.filter((e) => (e as { type: string }).type === "DELTA");
    // Both chunks arrive pre-decision (hedged race), so they flush as
    // a single buffered delta — content must be complete either way.
    const total = deltas.reduce(
      (acc, d) => acc + ((d as { delta: { content?: string } }).delta.content ?? ""),
      ""
    );
    expect(total).toBe("Hello world");
    expect(controller.currentTurn).toBeNull();

    const snapshot = controller.snapshot();
    expect(snapshot.turnId).toBeNull();
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

    const modelFailures = sink.events.filter(
      (e) =>
        (e as { type: string }).type === "TELEMETRY" &&
        (e as { event?: { kind?: { type?: string } } }).event?.kind?.type === "modelFailure"
    );
    expect(modelFailures.length).toBeGreaterThan(0);
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

  it("emits REROUTE_NEEDED when the candidate list is exhausted", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async () => {
      throw new TypeError("network down");
    });

    controller.startTurn({ ...basePayload });
    const reroute = await waitFor(sink, (e) => e.type === "REROUTE_NEEDED");
    expect(reroute).not.toBeNull();
    expect((reroute!.excluded as string[])).toContain("model-a");
    expect((reroute!.excluded as string[])).toContain("model-b");
    expect(controller.currentTurn?.status).toBe("reroute");
  });

  it("ends with exhausted when the reroute reply is empty", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async () => {
      throw new TypeError("network down");
    });

    controller.startTurn({ ...basePayload });
    await waitFor(sink, (e) => e.type === "REROUTE_NEEDED");
    controller.addCandidates("turn_test", []);
    const end = await waitFor(sink, (e) => e.type === "END");
    expect(end!.payload.reason).toBe("exhausted");
    expect(controller.currentTurn).toBeNull();
  });

  it("resumes with fresh candidates after reroute", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async (params) => {
      if (params.model === "model-c") {
        params.onChunk("third time lucky");
      } else {
        throw new TypeError("network down");
      }
    });

    controller.startTurn({
      ...basePayload,
      candidates: [
        { modelId: "model-a" },
        { modelId: "model-b" },
      ],
    });
    await waitFor(sink, (e) => e.type === "REROUTE_NEEDED");
    controller.addCandidates("turn_test", [{ modelId: "model-c", contextLength: 64000 }]);
    const end = await waitFor(sink, (e) => e.type === "END");
    expect(end!.payload.reason).toBe("done");
    expect(end!.payload.modelId).toBe("model-c");
  });

  it("aborts a reroute-parked turn on ABORT_TURN", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async () => {
      throw new TypeError("network down");
    });

    controller.startTurn({ ...basePayload });
    await waitFor(sink, (e) => e.type === "REROUTE_NEEDED");
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
    const busySnapshot = controller.snapshot();
    expect(busySnapshot.turnId).toBe("turn_1");
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

  it("does not route pre-decision loser chunks into the transcript", async () => {
    const sink = makeSink();
    // Single-racer path: everything flows (winner is the only stream)
    const controller = new HostTurnController(sink, async (params) => {
      params.onChunk("only");
    });
    controller.startTurn({ ...basePayload });
    await waitFor(sink, (e) => e.type === "END");
    const deltas = sink.events.filter((e) => (e as { type: string }).type === "DELTA");
    const total = deltas.reduce(
      (acc, d) => acc + ((d as { delta: { content?: string } }).delta.content ?? ""),
      ""
    );
    expect(total).toBe("only");
  });
});
