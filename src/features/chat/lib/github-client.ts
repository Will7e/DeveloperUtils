// ============================================================
// GitHub REST Client — Repo Access for Agent Mode
// ============================================================
// Thin fetch wrapper around api.github.com with the app's
// direct-fetch-then-proxy fallback (api.github.com sends CORS
// headers, so direct works in most environments; the proxy
// handles restrictive networks). Includes small in-memory caches
// for repos and trees, and surfaces remaining rate limit.

import {
  GITHUB_API_BASE_URL,
  GITHUB_MAX_TREE_ENTRIES,
} from "../constants";

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "network"
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

function classify(status: number): GitHubError["code"] | undefined {
  if (status === 401) return "unauthorized";
  // A 403 here is NOT a rate limit: the rate-limit case is detected and
  // thrown separately, with its own code and reset time. Labeling every
  // remaining 403 "rate_limited" made a permissions failure look like
  // something that clears itself in an hour.
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 422) return "forbidden";
  return undefined;
}

const PROXY_PREFIX = "/api/proxy?url=";

/**
 * Reports a credential GitHub refused (401), so the app can clear a session it
 * can no longer use.
 *
 * A listener rather than a store import, because this module is deliberately
 * store-free: it is the transport. Without the report, a revoked token kept
 * the header and settings tab saying "Connected" for as long as the app stayed
 * open — every repository call failing underneath it.
 */
type GitHubCredentialRefusedListener = (message: string) => void;

let credentialRefusedListener: GitHubCredentialRefusedListener | null = null;

export function onGitHubCredentialRefused(
  listener: GitHubCredentialRefusedListener | null
): void {
  credentialRefusedListener = listener;
}

/** What the app shows once GitHub refuses the stored token. */
export const GITHUB_CREDENTIAL_REFUSED_NOTE =
  "GitHub no longer accepts your saved token — reconnect it in Settings › GitHub.";

/**
 * Largest file worth pulling through the Blob API when the Contents API
 * declines to return it (anything over 1 MB).
 *
 * Base64 is 4/3 of the byte size, so bytes stop at 6 MiB — past that the file
 * would be fetched and transported only to be rejected for exceeding a cap
 * that was predictable before the request.
 */
export const GITHUB_BLOB_FALLBACK_MAX_BYTES = 6 * 1024 * 1024;

import { registerScopedResource } from "../identity/scoped-resources";

/** Small in-memory caches (session-scoped, invalidated by ref param) */
let repoListCacheState: { repos: GitHubRepo[]; at: number } | null = null;
const treeCache = new Map<string, GitHubTreeEntry[]>();
const TREE_CACHE_TTL = 5 * 60 * 1000;
const treeCacheStamps = new Map<string, number>();

function clearTreeCache(): void {
  treeCache.clear();
  treeCacheStamps.clear();
}

/**
 * Forgets the cached tree of one repository.
 *
 * The entries live for five minutes, keyed by `owner/repo@ref` — a fact about a
 * REPOSITORY at a REF, so a push is what makes them wrong. Reading a tree five
 * minutes stale is how a file created by the push looked absent, and a deleted
 * one looked present, to anything that reads the tree without also checking the
 * commit it was read at.
 */
export function clearTreeCacheForRepo(repo: { owner: string; repo: string }): void {
  const prefix = `${repo.owner}/${repo.repo}@`;
  for (const key of [...treeCache.keys()]) {
    if (key.startsWith(prefix)) treeCache.delete(key);
  }
  for (const key of [...treeCacheStamps.keys()]) {
    if (key.startsWith(prefix)) treeCacheStamps.delete(key);
  }
}

registerScopedResource({
  name: "github-client.tree",
  scope: "repo",
  release: ({ transition }) => {
    if (transition.type === "base.moved" && transition.ref) {
      clearTreeCacheForRepo(transition.ref);
    }
  },
});

interface GitHubApiErrorBody {
  message?: string;
  documentation_url?: string;
}

/**
 * Single GitHub API request with auth + proxy fallback.
 * Exported for the write client (github-write.ts) which layers
 * POST/PATCH git-data endpoints on the same transport.
 */
