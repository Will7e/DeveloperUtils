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
// (repo, branch, tool, args) so a branch switch or repo re-attach
// invalidates cleanly.

import type { RepoContext, ToolCallRequest, ToolCallResult } from "../types";
import { isToolCacheable } from "./tool-registry";

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
 * Builds the cache key for a tool call. Unknown/unparseable
 * arguments — or a tool the registry marks non-cacheable — yield
 * null → not cacheable.
 */
export function toolCacheKey(
  call: Pick<ToolCallRequest, "name" | "arguments">,
  repo: Pick<RepoContext, "owner" | "repo" | "branch">
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

/** Current cache size (debug/telemetry) */
export function toolCacheSize(): number {
  return cache.size;
}
