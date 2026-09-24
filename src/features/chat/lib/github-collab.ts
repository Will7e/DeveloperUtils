// ============================================================
// GitHub Collaboration — The Conversation Around the Code
// ============================================================
// The app could push a branch and open a pull request, and it could not read
// either one back. That asymmetry is what made the workflow a one-way trip: a
// user could say "review the PR you just opened and fix what it flags" and the
// agent had no endpoint to answer with, so the only remaining move was to
// guess, or to ask the user to paste the review into the chat.
//
// This module is the other direction. It is deliberately NOT forty tools: it
// is the short set of endpoints that a real issue-to-merge loop needs —
//
//   read:  issues (list/one, with comments), pull requests (list/one, with
//          files, reviews, comments and check state), workflow runs;
//   write: open an issue, comment on an issue or pull request, submit a
//          review, edit a pull request.
//
// Every write goes through the same human gate as `http_write` (see
// services/github-collab-actions.ts): these endpoints change someone else's
// repository, and none of them can be undone by this app.
//
// Caps everywhere, for one reason: an issue thread with 400 comments is not
// context, it is a bill. Each cap reports that it truncated, so a report that
// ends mid-thread says so instead of reading as the whole story.

import { githubFetch } from "./github-client";

export interface CollabRepo {
  token: string;
  owner: string;
  repo: string;
}

/** Cap on an issue or PR body kept from a read (the opening is the useful part) */
export const COLLAB_BODY_MAX = 6_000;
/** Cap on one comment's text */
export const COLLAB_COMMENT_MAX = 2_000;
/** How many comments of a thread are kept — the LAST ones, which answer "where is this now" */
export const COLLAB_COMMENT_LIMIT = 20;
/** How many issues / pull requests / commits a list call returns */
export const COLLAB_LIST_LIMIT = 30;
/** How many changed files a pull-request read reports */
export const COLLAB_FILES_LIMIT = 50;
/** How many formal reviews are kept (newest kept; a thread rarely needs more) */
export const COLLAB_REVIEW_LIMIT = 10;
/** How many inline review comments are read — the line-anchored feedback */
export const COLLAB_INLINE_LIMIT = 25;

/**
 * GitHub's own page size for these endpoints. Named because one place has to
 * know it: the LAST page of a thread is `ceil(total / 100)`, and asking for
 * page 1 to find the end of a 400-comment thread is how a "latest comments"
 * read returns comments from three years ago.
 */
const COLLAB_PAGE_SIZE = 100;

/**
 * The wire budget for a collaboration payload.
 *
 * `serializeToolResult` (lib/tools.ts) truncates ANY payload longer than
 * TOOL_RESULT_MAX_CHARS — and it truncates the JSON STRING, so what arrives at
 * the model is a broken document with a marker on the end. Per-field caps do
 * not prevent that: 20 comments × 2 000 chars, plus a 50-file list, plus a
 * 6 000-char body is over the ceiling with entirely ordinary input. So the
 * payload is fitted to a budget HERE, where the choice of what to drop can be
 * explained in the result itself.
 */
export const COLLAB_PAYLOAD_MAX = 10_000;

/**
 * GitHub answers 422 for a review that carries neither a body nor inline
 * comments. Exported so the executor can refuse first and name the missing
 * piece, instead of relaying a validation blob the model has to decode.
 */
export const COMMENT_MUST_HAVE_TEXT =
  "A review needs text: pass `body`, or `comments` (inline notes), or both — GitHub rejects a review with neither.";

/** One line of a title or body, for a list row */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface Capped {
  text: string;
  truncated: boolean;
}