export async function githubFetch(
  path: string,
  token: string,
  accept = "application/vnd.github+json",
  init?: { method?: string; body?: string }
): Promise<Response> {
  const url = `${GITHUB_API_BASE_URL}${path}`;
  const fullInit: RequestInit = {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.body ? { body: init.body } : {}),
  };

  const attempt = (useProxy: boolean) =>
    fetch(useProxy ? `${PROXY_PREFIX}${encodeURIComponent(url)}` : url, fullInit);

  let res: Response;
  try {
    res = await attempt(false);
  } catch (err) {
    if (err instanceof TypeError) {
      // CORS / network → retry through the app proxy
      res = await attempt(true);
    } else {
      throw err;
    }
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as GitHubApiErrorBody;
      detail = body.message ?? "";
    } catch {
      /* non-JSON error body */
    }
    const remaining = res.headers.get("x-ratelimit-remaining");
    const isRateLimited =
      res.status === 403 &&
      remaining === "0" &&
      res.headers.get("x-ratelimit-limit") !== null;

    if (isRateLimited) {
      const resetHeader = res.headers.get("x-ratelimit-reset");
      const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : null;
      const when = resetAt
        ? resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "soon";
      throw new GitHubError(
        `GitHub API rate limit reached — resets at ${when}.`,
        403,
        "rate_limited"
      );
    }
    const messages: Record<number, string> = {
      401: "GitHub token is invalid or expired. Reconnect in Chat Settings.",
      404: "Not found on GitHub — the repo or path may not exist or is private.",
    };
    // A 403 is the one status whose cause is worth spelling out, because
    // every cause has a different fix and the API's own message (when it
    // sent one) names which it is. Never swallow it behind a generic line.
    if (res.status === 403) {
      throw new GitHubError(
        `GitHub refused the request (403)${detail ? ` — ${detail}` : ""}. ` +
          "The token may lack the required access to this repository, the OAuth app may not be approved by its " +
          "organization, SAML SSO authorization may be required, or a `workflow` scope may be missing for " +
          "changes under .github/workflows/.",
        403,
        "forbidden"
      );
    }
    // The credential is dead, and the code that owns the session has to hear
    // it from here: this is the one place that sees the 401 for every caller.
    if (res.status === 401) credentialRefusedListener?.(GITHUB_CREDENTIAL_REFUSED_NOTE);
    throw new GitHubError(
      messages[res.status] ?? detail ?? `GitHub request failed (HTTP ${res.status}).`,
      res.status,
      classify(res.status)
    );
  }

  return res;
}

// ── Types ────────────────────────────────────────────────────

export interface GitHubRepo {
  fullName: string; // "owner/name"
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  updatedAt: number;
  language: string | null;
}

export interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

export interface GitHubFileContent {
  path: string;
  /** Decoded UTF-8 text (only when the file is valid UTF-8 and under cap) */
  text: string | null;
  size: number;
  sha: string;
  encoding: "base64" | "none";
  truncated: boolean;
  isBinary: boolean;
  /**
   * The payload exactly as the API sent it (base64, whitespace removed),
   * or null when it sent none — files over its 1 MB limit.
   *
   * Kept because a caller may want a file's BYTES while never wanting its
   * text, and a lossy text decode of an image is the bug that produced
   * `Expected ";" but found "\x14"`.
   */
  base64: string | null;
}

export interface GitHubUserInfo {
  login: string;
  avatarUrl: string | null;
}

// ── Endpoints ────────────────────────────────────────────────

/** Authenticated user — used to validate tokens and show a login chip */
export async function getAuthenticatedUser(token: string): Promise<GitHubUserInfo> {
  const res = await githubFetch("/user", token);
  const json = (await res.json()) as { login?: string; avatar_url?: string };
  if (!json.login) throw new GitHubError("GitHub returned no user.", res.status);
  return { login: json.login, avatarUrl: json.avatar_url ?? null };
}

