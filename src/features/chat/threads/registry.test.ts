import { describe, expect, it } from "vitest";
import {
  MAX_THREADS,
  acceptRemote,
  claimPaths,
  conflictsFor,
  emptyRegistry,
  expireClaims,
  isStale,
  normalizePath,
  parseRegistry,
  pathsOverlap,
  releasePaths,
  removeThread,
  upsertThread,
  type AgentThread,
  type ThreadRegistry,
} from "./registry";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

function draft(overrides: Partial<AgentThread> = {}) {
  return {
    threadId: "thread-a",
    label: "Fix auth",
    tabId: "tab-1",
    deviceId: "dev-1",
    owner: "acme",
    repo: "app",
    branch: "intab/auth-20260922",
    base: "main",
    intent: "Repair the redirect loop",
    status: "editing" as const,
    ...overrides,
  };
}

function withThreads(...drafts: Array<Partial<AgentThread>>): ThreadRegistry {
  return drafts.reduce((acc, d, i) => upsertThread(acc, draft(d), T0 + i), emptyRegistry());
}

describe("normalizePath", () => {
  it("accepts repo-relative paths and strips decoration", () => {
    expect(normalizePath("src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("/src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("src//a.ts")).toBe("src/a.ts");
    expect(normalizePath("src\\a\\b.ts")).toBe("src/a/b.ts");
    expect(normalizePath("src/chat/")).toBe("src/chat/");
  });

  it("rejects paths a claim cannot be scoped to", () => {
    expect(normalizePath("")).toBeNull();
    expect(normalizePath("   ")).toBeNull();
    expect(normalizePath(".")).toBeNull();
    expect(normalizePath("../outside.ts")).toBeNull();
    expect(normalizePath("src/../../etc/passwd")).toBeNull();
    expect(normalizePath("a".repeat(500))).toBeNull();
  });

  it("rejects non-strings without throwing", () => {
    expect(normalizePath(undefined as unknown as string)).toBeNull();
    expect(normalizePath(42 as unknown as string)).toBeNull();
  });
});

describe("pathsOverlap", () => {
  it("matches identical paths", () => {
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src/b.ts")).toBe(false);
  });

  it("lets a directory claim cover its contents in both directions", () => {
    expect(pathsOverlap("src/", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/features/", "src/")).toBe(true);
    expect(pathsOverlap("src/features/chat/", "src/features/chat/x.ts")).toBe(true);
  });

  it("does not confuse a prefix with a path boundary", () => {
    // "src/chat" as an exact path must not cover "src/chatty/x.ts".
    expect(pathsOverlap("src/chat", "src/chatty/x.ts")).toBe(false);
  });
});

describe("upsertThread", () => {
  it("bumps epoch monotonically and stamps the heartbeat", () => {
    const first = upsertThread(emptyRegistry(), draft(), T0);
    const second = upsertThread(first, draft({ status: "verifying" }), T0 + MINUTE);
    const thread = second.threads["thread-a"]!;
    expect(thread.epoch).toBe(2);
    expect(thread.status).toBe("verifying");
    expect(thread.heartbeatAt).toBe(T0 + MINUTE);
    expect(second.revision).toBeGreaterThan(first.revision);
  });

  it("keeps claims across an update that does not mention them", () => {
    const claimed = claimPaths(withThreads({}), {
      threadId: "thread-a",
      paths: ["src/a.ts"],
      now: T0,
    }).registry;
    const updated = upsertThread(claimed, draft({ label: "renamed" }), T0 + MINUTE);
    expect(updated.threads["thread-a"]!.claims.map((c) => c.path)).toEqual(["src/a.ts"]);
  });

  it("clamps strings so a malformed peer cannot bloat the doc", () => {
    const registry = upsertThread(emptyRegistry(), draft({ intent: "x".repeat(1000) }), T0);
    expect(registry.threads["thread-a"]!.intent.length).toBe(200);
  });

  it("ignores a draft without an id", () => {
    const registry = upsertThread(emptyRegistry(), draft({ threadId: "" }), T0);
    expect(Object.keys(registry.threads)).toHaveLength(0);
  });

  it("evicts the least recently heard-from thread at the cap", () => {
    let registry: ThreadRegistry = emptyRegistry();
    for (let i = 0; i < MAX_THREADS; i++) {
      registry = upsertThread(registry, draft({ threadId: `t${i}` }), T0 + i * 1000);
    }
    expect(Object.keys(registry.threads)).toHaveLength(MAX_THREADS);

    registry = upsertThread(registry, draft({ threadId: "fresh" }), T0 + 500_000);
    expect(Object.keys(registry.threads)).toHaveLength(MAX_THREADS);
    expect(registry.threads["fresh"]).toBeDefined();
    expect(registry.threads["t0"]).toBeUndefined();
  });
});

describe("claimPaths", () => {
  it("grants a free path", () => {
    const outcome = claimPaths(withThreads({}), {
      threadId: "thread-a",
      paths: ["src/a.ts"],
      now: T0,
    });
    expect(outcome.granted).toEqual(["src/a.ts"]);
    expect(outcome.conflicts).toHaveLength(0);
    expect(outcome.registry.threads["thread-a"]!.claims[0]!.expiresAt).toBeGreaterThan(T0);
  });

  it("refuses a path another thread holds", () => {
    const registry = withThreads({}, { threadId: "thread-b", label: "Refactor" });
    const first = claimPaths(registry, {
      threadId: "thread-b",
      paths: ["src/a.ts"],
      now: T0,
    }).registry;
    const second = claimPaths(first, { threadId: "thread-a", paths: ["src/a.ts"], now: T0 + 1000 });

    expect(second.granted).toEqual([]);
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]!.heldBy).toBe("thread-b");
    expect(second.conflicts[0]!.heldByLabel).toBe("Refactor");
  });

  it("treats a directory claim as covering its files, in both directions", () => {
    const registry = withThreads({}, { threadId: "thread-b" });
    const held = claimPaths(registry, {
      threadId: "thread-b",
      paths: ["src/features/chat/"],
      now: T0,
    }).registry;

    const fileRequest = claimPaths(held, {
      threadId: "thread-a",
      paths: ["src/features/chat/ChatPage.tsx"],
      now: T0,
    });
    expect(fileRequest.granted).toEqual([]);
    expect(fileRequest.conflicts[0]!.path).toBe("src/features/chat/ChatPage.tsx");

    const dirRequest = claimPaths(held, {
      threadId: "thread-a",
      paths: ["src/features/"],
      now: T0,
    });
    expect(dirRequest.granted).toEqual([]);
  });

  it("grants the free paths and reports only the taken ones", () => {
    const registry = withThreads({}, { threadId: "thread-b" });
    const held = claimPaths(registry, { threadId: "thread-b", paths: ["src/a.ts"], now: T0 }).registry;
    const outcome = claimPaths(held, {
      threadId: "thread-a",
      paths: ["src/a.ts", "src/b.ts"],
      now: T0,
    });
    expect(outcome.granted).toEqual(["src/b.ts"]);
    expect(outcome.conflicts.map((c) => c.path)).toEqual(["src/a.ts"]);
  });

  it("lets a thread renew its own claim without conflicting with itself", () => {
    const first = claimPaths(withThreads({}), {
      threadId: "thread-a",
      paths: ["src/a.ts"],
      now: T0,
    });
    const second = claimPaths(first.registry, {
      threadId: "thread-a",
      paths: ["src/a.ts"],
      now: T0 + MINUTE,
    });
    expect(second.granted).toEqual(["src/a.ts"]);
    expect(second.registry.threads["thread-a"]!.claims).toHaveLength(1);
    expect(second.registry.threads["thread-a"]!.claims[0]!.expiresAt).toBeGreaterThanOrEqual(
      T0 + MINUTE
    );
  });

  it("ignores an expired claim from another thread", () => {
    const registry = withThreads({}, { threadId: "thread-b" });
    const held = claimPaths(registry, {
      threadId: "thread-b",
      paths: ["src/a.ts"],
      ttlMs: 1000,
      now: T0,
    }).registry;
    const later = claimPaths(held, { threadId: "thread-a", paths: ["src/a.ts"], now: T0 + 5000 });
    expect(later.granted).toEqual(["src/a.ts"]);
    expect(later.registry.threads["thread-b"]!.claims).toHaveLength(0);
  });

  it("caps TTL so a claim cannot outlive a stale heartbeat", () => {
    const outcome = claimPaths(withThreads({}), {
      threadId: "thread-a",
      paths: ["src/a.ts"],
      ttlMs: 10 * 60 * MINUTE,
      now: T0,
    });
    expect(outcome.registry.threads["thread-a"]!.claims[0]!.expiresAt).toBeLessThanOrEqual(
      T0 + 10 * MINUTE
    );
  });

  it("grants nothing for an unregistered thread, without throwing", () => {
    const outcome = claimPaths(emptyRegistry(), {
      threadId: "ghost",
      paths: ["src/a.ts"],
      now: T0,
    });
    expect(outcome.granted).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
  });

  it("caps how many paths one request may claim", () => {
    const paths = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    const outcome = claimPaths(withThreads({}), { threadId: "thread-a", paths, now: T0 });
    expect(outcome.granted.length).toBe(64);
  });

  it("drops unnormalizable paths from a request instead of claiming them", () => {
    const outcome = claimPaths(withThreads({}), {
      threadId: "thread-a",
      paths: ["../evil", "", "src/ok.ts"],
      now: T0,
    });
    expect(outcome.granted).toEqual(["src/ok.ts"]);
  });

  it("does not mutate the input registry", () => {
    const registry = withThreads({});
    const before = JSON.stringify(registry);
    claimPaths(registry, { threadId: "thread-a", paths: ["src/a.ts"], now: T0 });
    expect(JSON.stringify(registry)).toBe(before);
  });
});

describe("releasePaths / expireClaims / removeThread", () => {
  it("releases every claim when no paths are given", () => {
    const claimed = claimPaths(withThreads({}), {
      threadId: "thread-a",
      paths: ["src/a.ts", "src/b.ts"],
      now: T0,
    }).registry;
    const released = releasePaths(claimed, "thread-a");
    expect(released.threads["thread-a"]!.claims).toHaveLength(0);
  });

  it("releases a subset", () => {
    const claimed = claimPaths(withThreads({}), {
      threadId: "thread-a",
      paths: ["src/a.ts", "src/b.ts"],
      now: T0,
    }).registry;
    const released = releasePaths(claimed, "thread-a", ["src/a.ts"]);
    expect(released.threads["thread-a"]!.claims.map((c) => c.path)).toEqual(["src/b.ts"]);
  });

  it("is a no-op for an unknown thread or an unchanged set", () => {
    const registry = withThreads({});
    expect(releasePaths(registry, "ghost")).toBe(registry);
    expect(releasePaths(registry, "thread-a", ["src/never.ts"])).toBe(registry);
  });

  it("drops expired claims and bumps the revision only when something changed", () => {
    const claimed = claimPaths(withThreads({}), {
      threadId: "thread-a",
      paths: ["src/a.ts"],
      ttlMs: 1000,
      now: T0,
    }).registry;
    expect(expireClaims(claimed, T0).revision).toBe(claimed.revision);
    const expired = expireClaims(claimed, T0 + 10_000);
    expect(expired.revision).toBe(claimed.revision + 1);
    expect(expired.threads["thread-a"]!.claims).toHaveLength(0);
  });

  it("forgets a thread and its claims together", () => {
    const claimed = claimPaths(withThreads({}, { threadId: "thread-b" }), {
      threadId: "thread-a",
      paths: ["src/a.ts"],
      now: T0,
    }).registry;
    const pruned = removeThread(claimed, "thread-a");
    expect(pruned.threads["thread-a"]).toBeUndefined();
    // The freed path is immediately claimable by the other thread.
    const re = claimPaths(pruned, { threadId: "thread-b", paths: ["src/a.ts"], now: T0 });
    expect(re.granted).toEqual(["src/a.ts"]);
  });
});

describe("conflictsFor / isStale", () => {
  it("reports only other threads' overlapping live claims", () => {
    const claimed = claimPaths(withThreads({}), {
      threadId: "thread-a",
      paths: ["src/a.ts"],
      now: T0,
    }).registry;
    expect(conflictsFor(claimed, { threadId: "thread-b", paths: ["src/a.ts"], now: T0 })).toHaveLength(1);
    expect(conflictsFor(claimed, { threadId: "thread-a", paths: ["src/a.ts"], now: T0 })).toHaveLength(0);
    expect(conflictsFor(claimed, { threadId: "thread-b", paths: ["src/z.ts"], now: T0 })).toHaveLength(0);
  });

  it("marks a thread stale after the heartbeat window", () => {
    const registry = withThreads({});
    const thread = registry.threads["thread-a"]!;
    expect(isStale(thread, T0 + MINUTE)).toBe(false);
    expect(isStale(thread, T0 + 11 * MINUTE)).toBe(true);
  });
});

describe("acceptRemote", () => {
  it("takes a strictly newer revision and rejects anything else", () => {
    const local = withThreads({});
    const newer = { ...local, revision: local.revision + 5 };
    expect(acceptRemote(local, newer).accepted).toBe(true);
    expect(acceptRemote(local, { ...local }).accepted).toBe(false);
    expect(acceptRemote(local, { ...local, revision: local.revision - 1 }).accepted).toBe(false);
  });
});

describe("parseRegistry", () => {
  it("reads a well-formed JSON string", () => {
    const registry = withThreads({});
    const parsed = parseRegistry(JSON.stringify(registry));
    expect(parsed?.threads["thread-a"]?.label).toBe("Fix auth");
  });

  it("returns null for junk instead of throwing", () => {
    expect(parseRegistry("not json")).toBeNull();
    expect(parseRegistry(null)).toBeNull();
    expect(parseRegistry(42)).toBeNull();
    expect(parseRegistry({})).toBeNull();
    expect(parseRegistry({ revision: "x", threads: {} })).toBeNull();
  });

  it("sanitizes a hostile peer message", () => {
    const parsed = parseRegistry({
      revision: 4,
      threads: {
        bad: {
          threadId: "bad",
          label: "ok",
          status: "definitely-not-a-status",
          epoch: "NaN",
          heartbeatAt: "soon",
          claims: [
            { path: "../../etc/passwd", expiresAt: T0 },
            { path: "src/ok.ts", expiresAt: T0 },
            { path: "src/no-expiry.ts" },
            "not-an-object",
          ],
        },
        "": { threadId: "" },
      },
    });

    expect(parsed).not.toBeNull();
    const thread = parsed!.threads["bad"]!;
    expect(thread.status).toBe("idle");
    expect(thread.epoch).toBe(0);
    expect(thread.heartbeatAt).toBe(0);
    expect(thread.claims.map((c) => c.path)).toEqual(["src/ok.ts"]);
    expect(thread.claims[0]!.threadId).toBe("bad");
    expect(Object.keys(parsed!.threads)).toEqual(["bad"]);
  });

  it("caps the number of threads it will accept", () => {
    const threads: Record<string, unknown> = {};
    for (let i = 0; i < MAX_THREADS + 20; i++) {
      threads[`t${i}`] = { threadId: `t${i}`, label: "x", claims: [] };
    }
    const parsed = parseRegistry({ revision: 1, threads });
    expect(Object.keys(parsed!.threads).length).toBe(MAX_THREADS);
  });
});
