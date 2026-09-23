// ============================================================
// Companion Client — Stop Reaches The Command
// ============================================================
// `run_command` can hold a turn for ten minutes and `verify_with_ci` for
// fifteen, and the loop used to check for the user's abort only BETWEEN
// tools. So pressing Stop during `npm install` left the turn visibly
// running on a command that had just been cancelled — the button was real
// but the wait was not interruptible.
//
// What these tests pin is the distinction the fix turns on: a request
// cancelled BY THE USER is reported as the user's stop, while a request
// that failed to reach the companion still says so. Collapsing the two
// would trade a lie about the daemon for a lie about the user's intent.
// ============================================================

import { describe, expect, it, vi } from "vitest";
import {
  materializeOnCompanion,
  runOnCompanion,
  STOPPED_BY_USER,
  type CompanionExecRequest,
} from "./companion-client";

const REQUEST: CompanionExecRequest = {
  origin: "http://127.0.0.1:8765",
  token: "pair-token",
  conversationId: "chat-1",
  command: "npm test",
  writes: [{ path: "src/app.ts", content: "export const a = 1;\n" }],
  deletes: [],
  timeoutMs: 5,
};

/** The abort a `fetch` raises when its signal fires. */
function abortedFetch(): typeof fetch {
  return (async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  }) as unknown as typeof fetch;
}

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe("runOnCompanion", () => {
  it("forwards the turn's signal to the request", async () => {
    // The property that makes Stop immediate: the socket is the thing
    // that gets cancelled, not just the code waiting on it.
    const signal = new AbortController().signal;
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return {
        ok: true,
        status: 200,
        json: async () => ({
          outcome: { exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await runOnCompanion(REQUEST, { fetch: fetchImpl, signal });

    expect(result.ok).toBe(true);
    expect(seen[0]?.signal).toBe(signal);
  });

  it("reports a cancelled command as the user's stop", async () => {
    const result = await runOnCompanion(REQUEST, {
      fetch: abortedFetch(),
      signal: aborted(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(STOPPED_BY_USER);
  });

  it("still reports an unreachable companion when nothing was cancelled", async () => {
    const result = await runOnCompanion(REQUEST, {
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not reach the companion/i);
  });
});

describe("materializeOnCompanion", () => {
  it("reports a cancelled write as the user's stop", async () => {
    // Materializing is the write half of `run_command`: it happens before
    // the command, and a Stop during a large change set is a Stop too.
    const { command: _command, timeoutMs: _timeoutMs, ...writeOnly } = REQUEST;
    const result = await materializeOnCompanion(writeOnly, {
      fetch: abortedFetch(),
      signal: aborted(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(STOPPED_BY_USER);
  });
});

describe("the message the agent reads", () => {
  it("says nothing was verified, so no proof can be claimed from it", () => {
    expect(STOPPED_BY_USER).toMatch(/nothing was verified/i);
    expect(STOPPED_BY_USER).toMatch(/stopped by the user/i);
  });
});
