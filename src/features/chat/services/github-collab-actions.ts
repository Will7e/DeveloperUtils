// ============================================================
// GitHub Collaboration Actions — Issues, Pull Requests, Reviews
// ============================================================
// The hands behind the nine collaboration tools. lib/github-collab.ts is the
// transport (endpoints, caps, normalization); this module is the policy:
//
//   • WHICH repository. The owner/name come from the thread's workspace, never
//     from an argument. A model that could name the repository could name
//     somebody else's, and "read the issues in `facebook/react`" is not a
//     capability this agent should have by accident.
//
//   • READS ARE FREE, WRITES ARE ASKED. The five read executors run without a
//     dialog — they change nothing, and a read that needed approval would make
//     the review conversation impossible to have. The four write executors go
//     through the SAME gate `http_write` uses (a real dialog naming the method,
//     the URL, the body and the agent's reason, with "run tools without asking"
//     honoured as auto-approval), because every one of them changes somebody
//     else's repository and none can be undone from here. That gate is also the
//     reason the token is not in the payload it shows: the credential this app
//     already holds is never re-rendered into a dialog.
//
//   • A REFUSAL IS A RESULT. Declining carries the user's note back into the
//     turn so the model adapts instead of resending, exactly like http_write.
//
// Deliberately no ledger and no undo: GitHub is not this app's storage. The
// reversal for a bad comment is deleting it on GitHub, and pretending
// otherwise — a local "undo" that leaves the comment up — would be worse than
// saying the write cannot be taken back here.

import { selectWorkspace, useChatStore } from "@/stores/chat.store";
import type { ToolCallResult, ToolName, WorkspaceState } from "../types";
import { GitHubError } from "../lib/github-client";
import {
  COLLAB_LIST_LIMIT,
  COMMENT_MUST_HAVE_TEXT,
  commentOnIssue,
  createIssue,
  fitPayload,
  listIssues,
  listPullRequests,
  readIssue,
  readPullRequest,
  findPullRequestForHead,
  replyToReviewComment,
  reviewPullRequest,
  updatePullRequest,
  type CollabRepo,
  type ReviewEvent,
  type ShedRule,
} from "../lib/github-collab";
import { fetchCiFailure, fetchRun, listWorkflowRuns } from "../lib/ci-client";

// ── Shared plumbing ──────────────────────────────────────────

type Outcome =
  | { ok: true; data: Record<string, unknown>; summary: string }
  | { ok: false; error: string; summary: string };

function toResult(name: ToolName, outcome: Outcome, started: number): ToolCallResult {
  return outcome.ok
    ? {
        callId: "",
        name,
        ok: true,
        data: outcome.data,
        durationMs: Date.now() - started,
        summary: outcome.summary,
      }
    : {
        callId: "",
        name,
        ok: false,
        data: { error: outcome.error },
        durationMs: Date.now() - started,
        summary: outcome.summary,
      };
}

function fail(name: ToolName, error: string, summary: string, started: number): ToolCallResult {
  return toResult(name, { ok: false, error, summary }, started);
}

/**
 * The repository this thread is attached to, plus the token to reach it.
 *
 * Same `selectWorkspace` rule as the write executors: the thread's CURRENT
 * repository, read through the store's own selector, because the entry in
 * memory is the one the thread just left during a repository switch.
 */
async function repoContext(
  conversationId: string
): Promise<{ ok: true; repo: CollabRepo; ws: WorkspaceState } | { ok: false; error: string }> {
  const store = useChatStore.getState();
  const live = selectWorkspace(store, conversationId);
  const ws = live ?? (await store.ensureWorkspace(conversationId));

  if (!ws) {
    return {
      ok: false,
      error:
        "No repository is attached to this conversation. Attach one first — issues and pull requests belong to a repository.",
    };
  }
  const token = store.settings.github.token;
  if (!token) {
    return {
      ok: false,
      error: "Connect GitHub in Chat Settings first — the collaboration tools act as your account.",
    };
  }
  return { ok: true, repo: { token, owner: ws.owner, repo: ws.repo }, ws };
}

/**
 * Turns a transport error into something the model can act on.
 *
 * `GitHubError` already carries the codes the API distinguishes; the useful
 * addition here is the sentence that says WHO can fix it, because "403" on its
 * own reads as a bug in the tool rather than a scope on the token.
 */