/** Repos the token can access (affiliated: owned/member/collab), newest first */
export async function listUserRepos(token: string): Promise<GitHubRepo[]> {
  if (repoListCacheState && Date.now() - repoListCacheState.at < 60_000) {
    return repoListCacheState.repos;
  }

  const all: GitHubRepo[] = [];
  for (let page = 1; page <= 4; page++) {
    const res = await githubFetch(
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      token
    );
    const json = (await res.json()) as Array<{
      full_name?: string;
      owner?: { login?: string };
      name?: string;
      private?: boolean;
      default_branch?: string;
      description?: string | null;
      updated_at?: string;
      language?: string | null;
      permissions?: { pull?: boolean };
    }>;
    const batch = Array.isArray(json) ? json : [];
    for (const r of batch) {
      if (!r.full_name || !r.owner?.login || !r.name) continue;
      all.push({
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        private: r.private ?? false,
        defaultBranch: r.default_branch ?? "main",
        description: r.description ?? null,
        updatedAt: r.updated_at ? Date.parse(r.updated_at) : 0,
        language: r.language ?? null,
      });
    }
    if (batch.length < 100) break;
  }

  repoListCacheState = { repos: all, at: Date.now() };
  return all;
}

/**
 * Recursive git tree for a ref — one call gives the full file list.
 * Cached per (owner, repo, ref) for the session.
 */
export async function getRepoTree(
  token: string,
  owner: string,
  repo: string,
  ref: string
): Promise<GitHubTreeEntry[]> {
  const cacheKey = `${owner}/${repo}@${ref}`;
  const stamped = treeCacheStamps.get(cacheKey);
  if (stamped !== undefined && Date.now() - stamped < TREE_CACHE_TTL) {
    const cached = treeCache.get(cacheKey);
    if (cached) return cached;
  }

  // Refs may contain slashes (feature/x) — encode per segment only
  const refPath = ref.split("/").map(encodeURIComponent).join("/");
  const res = await githubFetch(
    `/repos/${owner}/${repo}/git/trees/${refPath}?recursive=1`,
    token
  );
  const json = (await res.json()) as {
    tree?: Array<{ path?: string; type?: string; size?: number }>;
    truncated?: boolean;
  };
  const entries: GitHubTreeEntry[] = [];
  for (const e of json.tree ?? []) {
    if (!e.path || (e.type !== "blob" && e.type !== "tree")) continue;
    entries.push({
      path: e.path,
      type: e.type,
      ...(e.type === "blob" && typeof e.size === "number" ? { size: e.size } : {}),
    });
  }

  // Cache even truncated trees — refetching doesn't help; the caller
  // sees `entries.length >= GITHUB_MAX_TREE_ENTRIES` and can adapt.
  treeCache.set(cacheKey, entries);
  treeCacheStamps.set(cacheKey, Date.now());
  return entries;
}

/** True when the cached tree (if any) was truncated by the API */
export function isTreeLikelyTruncated(entries: GitHubTreeEntry[]): boolean {
  return entries.length >= GITHUB_MAX_TREE_ENTRIES;
}

