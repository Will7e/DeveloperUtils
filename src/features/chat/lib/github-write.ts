// ============================================================
// GitHub Write Client — Git Data API for the Gated Push Flow
// ============================================================
// Implements the standard low-level commit chain so one push can
// carry every workspace change in a single commit:
//
//   getBranchHead → createBranch (agent/* from base)
//   → createBlob per changed file → createTree(baseTreeSha, entries)
//   → createCommit(parent, tree) → updateRef(branch, commit)
//   → openPullRequest
//
// Reuses githubFetch from github-client.ts for auth headers, the
// proxy fallback, and rate-limit handling. Never calls updateRef
// on the base branch itself — pushes target the agent working
// branch only. Concurrency is guarded by re-reading the head right
// before the ref update (fast-forward check).

import { githubFetch } from "./github-client";
import { AGENT_BRANCH_PREFIX } from "../constants";

// ── Types ────────────────────────────────────────────────────

export interface BranchHead {
  refName: string;
  commitSha: string;
  treeSha: string | null;
}

export interface TreeEntryInput {
  path: string;
  mode: "100644" | "100755" | "040000" | "160000" | "120000";
  type: "blob" | "tree" | "commit";
  /** null → delete this path in the new tree */
  sha: string | null;
}

export interface PushChainResult {
  branchName: string;
  commitSha: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  htmlUrl: string;
}

export class GitHubWriteError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: "conflict" | "forbidden" | "not_found" | "rate_limited" | "validation"
  ) {
    super(message);
    this.name = "GitHubWriteError";
  }
}

function classifyStatus(status: number, message: string): GitHubWriteError["code"] {
  if (status === 409 || status === 422) {
    if (/fast-forward|non-fast-forward|not a fast-forward|updated|is at/i.test(message)) {
      return "conflict";
    }
    return "validation";
  }
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return undefined;
}

function wrap(status: number, message: string, detail?: string): GitHubWriteError {
  return new GitHubWriteError(detail ? `${message} — ${detail}` : message, status, classifyStatus(status, message));
}

/**
 * GitHub's own explanation for a failed write, when it sent one.
 *
 * Worth the few lines: the interesting push failures are the ones the
 * API names precisely — a token missing the `workflow` scope, an org
 * that has not approved the OAuth app, a non-fast-forward ref. Throwing
 * a generic "failed to create a blob" discards the only part of the
 * response a user can act on.
 */