function describeError(err: unknown): string {
  if (err instanceof GitHubError) {
    if (err.code === "unauthorized") {
      return `${err.message} Reconnect GitHub in Chat Settings.`;
    }
    // Checked BEFORE the forbidden branch: github-client classifies 422 as
    // "forbidden" (a validation refusal is not a permission one), so ordering
    // these the other way sends a model to the token settings for a line number
    // that is simply not in the diff.
    if (/review thread|part of the diff|diff hunk/i.test(err.message)) {
      return `${err.message} An inline comment's \`line\` must be a line that appears in this pull request's diff — re-read it with \`read_pull_request\` and use a line from \`files\`, or move the point into the review \`body\`.`;
    }
    if (err.code === "forbidden") {
      return `${err.message} Issues and pull requests need \`issues: write\` and \`pull_requests: write\` on a fine-grained token.`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "The GitHub request failed.";
}

function optionalArg(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === "string" && args[key].trim() !== "" ? (args[key] as string).trim() : undefined;
}

/** A positive issue/PR number, or a refusal that names the argument */
function requireNumber(args: Record<string, unknown>, key: string): number {
  const raw = args[key];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`\`${key}\` must be a positive integer (e.g. 42). Received: ${JSON.stringify(raw)}.`);
  }
  return raw;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return rows.length > 0 ? rows.map((v) => v.trim()) : undefined;
}

// ── Fitting a read into the wire budget ──────────────────────

/**
 * Shedding order for an issue read: comments first (they are the pageable
 * part), then the body, which is the only other large field.
 */
const ISSUE_SHED: readonly ShedRule[] = [
  {
    key: "issue.comments",
    note: "Some older comments were left out to fit this result — they are on GitHub, and `commentsTotal` says how many exist.",
  },
  {
    key: "issue.body",
    note: "The issue body was trimmed to fit this result; the full text is on GitHub.",
  },
];

/**
 * Shedding order for a pull-request read.
 *
 * The file list goes LAST on purpose: a fix-up turn is deciding what to CHANGE,
 * and the inline comments name the file and line anyway — the file list is the
 * context for reading the diff, not for acting on the review. Verdict fields
 * are never shed; they are the answer.
 */
const PULL_SHED: readonly ShedRule[] = [
  {
    key: "pullRequest.files",
    note: "The file list was trimmed to fit this result — `filesTotal` says how many files the pull request touches.",
  },
  {
    key: "pullRequest.comments",
    note: "Older conversation comments were left out to fit this result — `commentsTotal` says how many exist.",
  },
  {
    key: "pullRequest.reviews",
    note: "Older reviews were left out to fit this result — `reviewsTotal` says how many exist.",
  },
  {
    key: "pullRequest.body",
    note: "The description was trimmed to fit this result; the full text is on GitHub.",
  },
  // Last, because these are the payload's point: the reviewer's own words, on
  // the line they are about.
  {
    key: "pullRequest.inlineComments",
    note: "Some inline review comments were left out to fit this result — `read_pull_request` shows the newest 25.",
  },
];

// ── The approval gate for writes ─────────────────────────────

interface WriteGate {
  method: string;
  url: string;
  body: unknown;
  /**
   * The model's one-liner for the dialog.
   *
   * This is the only human sentence the dialog carries, so a caller whose
   * request is not self-explanatory from the URL (a reply landing in a review
   * thread rather than the conversation) must say so HERE — a field that only
   * the code reads is a field the user never sees.
   */
  why: string;
}

/**
 * Shows the write before it happens and blocks on the answer.
 *
 * The endpoint is composed for DISPLAY from the same path the transport will
 * build, so what the dialog names is what goes out. The token is deliberately
 * not among the headers shown: it is the app's credential, the dialog's job is
 * to describe the CHANGE, and a bearer token rendered into a modal is a token
 * in the next screenshot.
 */
async function approveWrite(
  conversationId: string,
  gate: WriteGate
): Promise<{ ok: true; auto: boolean } | { ok: false; error: string }> {
  const decision = await useChatStore.getState().requestHttpApproval({
    conversationId,
    createdAt: Date.now(),
    method: gate.method,
    url: gate.url,
    headers: { Accept: "application/vnd.github+json" },
    body: JSON.stringify(gate.body, null, 2),
    why: gate.why,
  });
  if (!decision.approved) {
    return {
      ok: false,
      error: decision.note
        ? `The user did not approve this GitHub write: ${decision.note}. Adapt to that — do not resend the same call.`
        : "The user did not approve this GitHub write. Nothing was sent. Do not resend it; ask what they want instead.",
    };
  }
  return { ok: true, auto: decision.auto === true };
}

