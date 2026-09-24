// ============================================================
// Tool Cache — Session LRU for Agent Tool Results
// ============================================================
// Agent loops re-read the same files and re-run the same searches
// across iterations. This caches tool results for the session
// (memory-only, bounded, per repo+branch) so repeat calls return
// instantly and never hit the network twice.
//
// Cacheability policy lives in the tool registry (lib/tool-registry.ts):
// each tool declares `cacheable`, and this module consults it. Today
// that means read-only file/tree reads are cached while search_code is
// not (time-sensitive indexing). Cache lookups are keyed by
// (repo, branch, tool, args, READ VIEW) so a branch switch or repo re-attach
// invalidates cleanly AND two agents on one repository cannot serve each
// other's reads.

import { selectWorkspace, useChatStore } from "@/stores/chat.store";
import type { RepoContext, ToolCallRequest, ToolCallResult } from "../types";
import { isToolCacheable } from "./tool-registry";
import { registerScopedResource } from "../identity/scoped-resources";
import { bindingIdOf } from "../identity/bindings";

interface CacheEntry {
  result: ToolCallResult;
  /** Insertion order key for LRU eviction */
  at: number;
  /** Last-access time for LRU touch */
  lastUsedAt: number;
}

const MAX_ENTRIES = 64;
/** Results older than this are evicted even when under the size cap */
const TTL_MS = 10 * 60_000;

const cache = new Map<string, CacheEntry>();
let clock = 0;

/**
 * The revision a cached read resolves against.
 *
 * Reads are WORKSPACE-FIRST (lib/tools.ts): `read_file` answers from the
 * thread's working copy when that copy holds the file, so the identical call
 * with identical arguments returns DIFFERENT bytes in two threads that have
 * edited different things. A key of (repo, branch, tool, args) therefore served
 * one agent's uncommitted edit to another agent as "the file's content" — the
 * same evidence-mismatch class the binding layer exists to prevent, and one
 * that only becomes reachable once two threads can work at once.
 *
 * What is in the key is the WORKING COPY, not the repository: a read whose
 * answer comes from GitHub would be safe to share, but the lookup happens
 * before the call, when nothing yet knows which side will answer. Refusing to
 * share is the honest direction, and the expensive half — the tree and the
 * pristine contents at a base commit — is still shared across threads by
 * workspace/repo-base.ts, keyed by repository and commit.
 */
export interface ReadView {
  /** The thread-on-repository this read belongs to */
  bindingId?: string;
  /** That working copy's revision; it moves on every agent write */
  workspaceUpdatedAt?: number;
}

/**
 * The read view for a conversation, or null when there is no thread.
 *
 * Reads the SAME working copy the read tools will read (selectWorkspace fails
 * closed on a stale entry), so the key and the answer are derived from one
 * source rather than from two that can disagree.
 */
export function readViewFor(conversationId: string | null | undefined): ReadView | null {
  if (!conversationId) return null;
  const state = useChatStore.getState();
  const workspace = selectWorkspace(state, conversationId);
  return {
    bindingId: bindingIdOf(conversationId),
    workspaceUpdatedAt: workspace?.updatedAt,
  };
}

/**
 * Builds the cache key for a tool call. Unknown/unparseable
 * arguments — or a tool the registry marks non-cacheable — yield
 * null → not cacheable.
 */
export function toolCacheKey(
  call: Pick<ToolCallRequest, "name" | "arguments">,
  repo: Pick<RepoContext, "owner" | "repo" | "branch">,
  /** Where the read resolves from; omit only when the caller has no thread */
  view?: ReadView | null
): string | null {
  if (!isToolCacheable(call.name)) return null;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  const parts: string[] = [repo.owner, repo.repo, repo.branch, call.name];
  // Canonical arg order: sorted keys, compact JSON
  const sortedArgs = Object.keys(args)
    .sort()
    .map((k) => `${k}=${String(args[k])}`);
  parts.push(...sortedArgs);
  // Appended rather than prepended, because `clearToolCacheForRepo` drops
  // entries by the `owner|repo|` prefix this key starts with. `#view` cannot be
  // produced by an argument (arguments are `key=value` pairs, and no tool has an
  // argument named `#view`), so the marker cannot be forged by tool input.
  if (view) parts.push(`#view=${view.bindingId ?? "-"}@${view.workspaceUpdatedAt ?? "-"}`);
  return parts.join("|");
}

/** Peeks without LRU touch (used by tests/debug) */
export function peekToolCache(key: string): ToolCallResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

/** Looks up a cached result, touching LRU order */
export function lookupToolCache(key: string | null): ToolCallResult | null {
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  entry.lastUsedAt = ++clock;
  return entry.result;
}

/** Stores a successful tool result (failures are never cached) */
export function storeToolCache(key: string | null, result: ToolCallResult): void {
  if (!key) return;
  if (!result.ok) return;
  cache.set(key, { result, at: Date.now(), lastUsedAt: ++clock });
  if (cache.size > MAX_ENTRIES) {
    // Evict least-recently-used
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of cache) {
      if (v.lastUsedAt < oldest) {
        oldest = v.lastUsedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
}

/** Drops the whole cache (branch switch, repo change, debugging) */
export function clearToolCache(): void {
  cache.clear();
  clock = 0;
}

/**
 * Drops every entry read from one repository.
 *
 * The key is (owner, repo, branch, tool, args) and carries no base commit, so a
 * push that moves the branch head leaves results describing the PARENT commit
 * that would still be served as current — a cached file read is a read of code
 * that is no longer there. The separator is the `|` this module's keys use, and
 * GitHub owner/repo names cannot contain one.
 */
export function clearToolCacheForRepo(repo: Pick<RepoContext, "owner" | "repo">): void {
  const prefix = `${repo.owner}|${repo.repo}|`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Scoped by REPOSITORY, because that is what its keys are: a result read from a
 * repository is the same result for every thread on it, and stays valid across a
 * thread moving between repositories. What it cannot survive is the repository
 * changing underneath it, which is what `base.moved` means.
 */
registerScopedResource({
  name: "tool-cache.results",
  scope: "repo",
  release: ({ transition }) => {
    if (transition.type === "base.moved" && transition.ref) {
      clearToolCacheForRepo(transition.ref);
    }
  },
});

/** Current cache size (debug/telemetry) */
export function toolCacheSize(): number {
  return cache.size;
}