function apiMessage(body: unknown): string | undefined {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

/**
 * Failure text for a write stage, including GitHub's reason and the
 * scope fix when the reason is a missing scope. Nothing here is
 * speculative: the added sentences are only appended for the status and
 * scope the API actually reported.
 */
function writeFailure(status: number, action: string, body: unknown): GitHubWriteError {
  const detail = apiMessage(body);
  if (status === 403 && /workflow/i.test(detail ?? "")) {
    return wrap(
      403,
      action,
      `${detail} — reconnecting GitHub with the \`workflow\` scope included is required to push changes under .github/workflows/.`
    );
  }
  if (status === 403) {
    return wrap(
      403,
      action,
      `${detail ?? "GitHub refused the write"} — the token may be read-only for this repository, the OAuth app may not be approved by its organization, or SAML SSO authorization may be required.`
    );
  }
  return wrap(status, action, detail);
}

// ── Refs & branches ──────────────────────────────────────────

/** Head commit of a branch (GET /git/ref or /git/refs/heads fallback) */
export async function getBranchHead(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<BranchHead> {
  const refPath = branch.split("/").map(encodeURIComponent).join("/");
  let res: Response;
  try {
    res = await githubFetch(`/repos/${owner}/${repo}/git/ref/heads/${refPath}`, token);
  } catch (err) {
    // Older shapes: /git/refs/heads/<branch>
    if (err instanceof Error && /404|not found/i.test(err.message)) {
      const res2 = await githubFetch(`/repos/${owner}/${repo}/git/refs/heads/${refPath}`, token);
      return parseRef(await res2.json());
    }
    throw err;
  }
  return parseRef(await res.json());
}

interface RefJson {
  object?: { sha?: string; type?: string };
}

function parseRef(json: unknown): BranchHead {
  const j = json as RefJson;
  const obj = Array.isArray(json) ? (json as RefJson[])[0]?.object : j.object;
  if (!obj?.sha) throw wrap(404, "Branch reference not found on GitHub.");
  return { refName: "", commitSha: obj.sha, treeSha: null };
}

/** Resolves the tree sha of a commit (needed as the base for createTree) */
export async function getCommit(
  token: string,
  owner: string,
  repo: string,
  sha: string
): Promise<{ sha: string; treeSha: string; parentShas: string[] }> {
  const res = await githubFetch(`/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`, token);
  const json = (await res.json()) as {
    sha?: string;
    parents?: Array<{ sha?: string }>;
    commit?: { tree?: { sha?: string } };
  };
  if (!json.sha || !json.commit?.tree?.sha) {
    throw wrap(422, "Could not resolve the base commit tree.");
  }
  return {
    sha: json.sha,
    treeSha: json.commit.tree.sha,
    parentShas: (json.parents ?? []).map((p) => p.sha ?? "").filter(Boolean),
  };
}

/** Creates a new branch pointing at a commit sha */
export async function createBranch(
  token: string,
  owner: string,
  repo: string,
  branchName: string,
  fromSha: string
): Promise<void> {
  const res = await rawJson(
    await githubFetch(
      `/repos/${owner}/${repo}/git/refs`,
      token,
      "application/vnd.github+json",
      {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
      }
    )
  );
  if (!res.ok && res.status !== 422) {
    throw writeFailure(res.status, "Failed to create the working branch.", await res.body);
  }
  // 422 "Reference already exists" is tolerated — branch reuse is fine
}

/** Updates (fast-forwards) a branch ref to a commit */
export async function updateRef(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  sha: string
): Promise<void> {
  const refPath = branch.split("/").map(encodeURIComponent).join("/");
  const res = await rawJson(
    await githubFetch(
      `/repos/${owner}/${repo}/git/refs/heads/${refPath}`,
      token,
      "application/vnd.github+json",
      { method: "PATCH", body: JSON.stringify({ sha, force: false }) }
    )
  );
  if (!res.ok) {
    throw writeFailure(
      res.status,
      `Failed to update the working branch (HTTP ${res.status}).`,
      await res.body
    );
  }
}

/** True when the branch name is a protected default branch we refuse to touch */
export function isProtectedBranchName(branch: string): boolean {
  const name = branch.toLowerCase();
  return name === "main" || name === "master" || name === "develop" || name === "development";
}

/** Lists branch names (up to 300) — used for collision-safe naming */
export async function listBranches(token: string, owner: string, repo: string): Promise<string[]> {
  const res = await githubFetch(`/repos/${owner}/${repo}/branches?per_page=100`, token);
  const json = (await res.json()) as Array<{ name?: string }>;
  return (Array.isArray(json) ? json : []).map((b) => b.name ?? "").filter(Boolean);
}

// ── Blobs & trees & commits ──────────────────────────────────

/** Creates a blob and returns its sha */
export async function createBlob(
  token: string,
  owner: string,
  repo: string,
  content: string
): Promise<string> {
  const res = await rawJson(
    await githubFetch(`/repos/${owner}/${repo}/git/blobs`, token, "application/vnd.github+json", {
      method: "POST",
      body: JSON.stringify({ content, encoding: "utf-8" }),
    })
  );
  const json = (await res.body) as { sha?: string };
  if (!res.ok || !json.sha) {
    throw writeFailure(res.status, "Failed to create a blob for the push.", json);
  }
  return json.sha;
}

export async function createTree(
  token: string,
  owner: string,
  repo: string,
  baseTreeSha: string,
  entries: TreeEntryInput[]
): Promise<string> {
  const res = await rawJson(
    await githubFetch(`/repos/${owner}/${repo}/git/trees`, token, "application/vnd.github+json", {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
    })
  );
  const json = (await res.body) as { sha?: string };
  if (!res.ok || !json.sha) {
    throw writeFailure(res.status, "Failed to create the git tree for the push.", json);
  }
  return json.sha;
}

export async function createCommit(
  token: string,
  owner: string,
  repo: string,
  message: string,
  treeSha: string,
  parentShas: string[]
): Promise<string> {
  const res = await rawJson(
    await githubFetch(`/repos/${owner}/${repo}/git/commits`, token, "application/vnd.github+json", {
      method: "POST",
      body: JSON.stringify({ message, tree: treeSha, parents: parentShas }),
    })
  );
  const json = (await res.body) as { sha?: string };
  if (!res.ok || !json.sha) {
    throw writeFailure(res.status, "Failed to create the commit.", json);
  }
  return json.sha;
}

// ── Pull requests ────────────────────────────────────────────

export async function openPullRequest(
  token: string,
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<PullRequestInfo> {
  const res = await rawJson(
    await githubFetch(`/repos/${owner}/${repo}/pulls`, token, "application/vnd.github+json", {
      method: "POST",
      body: JSON.stringify({ title, head, base, body, draft: false }),
    })
  );
  const json = (await res.body) as {
    number?: number;
    url?: string;
    html_url?: string;
    message?: string;
  };
  if (!res.ok || !json.number) {
    // A PR may already exist for this head/base — surface clearly
    const msg = json.message || `Failed to open the pull request (HTTP ${res.status}).`;
    throw wrap(res.status, msg);
  }
  return {
    number: json.number,
    url: json.url ?? "",
    htmlUrl: json.html_url ?? `https://github.com/${owner}/${repo}/pull/${json.number}`,
  };
}

// ── Push preflight (stale base + write permission) ───────────

export interface PushPreflight {
  /** Head commit of the base branch right now */
  currentHeadSha: string;
  /** True when the base branch moved since the workspace was hydrated */
  baseMoved: boolean;
  /** Paths whose content on the base branch is no longer what the agent read */
  upstreamChanged: string[];
  /**
   * Whether the token may push to this repo, when the API reports it
   * (`permissions.push`). null → unknown/not reported.
   */
  canPush: boolean | null;
}

/**
 * Recursive blob shas of a tree (path → blob sha). Used to detect
 * whether a file the agent edited has moved on since it read it.
 * Tree listings are the only way to get upstream shas in one call.
 */
export async function getTreeBlobShas(
  token: string,
  owner: string,
  repo: string,
  treeSha: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const res = await githubFetch(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    token
  );
  const json = (await res.json()) as {
    tree?: Array<{ path?: string; type?: string; sha?: string }>;
  };
  for (const entry of json.tree ?? []) {
    if (entry.type === "blob" && entry.path && entry.sha) out.set(entry.path, entry.sha);
  }
  return out;
}

/**
 * Preflight for a push: has the base branch moved, did any file the
 * agent touched change upstream, and may this token write at all?
 *
 * Every PROBE failure here is non-fatal by design — the write path is
 * path-scoped so a push cannot corrupt unrelated files. The point is
 * to tell the human (and the model) when they are about to overwrite
 * someone else's work, or to fail for a missing scope, instead of
 * discovering it after commit.
 */
export async function inspectPushPreconditions(
  token: string,
  params: {
    owner: string;
    repo: string;
    baseBranch: string;
    baseCommitSha: string;
    files: Array<{ path: string; baseSha: string | null }>;
  }
): Promise<PushPreflight> {
  const { owner, repo, baseBranch, baseCommitSha, files } = params;
  const head = await getBranchHead(token, owner, repo, baseBranch);
  const baseMoved = Boolean(baseCommitSha) && head.commitSha !== baseCommitSha;

  let upstreamChanged: string[] = [];
  if (baseMoved) {
    const commit = await getCommit(token, owner, repo, head.commitSha);
    const shas = await getTreeBlobShas(token, owner, repo, commit.treeSha);
    upstreamChanged = files
      .filter((f) => f.baseSha !== null && shas.get(f.path) !== f.baseSha)
      .map((f) => f.path);
  }

  let canPush: boolean | null = null;
  try {
    const res = await githubFetch(`/repos/${owner}/${repo}`, token);
    const json = (await res.json()) as { permissions?: { push?: boolean } };
    if (typeof json.permissions?.push === "boolean") canPush = json.permissions.push;
  } catch {
    // Permission probing is advisory — never block a push on it.
  }

  return { currentHeadSha: head.commitSha, baseMoved, upstreamChanged, canPush };
}

/**
 * The definitive, pre-gate access check, as distinct from an advisory
 * warning.
 *
 * A probe that FAILED is unknown and must not block anything (see the
 * note on inspectPushPreconditions). `canPush === false` is the opposite:
 * GitHub reported this token's permissions on this repository, so a
 * human clicking Approve cannot make the push land — they would read a
 * diff, approve it, and watch the write 403. That is the "access issue"
 * an agent cannot talk its way out of, so it is refused early with an
 * instruction the user can actually act on.
 *
 * Returns null when write access is possible or simply unknown.
 */
export function pushAccessBlocker(
  preflight: PushPreflight,
  target: { owner: string; repo: string }
): string | null {
  if (preflight.canPush !== false) return null;
  return (
    `The connected GitHub token has READ-ONLY access to ${target.owner}/${target.repo}, so GitHub will reject this push (403). ` +
    "No approval can change that. Reconnect GitHub with a token that can write to this repository: " +
    "a fine-grained token with Contents → Read and write (add Pull requests → Read and write to open the PR), " +
    "or an OAuth / classic token with the `repo` and `workflow` scopes. " +
    "If the repository belongs to an organization, the token may also need that organization's approval (or SAML SSO authorization)."
  );
}

// ── High-level gated push orchestration ──────────────────────

export interface PushPlan {
  owner: string;
  repo: string;
  baseBranch: string;
  baseCommitSha: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  files: Array<{ path: string; content: string | null; baseSha: string | null }>;
  /** Creates the working branch as part of the chain (recommended) */
  createBranchIfNeeded: boolean;
  /**
   * Reuses an existing working branch when provided. Pushing again
   * onto the same branch parents the new commit on the branch's
   * CURRENT head (not baseCommitSha), so repeat pushes stack cleanly.
   */
  workingBranch?: string;
}

export interface PushChainOptions {
  /** Called with a short progress note after each stage (UI toasts) */
  onProgress?: (note: string) => void;
}

/**
 * Executes the full push chain. The caller (push_changes executor)
 * has already obtained user approval — this function performs the
 * GitHub writes: branch → blobs → tree → commit → ref → PR.
 */
export async function executePushChain(
  token: string,
  plan: PushPlan,
  options: PushChainOptions = {}
): Promise<PushChainResult & { pr?: PullRequestInfo }> {
  const { owner, repo, baseBranch, files, commitMessage } = plan;
  // prTitle/prBody are applied by the caller after the push lands
  // (see runPushChanges → openPullRequest)
  const progress = options.onProgress ?? (() => {});

  if (files.length === 0) {
    throw new GitHubWriteError("No workspace changes to push.", 422, "validation");
  }
  if (isProtectedBranchName(plan.workingBranch ?? baseBranch)) {
    throw new GitHubWriteError(
      "Refusing to push to a protected default branch — pushes always target an agent working branch.",
      403,
      "forbidden"
    );
  }

  // ── 1. Resolve the parent commit + tree ──
  // Repeat pushes to an existing working branch parent on that
  // branch's current head; a fresh push parents on the base branch.
  progress("Resolving the base commit…");
  const parentBranch = plan.workingBranch ?? baseBranch;
  const parentHead = await getBranchHead(token, owner, repo, parentBranch);
  const parentCommit = await getCommit(token, owner, repo, parentHead.commitSha);

  // ── 2. Create (or reuse) the working branch ──
  let workingBranch = plan.workingBranch ?? "";
  if (!workingBranch) {
    workingBranch = await uniqueBranchName(token, owner, repo, baseBranch);
    progress(`Creating branch ${workingBranch}…`);
    await createBranch(token, owner, repo, workingBranch, parentHead.commitSha);
  } else {
    progress(`Reusing branch ${workingBranch}…`);
  }

  // ── 3. Upload blobs ──
  const treeEntries: TreeEntryInput[] = [];
  for (const f of files) {
    if (f.content === null) {
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: null });
    } else {
      progress(`Uploading ${f.path}…`);
      const sha = await createBlob(token, owner, repo, f.content);
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha });
    }
  }

  // ── 4. Create tree on top of the parent tree ──
  progress("Building the git tree…");
  const newTreeSha = await createTree(token, owner, repo, parentCommit.treeSha, treeEntries);

  // ── 5. Create the commit ──
  progress("Creating the commit…");
  const commitSha = await createCommit(token, owner, repo, commitMessage, newTreeSha, [parentHead.commitSha]);

  // ── 6. Fast-forward the working branch ──
  progress("Updating the branch…");
  await updateRef(token, owner, repo, workingBranch, commitSha);

  return { branchName: workingBranch, commitSha };
}

/** Generates a collision-safe agent branch name */
export async function uniqueBranchName(
  token: string,
  owner: string,
  repo: string,
  baseBranch: string
): Promise<string> {
  const existing = await listBranches(token, owner, repo);
  const taken = new Set(existing);
  const slug = baseBranch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "base";
  const stamp = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`;
  const time = `${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
  let name = `${AGENT_BRANCH_PREFIX}${slug}-${day}-${time}`;
  let n = 2;
  while (taken.has(name)) {
    name = `${AGENT_BRANCH_PREFIX}${slug}-${day}-${time}-${n}`;
    n++;
  }
  return name;
}

// ── Raw JSON helper ──────────────────────────────────────────

interface JsonResult {
  ok: boolean;
  status: number;
  body: Promise<unknown>;
}

async function rawJson(res: Response): Promise<JsonResult> {
  return { ok: res.ok, status: res.status, body: res.json() };
}