/** The sentence every approved write appends, so a report cannot imply review */
function writeScope(auto: boolean): Record<string, unknown> {
  return {
    scope:
      "Written to GITHUB, not to the workspace — this app has no undo for it. The user can edit or delete it on GitHub.",
    ...(auto
      ? {
          autoApproved:
            '"Run tools without asking" is on in the user\'s chat settings, so this write was sent without showing them a dialog. Say so when you report it — never describe it as reviewed.',
        }
      : {}),
  };
}

const GITHUB_API = "https://api.github.com";

// ── list_issues ──────────────────────────────────────────────

export async function runListIssues(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "list_issues";
  const ctx = await repoContext(conversationId);
  if (!ctx.ok) return fail(name, ctx.error, "no repository", started);

  const state = optionalArg(args, "state");
  const includePrs = args.includePullRequests === true;
  try {
    const issues = await listIssues(ctx.repo, {
      ...(state === "open" || state === "closed" || state === "all" ? { state } : {}),
      ...(optionalArg(args, "labels") ? { labels: optionalArg(args, "labels")! } : {}),
      ...(optionalArg(args, "assignee") ? { assignee: optionalArg(args, "assignee")! } : {}),
      includePullRequests: includePrs,
    });
    // A 30-row list is ~250 chars a row, which is under the wire budget with
    // room to spare — but only just, so it is fitted rather than assumed.
    const fitted = fitPayload(
      {
        repository: `${ctx.repo.owner}/${ctx.repo.repo}`,
        count: issues.length,
        issues,
        ...(includePrs
          ? {}
          : {
              note: "Pull requests are excluded from this list (GitHub's issues endpoint returns them mixed in). Use list_pull_requests for those.",
            }),
        ...(issues.length === COLLAB_LIST_LIMIT
          ? { capNote: `Exactly ${COLLAB_LIST_LIMIT} were returned, which is this tool's cap — there may be more.` }
          : {}),
      },
      [
        {
          key: "issues",
          note: "Some rows were left out to fit this result — narrow the filters (labels, state) or read the rest on GitHub.",
        },
      ]
    );
    return toResult(
      name,
      {
        ok: true,
        data: { ...fitted.data, ...(fitted.notes.length > 0 ? { trimmed: fitted.notes } : {}) },
        summary: `${issues.length} issue(s)`,
      },
      started
    );
  } catch (err) {
    return fail(name, describeError(err), "read failed", started);
  }
}

// ── read_issue ───────────────────────────────────────────────

export async function runReadIssue(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "read_issue";
  const ctx = await repoContext(conversationId);
  if (!ctx.ok) return fail(name, ctx.error, "no repository", started);

  let number: number;
  try {
    number = requireNumber(args, "number");
  } catch (err) {
    return fail(name, err instanceof Error ? err.message : "bad argument", "bad argument", started);
  }

  try {
    const issue = await readIssue(ctx.repo, number);
    const fitted = fitPayload(
      {
        repository: `${ctx.repo.owner}/${ctx.repo.repo}`,
        issue,
        ...(issue.isPullRequest
          ? {
              note: `#${number} is a PULL REQUEST, not an issue — read_pull_request gives you its diff, reviews and check state.`,
            }
          : {}),
        ...(issue.comments.length < issue.commentsTotal
          ? {
              commentsNote: `Showing the last ${issue.comments.length} of ${issue.commentsTotal} comments — the earlier ones are on GitHub.`,
            }
          : {}),
      },
      ISSUE_SHED
    );
    return toResult(
      name,
      {
        ok: true,
        data: { ...fitted.data, ...(fitted.notes.length > 0 ? { trimmed: fitted.notes } : {}) },
        summary: `#${number} ${issue.title.slice(0, 40)}`,
      },
      started
    );
  } catch (err) {
    return fail(name, describeError(err), "read failed", started);
  }
}

// ── list_pull_requests ───────────────────────────────────────

