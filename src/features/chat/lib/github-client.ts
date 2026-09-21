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
  if (status === 403) return "rate_limited"; // 403 with 0 remaining = rate limit
  if (status === 404) return "not_found";
  if (status === 422) return "forbidden";
  return undefined;
}

const PROXY_PREFIX = "/api/proxy?url=";

/** Small in-memory caches (session-scoped, invalidated by ref param) */
let repoListCacheState: { repos: GitHubRepo[]; at: number } | null = null;
const treeCache = new Map<string, GitHubTreeEntry[]>();
const TREE_CACHE_TTL = 5 * 60 * 1000;
const treeCacheStamps = new Map<string, number>();

function clearTreeCache(): void {
  treeCache.clear();
  treeCacheStamps.clear();
}

interface GitHubApiErrorBody {
  message?: string;
  documentation_url?: string;
}

/** Single GitHub API request with auth + proxy fallback */
async function githubFetch(
  path: string,
  token: string,
  accept = "application/vnd.github+json"
): Promise<Response> {
  const url = `${GITHUB_API_BASE_URL}${path}`;
  const init: RequestInit = {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };

  const attempt = (useProxy: boolean) =>
    fetch(useProxy ? `${PROXY_PREFIX}${encodeURIComponent(url)}` : url, init);

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
      403: "GitHub refused the request (token lacks access or SSO is required).",
      404: "Not found on GitHub — the repo or path may not exist or is private.",
    };
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
  const isBinaryHint = json.encoding !== "base64" || raw === "";

  // The Contents API returns content:null for files >1MB — flag it.
  if (raw === "" && size > 0) {
    return {
      path: json.path ?? path,
      text: null,
      size,
      sha,
      encoding: "none",
      truncated: true,
      isBinary: false,
    };
  }

  if (isBinaryHint) {
    return {
      path: json.path ?? path,
      text: null,
      size,
      sha,
      encoding: "none",
      truncated: false,
      isBinary: true,
    };
  }

  let decoded: string;
  try {
    decoded = decodeBase64Utf8(raw.replace(/\n/g, ""));
  } catch {
    return {
      path: json.path ?? path,
      text: null,
      size,
      sha,
      encoding: "none",
      truncated: false,
      isBinary: true,
    };
  }

  return {
    path: json.path ?? path,
    text: decoded,
    size,
    sha,
    encoding: "base64",
    truncated: false,
    isBinary: false,
  };
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
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Invalidate the repo list (e.g. after connecting a new account) */
export function invalidateRepoCache(): void {
  repoListCacheState = null;
  clearTreeCache();
}
