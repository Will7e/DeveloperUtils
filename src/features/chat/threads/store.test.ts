import { beforeEach, describe, expect, it } from "vitest";
import { createThreadStore, type ThreadChannelLike, type ThreadStore } from "./store";
import type { AgentThread, ThreadRegistry } from "./registry";

const T0 = 1_700_000_000_000;

// ── Fakes: enough of the browser to exercise the coordination logic ──

/** A BroadcastChannel bus: every message reaches all other channels */
class FakeHub {
  private channels: FakeChannel[] = [];
  create(): FakeChannel {
    const channel = new FakeChannel(this);
    this.channels.push(channel);
    return channel;
  }
  fanOut(sender: FakeChannel, data: unknown): void {
    for (const channel of this.channels) {
      if (channel !== sender) channel.deliver(data);
    }
  }
  drop(channel: FakeChannel): void {
    this.channels = this.channels.filter((c) => c !== channel);
  }
}

class FakeChannel implements ThreadChannelLike {
  private listeners = new Set<(event: { data: unknown }) => void>();
  constructor(private hub: FakeHub) {}
  postMessage(data: unknown): void {
    this.hub.fanOut(this, data);
  }
  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.delete(listener);
  }
  deliver(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
  close(): void {
    this.hub.drop(this);
    this.listeners.clear();
  }
}

/** Shared key-value slot standing in for the encrypted IDB entry */
function createKv() {
  let value: string | null = null;
  return {
    read: async (): Promise<string | null> => value,
    write: async (next: string | null): Promise<void> => {
      value = next;
    },
  };
}

/**
 * Serializes callbacks across every store that shares it, like Web Locks
 * does across tabs. This is what makes the claim test meaningful.
 */
function createSharedLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(
      () => fn(),
      () => fn()
    );
    tail = run.catch(() => undefined);
    return run;
  };
}

let hub: FakeHub;
let kv: ReturnType<typeof createKv>;
let lock: ReturnType<typeof createSharedLock>;
let clock: number;

interface StoreOverrides {
  tabId: string;
  save?: (registry: ThreadRegistry) => Promise<void>;
}

function makeStore(overrides: StoreOverrides): ThreadStore {
  return createThreadStore({
    now: () => clock,
    tabId: overrides.tabId,
    deviceId: () => "dev-1",
    load: async () => {
      const raw = await kv.read();
      return raw ? (JSON.parse(raw) as ThreadRegistry) : null;
    },
    save: overrides.save ?? (async (registry) => kv.write(JSON.stringify(registry))),
    channel: () => hub.create(),
    withLock: lock,
  });
}

function draft(overrides: Partial<AgentThread> = {}): Omit<AgentThread, "epoch" | "heartbeatAt" | "claims"> {
  return {
    threadId: "thread-a",
    label: "Fix auth",
    tabId: "tab-1",
    deviceId: "dev-1",
    owner: "acme",
    repo: "app",
    branch: "intab/auth-1",
    base: "main",
    intent: "Repair the redirect loop",
    status: "editing",
    ...overrides,
  };
}

beforeEach(() => {
  hub = new FakeHub();
  kv = createKv();
  lock = createSharedLock();
  clock = T0;
});

describe("claim arbitration across tabs", () => {
  it("grants a path to the first thread and refuses the second", async () => {
    const a = makeStore({ tabId: "tab-a" });
    const b = makeStore({ tabId: "tab-b" });
    a.attach({ threadId: "ta" });
    b.attach({ threadId: "tb" });
    await a.upsertThread(draft({ threadId: "ta", label: "A" }));
    await b.upsertThread(draft({ threadId: "tb", label: "B" }));

    const first = await a.claimPaths(["src/shared.ts"]);
    expect(first.granted).toEqual(["src/shared.ts"]);

    // The second tab reads the persisted copy inside the lock, so it sees
    // the claim the first tab just wrote — this is the whole point.
    const second = await b.claimPaths(["src/shared.ts"]);
    expect(second.granted).toEqual([]);
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]!.heldBy).toBe("ta");
    expect(second.conflicts[0]!.heldByLabel).toBe("A");

    a.dispose();
    b.dispose();
  });

  it("frees the path when the holder releases it", async () => {
    const a = makeStore({ tabId: "tab-a" });
    const b = makeStore({ tabId: "tab-b" });
    a.attach({ threadId: "ta" });
    b.attach({ threadId: "tb" });
    await a.upsertThread(draft({ threadId: "ta" }));
    await b.upsertThread(draft({ threadId: "tb" }));

    await a.claimPaths(["src/shared.ts"]);
    await a.releasePaths();
    const outcome = await b.claimPaths(["src/shared.ts"]);
    expect(outcome.granted).toEqual(["src/shared.ts"]);

    a.dispose();
    b.dispose();
  });

  it("frees the path when the claim expires", async () => {
    const a = makeStore({ tabId: "tab-a" });
    const b = makeStore({ tabId: "tab-b" });
    a.attach({ threadId: "ta" });
    b.attach({ threadId: "tb" });
    await a.upsertThread(draft({ threadId: "ta" }));
    await b.upsertThread(draft({ threadId: "tb" }));

    await a.claimPaths(["src/shared.ts"], { ttlMs: 1000 });
    clock = T0 + 5000;
    const outcome = await b.claimPaths(["src/shared.ts"]);
    expect(outcome.granted).toEqual(["src/shared.ts"]);

    a.dispose();
    b.dispose();
  });
});

