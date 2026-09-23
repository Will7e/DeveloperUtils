// ============================================================
// CI Client — Dispatching The Repository's Own Verification
// ============================================================
// The network half of the CI tier: start a workflow on the agent's working
// branch, find the run it created, and wait for a conclusion.
//
// Three details are the difference between this working and appearing to:
//
//   • a dispatch answers 204 with NO body, so the run cannot be identified
//     from the response. It is found by asking for runs on that branch
//     CREATED AFTER the dispatch — otherwise the previous green run on the
//     same branch is returned, and every verification passes.
//   • the dispatch permission is `actions: write`, which is not the same as
//     the contents permission a push needs. A 403 here is reported as a
//     scope problem with the fix, not as "something went wrong".
//   • polling backs off. GitHub rate limits per installation, and a tight
//     loop on a ten-minute build burns the budget the agent needs for
//     everything else.
// ============================================================

import { githubFetch, GitHubError } from "./github-client";
import {
  CI_POLL_INTERVAL_MS,
  CI_POLL_MAX_INTERVAL_MS,
  interpretCiRun,
  type CiConclusion,
  type CiRun,
  type CiVerdict,
} from "./ci-plan";

export interface CiClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Give up waiting after this long, and say so */
  maxWaitMs?: number;
  /** How often to ask */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  onPoll?: (run: CiRun, elapsedMs: number) => void;
  /**
   * The turn's abort signal. A CI wait pools up to fifteen minutes of
   * polling, and a Stop that only took effect after the verdict would be a
   * Stop that did nothing (see companion-client's CompanionDeps).
   */
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The workflow file name, which the API accepts in place of a numeric id. */
export function workflowIdFromPath(path: string): string {
  return path.split("/").pop() ?? path;
}

export type CiDispatchResult =
  | { ok: true }
  | { ok: false; error: string; code: "scope" | "not-found" | "no-dispatch-trigger" | "transport" };

/**
 * Start one run of a workflow on a ref.
 *
 * `inputs` is empty by default: a workflow's own defaults are what the
 * repository's author intended, and inventing inputs is how a CI run turns
 * into a test of the wrong thing.
 */
export async function dispatchWorkflow(
  request: {
    token: string;
    owner: string;
    repo: string;
    workflowPath: string;
    ref: string;
    inputs?: Record<string, string>;
  },
  deps: CiClientDeps = {}
): Promise<CiDispatchResult> {
  const id = workflowIdFromPath(request.workflowPath);
  try {
    await githubFetch(
      `/repos/${request.owner}/${request.repo}/actions/workflows/${encodeURIComponent(id)}/dispatches`,
      request.token,
      "application/vnd.github+json",
      {
        method: "POST",
        body: JSON.stringify({ ref: request.ref, inputs: request.inputs ?? {} }),
      }
    );
    return { ok: true };
  } catch (err) {
    if (err instanceof GitHubError) {
      if (err.status === 403 || err.status === 401) {
        return {
          ok: false,
          code: "scope",
          error:
            "GitHub refused the dispatch: starting a workflow needs `actions: write` on this repository, " +
            "which is a different permission from the one that pushes code. Reconnect with that scope.",
        };
      }
      if (err.status === 404) {
        return { ok: false, code: "not-found", error: `No workflow named ${id} on ${request.ref}.` };
      }
      if (err.status === 422) {
        return {
          ok: false,
          code: "no-dispatch-trigger",
          error:
            `${id} does not declare \`workflow_dispatch\`, so GitHub will not start it on demand. ` +
            "Add the trigger, or rely on the push to run it.",
        };
      }
      return { ok: false, code: "transport", error: err.message };
    }
    return { ok: false, code: "transport", error: err instanceof Error ? err.message : String(err) };
  }
  void deps;
}

/**
 * The run this dispatch created.
 *
 * Asked for by branch and event, then filtered to runs created at or after
 * `sinceIso` — the newest-first list alone would hand back the last green
 * run on the branch, which is a verification that already happened.
 */