/** File contents (Contents API). Binary/too-large files are flagged, not decoded. */
export async function readFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<GitHubFileContent> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${encodeURIComponent(ref)}`,
    token
  );
  const json = (await res.json()) as {
    path?: string;
    size?: number;
    sha?: string;
    content?: string | null;
    encoding?: string;
  };

  const size = json.size ?? 0;
  const sha = json.sha ?? "";
  const raw = json.content ?? "";
  // The API wraps base64 at 60 chars; the payload is the same string with
  // the newlines gone, and that is the form a base64 decoder wants.
  const payload = raw.replace(/\s+/g, "");
  const isBinaryHint = json.encoding !== "base64" || raw === "";
  const resolvedPath = json.path ?? path;

  // The Contents API returns content:null for files >1MB. The bytes still
  // exist on GitHub and the Blob API will hand them over, so ask it instead
  // of reporting a file we know is present as unloadable — which is all
  // "over the API's size limit" ever meant to whoever read the message.
  if (raw === "" && size > 0) {
    const viaBlob = await readBlobFallback(token, owner, repo, resolvedPath, sha, size);
    if (viaBlob) return viaBlob;
    return {
      path: resolvedPath,
      text: null,
      size,
      sha,
      encoding: "none",
      truncated: true,
      isBinary: false,
      base64: null,
    };
  }

  // A zero-byte file is a legitimately EMPTY text file, not a binary one. The
  // API sends encoding:"base64" with a zero-length payload, and every caller
  // downstream reads `text: null` as "could not be loaded" — so calling an
  // empty file binary makes it permanently unloadable.
  if (raw === "" && json.encoding === "base64") {
    return {
      path: resolvedPath,
      text: "",
      size,
      sha,
      encoding: "base64",
      truncated: false,
      isBinary: false,
      base64: "",
    };
  }

  if (isBinaryHint) {
    return {
      path: resolvedPath,
      text: null,
      size,
      sha,
      encoding: "none",
      truncated: false,
      isBinary: true,
      base64: null,
    };
  }

  return decodeBase64File(resolvedPath, size, sha, payload);
}

/**
 * One base64 payload → a file, decoding the text when the bytes ARE text.
 *
 * Not UTF-8 is not a failure: there is no text, but there ARE bytes — which is
 * what a caller inlining an image, a font or a clip needs.
 */
function decodeBase64File(
  path: string,
  size: number,
  sha: string,
  payload: string
): GitHubFileContent {
  try {
    return {
      path,
      text: decodeBase64Utf8(payload),
      size,
      sha,
      encoding: "base64",
      truncated: false,
      isBinary: false,
      base64: payload,
    };
  } catch {
    return {
      path,
      text: null,
      size,
      sha,
      encoding: "none",
      truncated: false,
      isBinary: true,
      base64: payload,
    };
  }
}

/**
 * The same file, from the Blob API.
 *
 * `GET /repos/{owner}/{repo}/git/blobs/{sha}` returns base64 for anything up to
 * 100 MB, which is exactly the gap the Contents API leaves at 1 MB.
 *
 * Returns null whenever the bytes are not worth having — too big, no sha, or
 * the request itself failed — so the caller keeps its existing "not loaded"
 * report. A fallback must not become a new failure mode.
 */
async function readBlobFallback(
  token: string,
  owner: string,
  repo: string,
  path: string,
  sha: string,
  size: number
): Promise<GitHubFileContent | null> {
  if (!sha || size > GITHUB_BLOB_FALLBACK_MAX_BYTES) return null;
  try {
    const res = await githubFetch(`/repos/${owner}/${repo}/git/blobs/${sha}`, token);
    const json = (await res.json()) as { content?: string; encoding?: string };
    if (json.encoding !== "base64") return null;
    const payload = (json.content ?? "").replace(/\s+/g, "");
    if (!payload) return null;
    return decodeBase64File(path, size, sha, payload);
  } catch {
    return null;
  }
}

/** Code search scoped to one repo (requires an authenticated token) */
export interface GitHubSearchResult {
  path: string;
  repository: string;
  /** Fragment of the matching file content around the hit */
  fragment: string | null;
}

export async function searchCodeInRepo(
  token: string,
  owner: string,
  repo: string,
  query: string
): Promise<GitHubSearchResult[]> {
  const q = encodeURIComponent(`${query} repo:${owner}/${repo}`);
  const res = await githubFetch(`/search/code?q=${q}&per_page=15`, token);
  const json = (await res.json()) as {
    items?: Array<{
      path?: string;
      repository?: { full_name?: string };
      text_matches?: Array<{ fragment?: string }>;
    }>;
    total_count?: number;
  };
  return (json.items ?? []).map((item) => ({
    path: item.path ?? "",
    repository: item.repository?.full_name ?? `${owner}/${repo}`,
    fragment: item.text_matches?.[0]?.fragment ?? null,
  }));
}

// ── Helpers ──────────────────────────────────────────────────

/** Base64 → UTF-8 using TextDecoder (no atob unicode pitfalls) */
/**
 * Decodes base64 UTF-8 text, THROWING when the bytes are not UTF-8.
 *
 * Strict on purpose — this is what makes `isBinary` mean something. The
 * lenient decoder it replaces never threw, so a committed `.webp` was
 * returned as "text": the agent's read_file showed it mojibake, and code
 * that trusted "text" parsed the image's bytes as JavaScript
 * (`Expected ";" but found "\x14"`). A NUL byte is treated as binary too:
 * it is valid UTF-8, and no source file has one.
 */
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\u0000")) throw new Error("Binary content is not readable as text.");
  return text;
}

/** Invalidate the repo list (e.g. after connecting a new account) */
export function invalidateRepoCache(): void {
  repoListCacheState = null;
  clearTreeCache();
}
