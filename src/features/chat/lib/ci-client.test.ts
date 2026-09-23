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
