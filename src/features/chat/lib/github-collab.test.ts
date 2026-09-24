// ============================================================
// GitHub Collaboration — The Other Direction Of The Workflow
// ============================================================
// The push chain could open a pull request and never read one back. These
// tests hold down the three things that make the reads trustworthy:
//
//   1. THE LIST SAYS WHAT IT LEFT OUT. GitHub's issues endpoint returns pull
//      requests too, so a list that quietly mixes them is how an agent reports
//      "no issue mentions this" while looking at four PRs it just opened.
//   2. THE CAPS ARE HONEST. A thread trimmed to its last 20 comments must say
//      how many exist, or a partial read reads as the whole story.
//   3. WHAT IS SENT IS WHAT WAS ASKED FOR. A write must not invent fields —
//      `labels: undefined` is a 422, and a PATCH that carries every field
//      silently overwrites the ones the model never mentioned.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COLLAB_COMMENT_LIMIT,
  COLLAB_FILES_LIMIT,
  COLLAB_PAYLOAD_MAX,
  COLLAB_REVIEW_LIMIT,
  commentOnIssue,
  createIssue,
  findPullRequestForHead,
  fitPayload,
  lastPageFromLink,
  listIssues,
  listPullRequests,
  readIssue,
  readPullRequest,
  replyToReviewComment,
  reviewPullRequest,
  updatePullRequest,
} from "./github-collab";
import { isUntrustedTool } from "./untrusted";
import { TOOL_RESULT_MAX_CHARS } from "../constants";

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const REPO = { token: "ghp_secret", owner: "acme", repo: "web" };

/** A long filler string — the bodies and comments in the budget tests */
const tricky = (size: number) => "x".repeat(size);

const rawIssue = (over: Record<string, unknown> = {}) => ({
  number: 42,
  title: "Login fails with a +tag",
  state: "open",
  user: { login: "dana" },
  labels: [{ name: "bug" }],
  comments: 3,
  updated_at: "2026-09-20T10:00:00Z",
  body: "Steps to reproduce…",
  html_url: "https://github.com/acme/web/issues/42",
  ...over,
});

const rawComment = (n: number) => ({
  user: { login: `user${n}` },
  created_at: "2026-09-21T10:00:00Z",
  body: `comment ${n}`,
});

const rawPull = (over: Record<string, unknown> = {}) => ({
  number: 17,
  title: "Fix login",
  state: "open",
  draft: false,
  merged: false,
  user: { login: "dana" },
  head: { ref: "agent/fix-login", sha: "abc123" },
  base: { ref: "main" },
  updated_at: "2026-09-22T10:00:00Z",
  changed_files: 2,
  additions: 10,
  deletions: 3,
  body: "Fixes the login bug",
  html_url: "https://github.com/acme/web/pull/17",
  created_at: "2026-09-21T10:00:00Z",
  mergeable: true,
  mergeable_state: "clean",
  ...over,
});

describe("listIssues", () => {
  it("drops the pull requests GitHub mixes into the issues endpoint", async () => {
    stubFetch(() =>
      json([
        rawIssue(),
        rawIssue({ number: 17, title: "Fix login", pull_request: { url: "x" } }),
      ])
    );
    const issues = await listIssues(REPO);
    expect(issues.map((i) => i.number)).toEqual([42]);
  });

  it("returns them when asked, marked as such", async () => {
    stubFetch(() =>
      json([
        rawIssue(),
        rawIssue({ number: 17, title: "Fix login", pull_request: { url: "x" } }),
      ])
    );
    const rows = await listIssues(REPO, { includePullRequests: true });
    expect(rows.map((r) => [r.number, r.isPullRequest])).toEqual([
      [42, false],
      [17, true],
    ]);
  });

  it("sends the filters GitHub expects and defaults to open issues", async () => {
    const calls = stubFetch(() => json([]));
    await listIssues(REPO, { state: "closed", labels: "bug,urgent", assignee: "dana" });
    const url = calls[0]!.url;
    expect(url).toContain("/repos/acme/web/issues?");
    expect(url).toContain("state=closed");
    expect(url).toContain("labels=bug%2Curgent");
    expect(url).toContain("assignee=dana");
  });
});

