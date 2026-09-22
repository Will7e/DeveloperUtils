// ============================================================
// Module Cache — Sharing Package Sources Across Builds
// ============================================================
// Safe because a module URL is already a content identity: the graph keys
// modules by the POST-REDIRECT url for exactly that reason, so that two
// specifiers resolving to one build become one module instance (one React).
// Caching by that URL adds no assumption the graph does not already make.
//
// What these tests pin is that both ends of the chain are cached — the URL a
// build asks for, and the URL the bytes actually came from, because a
// module's own relative imports resolve against the latter.

import { beforeEach, describe, expect, it } from "vitest";
import {
  getCachedModule,
  moduleCacheSize,
  rememberModule,
  resetModuleCache,
} from "./module-cache";

const REQUESTED = "https://esm.sh/react@19.3.0";
const FINAL = "https://esm.sh/v135/react@19.3.0/es2022/react.mjs";

beforeEach(() => {
  resetModuleCache();
});

describe("module cache", () => {
  it("answers the URL that was requested and the URL it came from", () => {
    rememberModule(REQUESTED, { source: "export const x = 1;", finalUrl: FINAL });

    expect(getCachedModule(REQUESTED)?.finalUrl).toBe(FINAL);
    // A rebuild that starts from the redirected URL — or from a package whose
    // relative import names it — must hit too, not re-fetch the same bytes.
    expect(getCachedModule(FINAL)?.source).toBe("export const x = 1;");
  });

  it("misses cleanly for a module nothing has fetched", () => {
    expect(getCachedModule("https://esm.sh/never-used@1.0.0")).toBeNull();
  });

  it("keeps identity: one module, however many URLs name it", () => {
    rememberModule(REQUESTED, { source: "one", finalUrl: FINAL });
    rememberModule(REQUESTED, { source: "two", finalUrl: FINAL });
    expect(getCachedModule(REQUESTED)?.source).toBe("two");
    // Two KEYS (requested and final) that resolve to one module object — the
    // same identity the graph relies on for a single React instance.
    expect(moduleCacheSize()).toBe(2);
    expect(getCachedModule(REQUESTED)).toBe(getCachedModule(FINAL));
  });

  it("stays bounded, dropping the oldest entries first", () => {
    // A session previews many apps; an unbounded map of package sources is a
    // leak in a tab that stays open all day.
    for (let i = 0; i < 900; i++) {
      rememberModule(`https://esm.sh/pkg-${i}@1.0.0`, {
        source: `export const n = ${i};`,
        finalUrl: `https://esm.sh/pkg-${i}@1.0.0/es2022/pkg.mjs`,
      });
    }
    expect(moduleCacheSize()).toBeLessThanOrEqual(800);
    // The newest are kept, and the very oldest is gone.
    expect(getCachedModule("https://esm.sh/pkg-899@1.0.0")).not.toBeNull();
    expect(getCachedModule("https://esm.sh/pkg-0@1.0.0")).toBeNull();
  });

  it("treats a read as a use, so a module every build needs is not evicted", () => {
    const hot = "https://esm.sh/hot@1.0.0";
    rememberModule(hot, { source: "hot", finalUrl: "https://esm.sh/hot.mjs" });

    // Far more cold modules arrive than the cache can hold, but each round a
    // build reads the hot one — which is the case that matters: React is
    // asked for by every build, and evicting it is exactly the re-download
    // this cache exists to prevent.
    for (let i = 0; i < 600; i++) {
      rememberModule(`https://esm.sh/cold-${i}@1.0.0`, {
        source: "cold",
        finalUrl: `https://esm.sh/cold-${i}.mjs`,
      });
      expect(getCachedModule(hot)).not.toBeNull();
    }

    // Once nothing read it for long enough, it does go — a cache that never
    // forgets is a leak, not a cache.
    for (let i = 0; i < 900; i++) {
      rememberModule(`https://esm.sh/colder-${i}@1.0.0`, {
        source: "colder",
        finalUrl: `https://esm.sh/colder-${i}.mjs`,
      });
    }
    expect(getCachedModule(hot)).toBeNull();
  });
});
