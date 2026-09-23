import { describe, it, expect, beforeEach, vi } from "vitest";
import { HostTurnController, type HostEventSink } from "./host-controller";
import { OpenRouterError } from "../lib/openrouter-client";
import { resetTurnLog } from "./turn-log";
import { HOST_ORPHAN_GRACE_MS } from "../constants";
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
  delta?: { turnId?: string; seq: number; content?: string; reasoning?: string };
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

  it("refuses a second start for the SAME conversation, leaving the live turn alone", async () => {
    const sink = makeSink();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const controller = new HostTurnController(sink, () => gate);

    expect(controller.startTurn({ ...basePayload, turnId: "turn_1" })).toBe(true);
    expect(controller.snapshot().turnId).toBe("turn_1");
    // One turn per conversation: a second start for the same chat is not
    // admitted here (the worker replaces it instead, which is the reload
    // path) and must not disturb the turn already streaming.
    expect(controller.startTurn({ ...basePayload, turnId: "turn_2" })).toBe(false);
    expect(controller.snapshot().turnId).toBe("turn_1");
    expect(controller.liveTurnCount).toBe(1);
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

describe("HostTurnController — several conversations at once", () => {
  /**
   * The host is the app's multiplexer: one stream per conversation,
   * addressed by turnId. These tests pin the two properties that make
   * that safe — turns never touch each other's state, and a reply the
   * page receives always belongs to the turn it asked about.
   */

  /** Deltas grouped by the turn that produced them */
  function contentByTurn(sink: SinkRecord): Map<string, string> {
    const out = new Map<string, string>();
    for (const raw of sink.events) {
      const event = raw as AnyEvent;
      // A delta's turn is on the delta itself — that address is what lets
      // one page render only its own conversation's stream.
      const turnId = event.delta?.turnId;
      if (event.type !== "DELTA" || !turnId) continue;
      out.set(turnId, (out.get(turnId) ?? "") + (event.delta?.content ?? ""));
    }
    return out;
  }

  it("streams two conversations concurrently, each addressed by its own turn", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async (params) => {
      params.onChunk(params.systemPrompt ?? "");
      await new Promise<void>((_resolve, reject) => {
        params.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      });
    });

    expect(
      controller.startTurn({ ...basePayload, turnId: "turn_a", conversationId: "convA", systemPrompt: "a" })
    ).toBe(true);
    // The second chat is admitted WHILE the first is streaming — the
    // whole point: it used to be refused and degraded to a page-local
    // stream that died with its tab.
    expect(
      controller.startTurn({ ...basePayload, turnId: "turn_b", conversationId: "convB", systemPrompt: "b" })
    ).toBe(true);
    expect(controller.liveTurnCount).toBe(2);

    const byTurn = contentByTurn(sink);
    expect(byTurn.get("turn_a")).toBe("a");
    expect(byTurn.get("turn_b")).toBe("b");

    controller.abortTurn("turn_a");
    controller.abortTurn("turn_b");
    await waitFor(sink, (e) => e.type === "END" && e.payload.turnId === "turn_b");
    await waitFor(sink, (e) => e.type === "END" && e.payload.turnId === "turn_a");
  });

  it("answers a snapshot about the conversation that was asked about", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async (params) => {
      params.onChunk(`content of ${params.systemPrompt ?? ""}`);
      await new Promise<void>(() => {
        /* held open until the test ends */
      });
    });

    controller.startTurn({ ...basePayload, turnId: "turn_a", conversationId: "convA", systemPrompt: "convA" });
    controller.startTurn({ ...basePayload, turnId: "turn_b", conversationId: "convB", systemPrompt: "convB" });

    expect(controller.snapshot("convA").turnId).toBe("turn_a");
    expect(controller.snapshot("convA").content).toBe("content of convA");
    expect(controller.snapshot("convB").content).toBe("content of convB");
    // An unscoped ask means "the newest live turn", which is what the
    // single-turn host always handed back.
    expect(controller.snapshot().turnId).toBe("turn_b");
    // And an idle conversation is described as ended, not as somebody
    // else's live stream.
    expect(controller.snapshot("convC").turnId).toBeNull();
    expect(controller.turnFor("convC")).toBeNull();
  });

  it("aborting one conversation's turn does not stop another", async () => {
    const sink = makeSink();
    const controller = new HostTurnController(sink, async (params) => {
      params.onChunk(params.systemPrompt ?? "");
      await new Promise<void>((_resolve, reject) => {
        params.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      });
    });

    controller.startTurn({ ...basePayload, turnId: "turn_a", conversationId: "convA", systemPrompt: "a" });
    controller.startTurn({ ...basePayload, turnId: "turn_b", conversationId: "convB", systemPrompt: "b" });

    controller.abortTurn("turn_a");
    const endA = await waitFor(sink, (e) => e.type === "END" && e.payload.turnId === "turn_a");
    expect(endA?.payload.reason).toBe("aborted");

    // Stop is one conversation's button. The work left running in the
    // other chat is still running, with its own buffered content.
    expect(controller.turnFor("convB")?.turnId).toBe("turn_b");
    expect(controller.snapshot("convB").status).toBe("streaming");
    expect(controller.liveTurnCount).toBe(1);
  });

  it("replaces only the conversation being re-sent", async () => {
    const sink = makeSink();
    const started: string[] = [];
    const controller = new HostTurnController(sink, async (params) => {
      started.push(params.systemPrompt ?? "");
      params.onChunk(params.systemPrompt ?? "");
      await new Promise<void>((_resolve, reject) => {
        params.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      });
    });

    controller.startTurn({ ...basePayload, turnId: "turn_a1", conversationId: "convA", systemPrompt: "a1" });
    controller.startTurn({ ...basePayload, turnId: "turn_b", conversationId: "convB", systemPrompt: "b" });
    // The reload re-send for convA lands while convB is mid-stream.
    controller.replaceTurn({ ...basePayload, turnId: "turn_a2", conversationId: "convA", systemPrompt: "a2" });

    expect(controller.turnFor("convA")?.turnId).toBe("turn_a2");
    expect(controller.turnFor("convB")?.turnId).toBe("turn_b");
    expect(controller.liveTurnCount).toBe(2);

    const endA1 = await waitFor(sink, (e) => e.type === "END" && e.payload.turnId === "turn_a1");
    expect(endA1?.payload.reason).toBe("aborted");
    expect(started).toEqual(["a1", "b", "a2"]);
  });

  it("orphan-aborts every live turn only after the last page is gone", async () => {
    vi.useFakeTimers();
    try {
      const sink = makeSink(0);
      const controller = new HostTurnController(sink, async (params) => {
        params.onChunk("x");
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      });

      controller.startTurn({ ...basePayload, turnId: "turn_a", conversationId: "convA" });
      controller.startTurn({ ...basePayload, turnId: "turn_b", conversationId: "convB" });
      controller.setPageCount(0);

      // The grace window is the point: a reloading page re-attaches and
      // the streams continue.
      await vi.advanceTimersByTimeAsync(HOST_ORPHAN_GRACE_MS - 1_000);
      expect(sink.events.some((e) => (e as AnyEvent).type === "END")).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      const ends = sink.events.filter((e) => (e as AnyEvent).type === "END") as AnyEvent[];
      expect(ends.map((e) => e.payload.turnId).sort()).toEqual(["turn_a", "turn_b"]);
      expect(ends.every((e) => e.payload.reason === "aborted")).toBe(true);
      expect(controller.liveTurnCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a page that re-attaches in the grace window keeps its stream alive", async () => {
    vi.useFakeTimers();
    try {
      const sink = makeSink(0);
      const controller = new HostTurnController(sink, async (params) => {
        params.onChunk("still going");
        await new Promise<void>(() => {
          /* held open: never aborted */
        });
      });

      controller.startTurn({ ...basePayload, turnId: "turn_a", conversationId: "convA" });
      controller.setPageCount(0);
      await vi.advanceTimersByTimeAsync(HOST_ORPHAN_GRACE_MS / 2);

      // The reload finished: a page is attached again.
      sink.pageCount = 1;
      controller.setPageCount(1);
      await vi.advanceTimersByTimeAsync(HOST_ORPHAN_GRACE_MS * 2);

      expect(sink.events.some((e) => (e as AnyEvent).type === "END")).toBe(false);
      expect(controller.snapshot("convA").content).toBe("still going");
    } finally {
      vi.useRealTimers();
    }
  });
});