export async function runListPullRequests(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "list_pull_requests";
  const ctx = await repoContext(conversationId);
  if (!ctx.ok) return fail(name, ctx.error, "no repository", started);

  const state = optionalArg(args, "state");
  try {
    const pulls = await listPullRequests(ctx.repo, {
      ...(state === "open" || state === "closed" || state === "all" ? { state } : {}),
      ...(optionalArg(args, "head") ? { head: optionalArg(args, "head")! } : {}),
      ...(optionalArg(args, "base") ? { base: optionalArg(args, "base")! } : {}),
      ...(optionalArg(args, "author") ? { author: optionalArg(args, "author")! } : {}),
    });
    const fitted = fitPayload(
      {
        repository: `${ctx.repo.owner}/${ctx.repo.repo}`,
        count: pulls.length,
        pullRequests: pulls,
        ...(pulls.length === COLLAB_LIST_LIMIT
          ? { capNote: `Exactly ${COLLAB_LIST_LIMIT} were returned, which is this tool's cap — there may be more.` }
          : {}),
      },
      [
        {
          key: "pullRequests",
          note: "Some rows were left out to fit this result — narrow the filters (head, base, state) or read the rest on GitHub.",
        },
      ]
    );
    return toResult(
      name,
      {
        ok: true,
        data: { ...fitted.data, ...(fitted.notes.length > 0 ? { trimmed: fitted.notes } : {}) },
        summary: `${pulls.length} pull request(s)`,
      },
      started
    );
  } catch (err) {
    return fail(name, describeError(err), "read failed", started);
  }
}

// ── read_pull_request ────────────────────────────────────────

export async function runReadPullRequest(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "read_pull_request";
  const ctx = await repoContext(conversationId);
  if (!ctx.ok) return fail(name, ctx.error, "no repository", started);

  let number: number;
  try {
    number = requireNumber(args, "number");
  } catch (err) {
    return fail(name, err instanceof Error ? err.message : "bad argument", "bad argument", started);
  }

  try {
    const pr = await readPullRequest(ctx.repo, number);
    const blockingReviews = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED");
    const fitted = fitPayload(
      {
        repository: `${ctx.repo.owner}/${ctx.repo.repo}`,
        pullRequest: pr,
        // The facts a fix-up turn is actually deciding on, pulled out of the
        // detail so the model does not have to re-derive them from five arrays
        // — and so a green-check claim has somewhere to point.
        verdict: {
          checks: pr.checks
            ? pr.checks.allGreen
              ? `all checks green (${pr.checks.total} reported)`
              : pr.checks.failing.length > 0
                ? `failing: ${pr.checks.failing.join("; ")}`
                : pr.checks.running.length > 0
                  ? `still running: ${pr.checks.running.join("; ")}`
                  : // Neither failing nor running, yet not green: every check that
                    // reported was skipped or neutral, so nothing was proven.
                    `${pr.checks.total} check(s) reported but NOTHING passed (skipped or neutral) — this is not a green build`
            : "no checks or commit statuses reported on this commit",
          blockingReviews: blockingReviews.map((r) => r.author),
          inlineComments: pr.inlineComments.length,
          mergeable:
            pr.mergeable === null
              ? `GitHub has not computed mergeability yet (${pr.mergeStateNote || "unknown"})`
              : pr.mergeable
                ? `mergeable (${pr.mergeStateNote || "clean"})`
                : `NOT mergeable (${pr.mergeStateNote || "no state given"})`,
        },
        ...(pr.filesTruncated
          ? { filesNote: `Showing ${pr.files.length} of ${pr.filesTotal} changed files.` }
          : {}),
        ...(pr.comments.length < pr.commentsTotal
          ? { commentsNote: `Showing the last ${pr.comments.length} of ${pr.commentsTotal} comments.` }
          : {}),
        ...(pr.reviews.length < pr.reviewsTotal
          ? { reviewsNote: `Showing the newest ${pr.reviews.length} of ${pr.reviewsTotal} reviews.` }
          : {}),
        ...(pr.inlineCommentsTruncated
          ? {
              inlineNote:
                "The newest inline review comments are shown; older annotations are on GitHub. Reply with `comment_on_issue`'s `replyToCommentId`.",
            }
          : {}),
      },
      PULL_SHED
    );
    return toResult(
      name,
      {
        ok: true,
        data: { ...fitted.data, ...(fitted.notes.length > 0 ? { trimmed: fitted.notes } : {}) },
        summary: `#${number} ${pr.checks?.allGreen ? "green" : "see verdict"}`,
      },
      started
    );
  } catch (err) {
    return fail(name, describeError(err), "read failed", started);
  }
}

// ── read_ci_logs ─────────────────────────────────────────────

