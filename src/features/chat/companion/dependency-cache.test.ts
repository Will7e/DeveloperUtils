// ============================================================
// Dependency Cache — One Install Serves Every Tree On That Lockfile
// ============================================================
// The property that matters is that adopting a cached tree can never change what
// a command sees. Two cases decide it:
//
//   • a tree that already installed something is never overwritten, and
//   • a lockfile that changed keys to a different entry, so a stale tree is
//     never handed to code that no longer asks for those dependencies.
//
// Real files, real directories. The failure mode this guards against is a copy
// that silently half-succeeds, and a mocked fs would not produce one.
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptCachedModules,
  cacheEntryDir,
  cacheKeyFor,
  cacheModulesDir,
  promoteModules,
  pruneDependencyCache,
  readLockfileKey,
} from "./dependency-cache";

const roots: string[] = [];

async function tempRoot(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `intab-depcache-${label}-`));
  roots.push(dir);
  return dir;
}

/** A tree with a lockfile and (optionally) an installed dependency tree */
async function makeTree(
  root: string,
  options: { lock?: string; lockfile?: string; withModules?: boolean; marker?: string }
): Promise<void> {
  await mkdir(root, { recursive: true });
  if (options.lock !== undefined) {
    await writeFile(join(root, options.lockfile ?? "package-lock.json"), options.lock, "utf8");
  }
  if (options.withModules) {
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "left-pad", "index.js"),
      options.marker ?? "module.exports = 1;\n",
      "utf8"
    );
  }
}