describe("awareness fan-out", () => {
  it("adopts a peer's newer registry through the channel", async () => {
    const a = makeStore({ tabId: "tab-a" });
    const b = makeStore({ tabId: "tab-b" });
    await a.upsertThread(draft({ threadId: "ta", label: "From A" }));

    // The broadcast is synchronous in this fake, so B already knows.
    expect(b.snapshot().threads["ta"]?.label).toBe("From A");
    expect(b.snapshot().revision).toBeGreaterThan(0);

    a.dispose();
    b.dispose();
  });

  it("never lets an older revision win", async () => {
    const a = makeStore({ tabId: "tab-a" });
    const b = makeStore({ tabId: "tab-b" });
    await a.upsertThread(draft({ threadId: "ta" }));
    const revisionAfterA = b.snapshot().revision;
    await b.upsertThread(draft({ threadId: "tb" }));
    expect(b.snapshot().revision).toBeGreaterThan(revisionAfterA);
    expect(b.snapshot().threads["tb"]).toBeDefined();
    expect(b.snapshot().threads["ta"]).toBeDefined();

    a.dispose();
    b.dispose();
  });

  it("picks up persisted state on syncFromPeers even with no peer alive", async () => {
    const a = makeStore({ tabId: "tab-a" });
    a.attach({ threadId: "ta" });
    await a.upsertThread(draft({ threadId: "ta", label: "Persisted" }));
    a.dispose();

    const b = makeStore({ tabId: "tab-b" });
    expect(b.snapshot().threads["ta"]).toBeUndefined();
    await b.syncFromPeers();
    expect(b.snapshot().threads["ta"]?.label).toBe("Persisted");
    b.dispose();
  });

  it("stops listening once disposed", async () => {
    const a = makeStore({ tabId: "tab-a" });
    const b = makeStore({ tabId: "tab-b" });
    b.dispose();
    const revision = b.snapshot().revision;
    await a.upsertThread(draft({ threadId: "ta" }));
    expect(b.snapshot().revision).toBe(revision);
    a.dispose();
  });
});

describe("lifecycle", () => {
  it("heartbeat renews claims and bumps the epoch", async () => {
    const store = makeStore({ tabId: "tab-a" });
    store.attach({ threadId: "ta" });
    await store.upsertThread(draft({ threadId: "ta" }));
    const claimed = await store.claimPaths(["src/a.ts"], { ttlMs: 1000 });
    const expiry = claimed.registry.threads["ta"]!.claims[0]!.expiresAt;

    clock = T0 + 500;
    await store.heartbeat();

    const thread = store.snapshot().threads["ta"]!;
    expect(thread.claims[0]!.expiresAt).toBeGreaterThan(expiry);
    expect(thread.epoch).toBe(2);
    expect(store.snapshot().threads["ta"]!.claims).toHaveLength(1);
    store.dispose();
  });

  it("detachThread removes the thread and frees its paths", async () => {
    const store = makeStore({ tabId: "tab-a" });
    store.attach({ threadId: "ta" });
    await store.upsertThread(draft({ threadId: "ta" }));
    await store.claimPaths(["src/a.ts"]);
    await store.detachThread();

    expect(store.snapshot().threads["ta"]).toBeUndefined();
    expect(store.selfThreadId).toBeNull();
    expect(store.snapshot().revision).toBeGreaterThan(0);
    store.dispose();
  });

  it("claiming without an attached thread is a no-op, not a throw", async () => {
    const store = makeStore({ tabId: "tab-a" });
    const outcome = await store.claimPaths(["src/a.ts"]);
    expect(outcome.granted).toEqual([]);
    store.dispose();
  });

  it("claiming nothing is a no-op", async () => {
    const store = makeStore({ tabId: "tab-a" });
    store.attach({ threadId: "ta" });
    await store.upsertThread(draft({ threadId: "ta" }));
    const before = store.snapshot().revision;
    const outcome = await store.claimPaths([]);
    expect(outcome.granted).toEqual([]);
    expect(store.snapshot().revision).toBe(before);
    store.dispose();
  });
});

describe("degradation", () => {
  it("keeps working in memory when persistence is unavailable, and says so", async () => {
    const store = makeStore({
      tabId: "tab-a",
      save: async () => {
        throw new Error("vault unavailable");
      },
    });
    store.attach({ threadId: "ta" });
    await store.upsertThread(draft({ threadId: "ta" }));

    expect(store.status().persistence).toBe("memory-only");
    expect(store.snapshot().threads["ta"]).toBeDefined();
    store.dispose();
  });

  it("reports peer count and revision for the UI", async () => {
    const a = makeStore({ tabId: "tab-a" });
    const b = makeStore({ tabId: "tab-b" });
    await a.upsertThread(draft({ threadId: "ta" }));
    await b.upsertThread(draft({ threadId: "tb" }));
    // Both answered each other's broadcasts.
    expect(a.status().peers).toBeGreaterThanOrEqual(1);
    expect(a.status().persistence).toBe("ok");
    expect(a.status().revision).toBeGreaterThan(0);

    a.dispose();
    b.dispose();
  });
});
