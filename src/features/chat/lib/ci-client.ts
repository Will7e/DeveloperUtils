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
import { GITHUB_API_BASE_URL } from "../constants";
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

/**
 * The most recent runs of a branch (or of the whole repository).
 *
 * `verify_with_ci` finds the run IT dispatched, which is the right rule for a
 * verification. A read that only wants to explain a red badge — "what broke on
 * my branch" — needs the opposite: the newest run there is, whoever started
 * it. Newest-first is the API's own order, so this does not sort.
 */
export async function listWorkflowRuns(request: {
  token: string;
  owner: string;
  repo: string;
  branch?: string;
  workflowPath?: string;
  perPage?: number;
}): Promise<CiRun[]> {
  const params = new URLSearchParams({
    per_page: String(Math.min(Math.max(request.perPage ?? 10, 1), 50)),
  });
  if (request.branch) params.set("branch", request.branch);
  const path = request.workflowPath
    ? `/repos/${request.owner}/${request.repo}/actions/workflows/${workflowIdFromPath(request.workflowPath)}/runs?${params}`
    : `/repos/${request.owner}/${request.repo}/actions/runs?${params}`;
  const res = await githubFetch(path, request.token);
  const payload = (await res.json()) as { workflow_runs?: unknown };
  const rows = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
  return rows.flatMap((raw) => {
    const run = normalizeRun(raw);
    return run ? [run] : [];
  });
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

/** Which job and step broke, and the first failures from its log. */
export interface CiFailureDetail {
  /** Job name as GitHub labels it, e.g. "build (20.x)" */
  job: string;
  /** The failing step's name, when the job reports one */
  step: string | null;
  /** Deduplicated, timestamp-stripped failure lines, already capped */
  lines: string[];
  /**
   * Set when the log could not be read, naming why. The job and step are still
   * reported: "`test` failed at step `npm test`" is already most of what the
   * agent needs in order to act, and it must survive the log fetch failing.
   */
  logUnavailable?: string;
}

/** Cap on the log body we are willing to read (the tail is what matters) */
const CI_LOG_MAX_CHARS = 200_000;
/** How many failure lines to keep — the ledger caps at 20 anyway */
const CI_FAILURE_LINE_CAP = 16;

/** ANSI colour and control sequences, which make a log unreadable to a model */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** `2026-09-24T01:02:03.4567890Z ` — GitHub prefixes every log line with one */
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;

const ERROR_MARKERS =
  /(##\[error\]|npm ERR!|error:|ERROR|Error\b|FAIL|failed|assertion|panic|Traceback|exited with code|cannot find|no such file)/;

/**
 * The failing job's own output — what the verdict could not carry.
 *
 * `verify_with_ci` reported a conclusion and a URL, so a failed run told the
 * agent THAT it broke and never WHERE. The consequence was concrete: the agent
 * could not fix what CI reported without the user opening the run and pasting
 * the log back into the chat, which made the tier useless at exactly the moment
 * it mattered. This reads the failure instead of linking to it.
 *
 * Never throws. A log that cannot be read degrades to the job and step names,
 * because that is still an instruction and an exception is not.
 */
export async function fetchCiFailure(
  request: { token: string; owner: string; repo: string; runId: number },
  deps: CiClientDeps = {}
): Promise<CiFailureDetail | null> {
  const doFetch = deps.fetch ?? fetch;
  // Assigned on every path that survives the catch, so there is no initial
  // `null` that a reader has to check against a later reassignment.
  let job: CiJob | null;
  try {
    const res = await githubFetch(
      `/repos/${request.owner}/${request.repo}/actions/runs/${request.runId}/jobs?per_page=50`,
      request.token
    );
    const payload = (await res.json()) as { jobs?: unknown[] };
    job = firstFailedJob(payload.jobs ?? []);
  } catch {
    return null;
  }
  if (!job) return null;

  const failingStep =
    job.steps.find((s) => s.conclusion === "failure" || s.conclusion === "timed_out")?.name ?? null;
  const base: CiFailureDetail = { job: job.name, step: failingStep, lines: [] };

  try {
    // The jobs endpoint answers 302 to a short-lived signed URL; fetch follows
    // it, and that URL carries its own authorization so the header is not what
    // authorizes the download.
    const res = await doFetch(
      `${GITHUB_API_BASE_URL}/repos/${request.owner}/${request.repo}/actions/jobs/${job.id}/logs`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${request.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(deps.signal ? { signal: deps.signal } : {}),
      }
    );
    if (!res.ok) {
      return { ...base, logUnavailable: `GitHub answered HTTP ${res.status} for the job log.` };
    }
    const text = (await res.text()).slice(-CI_LOG_MAX_CHARS);
    return { ...base, lines: extractFailureLines(text) };
  } catch (err) {
    if (deps.signal?.aborted) return { ...base, logUnavailable: "Stopped by the user before the log was read." };
    return {
      ...base,
      logUnavailable: `The job log could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** One job of a run, as far as a failure report needs to know it */
type CiJob = {
  id: number;
  name: string;
  conclusion: string | null;
  steps: Array<{ name: string; conclusion: string | null }>;
};

function firstFailedJob(raw: unknown[]): CiJob | null {
  const failed: CiJob[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const j = entry as Record<string, unknown>;
    if (typeof j.id !== "number") continue;
    const conclusion = typeof j.conclusion === "string" ? j.conclusion : null;
    if (conclusion !== "failure" && conclusion !== "timed_out") continue;
    const steps = Array.isArray(j.steps)
      ? (j.steps as unknown[]).flatMap((s) => {
          if (typeof s !== "object" || s === null) return [];
          const step = s as Record<string, unknown>;
          return [
            {
              name: typeof step.name === "string" ? step.name : "(unnamed step)",
              conclusion: typeof step.conclusion === "string" ? step.conclusion : null,
            },
          ];
        })
      : [];
    failed.push({
      id: j.id,
      name: typeof j.name === "string" ? j.name : `job ${j.id}`,
      conclusion,
      steps,
    });
  }
  // A hard failure is more useful than a timeout, and the first of either is
  // usually the upstream cause rather than a job that failed because of it.
  return failed.find((j) => j.conclusion === "failure") ?? failed[0] ?? null;
}

/**
 * The lines that explain the failure, not the last N lines of a log.
 *
 * GitHub's log for a failed step is mostly install noise, so a plain tail is
 * often "added 412 packages" while the assertion that failed sits forty lines
 * above. Markers pick the real errors out; if nothing matches, the tail is the
 * fallback, and the caller is told what it got rather than being handed an
 * empty list that reads as "no errors found".
 */
export function extractFailureLines(text: string): string[] {
  const cleaned = text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(LOG_TIMESTAMP, "").replace(/^##\[(error|warning|group|endgroup|section)\]/, "").trimEnd())
    .filter((line) => line.trim().length > 0);

  const seen = new Set<string>();
  const picked: string[] = [];
  for (const line of cleaned) {
    if (!ERROR_MARKERS.test(line)) continue;
    // GitHub repeats the same error once per matrix leg and once in the
    // summary; the model needs it once.
    const key = line.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(key.length > 400 ? `${key.slice(0, 400)}…` : key);
    if (picked.length >= CI_FAILURE_LINE_CAP) break;
  }
  if (picked.length > 0) return picked;

  const tail = cleaned.slice(-8).filter((line) => !seen.has(line));
  return tail.map((line) => (line.length > 400 ? `${line.slice(0, 400)}…` : line));
}


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