describe("readIssue", () => {
  it("keeps the LAST comments and says how many exist", async () => {
    const many = Array.from({ length: 25 }, (_, i) => rawComment(i + 1));
    stubFetch((url) => (url.includes("/comments") ? json(many) : json(rawIssue({ comments: 25 }))));

    const issue = await readIssue(REPO, 42);
    expect(issue.comments).toHaveLength(COLLAB_COMMENT_LIMIT);
    // The tail is the current state of a thread; comment 25 edited in, 21 kept.
    expect(issue.comments[0]!.body).toBe("comment 6");
    expect(issue.comments[issue.comments.length - 1]!.body).toBe("comment 25");
    expect(issue.commentsTotal).toBe(25);
  });

  it("caps a long body and flags the truncation", async () => {
    const body = "x".repeat(7_000);
    stubFetch((url) => (url.includes("/comments") ? json([]) : json(rawIssue({ body }))));
    const issue = await readIssue(REPO, 42);
    expect(issue.body.length).toBeLessThan(body.length);
    expect(issue.bodyTruncated).toBe(true);
    expect(issue.body).toContain("read the rest on GitHub");
  });

  it("reads the issue once, not twice", async () => {
    const calls = stubFetch((url) => (url.includes("/comments") ? json([]) : json(rawIssue())));
    await readIssue(REPO, 42);
    const issueCalls = calls.filter((c) => c.url.endsWith("/issues/42"));
    expect(issueCalls).toHaveLength(1);
  });
});

describe("listPullRequests", () => {
  it("qualifies head with the owner, which is how the API matches a branch", async () => {
    // A bare branch name returns nothing at all — the failure mode is an empty
    // list, which reads as "no pull request for this branch" instead of an error.
    const calls = stubFetch(() => json([]));
    await listPullRequests(REPO, { head: "agent/fix-login" });
    expect(calls[0]!.url).toContain("head=acme%3Aagent%2Ffix-login");
  });
});

describe("findPullRequestForHead", () => {
  // The lookup that keeps the fix-up round honest: GitHub refuses a SECOND open
  // pull request for the same head/base, and the push has already landed when
  // that 422 arrives.
  it("prefers the open pull request", async () => {
    stubFetch(() =>
      json([
        rawPull({ number: 9, state: "closed", html_url: "https://github.com/acme/web/pull/9" }),
        rawPull({ number: 17, state: "open", html_url: "https://github.com/acme/web/pull/17" }),
      ])
    );
    const found = await findPullRequestForHead(REPO, "agent/fix-login");
    expect(found?.number).toBe(17);
    expect(found?.url).toBe("https://github.com/acme/web/pull/17");
  });

  it("still returns a closed one, so the push can name where the branch stands", async () => {
    stubFetch(() => json([rawPull({ number: 9, state: "closed" })]));
    expect((await findPullRequestForHead(REPO, "agent/fix-login"))?.number).toBe(9);
  });

  it("searches every state, not just open ones", async () => {
    const calls = stubFetch(() => json([]));
    await findPullRequestForHead(REPO, "agent/fix-login");
    expect(calls[0]!.url).toContain("state=all");
    expect(calls[0]!.url).toContain("head=acme%3Aagent%2Ffix-login");
  });

  it("returns null for a branch with no pull request", async () => {
    stubFetch(() => json([]));
    expect(await findPullRequestForHead(REPO, "agent/fresh")).toBeNull();
  });
});

