// ============================================================
// Module Cache — Package Sources Are A Fact About The URL
// ============================================================
// A build used to fetch every package it needed, every time. The same React,
// the same lucide-react, the same Supabase — for every conversation, and for
// every rebuild within one. Opening a second chat on the same app therefore
// re-downloaded the entire dependency graph before the first pixel, which is
// most of what "switching chats is slow" was measuring.
//
// What makes sharing safe is that a module URL is already a CONTENT
// IDENTITY, and the graph depends on that: esm.sh's built paths carry a
// version and a format/encoding hash (`react@19.3.0/X-ZXJlYWN0/es2022/...`),
// and `FetchedModule.finalUrl` — the post-redirect URL — is what the graph
// keys modules by, precisely so two specifiers that resolve to one build
// become one module instance. Caching by that URL adds no new assumption; it
// extends an existing one across builds.
//
// Bounded on purpose. A session previews many apps, and an unbounded map of
// package sources is a memory leak in a tab that stays open all day. Eviction
// is insertion-ordered (oldest first), which is the right shape here: the
// modules a new build wants are the ones a recent build wanted.
// ============================================================

import type { FetchedModule } from "./graph";

/** Roughly a large app's dependency graph, in sources */
const MAX_ENTRIES = 800;

const cache = new Map<string, FetchedModule>();

/** Test seam */
export function resetModuleCache(): void {
  cache.clear();
}

/** How many modules are held (tests, and a coarse memory story) */
export function moduleCacheSize(): number {
  return cache.size;
}

/** The source fetched for this URL, if any build already fetched it */
export function getCachedModule(url: string): FetchedModule | null {
  const hit = cache.get(url);
  if (!hit) return null;
  // Re-insert to mark it most-recently-used
  cache.delete(url);
  cache.set(url, hit);
  return hit;
}

/**
 * Remembers a module under BOTH the URL that was requested and the URL it
 * finally came from.
 *
 * Both, because they are both asked for: the graph resolves specifiers to
 * requested URLs, while a module's own relative imports resolve against its
 * final URL — so a rebuild that starts from the other end of the chain must
 * still hit the cache rather than fetch the same bytes again.
 */
export function rememberModule(requestedUrl: string, module: FetchedModule): void {
  for (const key of new Set([requestedUrl, module.finalUrl])) {
    cache.delete(key);
    cache.set(key, module);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