function cap(text: string, max: number): Capped {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n… [${text.length - max} more characters — read the rest on GitHub]`,
    truncated: true,
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) => {
    if (typeof l === "string") return [l];
    if (typeof l === "object" && l !== null) {
      const name = (l as Record<string, unknown>).name;
      if (typeof name === "string") return [name];
    }
    return [];
  });
}

// ── Issues ───────────────────────────────────────────────────

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  commentCount: number;
  updatedAt: string;
  /** True for the pull requests GitHub returns from the issues endpoint */
  isPullRequest: boolean;
  bodyPreview: string;
}

export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
  truncated: boolean;
}

/** One line-anchored review comment — the `path:line` kind, not a review body */
export interface PullRequestInlineComment {
  /** Review-comment id, for replying to THIS thread (`in_reply_to`) */
  id: number;
  author: string;
  path: string;
  /** Line in the file, as GitHub anchors it (null for a file-level note) */
  line: number | null;
  body: string;
  createdAt: string;
  /** Set when this comment is itself a reply inside a thread */
  replyToId: number | null;
}

/**
 * A capped tail of a comment thread.
 *
 * Two independent things were wrong with reading page 1 and slicing it: the
 * slice returned comments 81–100 of a long thread (neither the start nor the
 * end), and the reported total was the page size rather than the thread's
 * length. Both matter because the whole justification for keeping "the last
 * comments" is that they say where the thread stands now.
 */
interface CommentTail {
  comments: IssueComment[];
  /** the thread's real length, from the issue resource itself when known */
  total: number;
}

function normalizeComment(raw: unknown): IssueComment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const text = cap(asString(row.body), COLLAB_COMMENT_MAX);
  return {
    author: asString((row.user as Record<string, unknown> | undefined)?.login) || "unknown",
    createdAt: asString(row.created_at),
    body: text.text,
    truncated: text.truncated,
  };
}

/**
 * The page number named as `rel="last"` in a Link header, when there is one.
 *
 * Used with `per_page=1`, where the last page's index IS the number of items —
 * that is what makes it a count and not just a page. Exported for the test that
 * pins the parsing, because a mis-parsed Link header is a silently wrong page
 * number, which is the quietest kind of wrong.
 */
export function lastPageFromLink(link: string | null): number | null {
  if (!link) return null;
  const match = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  return match ? Number(match[1]) : null;
}

/**
 * The LAST comments of a thread.
 *
 * The list endpoints have no `sort`/`direction` — the issue-comments list is
 * oldest-first, always — so reaching the end of a long thread means knowing how
 * many pages there are. Two ways to know, and the caller picks:
 *
 *   • `knownTotal` — the issue resource's own `comments` field is the count of
 *     the comments this endpoint returns, so it is exact and free. That is the
 *     issue path.
 *   • otherwise a `per_page=1` probe: the Link header names the last page, and
 *     with one item per page that index is the count. One tiny request buys an
 *     exact total for a pull request, whose `comments` field mixes conversation
 *     comments and review comments and so cannot be used for page arithmetic.
 *
 * Both a page-1 slice and a guessed total were what this replaced: the slice
 * returned comments 81–100 of a 400-comment thread, and the total reported the
 * page size as the thread's length.
 */
async function fetchCommentTail(
  req: CollabRepo,
  number: number,
  knownTotal: number | null
): Promise<CommentTail> {
  const base = `/repos/${req.owner}/${req.repo}/issues/${number}/comments`;
  let total = knownTotal ?? 0;
  if (total <= 0) {
    const probe = await githubFetch(`${base}?per_page=1`, req.token);
    total = lastPageFromLink(probe.headers.get("link")) ?? 1;
  }
  const page = Math.max(1, Math.ceil(total / COLLAB_PAGE_SIZE));
  const res = await githubFetch(`${base}?per_page=${COLLAB_PAGE_SIZE}&page=${page}`, req.token);
  const first = (await res.json()) as unknown;
  let rows = Array.isArray(first) ? first : [];
  let readPage = page;
  if (rows.length === 0 && page > 1) {
    // An empty page must never be reported as an empty thread. Either the count
    // described a different collection, or the transport lost the Link header
    // that produced it (the app's CORS proxy can), which leaves `total` at 1 —
    // in both cases the honest answer is the thread's first page, not silence.
    const retry = await githubFetch(`${base}?per_page=${COLLAB_PAGE_SIZE}`, req.token);
    const retried = (await retry.json()) as unknown;
    rows = Array.isArray(retried) ? retried : [];
    readPage = 1;
  }
  return {
    comments: rows.slice(-COLLAB_COMMENT_LIMIT).flatMap((c) => {
      const one = normalizeComment(c);
      return one ? [one] : [];
    }),
    // A single-page thread answers with its own length, which IS the count; when
    // the page arithmetic did not hold, the page we actually read is the truth.
    total: readPage === 1 ? Math.max(rows.length, total) : total,
  };
}

export interface IssueDetail extends IssueSummary {
  body: string;
  bodyTruncated: boolean;
  url: string;
  comments: IssueComment[];
  /** How many comments exist in total, including any the cap dropped */
  commentsTotal: number;
}

function normalizeIssue(raw: unknown): IssueSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const issue = raw as Record<string, unknown>;
  const number = asNumber(issue.number);
  if (!number) return null;
  return {
    number,
    title: asString(issue.title) || "(untitled)",
    state: asString(issue.state) || "unknown",
    author: asString((issue.user as Record<string, unknown> | undefined)?.login) || "unknown",
    labels: labelNames(issue.labels),
    commentCount: asNumber(issue.comments),
    updatedAt: asString(issue.updated_at),
    isPullRequest: typeof issue.pull_request === "object" && issue.pull_request !== null,
    bodyPreview: oneLine(asString(issue.body), 200),
  };
}

/**
 * Issues in a repository.
 *
 * `includePullRequests` exists because GitHub's issues endpoint returns pull
 * requests too, and a list titled "issues" that silently mixes them is how an
 * agent reports "11 open issues, none about this" when four of them were the
 * PRs it just opened. The default is the narrower one; the caller that wants
 * everything asks for it.
 */
export async function listIssues(
  req: CollabRepo,
  filter: { state?: "open" | "closed" | "all"; labels?: string; assignee?: string; includePullRequests?: boolean } = {}
): Promise<IssueSummary[]> {
  const params = new URLSearchParams({
    state: filter.state ?? "open",
    per_page: String(COLLAB_LIST_LIMIT),
    sort: "updated",
    direction: "desc",
  });
  if (filter.labels) params.set("labels", filter.labels);
  if (filter.assignee) params.set("assignee", filter.assignee);

  const res = await githubFetch(`/repos/${req.owner}/${req.repo}/issues?${params}`, req.token);
  const raw = (await res.json()) as unknown;
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .map(normalizeIssue)
    .filter((i): i is IssueSummary => i !== null)
    .filter((i) => filter.includePullRequests === true || !i.isPullRequest);
}

export async function readIssue(req: CollabRepo, number: number): Promise<IssueDetail> {
  const issueRes = await githubFetch(`/repos/${req.owner}/${req.repo}/issues/${number}`, req.token);
  const detail = (await issueRes.json()) as Record<string, unknown>;
  const summary = normalizeIssue(detail);
  if (!summary) throw new Error(`Issue #${number} could not be read.`);

  const body = cap(asString(detail.body), COLLAB_BODY_MAX);

  // The last comments are the ones that say where the thread stands; the first
  // ones usually describe the symptom the issue opened with, which the body
  // already carried. The issue resource carries the real count, which is what
  // makes the last PAGE findable.
  const tail = await fetchCommentTail(req, number, summary.commentCount || null);

  return {
    ...summary,
    body: body.text,
    bodyTruncated: body.truncated,
    url: asString(detail.html_url),
    comments: tail.comments,
    commentsTotal: tail.total,
  };
}

