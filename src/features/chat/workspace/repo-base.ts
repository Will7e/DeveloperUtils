// ============================================================
// Repo Base — What Is True Of The Repository, Cached Once
// ============================================================
// A workspace holds two very different kinds of state, and they were sharing
// one lifetime:
//
//   • what the REPOSITORY says — the tree, and each file's pristine contents
//     at the base commit. Expensive (one recursive tree call, one request per
//     file), identical for every chat working on that repo, and invalidated
//     only by a push;
//   • what THIS CHAT did to it — edits, deletions, the undo log, the working
//     branch. Cheap, private, and the reason two chats on one repo must not
//     share a workspace.
//
// Both used to be created per conversation, so opening a second chat on the
// same repo paid for the tree again and re-downloaded every file the first
// chat had already read. This module is the first half: the repo-derived
// facts, fetched once and shared.
//
// It is a CACHE, deliberately: nothing here is authoritative, every function
// falls through to GitHub on a miss, and losing everything costs speed rather
// than correctness. That is what makes it safe to keep in memory only for the
// hot path and in IndexedDB to survive a reload.
// ============================================================

import { getRepoTree } from "../lib/github-client";
import type { WorkspaceTreeEntry } from "../types";
import { readValue, writeValue } from "@/services/idb-storage.service";
import { registerScopedResource } from "../identity/scoped-resources";

/** Which repository, at which branch — the identity of a base */
export interface RepoIdentity {
  owner: string;
  repo: string;
  branch: string;
}

/** One file's pristine contents, as GitHub served them */
export interface RepoBaseFile {
  content: string;
  sha: string | null;
  /**
   * The file's bytes as the API sent them, when it sent bytes at all.
   *
   * Only binary ASSETS carry this (images, fonts): the browser workspace's
   * preview serves them, and a text field cannot. Optional — entries cached
   * before the field existed are still valid text, and a text-only cache is
   * the normal state for source files.
   */
  base64?: string;
}

export interface RepoBase {
  owner: string;
  repo: string;
  branch: string;
  /** The commit the tree was read at — not necessarily the branch head now */
  baseCommitSha: string;
  tree: WorkspaceTreeEntry[];
  /** Only the files something has actually asked for (this is lazy) */
  files: Record<string, RepoBaseFile>;
  fetchedAt: number;
}

const IDB_KEY_PREFIX = "intab_repo_base_";
/** How many repos stay resident. A developer works on a few, not a hundred. */
const MAX_RESIDENT = 4;

/** Keys are ours, but an owner/repo/branch can contain anything */
export function repoBaseKey({ owner, repo, branch }: RepoIdentity): string {
  return `${owner}|${repo}|${branch}`;
}

const resident = new Map<string, RepoBase>();

/** Test seam: drop everything resident (the IDB records stay) */
export function resetRepoBaseCache(): void {
  resident.clear();
}

function touch(key: string, base: RepoBase): RepoBase {
  // Re-insert to mark it most-recently-used
  resident.delete(key);
  resident.set(key, base);
  while (resident.size > MAX_RESIDENT) {
    const oldest = resident.keys().next().value;
    if (oldest === undefined) break;
    resident.delete(oldest);
  }
  return base;
}

async function loadFromIdb(key: string): Promise<RepoBase | null> {
  try {
    const raw = await readValue(IDB_KEY_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RepoBase;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.tree) ? parsed : null;
  } catch {
    return null;
  }
}

async function saveToIdb(key: string, base: RepoBase): Promise<void> {
  try {
    await writeValue(IDB_KEY_PREFIX + key, JSON.stringify(base));
  } catch {
    /* best-effort: the cache is an optimisation, never a source of truth */
  }
}

/**
 * The cached base for a repo, from memory then IndexedDB. Null when this
 * machine has never seen it — the caller then decides whether to fetch.
 */
async function readBase(identity: RepoIdentity): Promise<RepoBase | null> {
  const key = repoBaseKey(identity);
  const hit = resident.get(key);
  if (hit) return touch(key, hit);
  const stored = await loadFromIdb(key);
  if (!stored) return null;
  // A record for the same repo at a different branch is a different base.
  if (stored.branch !== identity.branch) return null;
  return touch(key, stored);
}

