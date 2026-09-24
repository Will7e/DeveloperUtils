// ============================================================
// CI Client — The Run You Dispatched, Not The Last Green One
// ============================================================
// A dispatch answers 204 with no body, so the run has to be FOUND. The test
// that matters most is the one where a previous successful run on the same
// branch is sitting in the list: picking it would make every verification
// pass on the strength of a build that finished yesterday.
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchWorkflow,
  extractFailureLines,
  fetchCiFailure,
  fetchRun,
  findDispatchedRun,
  waitForRun,
  workflowIdFromPath,
} from "./ci-client";
import type { CiRun } from "./ci-plan";

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const rawRun = (over: Record<string, unknown>) => ({
  id: 100,
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/acme/web/actions/runs/100",
  name: "Verify",
  head_branch: "agent/x",
  created_at: "2026-09-22T10:00:00Z",
  ...over,
});

describe("workflowIdFromPath", () => {
  it("uses the file name, which the API accepts in place of an id", () => {
    expect(workflowIdFromPath(".github/workflows/verify.yml")).toBe("verify.yml");
  });
});

describe("dispatchWorkflow", () => {
  it("posts the ref and no invented inputs", async () => {
    const calls = stubFetch((_, init) => {
      const body = JSON.parse(String(init?.body)) as { ref: string; inputs: unknown };
      expect(body.ref).toBe("agent/x");
      expect(body.inputs).toEqual({});
      return json(null, 204);
    });
    const result = await dispatchWorkflow({
      token: "t",
      owner: "acme",
      repo: "web",
      workflowPath: ".github/workflows/verify.yml",
      ref: "agent/x",
    });
    expect(result.ok).toBe(true);
    expect(calls[0]).toContain("/actions/workflows/verify.yml/dispatches");
  });

  it("explains a scope refusal as a scope refusal", async () => {
    // `actions: write` is not the permission that pushes code, and an agent
    // told only "403" will retry the same call.
    stubFetch(() => json({ message: "Resource not accessible by integration" }, 403));
    const result = await dispatchWorkflow({
      token: "t",
      owner: "acme",
      repo: "web",
      workflowPath: ".github/workflows/ci.yml",
      ref: "agent/x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("scope");
      expect(result.error).toContain("actions: write");
    }
  });

  it("explains a missing dispatch trigger", async () => {
    stubFetch(() => json({ message: "Workflow does not have workflow_dispatch trigger" }, 422));
    const result = await dispatchWorkflow({
      token: "t",
      owner: "acme",
      repo: "web",
      workflowPath: ".github/workflows/ci.yml",
      ref: "agent/x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no-dispatch-trigger");
  });
});

describe("findDispatchedRun", () => {
  it("ignores a run that predates the dispatch", async () => {
    stubFetch(() =>
      json({
        workflow_runs: [
          rawRun({ id: 1, created_at: "2026-09-21T09:00:00Z", conclusion: "success" }),
          rawRun({ id: 2, created_at: "2026-09-22T10:00:05Z", status: "queued", conclusion: null }),
        ],
      })
    );
    const run = await findDispatchedRun({
      token: "t",
      owner: "acme",
      repo: "web",
      workflowPath: ".github/workflows/verify.yml",
      ref: "agent/x",
      sinceIso: "2026-09-22T10:00:00Z",
    });
    expect(run?.id).toBe(2);
  });

  it("returns nothing when every run is older, rather than the newest one", async () => {
    stubFetch(() => json({ workflow_runs: [rawRun({ created_at: "2026-09-21T09:00:00Z" })] }));
    const run = await findDispatchedRun({
      token: "t",
      owner: "acme",
      repo: "web",
      workflowPath: ".github/workflows/verify.yml",
      ref: "agent/x",
      sinceIso: "2026-09-22T10:00:00Z",
    });
    expect(run).toBeNull();
  });

  it("asks for dispatched runs on this branch only", async () => {
    const calls = stubFetch(() => json({ workflow_runs: [] }));
    await findDispatchedRun({
      token: "t",
      owner: "acme",
      repo: "web",
      workflowPath: ".github/workflows/verify.yml",
      ref: "agent/x",
      sinceIso: "2026-09-22T10:00:00Z",
    });
    expect(calls[0]).toContain("branch=agent%2Fx");
    expect(calls[0]).toContain("event=workflow_dispatch");
  });
});

describe("waitForRun", () => {
  const queued: CiRun = {
    id: 7,
    status: "queued",
    conclusion: null,
    htmlUrl: "https://github.com/acme/web/actions/runs/7",
    name: "Verify",
    headBranch: "agent/x",
    createdAt: "2026-09-22T10:00:00Z",
  };

  it("polls until the run concludes and returns the verdict", async () => {
    let polls = 0;
    stubFetch(() => {
      polls += 1;
      return json(rawRun({ id: 7, status: polls >= 2 ? "completed" : "in_progress", conclusion: polls >= 2 ? "success" : null }));
    });
    const waited: number[] = [];
    const result = await waitForRun(
      { token: "t", owner: "acme", repo: "web", run: queued },
      {
        // No real waiting: the schedule is the caller's, not the clock's.
        sleep: async (ms) => void waited.push(ms),
        pollIntervalMs: 100,
        maxPollIntervalMs: 1_000,
      }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.status).toBe("passed");
      expect(result.verdict.authoritativelyGreen).toBe(true);
    }
  });

  it("backs off between polls instead of hammering the API", async () => {
    let polls = 0;
    stubFetch(() => {
      polls += 1;
      return json(rawRun({ id: 7, status: polls >= 3 ? "completed" : "in_progress", conclusion: null }));
    });
    const waited: number[] = [];
    await waitForRun(
      { token: "t", owner: "acme", repo: "web", run: queued },
      { sleep: async (ms) => void waited.push(ms), pollIntervalMs: 100, maxPollIntervalMs: 250 }
    );
    expect(waited.length).toBeGreaterThan(1);
    expect(waited[1]!).toBeGreaterThan(waited[0]!);
    expect(Math.max(...waited)).toBeLessThanOrEqual(250);
  });

  it("gives the wait up when the user stops the turn", async () => {
    // A CI wait is up to fifteen minutes of polling, so Stop has to reach
    // it — and it must come back as "stopped", never as a verdict, because
    // a verdict would be recorded as evidence about this revision.
    const calls = stubFetch(() => json(rawRun({ id: 7, status: "in_progress", conclusion: null })));
    const controller = new AbortController();
    controller.abort();

    const result = await waitForRun(
      { token: "t", owner: "acme", repo: "web", run: queued },
      { sleep: async () => {}, signal: controller.signal }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/stopped by the user/i);
    // Nothing was even asked of GitHub: an aborted wait is over before it starts.
    expect(calls).toHaveLength(0);
  });

  it("reports a timeout as still running, never as a failure", async () => {
    stubFetch(() => json(rawRun({ id: 7, status: "in_progress", conclusion: null })));
    let clock = 0;
    const result = await waitForRun(
      { token: "t", owner: "acme", repo: "web", run: queued },
      {
        sleep: async () => {
          clock += 60_000;
        },
        now: () => clock,
        maxWaitMs: 120_000,
      }
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdict.status).toBe("running");
  });
});

describe("fetchRun", () => {
  it("reads the run's state", async () => {
    stubFetch(() => json(rawRun({ id: 9, status: "completed", conclusion: "failure" })));
    const run = await fetchRun({ token: "t", owner: "acme", repo: "web", runId: 9 });
    expect(run?.conclusion).toBe("failure");
  });
});

// ============================================================
// fetchCiFailure — A Red Run Says Where, Not Just That
// ============================================================
// The tier's job is to make a failure ACTIONABLE. A conclusion plus a URL tells
// the agent that the change broke and nothing else, so the only way to fix CI
// from a browser chat was for the user to open the run and paste the log back
// in. These cases pin the two halves of the fix, and the one thing that must
// survive its failure: the job and step names.

describe("extractFailureLines", () => {
  it("picks the errors out of install noise instead of taking the tail", () => {
    // The real shape of a failed step's log: mostly nothing, then the failure,
    // then more nothing. A plain tail hands back the epilogue.
    const log = [
      "2026-09-24T01:00:00.0000000Z npm warn deprecated left-pad@1.0.0",
      "2026-09-24T01:00:01.0000000Z added 412 packages in 8s",
      "2026-09-24T01:00:02.0000000Z ",
      "2026-09-24T01:00:03.0000000Z > project@1.0.0 test",
      "2026-09-24T01:00:04.0000000Z ##[error]FAIL src/app.test.ts",
      "2026-09-24T01:00:05.0000000Z npm ERR! Test failed. See above for more details.",
      "2026-09-24T01:00:06.0000000Z Process completed with exit code 1.",
    ].join("\n");

    const lines = extractFailureLines(log);
    expect(lines.some((l) => l.includes("FAIL src/app.test.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("npm ERR!"))).toBe(true);
    // The timestamp prefix is stripped: it is noise in every line and the model
    // does not reason about log clock times.
    expect(lines.every((l) => !/^\d{4}-\d{2}-\d{2}T/.test(l))).toBe(true);
    // The ##[error] wrapper is a GitHub annotation marker, not the message.
    expect(lines.some((l) => l.startsWith("FAIL"))).toBe(true);
  });

  it("strips ANSI colour codes, which otherwise make the log unreadable", () => {
    const log = "\u001b[31m\u001b[1mError: cannot find module 'foo'\u001b[0m\n";
    expect(extractFailureLines(log)).toEqual(["Error: cannot find module 'foo'"]);
  });

  it("reports each error once, even across matrix legs", () => {
    const line = "2026-09-24T01:00:00.0000000Z ##[error]TypeError: x is not a function";
    const lines = extractFailureLines([line, line, line].join("\n"));
    expect(lines).toHaveLength(1);
  });

  it("falls back to the tail rather than returning nothing", () => {
    // An empty list reads as "no errors found", which is a worse lie than a
    // tail the caller can see is just a tail.
    const log = ["step 1", "step 2", "step 3"].join("\n");
    expect(extractFailureLines(log)).toEqual(["step 1", "step 2", "step 3"]);
  });

  it("caps how much it hands back, and says so in the line itself", () => {
    const long = `${"x".repeat(600)} error`;
    const lines = extractFailureLines(long);
    expect(lines[0]!.length).toBeLessThan(420);
    expect(lines[0]!.endsWith("…")).toBe(true);
  });
});

describe("fetchCiFailure", () => {
  it("names the failing job and step, and returns its log lines", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/actions/runs/7/jobs")) {
        return json({
          jobs: [
            { id: 1, name: "lint", conclusion: "success", steps: [] },
            {
              id: 2,
              name: "test (20.x)",
              conclusion: "failure",
              steps: [
                { name: "npm ci", conclusion: "success" },
                { name: "npm test", conclusion: "failure" },
              ],
            },
          ],
        });
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "2026-09-24T01:00:00.0000000Z ##[error]2 tests failed",
      } as unknown as Response;
    });

    const detail = await fetchCiFailure({ token: "t", owner: "o", repo: "r", runId: 7 });
    expect(detail?.job).toBe("test (20.x)");
    expect(detail?.step).toBe("npm test");
    expect(detail?.lines).toEqual(["2 tests failed"]);
    expect(calls.some((c) => c.includes("/actions/jobs/2/logs"))).toBe(true);
  });

  it("prefers a hard failure over a timeout, and the first of either", async () => {
    stubFetch((url) => {
      if (url.includes("/actions/runs/7/jobs")) {
        return json({
          jobs: [
            { id: 9, name: "slow", conclusion: "timed_out", steps: [] },
            { id: 8, name: "real failure", conclusion: "failure", steps: [] },
          ],
        });
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "boom error" } as unknown as Response;
    });

    const detail = await fetchCiFailure({ token: "t", owner: "o", repo: "r", runId: 7 });
    expect(detail?.job).toBe("real failure");
  });

  it("still names the job and step when the log itself cannot be read", async () => {
    // The degradation that matters: the log endpoint needs a redirect to a
    // signed URL, which is the part most likely to fail in a browser. Losing it
    // must not lose the half of the answer that is already actionable.
    stubFetch((url) => {
      if (url.includes("/actions/runs/7/jobs")) {
        return json({
          jobs: [
            {
              id: 2,
              name: "build",
              conclusion: "failure",
              steps: [{ name: "npm run build", conclusion: "failure" }],
            },
          ],
        });
      }
      return json({ message: "nope" }, 500);
    });

    const detail = await fetchCiFailure({ token: "t", owner: "o", repo: "r", runId: 7 });
    expect(detail?.job).toBe("build");
    expect(detail?.step).toBe("npm run build");
    expect(detail?.lines).toEqual([]);
    expect(detail?.logUnavailable).toMatch(/HTTP 500/);
  });

  it("returns null when nothing actually failed", async () => {
    stubFetch(() =>
      json({ jobs: [{ id: 1, name: "test", conclusion: "success", steps: [] }] })
    );
    expect(await fetchCiFailure({ token: "t", owner: "o", repo: "r", runId: 7 })).toBeNull();
  });
});
