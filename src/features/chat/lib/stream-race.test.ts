// ============================================================
// Stream Race — Regression Tests
// ============================================================
// The all-racers-fail path used to busy-loop forever: once the
// hedge settled tokenless, the decision loop re-added the dead
// hedge to `alive` on every pass and never threw. A turn would
// hang the whole candidate walk (page runner AND session host).
//
// The abort path is covered too: a Stop that lands while a racer is
// in flight must not launch a fresh hedge (the new stream would be
// born un-cancellable and hold the turn open forever).

import { describe, it, expect, vi } from "vitest";
import { raceStreams } from "./stream-race";
import type { ModelInfo } from "../types";

function model(id: string): ModelInfo {
  return { id, name: id, contextLength: 128000 } as unknown as ModelInfo;
}

describe("raceStreams", () => {
  it(
    "throws (never hangs) when every racer fails before the first token",
    { timeout: 3000 },
    async () => {
      await expect(
        raceStreams({
          candidates: [model("a"), model("b")],
          hedgeTriggerMs: 5,
          makeController: () => new AbortController(),
          startStream: async () => {
            throw new Error("provider down");
          },
        })
      ).rejects.toThrow("provider down");
    }
  );

  it("aborts the slower racer and returns the faster winner", async () => {
    const aborted: string[] = [];
    const result = await raceStreams({
      candidates: [model("slow"), model("fast")],
      hedgeTriggerMs: 10,
      makeController: () => new AbortController(),
      startStream: (m, signal, cbs) =>
        new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted.push(m.id);
            reject(new Error("aborted"));
          });
          const delay = m.id === "fast" ? 1 : 10_000;
          setTimeout(() => {
            cbs.onChunk(`token from ${m.id}`);
            resolve();
          }, delay);
        }),
      onDecided: vi.fn(),
    });

    expect(result.winner.id).toBe("fast");
    expect(result.hedged).toBe(true);
    expect(result.loser?.id).toBe("slow");
    expect(aborted).toContain("slow");
  });

  it("fails fast to the hedge when the primary dies tokenless", async () => {
    const result = await raceStreams({
      candidates: [model("primary"), model("backup")],
      hedgeTriggerMs: 60_000, // hedge only fires via fail-fast
      makeController: () => new AbortController(),
      startStream: (m, _signal, cbs) =>
        new Promise<void>((resolve, reject) => {
          if (m.id === "primary") {
            setTimeout(() => reject(new Error("primary dead")), 5);
          } else {
            setTimeout(() => {
              cbs.onChunk("backup live");
              resolve();
            }, 20);
          }
        }),
    });

    expect(result.winner.id).toBe("backup");
    expect(result.hedged).toBe(true);
  });

  it(
    "does not launch a hedge when the caller aborted before the first token",
    { timeout: 3000 },
    async () => {
      const outer = new AbortController();
      const started: string[] = [];

      const race = raceStreams({
        candidates: [model("primary"), model("backup")],
        hedgeTriggerMs: 60_000, // only fail-fast could fire a hedge
        makeController: () => {
          const c = new AbortController();
          if (outer.signal.aborted) c.abort();
          else outer.signal.addEventListener("abort", () => c.abort(), { once: true });
          return c;
        },
        startStream: (m, signal) =>
          new Promise<void>((resolve, reject) => {
            started.push(m.id);
            signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
            void resolve;
          }),
      });

      // Let the primary start, then Stop the turn
      await new Promise((r) => setTimeout(r, 5));
      outer.abort();

      await expect(race).rejects.toThrow();
      expect(started).toEqual(["primary"]);
    }
  );
});