// ── Pull requests ────────────────────────────────────────────

export interface PullRequestSummary {
  number: number;
  title: string;
  /** Web URL — what a push reports back for the branch it just pushed to */
  url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  author: string;
  head: string;
  base: string;
  updatedAt: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  bodyPreview: string;
}

export interface PullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PullRequestReview {
  author: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | PENDING */
  state: string;
  submittedAt: string;
  body: string;
}

export interface PullRequestChecks {
  total: number;
  /** distinct non-success conclusions, with their job names */
  failing: string[];
  running: string[];
  /** true when everything that reported said success — check runs AND statuses */
  allGreen: boolean;
  /**
   * The older Commit Status API, which check runs superseded without replacing.
   * CircleCI, Jenkins and Travis still publish here, and a repo whose CI reports
   * only as a commit status would otherwise be summarised as "no checks", which
   * is a wrong answer to "is this green" rather than a missing one.
   */
  statusState: string;
  /** Context names in the combined status, e.g. "ci/circleci: build (failure)" */
  statusContexts: string[];
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  bodyTruncated: boolean;
  url: string;
  createdAt: string;
  /** GitHub's own view: null while it is still computing */
  mergeable: boolean | null;
  mergedBy: string;
  files: PullRequestFile[];
  filesTruncated: boolean;
  /** GitHub's own changed-file count for the PR — not the length of one page */
  filesTotal: number;
  reviews: PullRequestReview[];
  reviewsTotal: number;
  /** The `path:line` feedback, newest first — what "the reviewer asked for" usually means */
  inlineComments: PullRequestInlineComment[];
  inlineCommentsTruncated: boolean;
  comments: IssueComment[];
  commentsTotal: number;
  checks: PullRequestChecks | null;
  /**
   * GitHub's mergeability block, verbatim. It is the one field that explains
   * WHY a pull request cannot merge ("2 of 3 required status checks are
   * expected", "review required"), and re-deriving it from the fields above
   * would lose exactly that sentence.
   */
  mergeStateNote: string;
}

