// ============================================================
// Turn Source — Local Transport Tests
// ============================================================
// The page-local source is the fallback for Safari (no SharedWorker)
// and for host refusal/death, so it must behave exactly like the
// worker-backed one: same events, same fan-out, same abort/reroute
// semantics — just without surviving the page.

import { describe, it, expect, beforeEach } from "vitest";
import { LocalTurnSource } from "./turn-source";
import { resetTurnLog } from "./turn-log";
import type { HostEvent, HostStartTurnPayload } from "./protocol";

const basePayload: HostStartTurnPayload = {
  turnId: "turn_local",
  conversationId: "conv1",
  apiKey: "sk-test",
  systemPrompt: "sys",
  temperature: 0.7,
  messages: [{ role: "user", content: "hi" }],
  candidates: [{ modelId: "model-a" }, { modelId: "model-b" }],
  turnKind: "analysis",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  events: HostEvent[],
  predicate: (e: HostEvent) => boolean,
  timeoutMs = 2000
): Promise<HostEvent | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(5);
  }
  return null;
}

beforeEach(() => {
  resetTurnLog();
});

describe("LocalTurnSource", () => {
  it("reports itself as non-surviving and streams to subscribers", async () => {
    const source = new LocalTurnSource(async (params) => {
      params.onChunk("Hello");
      params.onChunk(" world");
    });
    expect(source.survivable).toBe(false);
    expect(source.label).toBe("local");

    const events: HostEvent[] = [];
    source.subscribe((e) => events.push(e));

    const started = await source.startTurn({ ...basePayload });
    expect(started.kind).toBe("started");
    if (started.kind !== "started") throw new Error("unreachable");
    expect(started.snapshot.turnId).toBe("turn_local");

    const end = await waitFor(events, (e) => e.type === "END");
    expect(end).not.toBeNull();
    if (end?.type !== "END") throw new Error("unreachable");
    expect(end.payload.reason).toBe("done");
    expect(end.payload.modelId).toBe("model-a");

    const content = events
      .filter((e): e is Extract<HostEvent, { type: "DELTA" }> => e.type === "DELTA")
      .map((e) => e.delta.content ?? "")
      .join("");
    expect(content).toBe("Hello world");
  });

  it("aborts a running turn on request (END aborted)", async () => {
    const source = new LocalTurnSource(async (params) => {
      await new Promise<void>((resolve, reject) => {
        const signal = (params as { signal?: AbortSignal }).signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        void resolve;
      });
    });

    const events: HostEvent[] = [];
    source.subscribe((e) => events.push(e));
    await source.startTurn({ ...basePayload });
    await sleep(20);

    source.abortTurn("turn_local");
    const end = await waitFor(events, (e) => e.type === "END");
    expect(end).not.toBeNull();
    if (end?.type !== "END") throw new Error("unreachable");
    expect(end.payload.reason).toBe("aborted");
  });

  it("answers a reroute with fresh candidates and finishes on them", async () => {
    const source = new LocalTurnSource(async (params) => {
      if (params.model === "model-c") {
        params.onChunk("third time lucky");
        return;
      }
      throw new TypeError("network down");
    });

    const events: HostEvent[] = [];
    source.subscribe((e) => events.push(e));
    await source.startTurn({ ...basePayload });

    const reroute = await waitFor(events, (e) => e.type === "REROUTE_NEEDED");
    expect(reroute).not.toBeNull();
    if (reroute?.type !== "REROUTE_NEEDED") throw new Error("unreachable");
    expect(reroute.excluded).toContain("model-a");

    source.sendReroute("turn_local", [{ modelId: "model-c" }]);

    const end = await waitFor(events, (e) => e.type === "END");
    expect(end).not.toBeNull();
    if (end?.type !== "END") throw new Error("unreachable");
    expect(end.payload.reason).toBe("done");
    expect(end.payload.modelId).toBe("model-c");
  });

  it("gives every subscriber the same event stream", async () => {
    const source = new LocalTurnSource(async (params) => {
      params.onChunk("shared");
    });
    const a: HostEvent[] = [];
    const b: HostEvent[] = [];
    const unsubA = source.subscribe((e) => a.push(e));
    source.subscribe((e) => b.push(e));

    await source.startTurn({ ...basePayload });
    await waitFor(a, (e) => e.type === "END");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBe(a.length);

    unsubA();
    const before = b.length;
    await source.startTurn({ ...basePayload, turnId: "turn_local_2" });
    await waitFor(b, (e) => e.type === "END" && e.payload.turnId === "turn_local_2");
    expect(a.length).toBeLessThan(b.length);
    expect(before).toBeGreaterThan(0);
  });
});