export async function findDispatchedRun(
  request: {
    token: string;
    owner: string;
    repo: string;
    workflowPath: string;
    ref: string;
    sinceIso: string;
  },
  deps: CiClientDeps = {}
): Promise<CiRun | null> {
  const id = workflowIdFromPath(request.workflowPath);
  const res = await githubFetch(
    `/repos/${request.owner}/${request.repo}/actions/workflows/${encodeURIComponent(id)}/runs` +
      `?branch=${encodeURIComponent(request.ref)}&event=workflow_dispatch&per_page=10`,
    request.token
  );
  const payload = (await res.json()) as { workflow_runs?: unknown[] };
  const since = Date.parse(request.sinceIso);
  for (const raw of payload.workflow_runs ?? []) {
    const run = normalizeRun(raw);
    if (!run) continue;
    if (Number.isFinite(since) && Date.parse(run.createdAt) < since) continue;
    return run;
  }
  void deps;
  return null;
}

/** One run's current state. */
export async function fetchRun(
  request: { token: string; owner: string; repo: string; runId: number }
): Promise<CiRun | null> {
  const res = await githubFetch(
    `/repos/${request.owner}/${request.repo}/actions/runs/${request.runId}`,
    request.token
  );
  return normalizeRun(await res.json());
}

function normalizeRun(raw: unknown): CiRun | null {
  if (typeof raw !== "object" || raw === null) return null;
  const run = raw as Record<string, unknown>;
  if (typeof run.id !== "number") return null;
  return {
    id: run.id,
    status: typeof run.status === "string" ? run.status : "unknown",
    conclusion: (typeof run.conclusion === "string" ? run.conclusion : null) as CiConclusion,
    htmlUrl: typeof run.html_url === "string" ? run.html_url : "",
    name: typeof run.name === "string" ? run.name : `run ${run.id}`,
    headBranch: typeof run.head_branch === "string" ? run.head_branch : "",
    createdAt: typeof run.created_at === "string" ? run.created_at : new Date(0).toISOString(),
  };
}

export type CiWaitResult =
  | { ok: true; run: CiRun; verdict: CiVerdict }
  | { ok: false; error: string };

/**
 * Wait for the dispatched run to finish, backing off as it goes.
 *
 * A timeout is reported as a running verdict rather than a failure: the run
 * is still going on GitHub, and saying so is the truth the agent needs in
 * order to avoid calling it either way.
 */
export async function waitForRun(
  request: { token: string; owner: string; repo: string; run: CiRun },
  deps: CiClientDeps = {}
): Promise<CiWaitResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const maxWait = deps.maxWaitMs ?? 15 * 60_000;
  const initial = deps.pollIntervalMs ?? CI_POLL_INTERVAL_MS;
  const cap = deps.maxPollIntervalMs ?? CI_POLL_MAX_INTERVAL_MS;
  const started = now();
  let run = request.run;
  let interval = initial;

  for (;;) {
    if (deps.signal?.aborted) {
      // Not a verdict: no run happened against this revision, so nothing
      // may be recorded as verified in either direction.
      return { ok: false, error: "Stopped by the user while waiting for CI — the run was left to finish on GitHub." };
    }
    if (run.status === "completed") return { ok: true, run, verdict: interpretCiRun(run, now() - started) };
    if (now() - started >= maxWait) {
      return { ok: true, run, verdict: interpretCiRun(run, now() - started) };
    }
    await sleep(interval);
    if (deps.signal?.aborted) {
      return { ok: false, error: "Stopped by the user while waiting for CI — the run was left to finish on GitHub." };
    }
    interval = Math.min(Math.round(interval * 1.5), cap);
    try {
      const next = await fetchRun({
        token: request.token,
        owner: request.owner,
        repo: request.repo,
        runId: run.id,
      });
      if (next) run = next;
      deps.onPoll?.(run, now() - started);
    } catch (err) {
      // A transient API error while polling is not a verdict: the run is
      // still going, and answering "failed" here would be inventing one.
      if (err instanceof GitHubError && err.status >= 500) continue;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