function normalizePull(raw: unknown): PullRequestSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const pr = raw as Record<string, unknown>;
  const number = asNumber(pr.number);
  if (!number) return null;
  const head = pr.head as Record<string, unknown> | undefined;
  const base = pr.base as Record<string, unknown> | undefined;
  return {
    number,
    title: asString(pr.title) || "(untitled)",
    url: asString(pr.html_url),
    state: asString(pr.state) || "unknown",
    draft: pr.draft === true,
    merged: pr.merged === true,
    author: asString((pr.user as Record<string, unknown> | undefined)?.login) || "unknown",
    head: asString(head?.ref),
    base: asString(base?.ref),
    updatedAt: asString(pr.updated_at),
    changedFiles: asNumber(pr.changed_files),
    additions: asNumber(pr.additions),
    deletions: asNumber(pr.deletions),
    bodyPreview: oneLine(asString(pr.body), 200),
  };
}

export async function listPullRequests(
  req: CollabRepo,
  filter: { state?: "open" | "closed" | "all"; head?: string; base?: string; author?: string } = {}
): Promise<PullRequestSummary[]> {
  const params = new URLSearchParams({
    state: filter.state ?? "open",
    per_page: String(COLLAB_LIST_LIMIT),
    sort: "updated",
    direction: "desc",
  });
  // `head` must be prefixed with the owner to match only same-repo branches —
  // the API's own rule, and the reason a bare branch name silently returns
  // nothing.
  if (filter.head) params.set("head", `${req.owner}:${filter.head}`);
  if (filter.base) params.set("base", filter.base);

  const res = await githubFetch(`/repos/${req.owner}/${req.repo}/pulls?${params}`, req.token);
  const raw = (await res.json()) as unknown;
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .map(normalizePull)
    .filter((p): p is PullRequestSummary => p !== null)
    .filter((p) => !filter.author || p.author === filter.author);
}

/**
 * The pull request a branch already has, if any.
 *
 * The reason this exists: GitHub refuses a SECOND open pull request for the
 * same head/base pair with a 422, and the fix-up round — read the review, edit,
 * push again — is exactly the case that tries. The push had already succeeded
 * when that 422 arrived, so reporting it as a failure would say "the push
 * failed" about a commit that is on GitHub; finding the existing PR first is
 * what turns that into "pushed to pull request #17".
 *
 * An OPEN one is preferred; a closed or merged one is returned too, because
 * the caller still needs to say which pull request the branch belongs to.
 */
export async function findPullRequestForHead(
  req: CollabRepo,
  head: string
): Promise<PullRequestSummary | null> {
  if (!head) return null;
  const pulls = await listPullRequests(req, { state: "all", head });
  return pulls.find((p) => p.state === "open") ?? pulls[0] ?? null;
}

