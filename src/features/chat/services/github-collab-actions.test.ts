// ============================================================
// GitHub Collaboration Actions — Who Decides, And What Is Sent
// ============================================================
// The transport is tested next door (lib/github-collab.test.ts). What is
// tested here is the POLICY, and it is the part that can do damage:
//
//   1. READS NEVER PROMPT. A review thread that needs the user's approval to
//      read is a conversation the agent cannot have, so the prompt count for a
//      read is asserted to be zero — not merely "it worked anyway".
//   2. WRITES ALWAYS PROMPT, AND A REFUSAL SENDS NOTHING. The refusal carries
//      the user's note back, and the assertion that no request left the machine
//      is the whole point of the gate.
//   3. THE CREDENTIAL IS NOT IN THE DIALOG. The token is asserted against the
//      serialized pending request, so a leak from anywhere in the structure
//      fails — the same standard the app-surface read masking is held to.
//   4. THE REPOSITORY IS THE THREAD'S. Owner and name come from the attached
//      workspace, never from an argument, so there is no syntax that reads
//      somebody else's repository.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/stores/chat.store";
import { setAttachment } from "@/features/chat/identity/bindings";
import type { PendingHttpRequest, RepoContext, WorkspaceState } from "@/features/chat/types";
import {
  runCommentOnIssue,
  runCreateIssue,
  runListIssues,
  runListPullRequests,
  runReadCiLogs,
  runReadIssue,
  runReadPullRequest,
  runReviewPullRequest,
  runUpdatePullRequest,
} from "./github-collab-actions";

const WEB: RepoContext = { owner: "acme", repo: "web", branch: "main", attachedAt: 1 };
const TOKEN = "ghp_token_that_must_not_be_shown";

const store = () => useChatStore.getState();

function workspaceFor(id: string, ref: RepoContext = WEB): WorkspaceState {
  return {
    conversationId: id,
    owner: ref.owner,
    repo: ref.repo,
    branch: ref.branch,
    baseCommitSha: "base-sha",
    workingBranch: "agent/fix-login",
    tree: [],
    files: {},
    updatedAt: 1,
  };
}

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Global fetch stub; returns the call log so "nothing was sent" is checkable */
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  });
  return calls;
}

/** The approval dialog as the store would show it, plus the decision to give */
function stubApproval(decision: { approved: boolean; note?: string; auto?: boolean }) {
  const asked: PendingHttpRequest[] = [];
  useChatStore.setState({
    requestHttpApproval: async (pending: PendingHttpRequest) => {
      asked.push(pending);
      return decision;
    },
  });
  return asked;
}

let conversationId = "";

beforeEach(async () => {
  conversationId = store().createConversation("model-a");
  await setAttachment(conversationId, WEB);
  store().setWorkspace(conversationId, workspaceFor(conversationId));
  useChatStore.setState({
    settings: { ...store().settings, github: { ...store().settings.github, token: TOKEN } },
  });
});

afterEach(() => vi.unstubAllGlobals());

// ── 1. Reads are free ────────────────────────────────────────

describe("reads never ask for approval", () => {
  const READS = [
    ["list_issues", () => runListIssues(conversationId, {})],
    ["read_issue", () => runReadIssue(conversationId, { number: 42 })],
    ["list_pull_requests", () => runListPullRequests(conversationId, {})],
    ["read_pull_request", () => runReadPullRequest(conversationId, { number: 17 })],
    ["read_ci_logs", () => runReadCiLogs(conversationId, {})],
  ] as const;

  it.each(READS)("%s runs without a dialog", async (_name, run) => {
    const asked = stubApproval({ approved: false });
    stubFetch((url) => {
      if (url.includes("/issues?")) return json([]);
      if (url.includes("/pulls?")) return json([]);
      if (url.includes("/actions/runs")) return json({ workflow_runs: [] });
      if (url.includes("/check-runs")) return json({ check_runs: [] });
      if (url.includes("/comments") || url.includes("/reviews") || url.includes("/files")) return json([]);
      if (url.includes("/issues/")) return json({ number: 42, title: "t", state: "open", comments: 0, body: "" });
      return json({ number: 17, title: "t", state: "open" });
    });
    await run();
    expect(asked, "a read must not open the approval dialog").toHaveLength(0);
  });
});

// ── 2. Writes ask, and a refusal sends nothing ───────────────