afterEach(async () => {
  for (const dir of roots.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("cacheKeyFor", () => {
  it("collides on identical lockfiles and separates on different ones", () => {
    const a = cacheKeyFor({ name: "package-lock.json", content: "{ \"v\": 1 }" });
    const b = cacheKeyFor({ name: "package-lock.json", content: "{ \"v\": 1 }" });
    const c = cacheKeyFor({ name: "package-lock.json", content: "{ \"v\": 2 }" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("separates the same content under different lockfile names", () => {
    // pnpm and npm lockfiles of identical bytes do not describe identical
    // installs, and sharing an entry between them would be a silent mismatch.
    const npm = cacheKeyFor({ name: "package-lock.json", content: "x" });
    const pnpm = cacheKeyFor({ name: "pnpm-lock.yaml", content: "x" });
    expect(npm).not.toBe(pnpm);
  });

  it("has no key without a lockfile", () => {
    expect(cacheKeyFor(null)).toBeNull();
    expect(cacheKeyFor({ name: "", content: "x" })).toBeNull();
  });

  it("produces a name that is safe on every platform", () => {
    const key = cacheKeyFor({ name: "package-lock.json", content: "x" })!;
    expect(key).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("readLockfileKey", () => {
  it("keys on the lockfile the tree holds", async () => {
    const tree = await tempRoot("read");
    await makeTree(tree, { lock: "{ \"name\": \"a\" }" });
    const key = await readLockfileKey(tree);
    expect(key).toBe(cacheKeyFor({ name: "package-lock.json", content: "{ \"name\": \"a\" }" }));
  });

  it("returns null for a project with no lockfile rather than guessing", async () => {
    // Without a lockfile, "the same dependencies" is an assumption about what
    // the registry resolves today. Adopting on that assumption is how a
    // verification passes against dependencies the project no longer asks for.
    const tree = await tempRoot("nokey");
    await makeTree(tree, {});
    expect(await readLockfileKey(tree)).toBeNull();
  });

  it("prefers package-lock.json over a stray yarn.lock", async () => {
    const tree = await tempRoot("prefer");
    await makeTree(tree, { lock: "npm-lock", lockfile: "package-lock.json" });
    await writeFile(join(tree, "yarn.lock"), "yarn-lock", "utf8");
    expect(await readLockfileKey(tree)).toBe(
      cacheKeyFor({ name: "package-lock.json", content: "npm-lock" })
    );
  });
});

describe("adoptCachedModules", () => {
  it("populates a fresh tree from the cache, keyed by its own lockfile", async () => {
    const cache = await tempRoot("adopt-cache");
    const seed = await tempRoot("adopt-seed");
    const fresh = await tempRoot("adopt-fresh");
    const lock = "{ \"name\": \"seeded\" }";

    await makeTree(seed, { lock, withModules: true, marker: "cached();\n" });
    const key = await readLockfileKey(seed);
    await promoteModules({ cacheRoot: cache, treeRoot: seed, key });

    await makeTree(fresh, { lock });
    const outcome = await adoptCachedModules({ cacheRoot: cache, treeRoot: fresh, key });

    expect(outcome.changed).toBe(true);
    expect(await readFile(join(fresh, "node_modules", "left-pad", "index.js"), "utf8")).toBe("cached();\n");
  });

  it("never overwrites a tree that already has its own dependencies", async () => {
    // The only way this happens is that something installed them, and a real
    // install outranks a cache entry derived from a different run.
    const cache = await tempRoot("keep-cache");
    const tree = await tempRoot("keep-tree");
    const lock = "{ \"name\": \"keep\" }";
    await makeTree(tree, { lock, withModules: true, marker: "mine();\n" });
    const key = await readLockfileKey(tree);
    await promoteModules({ cacheRoot: cache, treeRoot: tree, key });

    // The tree's own copy is now something else — as if the agent edited it.
    await writeFile(join(tree, "node_modules", "left-pad", "index.js"), "mine();\n", "utf8");
    const outcome = await adoptCachedModules({ cacheRoot: cache, treeRoot: tree, key });

    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/already has dependencies/);
    expect(await readFile(join(tree, "node_modules", "left-pad", "index.js"), "utf8")).toBe("mine();\n");
  });

  it("does nothing, and says so, when nothing is cached for the lockfile", async () => {
    const cache = await tempRoot("empty-cache");
    const tree = await tempRoot("empty-tree");
    await makeTree(tree, { lock: "{ \"name\": \"uncached\" }" });
    const key = await readLockfileKey(tree);
    const outcome = await adoptCachedModules({ cacheRoot: cache, treeRoot: tree, key });

    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/nothing cached/);
  });

  it("is inert without a key, because the cache is an optimisation", async () => {
    const cache = await tempRoot("nokey-cache");
    const tree = await tempRoot("nokey-tree");
    const outcome = await adoptCachedModules({ cacheRoot: cache, treeRoot: tree, key: null });
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/no lockfile/);
  });
});

describe("promoteModules", () => {
  it("stores what the project's own install produced", async () => {
    const cache = await tempRoot("prom-cache");
    const tree = await tempRoot("prom-tree");
    await makeTree(tree, { lock: "{ \"name\": \"prom\" }", withModules: true });
    const key = await readLockfileKey(tree);

    const first = await promoteModules({ cacheRoot: cache, treeRoot: tree, key });
    expect(first.changed).toBe(true);
    // The cache holds the modules, not the whole tree: the lockfile and sources
    // are per-tree facts, and copying them would make an entry look like a
    // checkout.
    expect((await stat(cacheModulesDir(cache, key!))).isDirectory()).toBe(true);
    await expect(stat(join(cacheEntryDir(cache, key!), "package-lock.json"))).rejects.toThrow();
  });

  it("does not re-copy an entry that is already cached", async () => {
    const cache = await tempRoot("prom2-cache");
    const tree = await tempRoot("prom2-tree");
    await makeTree(tree, { lock: "{ \"name\": \"prom2\" }", withModules: true });
    const key = await readLockfileKey(tree);
    await promoteModules({ cacheRoot: cache, treeRoot: tree, key });

    const second = await promoteModules({ cacheRoot: cache, treeRoot: tree, key });
    expect(second.changed).toBe(false);
    expect(second.reason).toMatch(/already cached/);
  });

  it("stores nothing when the command ran before any install", async () => {
    const cache = await tempRoot("prom3-cache");
    const tree = await tempRoot("prom3-tree");
    await makeTree(tree, { lock: "{ \"name\": \"prom3\" }" });
    const key = await readLockfileKey(tree);
    const outcome = await promoteModules({ cacheRoot: cache, treeRoot: tree, key });
    expect(outcome.changed).toBe(false);
    expect(outcome.reason).toMatch(/no dependencies to cache/);
  });

  it("uses a different entry once the lockfile changes", async () => {
    // The correctness property: a dependency tree can never be adopted under a
    // lockfile it was not installed for.
    const cache = await tempRoot("prom4-cache");
    const tree = await tempRoot("prom4-tree");
    await makeTree(tree, { lock: "{ \"v\": 1 }", withModules: true });
    const before = await readLockfileKey(tree);
    await promoteModules({ cacheRoot: cache, treeRoot: tree, key: before });

    await writeFile(join(tree, "package-lock.json"), "{ \"v\": 2 }", "utf8");
    const after = await readLockfileKey(tree);
    expect(after).not.toBe(before);
    expect(await promoteModules({ cacheRoot: cache, treeRoot: tree, key: after })).toMatchObject({
      changed: true,
    });
  });
});

describe("pruneDependencyCache", () => {
  it("keeps the most recently used entries and evicts the rest", async () => {
    const cache = await tempRoot("prune");
    const names = ["aaaa", "bbbb", "cccc"];
    for (const [index, name] of names.entries()) {
      await mkdir(join(cache, name), { recursive: true });
      // Explicit mtimes rather than sleeps: the ordering must be the thing
      // under test, not the clock's resolution.
      const at = 1_700_000_000 + index * 60;
      await utimes(join(cache, name), at, at);
    }

    const evicted = await pruneDependencyCache(cache, 2);
    expect(evicted).toEqual(["aaaa"]);
    await expect(stat(join(cache, "aaaa"))).rejects.toThrow();
    expect((await stat(join(cache, "cccc"))).isDirectory()).toBe(true);
  });

  it("does nothing at or under the limit", async () => {
    const cache = await tempRoot("prune-none");
    await mkdir(join(cache, "aaaa"), { recursive: true });
    expect(await pruneDependencyCache(cache, 2)).toEqual([]);
  });

  it("tolerates a cache root that does not exist yet", async () => {
    const missing = join(await tempRoot("prune-missing"), "not-created");
    expect(await pruneDependencyCache(missing)).toEqual([]);
  });
});