async function pullChecks(req: CollabRepo, sha: string): Promise<PullRequestChecks | null> {
  if (!sha) return null;
  // Both APIs, because they are not alternatives: GitHub Actions publishes
  // check runs, while CircleCI, Jenkins, Travis and older setups publish commit
  // statuses. Reading only check runs reports "no checks" — a wrong answer to
  // "is this green" — for a repository whose CI is entirely green over there.
  // Each call degrades on its own. They need DIFFERENT scopes (check runs are
  // the Checks API, statuses are Commit statuses), so a token that can read one
  // and not the other must still answer with the half it can see — a shared
  // rejection would throw away a working answer because a neighbouring one
  // failed, and report "no checks" for a repository whose statuses are right
  // there.
  const [runsRes, statusRes] = await Promise.all([
    githubFetch(`/repos/${req.owner}/${req.repo}/commits/${sha}/check-runs?per_page=100`, req.token).catch(
      () => null
    ),
    githubFetch(`/repos/${req.owner}/${req.repo}/commits/${sha}/status`, req.token).catch(() => null),
  ]);
  const payload = runsRes
    ? ((await runsRes.json()) as { check_runs?: unknown })
    : {};
  const rows = Array.isArray(payload.check_runs) ? payload.check_runs : [];
  const failing: string[] = [];
  const running: string[] = [];
  let seen = 0;
  /** Runs that actually reported a pass — what "green" has to be based on */
  let passed = 0;
  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) continue;
    const run = entry as Record<string, unknown>;
    seen += 1;
    const name = asString(run.name) || "check";
    const status = asString(run.status);
    const conclusion = asString(run.conclusion);
    if (status !== "completed") {
      running.push(name);
      continue;
    }
    if (conclusion === "success") {
      passed += 1;
      continue;
    }
    // skipped / neutral are reported but prove nothing — counted in `total`,
    // never in `passed`.
    if (conclusion && conclusion !== "neutral" && conclusion !== "skipped") {
      failing.push(`${name} (${conclusion})`);
    }
  }

  let statusState = "";
  const statusContexts: string[] = [];
  if (statusRes) {
    const combined = (await statusRes.json()) as { state?: unknown; statuses?: unknown };
    const statusRows = Array.isArray(combined.statuses) ? combined.statuses : [];
    // The combined status is only counted when it LISTS contexts. GitHub
    // answers `pending` with an empty list for a commit nothing reported on —
    // reading that as "still running" turned every repository without CI into a
    // build in progress.
    if (statusRows.length > 0) {
      // Only the four documented values count; anything else is "this call told
      // us nothing", which beats shaping a verdict around a guessed field.
      const state = asString(combined.state);
      statusState = ["success", "pending", "failure", "error"].includes(state) ? state : "";
      for (const entry of statusRows) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        const context = asString(row.context) || "status";
        const rowState = asString(row.state) || "unknown";
        statusContexts.push(`${context} (${rowState})`);
        if (rowState === "success") passed += 1;
        else if (rowState === "failure" || rowState === "error") failing.push(`${context} (${rowState})`);
        else if (rowState === "pending") running.push(context);
      }
    }
  }
  // Nothing reported by either API: the honest answer is "no checks", and the
  // caller renders that as an absence of evidence rather than a green light.
  if (seen === 0 && statusState === "") return null;
  const statusPending = statusState === "pending";
  if (statusPending && statusContexts.length === 0) running.push("combined status");
  const total = seen + statusContexts.length;
  return {
    total,
    failing,
    running,
    // Green needs EVIDENCE: at least one thing PASSED, nothing failed, nothing
    // is still running, and the combined status is not bad. A repository whose
    // checks were all skipped, or which has no CI at all, must not read as "all
    // checks green" — that is the claim this field exists to stop a model from
    // making.
    allGreen:
      passed > 0 &&
      failing.length === 0 &&
      running.length === 0 &&
      !statusPending &&
      statusState !== "failure" &&
      statusState !== "error",
    statusState,
    statusContexts,
  };
}