describe("readPullRequest", () => {
  it("reports files, reviews, inline comments and the check verdict in one read", async () => {
    stubFetch((url) => {
      if (url.includes("/files")) {
        return json([
          { filename: "src/login.ts", status: "modified", additions: 8, deletions: 2 },
        ]);
      }
      if (url.includes("/reviews")) {
        return json([
          { user: { login: "sam" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-22T11:00:00Z", body: "needs a test" },
        ]);
      }
      if (url.includes("/pulls/17/comments")) {
        return json([
          {
            id: 9001,
            user: { login: "sam" },
            path: "src/login.ts",
            line: 42,
            body: "this branch is untested",
            created_at: "2026-09-22T11:05:00Z",
          },
        ]);
      }
      if (url.includes("/issues/17/comments")) return json([rawComment(1)]);
      if (url.includes("/check-runs")) {
        return json({
          check_runs: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "test (20.x)", status: "completed", conclusion: "failure" },
          ],
        });
      }
      if (url.includes("/status")) {
        return json({ state: "success", statuses: [{ context: "ci/build", state: "success" }] });
      }
      return json(rawPull({ changed_files: 1 }));
    });

    const pr = await readPullRequest(REPO, 17);
    expect(pr.files).toEqual([
      { path: "src/login.ts", status: "modified", additions: 8, deletions: 2 },
    ]);
    expect(pr.reviews[0]).toMatchObject({ author: "sam", state: "CHANGES_REQUESTED" });
    // The line-anchored feedback is the part a fix-up turn acts on, and it has
    // an id so the answer can be posted INSIDE that thread.
    expect(pr.inlineComments).toEqual([
      {
        id: 9001,
        author: "sam",
        path: "src/login.ts",
        line: 42,
        body: "this branch is untested",
        createdAt: "2026-09-22T11:05:00Z",
        replyToId: null,
      },
    ]);
    expect(pr.commentsTotal).toBe(1);
    expect(pr.checks).toMatchObject({
      total: 3,
      failing: ["test (20.x) (failure)"],
      running: [],
      allGreen: false,
      statusState: "success",
      statusContexts: ["ci/build (success)"],
    });
    expect(pr.mergeable).toBe(true);
    expect(pr.mergeStateNote).toBe("clean");
  });

  it("asks for the inline comments newest-first, which the endpoint supports", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/pulls/17/comments")) return json([]);
      if (url.includes("/issues/17/comments")) return json([]);
      if (url.includes("/check-runs")) return json({ check_runs: [] });
      if (url.includes("/status")) return json({ state: "", statuses: [] });
      return json(rawPull());
    });
    await readPullRequest(REPO, 17);
    const inline = calls.find((c) => c.url.includes("/pulls/17/comments"))!;
    expect(inline.url).toContain("sort=created");
    expect(inline.url).toContain("direction=desc");
  });

  it("counts a legacy commit status, not just check runs", async () => {
    // CircleCI and Jenkins publish here. Reading only check runs called a green
    // repository "no checks reported", which is a wrong answer, not a gap.
    stubFetch((url) => {
      if (url.includes("/files") || url.includes("/reviews") || url.includes("/comments")) return json([]);
      if (url.includes("/check-runs")) return json({ check_runs: [] });
      if (url.includes("/status")) {
        return json({
          state: "failure",
          statuses: [{ context: "ci/circleci: build", state: "failure" }],
        });
      }
      return json(rawPull());
    });
    const pr = await readPullRequest(REPO, 17);
    expect(pr.checks).toMatchObject({
      failing: ["ci/circleci: build (failure)"],
      allGreen: false,
      statusState: "failure",
    });
  });

  it("is green only when every reporting system says so", async () => {
    stubFetch((url) => {
      if (url.includes("/files") || url.includes("/reviews") || url.includes("/comments")) return json([]);
      if (url.includes("/check-runs")) {
        return json({ check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
      }
      if (url.includes("/status")) return json({ state: "success", statuses: [] });
      return json(rawPull());
    });
    const pr = await readPullRequest(REPO, 17);
    expect(pr.checks?.allGreen).toBe(true);
  });

  it("counts a still-running check as running, not as green", async () => {
    stubFetch((url) => {
      if (url.includes("/files") || url.includes("/reviews") || url.includes("/comments")) return json([]);
      if (url.includes("/check-runs")) {
        return json({ check_runs: [{ name: "build", status: "in_progress", conclusion: null }] });
      }
      return json(rawPull());
    });
    const pr = await readPullRequest(REPO, 17);
    expect(pr.checks).toMatchObject({ allGreen: false, running: ["build"], failing: [] });
  });

  it("caps the file list and reports the PR's OWN file count, not the page's", async () => {
    const files = Array.from({ length: 60 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
    }));
    stubFetch((url) => {
      if (url.includes("/files")) return json(files);
      if (url.includes("/check-runs")) return json({ check_runs: [] });
      if (url.includes("/status")) return json({ state: "", statuses: [] });
      if (url.includes("/reviews") || url.includes("/comments")) return json([]);
      return json(rawPull({ changed_files: 137 }));
    });
    const pr = await readPullRequest(REPO, 17);
    expect(pr.files).toHaveLength(COLLAB_FILES_LIMIT);
    // 137 is what GitHub says the pull request touches; the page holds 60.
    expect(pr.filesTotal).toBe(137);
    expect(pr.filesTruncated).toBe(true);
  });

  it("keeps the newest reviews when a PR has more than the cap", async () => {
    const reviews = Array.from({ length: 14 }, (_, i) => ({
      user: { login: `r${i}` },
      state: "APPROVED",
      submitted_at: "2026-09-22T11:00:00Z",
      body: `review ${i}`,
    }));
    stubFetch((url) => {
      if (url.includes("/reviews")) return json(reviews);
      if (url.includes("/check-runs")) return json({ check_runs: [] });
      if (url.includes("/status")) return json({ state: "", statuses: [] });
      if (url.includes("/files") || url.includes("/comments")) return json([]);
      return json(rawPull());
    });
    const pr = await readPullRequest(REPO, 17);
    expect(pr.reviews).toHaveLength(COLLAB_REVIEW_LIMIT);
    expect(pr.reviews[0]!.body).toBe("review 4");
    expect(pr.reviewsTotal).toBe(14);
  });

  it("degrades to no checks rather than failing the whole read", async () => {
    // A checks read needs a scope the token may not have. Losing the body, the
    // reviews and the conversation over that would be the tool failing at the
    // moment it is most needed.
    stubFetch((url) => {
      if (url.includes("/check-runs")) return json({ message: "no access" }, 403);
      if (url.includes("/status")) return json({ state: "pending", statuses: [] });
      if (url.includes("/files") || url.includes("/reviews") || url.includes("/comments")) return json([]);
      return json(rawPull());
    });
    const pr = await readPullRequest(REPO, 17);
    expect(pr.checks).toBeNull();
    expect(pr.title).toBe("Fix login");
  });

  it("keeps the half of the CI report the token CAN read", async () => {
    // Check runs and commit statuses need different scopes. A shared failure
    // would report "no checks" for a repository whose statuses are right there.
    stubFetch((url) => {
      if (url.includes("/check-runs")) return json({ message: "no access" }, 403);
      if (url.includes("/status")) {
        return json({ state: "success", statuses: [{ context: "ci/build", state: "success" }] });
      }
      if (url.includes("/files") || url.includes("/reviews") || url.includes("/comments")) return json([]);
      return json(rawPull());
    });
    const pr = await readPullRequest(REPO, 17);
    expect(pr.checks).toMatchObject({
      total: 1,
      failing: [],
      allGreen: true,
      statusContexts: ["ci/build (success)"],
    });
  });

  it("never calls a repository with no CI green", async () => {
    // "allGreen" is the field a model quotes to the user, so it requires
    // evidence. An EMPTY combined status is GitHub's answer for a commit that
    // nothing reported on — reading that as "still running" or as green is how a
    // repository with no CI gets a verdict it never earned.
    stubFetch((url) => {
      if (url.includes("/check-runs")) return json({ check_runs: [] });
      if (url.includes("/status")) return json({ state: "pending", statuses: [] });
      if (url.includes("/files") || url.includes("/reviews") || url.includes("/comments")) return json([]);
      return json(rawPull());
    });
    const pr = await readPullRequest(REPO, 17);
    expect(pr.checks).toBeNull();
  });

  it("does not call all-skipped checks green", async () => {
    stubFetch((url) => {
      if (url.includes("/check-runs")) {
        return json({
          check_runs: [
            { name: "build", status: "completed", conclusion: "skipped" },
            { name: "lint", status: "completed", conclusion: "neutral" },
          ],
        });
      }
      if (url.includes("/status")) return json({ state: "pending", statuses: [] });
      if (url.includes("/files") || url.includes("/reviews") || url.includes("/comments")) return json([]);
      return json(rawPull());
    });
    const pr = await readPullRequest(REPO, 17);
    expect(pr.checks).toMatchObject({ total: 2, failing: [], running: [], allGreen: false });
  });
});

