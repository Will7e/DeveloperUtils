import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  logTurnEvent,
  getTurnLog,
  formatTurnLog,
  resetTurnLog,
  subscribeTurnLog,
} from "./turn-log";

beforeEach(() => resetTurnLog());

describe("turn log ring buffer", () => {
  it("stores entries chronologically", () => {
    logTurnEvent({ turnId: "t1", conversationId: "c1", phase: "turn-start" });
    logTurnEvent({ turnId: "t1", conversationId: "c1", phase: "model-attempt", modelId: "m1" });
    const log = getTurnLog();
    expect(log).toHaveLength(2);
    expect(log[0]!.phase).toBe("turn-start");
    expect(log[1]!.phase).toBe("model-attempt");
    expect(log[1]!.modelId).toBe("m1");
  });

  it("evicts the oldest entry when the ring wraps", () => {
    for (let i = 0; i < 505; i++) {
      logTurnEvent({ turnId: `t${i}`, conversationId: null, phase: "turn-start", detail: String(i) });
    }
    const log = getTurnLog();
    expect(log).toHaveLength(500);
    // First entry should be the 5th pushed (index 5) after eviction
    expect(log[0]!.detail).toBe("5");
    expect(log[499]!.detail).toBe("504");
  });

  it("mirrors entries to subscribers (the host's log forwarding seam)", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeTurnLog((entry) => seen.push(entry.phase));

    logTurnEvent({ turnId: "t1", conversationId: "c1", phase: "model-attempt" });
    unsubscribe();
    logTurnEvent({ turnId: "t1", conversationId: "c1", phase: "stream-end" });

    expect(seen).toEqual(["model-attempt"]);
    expect(getTurnLog().map((e) => e.phase)).toEqual(["model-attempt", "stream-end"]);
  });

  it("survives a subscriber that throws", () => {
    const doomed = vi.fn(() => {
      throw new Error("bad consumer");
    });
    const healthy: string[] = [];
    const unsubA = subscribeTurnLog(doomed);
    const unsubB = subscribeTurnLog((e) => healthy.push(e.phase));

    expect(() =>
      logTurnEvent({ turnId: "t1", conversationId: "c1", phase: "failover" })
    ).not.toThrow();
    expect(doomed).toHaveBeenCalledOnce();
    expect(healthy).toEqual(["failover"]);
    unsubA();
    unsubB();
  });

  it("formats to a readable single-line-per-entry string", () => {
    logTurnEvent({ turnId: "abcdef12", conversationId: "c1", phase: "resume", detail: "restream" });
    const formatted = formatTurnLog();
    expect(formatted).toContain("resume");
    expect(formatted).toContain("restream");
    expect(formatted).toContain("turn=abcdef12");
  });
});