export async function readPullRequest(req: CollabRepo, number: number): Promise<PullRequestDetail> {
  const res = await githubFetch(`/repos/${req.owner}/${req.repo}/pulls/${number}`, req.token);
  const rawPr = (await res.json()) as Record<string, unknown>;
  const summary = normalizePull(rawPr);
  if (!summary) throw new Error(`Pull request #${number} could not be read.`);

  const body = cap(asString(rawPr.body), COLLAB_BODY_MAX);
  const head = rawPr.head as Record<string, unknown> | undefined;
  const headSha = asString(head?.sha);

  // One round trip holds the whole conversation: the file list, the formal
  // reviews, the line-anchored comments and the PR's own comment thread. The
  // inline endpoint takes `sort`/`direction`, so the NEWEST annotations come
  // back first in a single request — the opposite of the issue-comment
  // endpoint, whose list is oldest-first with no sort parameter at all.
  const [filesRes, reviewsRes, inlineRes, comments] = await Promise.all([
    githubFetch(`/repos/${req.owner}/${req.repo}/pulls/${number}/files?per_page=${COLLAB_PAGE_SIZE}`, req.token),
    githubFetch(`/repos/${req.owner}/${req.repo}/pulls/${number}/reviews?per_page=${COLLAB_PAGE_SIZE}`, req.token),
    githubFetch(
      `/repos/${req.owner}/${req.repo}/pulls/${number}/comments?per_page=${COLLAB_INLINE_LIMIT}&sort=created&direction=desc`,
      req.token
    ),
    // `null`: a pull request's `comments` field counts conversation comments
    // and review comments together, so the page arithmetic is derived from the
    // Link header instead of from a number that means something else.
    fetchCommentTail(req, number, null),
  ]);

  const rawFiles = (await filesRes.json()) as unknown;
  const fileRows = Array.isArray(rawFiles) ? rawFiles : [];
  const files = fileRows.slice(0, COLLAB_FILES_LIMIT).flatMap((f): PullRequestFile[] => {
    if (typeof f !== "object" || f === null) return [];
    const row = f as Record<string, unknown>;
    return [
      {
        path: asString(row.filename),
        status: asString(row.status) || "modified",
        additions: asNumber(row.additions),
        deletions: asNumber(row.deletions),
      },
    ];
  });

  const rawReviews = (await reviewsRes.json()) as unknown;
  const reviewRows = Array.isArray(rawReviews) ? rawReviews : [];
  const reviews = reviewRows
    .slice(-COLLAB_REVIEW_LIMIT)
    .flatMap((r): PullRequestReview[] => {
      if (typeof r !== "object" || r === null) return [];
      const row = r as Record<string, unknown>;
      return [
        {
          author: asString((row.user as Record<string, unknown> | undefined)?.login) || "unknown",
          state: asString(row.state).toUpperCase() || "COMMENTED",
          submittedAt: asString(row.submitted_at),
          body: cap(asString(row.body), COLLAB_COMMENT_MAX).text,
        },
      ];
    });

  const rawInline = (await inlineRes.json()) as unknown;
  const inlineRows = Array.isArray(rawInline) ? rawInline : [];
  const inlineComments = inlineRows.flatMap((c): PullRequestInlineComment[] => {
    if (typeof c !== "object" || c === null) return [];
    const row = c as Record<string, unknown>;
    return [
      {
        id: asNumber(row.id),
        author: asString((row.user as Record<string, unknown> | undefined)?.login) || "unknown",
        path: asString(row.path),
        // `line` is null on an outdated or file-level comment; `original_line`
        // still says where it was written.
        line:
          typeof row.line === "number"
            ? row.line
            : typeof row.original_line === "number"
              ? row.original_line
              : null,
        body: cap(asString(row.body), COLLAB_COMMENT_MAX).text,
        createdAt: asString(row.created_at),
        replyToId: typeof row.in_reply_to_id === "number" ? row.in_reply_to_id : null,
      },
    ];
  });

  // A checks read that fails must not fail the pull-request read: the
  // conversation is still readable without it, and reporting no checks is
  // honest (`checks: null`), while an exception would throw away the body, the
  // reviews and the failing-test context the agent actually needs.
  const checks = await pullChecks(req, headSha).catch(() => null);

  return {
    ...summary,
    body: body.text,
    bodyTruncated: body.truncated,
    url: asString(rawPr.html_url),
    createdAt: asString(rawPr.created_at),
    mergeable: typeof rawPr.mergeable === "boolean" ? rawPr.mergeable : null,
    mergedBy: asString((rawPr.merged_by as Record<string, unknown> | undefined)?.login),
    files,
    // The PR resource carries the true count (`changed_files`), so this is the
    // number GitHub reports rather than the length of one page of files.
    filesTruncated: summary.changedFiles > files.length,
    filesTotal: summary.changedFiles || fileRows.length,
    reviews,
    reviewsTotal: reviewRows.length,
    inlineComments,
    inlineCommentsTruncated: inlineRows.length >= COLLAB_INLINE_LIMIT,
    comments: comments.comments,
    commentsTotal: comments.total,
    checks,
    mergeStateNote: asString(rawPr.mergeable_state),
  };
}