describe("external text is marked as untrusted", () => {
  // An issue body, a review and a CI log are written by people this app has no
  // relationship with, and the agent reads them with push_changes in reach.
  // The delimiter is what turns "the repo told me to" into a reportable
  // injection attempt, so the classification is pinned here.
  it.each(["list_issues", "read_issue", "list_pull_requests", "read_pull_request", "read_ci_logs"])(
    "wraps `%s` results",
    (name) => {
      expect(isUntrustedTool(name)).toBe(true);
    }
  );

  it.each(["create_issue", "comment_on_issue", "review_pull_request", "update_pull_request"])(
    "does not wrap `%s` — its result is an id, a state and a URL",
    (name) => {
      expect(isUntrustedTool(name)).toBe(false);
    }
  );
});

// ── The two things that made a long thread unreadable ────────

describe("lastPageFromLink", () => {
  it("reads the page number out of a Link header", () => {
    expect(
      lastPageFromLink(
        '<https://api.github.com/repos/acme/web/issues/42/comments?per_page=1&page=2>; rel="next", ' +
          '<https://api.github.com/repos/acme/web/issues/42/comments?per_page=1&page=400>; rel="last"'
      )
    ).toBe(400);
  });

  it("answers null when the header names no last page", () => {
    expect(lastPageFromLink(null)).toBeNull();
    expect(lastPageFromLink('<https://api.github.com/…?page=2>; rel="next"')).toBeNull();
  });
});