/**
 * The failing job's output, for a run the agent did not necessarily start.
 *
 * `verify_with_ci` watches the run IT dispatched, which is the right rule when
 * the question is "did my push pass". The question this tool answers is the
 * other one — "what is broken on my branch right now" — which may be a run a
 * teammate's push started, so it takes the newest run and, when the run list
 * has one, prefers the newest FAILED one, because that is the one with
 * something to read.
 */
export async function runReadCiLogs(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "read_ci_logs";
  const ctx = await repoContext(conversationId);
  if (!ctx.ok) return fail(name, ctx.error, "no repository", started);

  const explicitRunId = typeof args.runId === "number" && Number.isInteger(args.runId) ? args.runId : undefined;
  const askedBranch = optionalArg(args, "branch");
  const working = ctx.ws.workingBranch;
  const branch = askedBranch ?? working ?? ctx.ws.branch;
  // Said out loud when it happens: a thread that has not pushed yet has no
  // working branch, so the runs read are the BASE branch's — which may be
  // somebody else's red build, and the model must not report it as this
  // change's failure.
  const fellBackToBase = !askedBranch && !working;
  const workflowPath = optionalArg(args, "workflow");

  try {
    const run = explicitRunId
      ? await fetchRun({ ...ctx.repo, runId: explicitRunId })
      : await (async () => {
          const runs = await listWorkflowRuns({
            ...ctx.repo,
            ...(branch ? { branch } : {}),
            ...(workflowPath ? { workflowPath } : {}),
            perPage: 20,
          });
          const finished = runs.filter((r) => r.status === "completed");
          return finished.find((r) => r.conclusion && r.conclusion !== "success") ?? runs[0] ?? null;
        })();

    if (!run) {
      return fail(
        name,
        explicitRunId
          ? `No workflow run with id ${explicitRunId} in ${ctx.repo.owner}/${ctx.repo.repo}.`
          : `No workflow runs found${branch ? ` for branch ${branch}` : ""} — nothing has run yet, so there is no log to read.`,
        "no run",
        started
      );
    }

    const runSummary = {
      id: run.id,
      name: run.name,
      branch: run.headBranch,
      status: run.status,
      conclusion: run.conclusion,
      url: run.htmlUrl,
    };
    // Present on every outcome, not only the failed one: "which branch did this
    // read from" is a fact about the ANSWER, and it is most misleading when a
    // green base-branch run is reported as if it were this work's.
    const branchNote = fellBackToBase
      ? {
          branchNote: `This thread has no pushed working branch, so runs were read for the BASE branch \`${branch}\`. A result there is not necessarily about this conversation's work — pass \`branch\` to look at another one.`,
        }
      : {};

    if (run.status !== "completed") {
      return toResult(
        name,
        {
          ok: true,
          data: {
            run: runSummary,
            failure: null,
            ...branchNote,
            note: "This run is still going, so there is no failure to read yet. Nothing has failed — it has not finished.",
          },
          summary: `run ${run.id} still running`,
        },
        started
      );
    }

    if (run.conclusion === "success") {
      return toResult(
        name,
        {
          ok: true,
          data: {
            run: runSummary,
            failure: null,
            ...branchNote,
            note: "The newest run on this branch passed — there is no failure to read. If you expected one, name the run id explicitly.",
          },
          summary: `run ${run.id} passed`,
        },
        started
      );
    }

    const failure = await fetchCiFailure({ ...ctx.repo, runId: run.id });
    return toResult(
      name,
      {
        ok: true,
        data: fitPayload(
          {
            run: runSummary,
            failure,
            ...branchNote,
            ...(failure === null
              ? {
                  note: "The run failed but no failing JOB could be read (a cancelled or startup failure reports no failed job). The run URL has the detail.",
                }
              : {}),
          },
          [
            {
              key: "failure.lines",
              note: "Some log lines were left out to fit this result — the run URL has the whole log.",
            },
          ]
        ).data,
        summary: failure ? `${failure.job}${failure.step ? ` / ${failure.step}` : ""}` : `run ${run.id} failed`,
      },
      started
    );
  } catch (err) {
    return fail(name, describeError(err), "read failed", started);
  }
}

// ── create_issue ─────────────────────────────────────────────