// ── Fitting a payload to the wire budget ─────────────────────

/**
 * Where a field sits in the shedding order, and what to say when it is lost.
 *
 * The order is the argument. The fields that identify the target are not
 * listed at all, so no amount of size pressure can drop the fact that this is
 * about issue #42. The listed arrays then lose their entries from the END:
 * comments are ordered oldest-first, so the end is the newest — and a comment
 * dropped from the end of the slice is only dropped once the budget is
 * genuinely gone, which the note reports.
 */
export interface ShedRule {
  /** Field path in the payload, `pullRequest.comments` style when nested */
  key: string;
  /** sentence recorded when something from this field is dropped */
  note: string;
}

export interface FittedPayload<T> {
  data: T;
  /** the sentences to include in the result, one per trimmed field */
  notes: string[];
}

/**
 * Fits a payload into the wire budget by giving up the least important pieces.
 *
 * `serializeToolResult` (lib/tools.ts) truncates any payload longer than
 * TOOL_RESULT_MAX_CHARS, and it truncates the SERIALIZED STRING — so an
 * oversized result reaches the model as broken JSON with a marker on the end.
 * Per-field caps do not prevent that, because caps multiply (20 comments ×
 * 2 000 chars + 50 files + a 6 000-char body). Trimming here is the difference
 * between "the last three comments were left out, and here is why" and a
 * document that stops parsing mid-word.
 */
/**
 * Resolves a rule's path to the object that OWNS the value and the key in it.
 *
 * Dotted paths (`issue.comments`) because the payloads keep their shape: an
 * issue read stays `{ repository, issue }` rather than being split into a
 * metadata object and a pile of arrays, which is how a model reads a document
 * that is still one document.
 */
function resolvePath(
  root: Record<string, unknown>,
  path: string
): { owner: Record<string, unknown>; key: string } | null {
  const parts = path.split(".");
  let owner = root;
  for (const part of parts.slice(0, -1)) {
    const next = owner[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) return null;
    owner = next as Record<string, unknown>;
  }
  return { owner, key: parts[parts.length - 1]! };
}

export function fitPayload<T extends Record<string, unknown>>(
  data: T,
  shed: readonly ShedRule[],
  cap: number = COLLAB_PAYLOAD_MAX
): FittedPayload<T> {
  const target = data as Record<string, unknown>;
  const notes = new Set<string>();
  let guard = 0;
  // One entry per pass, re-measured each time: the serialized size is the
  // quantity the wire actually enforces, and every removal changes it.
  while (JSON.stringify(target).length > cap && guard < 1_000) {
    guard += 1;
    let dropped = false;
    for (const rule of shed) {
      const found = resolvePath(target, rule.key);
      if (!found) continue;
      const value = found.owner[found.key];
      if (Array.isArray(value) && value.length > 0) {
        value.splice(-1, 1);
        notes.add(rule.note);
        dropped = true;
        break;
      }
      if (typeof value === "string" && value.length > 400) {
        // A single long string with nothing left to page out (a description and
        // no comments): halved rather than removed, because half a description
        // still answers "what is this about".
        found.owner[found.key] = `${value.slice(
          0,
          Math.floor(value.length / 2)
        )}\n… [trimmed to fit this result]`;
        notes.add(rule.note);
        dropped = true;
        break;
      }
    }
    if (!dropped) break;
  }
  return { data, notes: [...notes] };
}

// ── Writes ───────────────────────────────────────────────────
// Every function below changes someone else's repository. None of them is
// called without the user's approval: the executors route them through the
// same gate `http_write` uses, which shows the method, the URL, the body and
// the agent's reason before anything leaves the machine.

export interface WriteOutcome {
  number?: number;
  url?: string;
  state?: string;
  /** what GitHub called it, for a report the model can quote */
  detail: string;
}