describe("writes go through the gate", () => {
  const WRITES = [
    ["create_issue", () => runCreateIssue(conversationId, { title: "A defect" })],
    ["comment_on_issue", () => runCommentOnIssue(conversationId, { number: 17, body: "done" })],
    [
      "review_pull_request",
      () => runReviewPullRequest(conversationId, { number: 17, event: "APPROVE", body: "LGTM" }),
    ],
    ["update_pull_request", () => runUpdatePullRequest(conversationId, { number: 17, state: "closed" })],
  ] as const;

  it.each(WRITES)("%s asks first", async (_name, run) => {
    const asked = stubApproval({ approved: true });
    stubFetch(() => json({ number: 17, html_url: "u", state: "open" }));
    await run();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.method).toBeTruthy();
    expect(asked[0]!.url).toContain("api.github.com");
  });

  it.each(WRITES)("%s sends nothing when the user declines", async (_name, run) => {
    stubApproval({ approved: false, note: "not yet — wait for the review" });
    const calls = stubFetch(() => json({}));
    const result = await run();
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("wait for the review");
    expect(calls, "a declined write must not reach the API").toHaveLength(0);
  });

  it("never puts the token in the dialog it shows", async () => {
    const asked = stubApproval({ approved: true });
    stubFetch(() => json({ number: 17, html_url: "u", state: "open" }));
    await runUpdatePullRequest(conversationId, { number: 17, state: "closed" });

    const shown = JSON.stringify(asked[0]);
    expect(shown).not.toContain(TOKEN);
    expect(shown).not.toContain("Authorization");
    // The dialog still names the change: method, endpoint and the new state.
    expect(asked[0]!.url).toContain("/repos/acme/web/pulls/17");
    expect(asked[0]!.body).toContain("closed");
  });

  it("says so when auto-approval skipped the dialog", async () => {
    stubApproval({ approved: true, auto: true });
    stubFetch(() => json({ number: 7, html_url: "u", state: "open" }));
    const result = await runCreateIssue(conversationId, { title: "A defect" });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).autoApproved).toBeDefined();
  });

  it("does not claim review when the dialog was shown", async () => {
    stubApproval({ approved: true });
    stubFetch(() => json({ number: 7, html_url: "u", state: "open" }));
    const result = await runCreateIssue(conversationId, { title: "A defect" });
    expect((result.data as Record<string, unknown>).autoApproved).toBeUndefined();
  });
});

// ── 3. Refusals that happen before the dialog ────────────────