export async function runCreateIssue(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "create_issue";
  const ctx = await repoContext(conversationId);
  if (!ctx.ok) return fail(name, ctx.error, "no repository", started);

  const title = optionalArg(args, "title");
  if (!title) return fail(name, "`title` is required and must not be empty.", "bad argument", started);
  const body = optionalArg(args, "body");
  const labels = asStringArray(args.labels);
  const assignees = asStringArray(args.assignees);

  const gate = await approveWrite(conversationId, {
    method: "POST",
    url: `${GITHUB_API}/repos/${ctx.repo.owner}/${ctx.repo.repo}/issues`,
    body: { title, ...(body ? { body } : {}), ...(labels ? { labels } : {}), ...(assignees ? { assignees } : {}) },
    why: (optionalArg(args, "why") ?? "").trim() || `open an issue: ${title}`,
  });
  if (!gate.ok) return fail(name, gate.error, "declined", started);

  try {
    const created = await createIssue(ctx.repo, {
      title,
      ...(body ? { body } : {}),
      ...(labels ? { labels } : {}),
      ...(assignees ? { assignees } : {}),
    });
    return toResult(
      name,
      {
        ok: true,
        data: {
          number: created.number,
          url: created.url,
          state: created.state,
          approved: true,
          ...writeScope(gate.auto),
        },
        summary: created.detail,
      },
      started
    );
  } catch (err) {
    return fail(name, describeError(err), "write failed", started);
  }
}

// ── comment_on_issue ─────────────────────────────────────────

export async function runCommentOnIssue(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "comment_on_issue";
  const ctx = await repoContext(conversationId);
  if (!ctx.ok) return fail(name, ctx.error, "no repository", started);

  let number: number;
  try {
    number = requireNumber(args, "number");
  } catch (err) {
    return fail(name, err instanceof Error ? err.message : "bad argument", "bad argument", started);
  }
  const body = optionalArg(args, "body");
  if (!body) return fail(name, "`body` is required and must not be empty.", "bad argument", started);

  // `replyToCommentId` is the difference between answering a reviewer and
  // talking past them: the id addresses one inline thread, so the answer lands
  // under the note it answers instead of in the general conversation.
  const replyTo = typeof args.replyToCommentId === "number" && Number.isInteger(args.replyToCommentId)
    ? args.replyToCommentId
    : undefined;

  const gate = await approveWrite(conversationId, {
    method: "POST",
    url: replyTo
      ? `${GITHUB_API}/repos/${ctx.repo.owner}/${ctx.repo.repo}/pulls/${number}/comments`
      : `${GITHUB_API}/repos/${ctx.repo.owner}/${ctx.repo.repo}/issues/${number}/comments`,
    body: replyTo ? { body, in_reply_to: replyTo } : { body },
    why:
      (optionalArg(args, "why") ?? "").trim() ||
      (replyTo
        ? `a reply inside the review thread on #${number} (comment ${replyTo})`
        : `a comment on #${number}`),
  });
  if (!gate.ok) return fail(name, gate.error, "declined", started);

  try {
    const created = replyTo
      ? await replyToReviewComment(ctx.repo, { number, commentId: replyTo, body })
      : await commentOnIssue(ctx.repo, { number, body });
    return toResult(
      name,
      {
        ok: true,
        data: {
          number,
          url: created.url,
          approved: true,
          ...(replyTo ? { repliedToComment: replyTo } : {}),
          // A comment on a pull request is posted through the issues endpoint —
          // GitHub models them that way — and the model should know whether its
          // words landed in the conversation or under one review comment.
          scopeNote: replyTo
            ? "Posted as a reply INSIDE that review thread. The reviewer will see it under their own note."
            : "Posted to the issue/pull-request conversation thread.",
          ...writeScope(gate.auto),
        },
        summary: created.detail,
      },
      started
    );
  } catch (err) {
    return fail(name, describeError(err), "write failed", started);
  }
}

// ── review_pull_request ──────────────────────────────────────