async function writeBase(base: RepoBase): Promise<void> {
  const key = repoBaseKey(base);
  touch(key, base);
  await saveToIdb(key, base);
}

/**
 * The repository tree, fetched at most once per (repo, branch) per machine.
 *
 * `baseCommitSha` is the commit the tree is being read at. A cached tree is
 * reused only when it was read at the same commit: a push moves the base, and
 * a tree from before it would claim files that no longer exist.
 */
export async function getRepoBaseTree(
  identity: RepoIdentity,
  token: string,
  baseCommitSha: string
): Promise<{ tree: WorkspaceTreeEntry[]; cached: boolean }> {
  const cached = await readBase(identity);
  if (cached && cached.baseCommitSha === baseCommitSha && cached.tree.length > 0) {
    return { tree: cached.tree, cached: true };
  }

  const entries = await getRepoTree(token, identity.owner, identity.repo, identity.branch);
  const tree: WorkspaceTreeEntry[] = entries.map((e) => ({
    path: e.path,
    type: e.type,
    ...(e.type === "blob" && typeof e.size === "number" ? { size: e.size } : {}),
  }));

  await writeBase({
    ...identity,
    baseCommitSha,
    tree,
    // A new base is a new tree: the contents cached against the old one stay
    // keyed by path, and the next read anyway verifies against the tree.
    files: cached?.baseCommitSha === baseCommitSha ? cached.files : {},
    fetchedAt: Date.now(),
  });
  return { tree, cached: false };
}

/**
 * A file's pristine contents, from the cache when possible.
 *
 * Returns null on a miss so the caller can fetch and then `rememberRepoBaseFile`
 * — the cache never fabricates content, because a workspace decision
 * ("is this file modified?") depends on it being exactly what the repo has.
 */
export async function getRepoBaseFile(
  identity: RepoIdentity,
  path: string,
  baseCommitSha: string
): Promise<RepoBaseFile | null> {
  const base = await readBase(identity);
  // Contents are only pristine RELATIVE TO A COMMIT. Serving bytes cached at
  // an older base would make a file a push just changed look unmodified — and
  // "unmodified" is what a diff, a revert and a push all decide on.
  if (!base || base.baseCommitSha !== baseCommitSha) return null;
  return base.files[path] ?? null;
}

/**
 * Records pristine contents another chat already fetched.
 *
 * Creates the base record when there is none: a file is read on its own
 * (read_file, a mention, a search) long before anything asks for the whole
 * tree, and requiring a prior tree fetch dropped exactly the contents
 * this cache exists to share. The record it creates carries no tree, which is
 * what `getRepoBaseTree` checks for — so the first tree ask still fetches.
 */
export async function rememberRepoBaseFile(
  identity: RepoIdentity,
  path: string,
  baseCommitSha: string,
  file: RepoBaseFile
): Promise<void> {
  const existing = await readBase(identity);
  const base: RepoBase = existing ?? {
    ...identity,
    baseCommitSha,
    tree: [],
    files: {},
    fetchedAt: Date.now(),
  };
  // Never across base commits, and never over a copy already held: the first
  // pristine bytes recorded are the ones the base commit actually had.
  if (base.baseCommitSha !== baseCommitSha || base.files[path]) return;
  await writeBase({ ...base, files: { ...base.files, [path]: file } });
}

/**
 * Forgets a repo's base — after a push, the tree and every cached content
 * are stale, and a stale base is worse than a slow one.
 */
export async function invalidateRepoBase(identity: RepoIdentity): Promise<void> {
  const key = repoBaseKey(identity);
  resident.delete(key);
  try {
    await writeValue(IDB_KEY_PREFIX + key, null);
  } catch {
    /* best-effort */
  }
}

/**
 * Scoped by REPOSITORY, because the facts here are facts about a repository:
 * every thread on it shares the tree and the pristine contents, which is the
 * point of the cache. Its lifetime is a push, and a push is what `base.moved`
 * announces — so this is the first thing that has ever actually invalidated a
 * base at the moment it went stale, rather than relying on each reader noticing
 * that the commit it asked for no longer matches the commit on file.
 */
registerScopedResource({
  name: "repo-base.tree",
  scope: "repo",
  release: ({ transition }) => {
    if (transition.type === "base.moved" && transition.ref) {
      void invalidateRepoBase(transition.ref);
    }
  },
});