describe("arguments are corrected before the user is bothered", () => {
  it("refuses REQUEST_CHANGES with no reason, without asking", async () => {
    const asked = stubApproval({ approved: true });
    const calls = stubFetch(() => json({}));
    const result = await runReviewPullRequest(conversationId, { number: 17, event: "REQUEST_CHANGES" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("must say WHAT to change");
    expect(asked).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("refuses a review with neither body nor inline comments", async () => {
    stubApproval({ approved: true });
    const result = await runReviewPullRequest(conversationId, { number: 17, event: "COMMENT" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("A review needs text");
  });

  it("refuses an update with nothing to change", async () => {
    stubApproval({ approved: true });
    const result = await runUpdatePullRequest(conversationId, { number: 17 });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("Nothing to change");
  });

  it("names a bad issue number instead of quoting the API", async () => {
    const result = await runReadIssue(conversationId, { number: "42" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("positive integer");
  });
});

// ── 4. The repository comes from the thread ──────────────────

describe("the repository is the attached one", () => {
  it("refuses with the settings path when GitHub is not connected", async () => {
    useChatStore.setState({
      settings: { ...store().settings, github: { ...store().settings.github, token: "" } },
    });
    const calls = stubFetch(() => json([]));
    const result = await runListIssues(conversationId, {});
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("Chat Settings");
    expect(calls).toHaveLength(0);
  });

  it("refuses when no repository is attached", async () => {
    const empty = store().createConversation("model-b");
    const result = await runListIssues(empty, {});
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("No repository is attached");
  });

  it("reads the thread's own owner and repo", async () => {
    const calls = stubFetch(() => json([]));
    await runListIssues(conversationId, {});
    expect(calls[0]!.url).toContain("/repos/acme/web/issues");
  });

  it("explains a 403 as a token scope, not as a broken tool", async () => {
    stubFetch(() => json({ message: "Resource not accessible by personal access token" }, 403));
    const result = await runListPullRequests(conversationId, {});
    expect(result.ok).toBe(false);
    const error = String((result.data as { error: string }).error);
    expect(error).toContain("403");
    // The scope the tool needs, named — "403" alone reads as a broken tool.
    expect(error).toContain("issues: write");
  });
});

// ── 5. The reply path, and the read that must survive the wire ─

describe("comment_on_issue", () => {
  it("replies INSIDE a review thread when given a comment id", async () => {
    const asked = stubApproval({ approved: true });
    const calls = stubFetch(() => json({ html_url: "u" }));
    const result = await runCommentOnIssue(conversationId, {
      number: 17,
      body: "fixed in the next push",
      replyToCommentId: 9001,
    });
    // The dialog names the thread it will land in, and the request goes to the
    // review-comment endpoint with in_reply_to — not to the PR conversation.
    expect(asked[0]!.url).toContain("/pulls/17/comments");
    expect(JSON.parse(String(asked[0]!.body))).toMatchObject({ in_reply_to: 9001 });
    expect(calls[0]!.url).toContain("/pulls/17/comments");
    expect((result.data as Record<string, unknown>).repliedToComment).toBe(9001);
  });

  it("posts to the conversation when no thread is named", async () => {
    const asked = stubApproval({ approved: true });
    const calls = stubFetch(() => json({ html_url: "u" }));
    await runCommentOnIssue(conversationId, { number: 17, body: "done" });
    expect(asked[0]!.url).toContain("/issues/17/comments");
    expect(calls[0]!.url).toContain("/issues/17/comments");
  });
});

describe("review_pull_request", () => {
  it("refuses a REQUEST_CHANGES with no reason before asking anyone", async () => {
    const asked = stubApproval({ approved: true });
    const result = await runReviewPullRequest(conversationId, { number: 17, event: "REQUEST_CHANGES" });
    expect(result.ok).toBe(false);
    expect(asked).toHaveLength(0);
  });

  it("reports inline comments it had to drop, instead of losing them quietly", async () => {
    stubApproval({ approved: true });
    stubFetch(() => json({ state: "changes_requested", html_url: "u" }));
    const result = await runReviewPullRequest(conversationId, {
      number: 17,
      event: "REQUEST_CHANGES",
      body: "two things",
      comments: [
        { path: "src/a.ts", line: 3, body: "ok" },
        { path: "src/b.ts", line: 0, body: "no line" },
        { body: "no path" },
      ],
    });
    expect((result.data as Record<string, unknown>).inlineComments).toBe(1);
    expect((result.data as Record<string, unknown>).droppedInline).toBe(2);
  });

  it("turns GitHub's diff-anchor validation into a next move", async () => {
    stubApproval({ approved: true });
    stubFetch(() => json({ message: "Pull request review thread line must be part of the diff" }, 422));
    const result = await runReviewPullRequest(conversationId, {
      number: 17,
      event: "COMMENT",
      body: "see inline",
      comments: [{ path: "src/a.ts", line: 9999, body: "hmm" }],
    });
    expect(result.ok).toBe(false);
    const error = String((result.data as { error: string }).error);
    expect(error).toContain("appears in this pull request's diff");
    expect(error).toContain("body");
  });
});

describe("an oversized read is fitted, not truncated by the serializer", () => {
  it("keeps a maximal pull-request read parseable and inside the wire budget", async () => {
    const filler = "x".repeat(2_000);
    stubFetch((url) => {
      if (url.includes("/files")) {
        return json(
          Array.from({ length: 60 }, (_, i) => ({
            filename: `src/dir/file-${i}.ts`,
            status: "modified",
            additions: 20,
            deletions: 9,
          }))
        );
      }
      if (url.includes("/reviews")) {
        return json(
          Array.from({ length: 12 }, () => ({
            user: { login: "sam" },
            state: "CHANGES_REQUESTED",
            submitted_at: "2026-09-22T10:00:00Z",
            body: filler,
          }))
        );
      }
      if (url.includes("/pulls/17/comments")) {
        return json(
          Array.from({ length: 25 }, (_, i) => ({
            id: 1000 + i,
            user: { login: "sam" },
            path: "src/dir/file-0.ts",
            line: i + 1,
            body: filler,
            created_at: "2026-09-22T10:00:00Z",
          }))
        );
      }
      if (url.includes("/issues/17/comments")) {
        return json(
          Array.from({ length: 30 }, () => ({
            user: { login: "dana" },
            created_at: "2026-09-22T10:00:00Z",
            body: filler,
          }))
        );
      }
      if (url.includes("/check-runs")) return json({ check_runs: [] });
      if (url.includes("/status")) return json({ state: "", statuses: [] });
      return json({
        number: 17,
        title: "Fix login",
        state: "open",
        user: { login: "dana" },
        head: { ref: "agent/x", sha: "abc" },
        base: { ref: "main" },
        changed_files: 60,
        body: filler,
        html_url: "u",
        comments: 30,
      });
    });

    const result = await runReadPullRequest(conversationId, { number: 17 });
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result.data);
    expect(serialized.length).toBeLessThanOrEqual(10_000);
    expect(() => JSON.parse(serialized)).not.toThrow();
    const data = result.data as {
      trimmed?: string[];
      verdict: { blockingReviews: string[]; inlineComments: number };
      pullRequest: { number: number; inlineComments: unknown[] };
    };
    expect(data.trimmed && data.trimmed.length > 0).toBe(true);
    // The verdict and the reviewer's own words survive every trim.
    expect(new Set(data.verdict.blockingReviews)).toEqual(new Set(["sam"]));
    expect(data.pullRequest.inlineComments.length).toBeGreaterThan(0);
  });
});

// ── 6. The CI log read picks the run that has something to read ─

describe("read_ci_logs", () => {
  const run = (over: Record<string, unknown>) => ({
    id: 100,
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/acme/web/actions/runs/100",
    name: "Verify",
    head_branch: "agent/fix-login",
    created_at: "2026-09-22T10:00:00Z",
    ...over,
  });

  it("prefers the newest FAILED run over a green one", async () => {
    stubFetch((url) => {
      // Most specific first: the log URL contains `/jobs`, and the jobs URL
      // contains `/actions/runs`. A stub that checks the broader pattern first
      // answers the wrong question, which is how a working tool looks broken.
      if (url.includes("/logs")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => "2026-09-22T10:00:00Z npm ERR! missing script: test",
        } as unknown as Response;
      }
      if (url.includes("/jobs")) {
        return json({
          jobs: [
            {
              id: 900,
              name: "test",
              conclusion: "failure",
              steps: [{ name: "npm test", conclusion: "failure" }],
            },
          ],
        });
      }
      if (url.includes("/actions/runs")) {
        return json({
          workflow_runs: [
            run({ id: 101, conclusion: "success" }),
            run({ id: 100, conclusion: "failure" }),
          ],
        });
      }
      return json({});
    });

    const result = await runReadCiLogs(conversationId, {});
    expect(result.ok).toBe(true);
    const data = result.data as { run: { id: number }; failure: { job: string; step: string; lines: string[] } };
    expect(data.run.id).toBe(100);
    expect(data.failure.job).toBe("test");
    expect(data.failure.step).toBe("npm test");
    expect(data.failure.lines.join("\n")).toContain("missing script");
  });

  it("says a running run has not failed, rather than inventing a failure", async () => {
    stubFetch(() => json({ workflow_runs: [run({ status: "in_progress", conclusion: null })] }));
    const result = await runReadCiLogs(conversationId, {});
    expect(result.ok).toBe(true);
    const data = result.data as { failure: unknown; note: string };
    expect(data.failure).toBeNull();
    expect(data.note).toContain("still going");
  });

  it("says a green run has nothing to read", async () => {
    stubFetch(() => json({ workflow_runs: [run({})] }));
    const result = await runReadCiLogs(conversationId, {});
    const data = result.data as { failure: unknown; note: string };
    expect(data.failure).toBeNull();
    expect(data.note).toContain("passed");
  });

  it("says when it fell back to the base branch, so a red run is not read as this change's", async () => {
    // A thread that has not pushed has no working branch. Reading the BASE
    // branch's newest run is still useful, but reporting it as "your change
    // failed" would be a claim about work that does not exist yet.
    store().setWorkspace(conversationId, { ...workspaceFor(conversationId), workingBranch: null });
    stubFetch(() => json({ workflow_runs: [run({})] }));
    const result = await runReadCiLogs(conversationId, {});
    const data = result.data as { branchNote?: string };
    expect(data.branchNote).toContain("BASE branch");
  });

  it("does not claim a fallback when the working branch was used", async () => {
    stubFetch(() => json({ workflow_runs: [run({})] }));
    const result = await runReadCiLogs(conversationId, {});
    expect((result.data as { branchNote?: string }).branchNote).toBeUndefined();
  });

  it("reports an unknown run id as an error instead of reading some other run", async () => {
    stubFetch(() => json({ message: "Not Found" }, 404));
    const result = await runReadCiLogs(conversationId, { runId: 4242 });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("Not found on GitHub");
  });
});