describe("a long comment thread is read from its END", () => {
  it("asks for the last page, not page one", async () => {
    // 250 comments at 100 per page means the tail lives on page 3. Page 1 would
    // answer with comments 1–100 — the opposite of "where does this stand".
    const calls = stubFetch((url) => {
      if (url.includes("/comments")) return json([rawComment(250)]);
      return json(rawIssue({ comments: 250 }));
    });
    const issue = await readIssue(REPO, 42);
    const commentCall = calls.find((c) => c.url.includes("/comments"))!;
    expect(commentCall.url).toContain("page=3");
    expect(issue.commentsTotal).toBe(250);
  });

  it("probes for the count when the resource does not supply one", async () => {
    // A pull request's own `comments` field mixes conversation and review
    // comments, so the page is derived from the Link header of a one-item read.
    const calls = stubFetch((url) => {
      if (url.includes("/pulls/17/comments")) return json([]);
      if (url.includes("/issues/17/comments")) {
        if (url.includes("per_page=1")) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "link"
                  ? '<https://api.github.com/…?per_page=1&page=250>; rel="last"'
                  : null,
            },
            json: async () => [rawComment(1)],
          } as unknown as Response;
        }
        return json([rawComment(250)]);
      }
      if (url.includes("/check-runs")) return json({ check_runs: [] });
      if (url.includes("/status")) return json({ state: "", statuses: [] });
      if (url.includes("/files") || url.includes("/reviews")) return json([]);
      return json(rawPull());
    });
    const pr = await readPullRequest(REPO, 17);
    expect(pr.commentsTotal).toBe(250);
    const pageCalls = calls.filter((c) => c.url.includes("/issues/17/comments"));
    expect(pageCalls[pageCalls.length - 1]!.url).toContain("page=3");
  });

  it("reports a single-page thread's real length", async () => {
    stubFetch((url) => (url.includes("/comments") ? json([rawComment(1), rawComment(2)]) : json(rawIssue({ comments: 2 }))));
    const issue = await readIssue(REPO, 42);
    expect(issue.commentsTotal).toBe(2);
    expect(issue.comments).toHaveLength(2);
  });
});