export async function runReviewPullRequest(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "review_pull_request";
  const ctx = await repoContext(conversationId);
  if (!ctx.ok) return fail(name, ctx.error, "no repository", started);

  let number: number;
  try {
    number = requireNumber(args, "number");
  } catch (err) {
    return fail(name, err instanceof Error ? err.message : "bad argument", "bad argument", started);
  }

  const event = optionalArg(args, "event")?.toUpperCase();
  if (event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT") {
    return fail(
      name,
      '`event` must be one of APPROVE, REQUEST_CHANGES or COMMENT — a review without one is just a comment (use comment_on_issue for that).',
      "bad argument",
      started
    );
  }
  const body = optionalArg(args, "body");

  const rawComments = Array.isArray(args.comments) ? args.comments : [];
  const inlineComments = rawComments.flatMap((c) => {
    if (typeof c !== "object" || c === null) return [];
    const row = c as Record<string, unknown>;
    const path = typeof row.path === "string" ? row.path.trim() : "";
    const line = typeof row.line === "number" && Number.isInteger(row.line) ? row.line : 0;
    const text = typeof row.body === "string" ? row.body.trim() : "";
    if (!path || line <= 0 || !text) return [];
    return [{ path, line, body: text }];
  });
  // Counted rather than ignored: a malformed inline comment quietly disappearing
  // means the review goes out missing the point it was supposed to make.
  const droppedInline = rawComments.length - inlineComments.length;

  // REQUEST_CHANGES first, because "say what to change" is the more useful
  // refusal when both apply — a blocking review with no summary reason leaves
  // the author nothing to act on, even with inline notes attached. Then the
  // general rule: GitHub answers 422 for a review with no text at all, and
  // naming the missing piece beats relaying its validation blob.
  if (event === "REQUEST_CHANGES" && !body) {
    return fail(
      name,
      "REQUEST_CHANGES must say WHAT to change (`body`) — a blocking review with no reason leaves the author nothing to act on.",
      "bad argument",
      started
    );
  }
  if (!body && inlineComments.length === 0) {
    return fail(name, COMMENT_MUST_HAVE_TEXT, "bad argument", started);
  }

  const gate = await approveWrite(conversationId, {
    method: "POST",
    url: `${GITHUB_API}/repos/${ctx.repo.owner}/${ctx.repo.repo}/pulls/${number}/reviews`,
    body: {
      event,
      ...(body ? { body } : {}),
      ...(inlineComments.length > 0 ? { comments: inlineComments } : {}),
    },
    why: (optionalArg(args, "why") ?? "").trim() || `${event.toLowerCase().replace("_", " ")} on #${number}`,
  });
  if (!gate.ok) return fail(name, gate.error, "declined", started);

  try {
    const review = await reviewPullRequest(ctx.repo, {
      number,
      event: event as ReviewEvent,
      ...(body ? { body } : {}),
      ...(inlineComments.length > 0 ? { comments: inlineComments } : {}),
    });
    return toResult(
      name,
      {
        ok: true,
        data: {
          number,
          state: review.state,
          url: review.url,
          inlineComments: inlineComments.length,
          ...(droppedInline > 0
            ? {
                droppedInline,
                droppedNote: `${droppedInline} inline comment(s) were NOT submitted: each needs a \`path\`, a positive \`line\` and a \`body\`. They were dropped rather than refused, so check whether the review still says what you meant.`,
              }
            : {}),
          approved: true,
          ...writeScope(gate.auto),
        },
        summary: review.detail,
      },
      started
    );
  } catch (err) {
    return fail(name, describeError(err), "write failed", started);
  }
}

// ── update_pull_request ──────────────────────────────────────

export async function runUpdatePullRequest(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "update_pull_request";
  const ctx = await repoContext(conversationId);
  if (!ctx.ok) return fail(name, ctx.error, "no repository", started);

  let number: number;
  try {
    number = requireNumber(args, "number");
  } catch (err) {
    return fail(name, err instanceof Error ? err.message : "bad argument", "bad argument", started);
  }

  const title = typeof args.title === "string" ? args.title : undefined;
  const body = typeof args.body === "string" ? args.body : undefined;
  const stateArg = optionalArg(args, "state");
  const base = optionalArg(args, "base");
  const state = stateArg === "open" || stateArg === "closed" ? stateArg : undefined;

  if (title === undefined && body === undefined && state === undefined && base === undefined) {
    return fail(
      name,
      "Nothing to change: pass at least one of `title`, `body`, `state` (open|closed) or `base`. Closing a PR without pushing anything is `state: \"closed\"`.",
      "bad argument",
      started
    );
  }

  const gate = await approveWrite(conversationId, {
    method: "PATCH",
    url: `${GITHUB_API}/repos/${ctx.repo.owner}/${ctx.repo.repo}/pulls/${number}`,
    body: {
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(base !== undefined ? { base } : {}),
    },
    why: (optionalArg(args, "why") ?? "").trim() || `update pull request #${number}`,
  });
  if (!gate.ok) return fail(name, gate.error, "declined", started);

  try {
    const updated = await updatePullRequest(ctx.repo, {
      number,
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(base !== undefined ? { base } : {}),
    });
    return toResult(
      name,
      {
        ok: true,
        data: {
          number: updated.number,
          state: updated.state,
          url: updated.url,
          approved: true,
          ...(state === "closed"
            ? {
                closingNote:
                  "The pull request is CLOSED, not merged. Closing it does not remove the branch and does not merge anything.",
              }
            : {}),
          ...writeScope(gate.auto),
        },
        summary: updated.detail,
      },
      started
    );
  } catch (err) {
    return fail(name, describeError(err), "write failed", started);
  }
}