export async function createIssue(
  req: CollabRepo,
  input: { title: string; body?: string; labels?: string[]; assignees?: string[] }
): Promise<WriteOutcome> {
  const payload: Record<string, unknown> = { title: input.title };
  if (input.body) payload.body = input.body;
  if (input.labels && input.labels.length > 0) payload.labels = input.labels;
  if (input.assignees && input.assignees.length > 0) payload.assignees = input.assignees;

  const res = await githubFetch(`/repos/${req.owner}/${req.repo}/issues`, req.token, undefined, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const raw = (await res.json()) as Record<string, unknown>;
  return {
    number: asNumber(raw.number),
    url: asString(raw.html_url),
    state: asString(raw.state),
    detail: `opened issue #${asNumber(raw.number)}`,
  };
}

export async function commentOnIssue(
  req: CollabRepo,
  input: { number: number; body: string }
): Promise<WriteOutcome> {
  const res = await githubFetch(
    `/repos/${req.owner}/${req.repo}/issues/${input.number}/comments`,
    req.token,
    undefined,
    { method: "POST", body: JSON.stringify({ body: input.body }) }
  );
  const raw = (await res.json()) as Record<string, unknown>;
  return {
    number: input.number,
    url: asString(raw.html_url),
    detail: `commented on #${input.number}`,
  };
}

/** A review is a state machine, not a comment: the event is the whole point */
export const REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/**
 * Answers a SPECIFIC inline review comment, inside its own thread.
 *
 * A top-level comment cannot do this. The reviewer's `path:line` note is a
 * thread, and "fixed in the next push" belongs under that note — posting it as
 * a general PR comment is how the answer gets lost. The id comes from
 * `read_pull_request`'s `inlineComments[].id`.
 */
export async function replyToReviewComment(
  req: CollabRepo,
  input: { number: number; commentId: number; body: string }
): Promise<WriteOutcome> {
  const res = await githubFetch(
    `/repos/${req.owner}/${req.repo}/pulls/${input.number}/comments`,
    req.token,
    undefined,
    {
      method: "POST",
      body: JSON.stringify({ body: input.body, in_reply_to: input.commentId }),
    }
  );
  const raw = (await res.json()) as Record<string, unknown>;
  return {
    number: input.number,
    url: asString(raw.html_url),
    detail: `replied in the review thread on #${input.number}`,
  };
}

export async function reviewPullRequest(
  req: CollabRepo,
  input: {
    number: number;
    event: ReviewEvent;
    body?: string;
    comments?: Array<{ path: string; line: number; body: string }>;
  }
): Promise<WriteOutcome> {
  const payload: Record<string, unknown> = { event: input.event };
  // GitHub rejects COMMENTER/COMMENT with neither a body nor inline comments
  // (422), so a plain comment with no text is refused here with the reason
  // instead of at the API with a validation error.
  if (input.body) payload.body = input.body;
  if (input.comments && input.comments.length > 0) {
    payload.comments = input.comments.map((c) => ({ path: c.path, line: c.line, body: c.body }));
  }

  const res = await githubFetch(
    `/repos/${req.owner}/${req.repo}/pulls/${input.number}/reviews`,
    req.token,
    undefined,
    { method: "POST", body: JSON.stringify(payload) }
  );
  const raw = (await res.json()) as Record<string, unknown>;
  const state = asString(raw.state).toUpperCase() || input.event;
  return {
    number: input.number,
    url: asString(raw.html_url),
    state,
    detail: `review on #${input.number}: ${state}`,
  };
}

export async function updatePullRequest(
  req: CollabRepo,
  input: { number: number; title?: string; body?: string; state?: "open" | "closed"; base?: string }
): Promise<WriteOutcome> {
  const payload: Record<string, unknown> = {};
  if (input.title !== undefined) payload.title = input.title;
  if (input.body !== undefined) payload.body = input.body;
  if (input.state !== undefined) payload.state = input.state;
  if (input.base !== undefined) payload.base = input.base;

  const res = await githubFetch(
    `/repos/${req.owner}/${req.repo}/pulls/${input.number}`,
    req.token,
    undefined,
    { method: "PATCH", body: JSON.stringify(payload) }
  );
  const raw = (await res.json()) as Record<string, unknown>;
  const fields = Object.keys(payload);
  return {
    number: asNumber(raw.number) || input.number,
    url: asString(raw.html_url),
    state: asString(raw.state),
    detail: `updated #${input.number} (${fields.join(", ")})`,
  };
}