// ── Replying inside a review thread ────────────────────────

describe("replyToReviewComment", () => {
  it("posts into the thread with in_reply_to, not as a top-level comment", async () => {
    const calls = stubFetch(() => json({ html_url: "https://github.com/acme/web/pull/17#discussion_r9001" }));
    await replyToReviewComment(REPO, { number: 17, commentId: 9001, body: "fixed in the next push" });
    expect(calls[0]!.url).toContain("/repos/acme/web/pulls/17/comments");
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ body: "fixed in the next push", in_reply_to: 9001 });
  });
});

// ── The wire budget ─────────────────────────────────────────

describe("fitPayload", () => {
  it("leaves a payload under the cap untouched", () => {
    const data = { a: 1, list: [1, 2, 3] };
    const fitted = fitPayload(data, [{ key: "list", note: "dropped" }], 1_000);
    expect(fitted.notes).toEqual([]);
    expect(fitted.data.list).toEqual([1, 2, 3]);
  });

  it("sheds from the end of an array, in the declared order", () => {
    const data = {
      files: [tricky(600), tricky(600)],
      comments: [tricky(600), tricky(600)],
    };
    // One removal is exactly enough at this cap: 4×600 chars plus key
    // overhead is ~2 450, and 3×600 is ~1 850.
    const fitted = fitPayload(data, [{ key: "files", note: "files trimmed" }], 1_900);
    expect(fitted.data.files).toHaveLength(1);
    expect(fitted.data.comments).toHaveLength(2);
    expect(fitted.notes).toEqual(["files trimmed"]);
  });

  it("reaches a dotted path, so a nested payload keeps its shape", () => {
    const data = { repository: "acme/web", issue: { comments: [tricky(600), tricky(600)], body: "short" } };
    const fitted = fitPayload(data, [{ key: "issue.comments", note: "comments trimmed" }], 900);
    expect(data.issue.comments).toHaveLength(1);
    expect(data.repository).toBe("acme/web");
    expect(fitted.notes).toEqual(["comments trimmed"]);
  });

  it("halves a single long string rather than deleting it", () => {
    const data = { body: tricky(2_000) };
    const fitted = fitPayload(data, [{ key: "body", note: "body trimmed" }], 1_200);
    expect(data.body.length).toBeLessThan(2_000);
    expect(data.body).toContain("trimmed to fit this result");
    expect(fitted.notes).toEqual(["body trimmed"]);
  });
});

