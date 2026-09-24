// ============================================================
// Dependency Cache — Install Once Per Lockfile, Not Once Per Task
// ============================================================
// Every conversation gets its own throwaway tree, and the tree is the point: a
// command must never run in the user's checkout, and two chats must not see each
// other's files. The cost of that isolation was that each tree installed its own
// `node_modules` — so the second task on a repository paid the full `npm install`
// again, and trees were capped at three because three copies of a large
// dependency tree is not small.
//
// The observation that makes caching safe here is that `node_modules` is a pure
// FUNCTION of the lockfile (plus the registry, which is the same for both
// installs). Two trees with byte-identical lockfiles resolve to byte-identical
// dependency trees, so one install can serve both — and the lockfile hash is a
// content address for it, which means the cache cannot go stale in the way a
// cache keyed by branch or by timestamp always eventually does.
//
// Two operations, both conservative:
//
//   ADOPT   — before a command runs in a tree with no `node_modules`, if the
//             cache holds one for this lockfile, copy it in. Skipped entirely
//             when the tree already has one, so a real install always wins over
//             a cached guess about what the install would have produced.
//   PROMOTE — after a command ran and the tree DOES have a `node_modules` the
//             cache does not, copy it into the cache. This is why there is no
//             install hook to write: whatever the project's own install step
//             did, in whatever package manager, is captured by observing the
//             result rather than by predicting the command.
//
// Copies rather than links, deliberately. Hardlinking `node_modules` would be
// near-free and is the obvious next step, but it makes the cached entry mutable
// through the tree that adopted it — a dependency the agent installs into one
// task would silently appear in every later task on the same lockfile. A copy
// cannot leak that way, and this module's whole value is that adopting it can
// never change what a command sees.

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Lockfiles we can key on, in preference order.
 *
 * A project with no lockfile gets no cache at all rather than a best-effort
 * guess: without one, "the same dependencies" is an assumption about what the
 * registry would resolve today, and adopting a stale tree would make a
 * verification pass against dependencies the project no longer asks for.
 */
export const LOCKFILE_NAMES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

/** Max cached dependency trees kept; each one is large. */
export const DEFAULT_CACHE_ENTRIES = 4;

/** A lockfile's identity, as a directory name that is safe on every platform. */
export function cacheKeyFor(
  lockfile: { name: string; content: string } | null | undefined
): string | null {
  if (!lockfile || !lockfile.name) return null;
  const hash = createHash("sha256");
  hash.update(lockfile.name);
  hash.update("\0");
  // Content, not size or mtime: identical dependencies must collide and an
  // edited lockfile must not.
  hash.update(lockfile.content);
  return hash.digest("hex").slice(0, 16);
}

/** Where one keyed entry lives inside the cache root. */
export function cacheEntryDir(cacheRoot: string, key: string): string {
  return join(cacheRoot, key);
}

/** The entry's `node_modules`, which is what actually gets copied. */
export function cacheModulesDir(cacheRoot: string, key: string): string {
  return join(cacheEntryDir(cacheRoot, key), "node_modules");
}

/**
 * Reads the tree's lockfile and derives its key, or null when there is none.
 * Unreadable counts as absent: a cache is an optimisation and must never be the
 * reason a command did not run.
 */
export async function readLockfileKey(treeRoot: string): Promise<string | null> {
  for (const name of LOCKFILE_NAMES) {
    try {
      const content = await readFile(join(treeRoot, name), "utf8");
      return cacheKeyFor({ name, content });
    } catch {
      continue;
    }
  }
  return null;
}

async function hasModules(dir: string): Promise<boolean> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return false;
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

export interface DependencyCacheOutcome {
  /** True when the operation changed something on disk */
  changed: boolean;
  /** Why it did nothing, for the log and the tool result */
  reason?: string;
}

/**
 * Populate a tree's `node_modules` from the cache, when it has none.
 *
 * Never overwrites: a tree that already has dependencies is left alone, because
 * the only way that happens is that something installed them, and a real install
 * outranks a cache entry derived from a different run of the same lockfile.
 */
export async function adoptCachedModules(params: {
  cacheRoot: string;
  treeRoot: string;
  key: string | null;
}): Promise<DependencyCacheOutcome> {
  const { cacheRoot, treeRoot, key } = params;
  if (!key) return { changed: false, reason: "no lockfile to key the cache on" };

  const modules = join(treeRoot, "node_modules");
  if (await hasModules(modules)) {
    return { changed: false, reason: "the tree already has dependencies" };
  }
  const cached = cacheModulesDir(cacheRoot, key);
  if (!(await hasModules(cached))) {
    return { changed: false, reason: "nothing cached for this lockfile yet" };
  }

  try {
    await cp(cached, modules, { recursive: true, dereference: false });
    return { changed: true };
  } catch (err) {
    // A cache that cannot be copied is a slow task, not a failed one: the
    // project's own install still runs and still works.
    return {
      changed: false,
      reason: `could not adopt the cached dependencies: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Save a tree's `node_modules` under its lockfile key, when the cache lacks one.
 *
 * Called after commands rather than before, so it captures whatever install
 * actually happened. A tree whose lockfile changed mid-task simply stores under
 * the new key, which is correct: the dependencies in it match that lockfile.
 */
export async function promoteModules(params: {
  cacheRoot: string;
  treeRoot: string;
  key: string | null;
}): Promise<DependencyCacheOutcome> {
  const { cacheRoot, treeRoot, key } = params;
  if (!key) return { changed: false, reason: "no lockfile to key the cache on" };

  const modules = join(treeRoot, "node_modules");
  if (!(await hasModules(modules))) {
    return { changed: false, reason: "the tree has no dependencies to cache" };
  }
  const cached = cacheModulesDir(cacheRoot, key);
  if (await hasModules(cached)) {
    return { changed: false, reason: "already cached for this lockfile" };
  }

  try {
    await mkdir(cacheEntryDir(cacheRoot, key), { recursive: true });
    await cp(modules, cached, { recursive: true, dereference: false });
    return { changed: true };
  } catch (err) {
    return {
      changed: false,
      reason: `could not cache the dependencies: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Keep the newest N entries, delete the rest.
 *
 * Recency comes from each entry's mtime rather than from a bookkeeping file:
 * the entry directory is written when it is promoted, so its own timestamp IS
 * the last time it was useful, and a sidecar index would be one more thing that
 * can disagree with the disk.
 */
export async function pruneDependencyCache(
  cacheRoot: string,
  maxEntries: number = DEFAULT_CACHE_ENTRIES
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(cacheRoot);
  } catch {
    return [];
  }

  const entries: Array<{ name: string; at: number }> = [];
  for (const name of names) {
    try {
      const info = await stat(join(cacheRoot, name));
      if (info.isDirectory()) entries.push({ name, at: info.mtimeMs });
    } catch {
      continue;
    }
  }
  if (entries.length <= maxEntries) return [];

  entries.sort((a, b) => b.at - a.at);
  const evicted: string[] = [];
  for (const entry of entries.slice(maxEntries)) {
    try {
      await rm(join(cacheRoot, entry.name), { recursive: true, force: true });
      evicted.push(entry.name);
    } catch {
      continue;
    }
  }
  return evicted;
}