// ── create_pull_request ─────────────────────────────────

/**
 * Opens a pull request for THIS thread's working branch. The commit
 * comes first — push_changes is what puts commits on the branch and it
 * normally opens the PR itself, so this executor's job is the
 * deliberate "open it separately" case: a user-held PR, a re-open
 * after the push-time step failed, or a draft.
 *
 * Order of operations is the safety story: look for an existing PR for
 * the head branch BEFORE asking the user to approve anything (an
 * approval for a call GitHub would refuse with a 422 is a wasted
 * dialog), then gate the exact title/body, then create.
 */
export async function runCreatePullRequest(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "create_pull_request";
  const ctx = await repoContext(conversationId);
  if (!ctx.ok) return fail(name, ctx.error, "no repository", started);

  const title = optionalArg(args, "title");
  if (!title) return fail(name, "`title` is required — the change, as a reviewer would search for it.", "bad argument", started);
  const body = optionalArg(args, "body") ?? "";
  const draft = args.draft === true;
  const base = optionalArg(args, "base") || ctx.ws.branch;

  if (!ctx.ws.workingBranch) {
    return fail(
      name,
      "Nothing has been pushed from this conversation yet — there is no working branch to open a pull request FROM. Call push_changes first (it opens the pull request itself unless the user holds it back).",
      "no working branch",
      started
    );
  }
  const head = ctx.ws.workingBranch;
  if (head === base) {
    return fail(
      name,
      `The working branch IS the base branch (${base}) — a pull request needs two different branches. push_changes would have created a working branch; attach a workspace and push first.`,
      "same branch",
      started
    );
  }

  // Look before asking: an existing open PR for this head is the answer.
  try {
    const existing = await findPullRequestForHead(ctx.repo, head);
    if (existing && existing.state === "open") {
      return toResult(
        name,
        {
          ok: true,
          data: {
            status: "already-open",
            number: existing.number,
            url: existing.url,
            note: `Pull request #${existing.number} already covers ${head} — no duplicate was created. Update its description with update_pull_request if the story changed.`,
          },
          summary: `already open: #${existing.number}`,
        },
        started
      );
    }
  } catch {
    // A failed lookup must not block the create: GitHub's own 422 is the backstop.
  }

  const gate = await approveWrite(conversationId, {
    method: "POST",
    url: `${GITHUB_API}/repos/${ctx.repo.owner}/${ctx.repo.repo}/pulls`,
    body: { title, head, base, body, draft },
    why: (optionalArg(args, "why") ?? "").trim() || `open a pull request: ${title}`,
  });
  if (!gate.ok) return fail(name, gate.error, "declined", started);

  try {
    const { openPullRequest } = await import("../lib/github-write");
    const pr = await openPullRequest(ctx.repo.token, ctx.repo.owner, ctx.repo.repo, head, base, title, body);
    return toResult(
      name,
      {
        ok: true,
        data: {
          status: "opened",
          number: pr.number,
          url: pr.htmlUrl,
          head,
          base,
          ...(draft ? { draft: true } : {}),
          approved: true,
          ...writeScope(gate.auto),
        },
        summary: `opened PR #${pr.number}`,
      },
      started
    );
  } catch (err) {
    // The classic race: the lookup missed a PR created between the look
    // and the post. GitHub refuses the duplicate with a 422; report the
    // existing PR instead of a failure.
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists|422/i.test(message)) {
      try {
        const raced = await findPullRequestForHead(ctx.repo, head);
        if (raced) {
          return toResult(
            name,
            {
              ok: true,
              data: {
                status: "already-open",
                number: raced.number,
                url: raced.url,
                note: `A pull request for ${head} already exists (#${raced.number}, state: ${raced.state}) — GitHub refused the duplicate.`,
              },
              summary: `already open: #${raced.number}`,
            },
            started
          );
        }
      } catch {
        /* fall through to the raw error */
      }
    }
    return fail(name, describeError(err), "write failed", started);
  }
}