describe("a maximal read still parses", () => {
  it("keeps a 60-file, 20-comment, 10-review pull request inside the wire cap", async () => {
    // The failure this replaces: serializeToolResult truncates the JSON STRING,
    // so an oversized read arrived as a broken document with a marker on the
    // end — unparseable exactly when the answer was in the tail.
    const files = Array.from({ length: 60 }, (_, i) => ({
      filename: `src/dir/file-${i}.ts`,
      status: "modified",
      additions: 12,
      deletions: 7,
    }));
    const comments = Array.from({ length: 30 }, (_, i) => ({
      user: { login: `u${i}` },
      created_at: "2026-09-22T10:00:00Z",
      body: tricky(2_000),
    }));
    const reviews = Array.from({ length: 12 }, () => ({
      user: { login: "sam" },
      state: "CHANGES_REQUESTED",
      submitted_at: "2026-09-22T10:00:00Z",
      body: tricky(2_000),
    }));

    stubFetch((url) => {
      if (url.includes("/files")) return json(files);
      if (url.includes("/reviews")) return json(reviews);
      if (url.includes("/pulls/17/comments")) {
        return json(
          Array.from({ length: 25 }, (_, i) => ({
            id: 1000 + i,
            user: { login: "sam" },
            path: "src/dir/file-0.ts",
            line: i + 1,
            body: tricky(500),
            created_at: "2026-09-22T10:00:00Z",
          }))
        );
      }
      if (url.includes("/issues/17/comments")) return json(comments);
      if (url.includes("/check-runs")) return json({ check_runs: [] });
      if (url.includes("/status")) return json({ state: "", statuses: [] });
      return json(rawPull({ changed_files: 60, body: tricky(6_000), comments: 30 }));
    });

    const pr = await readPullRequest(REPO, 17);
    const payload = {
      repository: "acme/web",
      pullRequest: pr,
      verdict: { checks: "none", blockingReviews: ["sam"], inlineComments: pr.inlineComments.length },
    };
    const fitted = fitPayload(payload, [
      { key: "pullRequest.files", note: "files trimmed" },
      { key: "pullRequest.comments", note: "comments trimmed" },
      { key: "pullRequest.reviews", note: "reviews trimmed" },
      { key: "pullRequest.body", note: "body trimmed" },
      { key: "pullRequest.inlineComments", note: "inline trimmed" },
    ]);

    const serialized = JSON.stringify({ ...fitted.data, trimmed: fitted.notes });
    expect(fitted.notes.length).toBeGreaterThan(0);
    expect(serialized.length).toBeLessThanOrEqual(COLLAB_PAYLOAD_MAX);
    expect(serialized.length).toBeLessThan(TOOL_RESULT_MAX_CHARS);
    // Everything the turn acts on survives: which PR, what the reviewer said on
    // which line, and the checks verdict.
    expect(fitted.data.pullRequest.number).toBe(17);
    expect(fitted.data.pullRequest.inlineComments.length).toBeGreaterThan(0);
    expect(fitted.data.verdict.blockingReviews).toEqual(["sam"]);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});

describe("writes send exactly what was asked for", () => {
  it("omits fields the caller did not provide", async () => {
    const calls = stubFetch(() => json({ number: 7, html_url: "u", state: "open" }));
    await createIssue(REPO, { title: "A defect" });
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ title: "A defect" });
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("posts a comment through the issues endpoint, which is also the PR conversation", async () => {
    const calls = stubFetch(() => json({ html_url: "u" }));
    await commentOnIssue(REPO, { number: 17, body: "done" });
    expect(calls[0]!.url).toContain("/repos/acme/web/issues/17/comments");
  });

  it("carries the review event, body and inline comments", async () => {
    const calls = stubFetch(() => json({ state: "changes_requested", html_url: "u" }));
    const outcome = await reviewPullRequest(REPO, {
      number: 17,
      event: "REQUEST_CHANGES",
      body: "needs a test",
      comments: [{ path: "src/login.ts", line: 12, body: "this branch is untested" }],
    });
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body.event).toBe("REQUEST_CHANGES");
    expect(body.comments).toEqual([
      { path: "src/login.ts", line: 12, body: "this branch is untested" },
    ]);
    expect(outcome.state).toBe("CHANGES_REQUESTED");
  });

  it("PATCHes only the fields present, so a title edit cannot erase the body", async () => {
    const calls = stubFetch(() => json({ number: 17, state: "open", html_url: "u" }));
    await updatePullRequest(REPO, { number: 17, title: "Fix login (v2)" });
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["title"]);
    expect(calls[0]!.init?.method).toBe("PATCH");
  });
});
