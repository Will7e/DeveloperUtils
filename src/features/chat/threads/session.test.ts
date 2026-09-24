// ============================================================
// Thread Session — The Adapter Tests
// ============================================================
// The registry and the store each have their own suite. What these tests
// cover is the layer that until now had no callers: that presence is
// announced before a claim (or the claim is silently dropped), that a
// failing store cannot fail a write, and that the two shapes the rest of
// the app reads — the model digest and the reviewer's warning — actually
// appear.

import { beforeEach, describe, expect, it } from "vitest";
import {
  claimThreadPaths,
  claimWarningLines,
  announcePresence,
  currentThread,
  presenceDraft,
  threadDigestFor,
  threadIdentity,
  type ThreadIdentity,
} from "./session";
import type { ThreadRegistry } from "./registry";
import { createThreadStore, type ThreadChannelLike, type ThreadStore } from "./store";

const T0 = 1_700_000_000_000;

// ── Fakes (same shape as store.test.ts: enough browser to be real) ──

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

function createKv() {
  let value: string | null = null;
  return {
    read: async (): Promise<string | null> => value,
    /**
     * The persisted copy is deliberately NOT round-tripped through a
     * registry sanitizer here: the store already exercises parseRegistry,
     * and a test that re-implements it would pass even if the store stopped
     * loading. Any regression in what is written still shows up as a failed
     * conflict assertion below.
     */
    write: async (next: string | null): Promise<void> => {
      value = next;
    },
  };
}

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
let raw: ReturnType<typeof createKv>;
let kv: { read: () => Promise<ThreadRegistry | null>; write: (r: ThreadRegistry) => Promise<void> };
let lock: ReturnType<typeof createSharedLock>;
let clock: number;

/** The shared slot, encoded the way the store's own save/load pair expects */
function createSharedSlot(source: ReturnType<typeof createKv>) {
  return {
    read: async (): Promise<ThreadRegistry | null> => {
      const value = await source.read();
      return value ? (JSON.parse(value) as ThreadRegistry) : null;
    },
    write: async (registry: ThreadRegistry): Promise<void> => source.write(JSON.stringify(registry)),
  };
}

function makeStore(
  overrides: { tabId: string; save?: (registry: ThreadRegistry) => Promise<void> }
): ThreadStore {
  return createThreadStore({
    now: () => clock,
    tabId: overrides.tabId,
    deviceId: () => "dev-1",
    load: kv.read,
    save: overrides.save ?? kv.write,
    channel: () => hub.create(),
    withLock: lock,
  });
}

function identity(overrides: Partial<ThreadIdentity> = {}): ThreadIdentity {
  return {
    ...threadIdentity({
      conversationId: "conv-a",
      title: "Fix the redirect loop",
      repo: { owner: "acme", repo: "app", branch: "main" },
      workingBranch: "intab/auth-1",
      intent: "Repair the redirect loop",
    }),
    ...overrides,
  };
}

beforeEach(() => {
  hub = new FakeHub();
  raw = createKv();
  kv = createSharedSlot(raw);
  lock = createSharedLock();
  clock = T0;
});

describe("presence boundaries", () => {
  it("derives the thread record from a conversation's own facts", () => {
    // Written to the WORKING branch (where the writes land) and based on the
    // branch it forked from — the two are different facts and a peer needs
    // both to tell whether it shares a repository and what it would merge into.
    const draft = presenceDraft(identity());
    expect(draft).toMatchObject({
      threadId: "conv-a",
      label: "Fix the redirect loop",
      owner: "acme",
      repo: "app",
      branch: "intab/auth-1",
      base: "main",
      status: "planning",
    });
  });

  it("falls back to the attached branch for a thread with no working branch yet", () => {
    const draft = presenceDraft(
      identity({
        ...threadIdentity({
          conversationId: "conv-a",
          title: "t",
          repo: { owner: "acme", repo: "app", branch: "main" },
          workingBranch: null,
          intent: "",
        }),
      })
    );
    expect(draft.branch).toBe("main");
  });

  it("keeps an intent to one readable line", () => {
    // The intent is rendered inside a digest alongside other threads' intents,
    // so a pasted stack trace must not become the digest.
    const long = threadIdentity({
      conversationId: "conv-a",
      title: "t",
      repo: { owner: "acme", repo: "app", branch: "main" },
      intent: `  ${"fix ".repeat(80)}\nand then\nfix some more  `,
    });
    expect(long.intent.length).toBeLessThanOrEqual(160);
    expect(long.intent).not.toContain("\n");
    expect(long.intent.endsWith("…")).toBe(true);
  });

  it("treats a chat with no repository as a thread with no repository", () => {
    const draft = presenceDraft(
      identity(
        threadIdentity({
          conversationId: "conv-a",
          title: "t",
          repo: null,
          intent: "explain the parser",
        })
      )
    );
    expect(draft.owner).toBe("");
    expect(draft.repo).toBe("");
  });
});

describe("claiming paths", () => {
  it("announces presence first, so the first claim is not silently dropped", async () => {
    // claimPaths refuses a thread the registry has never seen. Claiming
    // without announcing would report "no conflicts" forever — the failure
    // mode that looks exactly like a clean run.
    const store = makeStore({ tabId: "tab-a" });
    const result = await claimThreadPaths(identity(), ["src/auth.ts"], store);

    expect(result.granted).toEqual(["src/auth.ts"]);
    expect(store.snapshot().threads["conv-a"]?.claims.map((c) => c.path)).toEqual(["src/auth.ts"]);
    store.dispose();
  });

  it("reports the peer holding a path, with the words the model reads", async () => {
    const a = makeStore({ tabId: "tab-a" });
    const b = makeStore({ tabId: "tab-b" });

    await claimThreadPaths(identity(), ["src/auth.ts"], a);
    const second = await claimThreadPaths(
      identity({
        ...threadIdentity({
          conversationId: "conv-b",
          title: "Add login analytics",
          repo: { owner: "acme", repo: "app", branch: "main" },
          intent: "add analytics",
        }),
      }),
      ["src/auth.ts"],
      b
    );

    expect(second.granted).toEqual([]);
    expect(second.conflicts).toHaveLength(1);

    const [warning] = claimWarningLines(second.conflicts, clock);
    expect(warning).toContain("src/auth.ts");
    expect(warning).toContain("Fix the redirect loop");

    a.dispose();
    b.dispose();
  });

  it("does not report a conflict across repositories that share a path", async () => {
    // `src/auth.ts` in two repositories is two different files. Warning about
    // it trains the reader to skip the warning, and the one real conflict
    // arrives in the same voice.
    const a = makeStore({ tabId: "tab-a" });
    const b = makeStore({ tabId: "tab-b" });

    await claimThreadPaths(identity(), ["src/auth.ts"], a);
    const other = await claimThreadPaths(
      identity({
        ...threadIdentity({
          conversationId: "conv-b",
          title: "Other repo",
          repo: { owner: "acme", repo: "other", branch: "main" },
          intent: "work elsewhere",
        }),
      }),
      ["src/auth.ts"],
      b
    );

    expect(other.granted).toEqual(["src/auth.ts"]);
    expect(other.conflicts).toEqual([]);

    a.dispose();
    b.dispose();
  });

  it("still holds the path when nothing is listening (no store, no vault)", async () => {
    // Fail open: a store that cannot persist is a coordination outage, not a
    // failed write. The claim is unrecorded and the caller is told nothing
    // rather than being handed an error it would have to ignore.
    const store = makeStore({
      tabId: "tab-a",
      save: async () => {
        throw new Error("Vault unavailable");
      },
    });
    const result = await claimThreadPaths(identity(), ["src/auth.ts"], store);
    expect(result.conflicts).toEqual([]);
    await expect(announcePresence(identity(), store)).resolves.toBeUndefined();
    store.dispose();
  });

  it("keeps the intent the turn announced when a later write announces again", async () => {
    // A write tool that has to announce by itself knows only the path it is
    // editing. An empty intent there means "nothing new to say": overwriting it
    // would erase the one line every peer reads to work out what this thread is
    // doing.
    const store = makeStore({ tabId: "tab-a" });
    await announcePresence(identity(), store);
    await claimThreadPaths(identity({ intent: "", planStep: undefined }), ["src/auth.ts"], store);

    const thread = currentThread(store, "conv-a")!;
    expect(thread.intent).toBe("Repair the redirect loop");
    expect(thread.label).toBe("Fix the redirect loop");
    store.dispose();
  });

  it("turns a planning thread into an editing one at its first write", async () => {
    // The status is what a peer's digest renders as the verb, so it has to
    // follow what the thread is actually doing rather than what it said it
    // would do at turn start.
    const store = makeStore({ tabId: "tab-a" });
    await announcePresence(identity({ status: "planning" }), store);
    expect(currentThread(store, "conv-a")?.status).toBe("planning");

    await claimThreadPaths(identity({ status: "editing" }), ["src/auth.ts"], store);
    expect(currentThread(store, "conv-a")?.status).toBe("editing");
    store.dispose();
  });

  it("asks for nothing when there is nothing to claim", async () => {
    const store = makeStore({ tabId: "tab-a" });
    expect(await claimThreadPaths(identity(), [], store)).toEqual({ granted: [], conflicts: [] });
    // No presence either: an empty claim is not a reason to write a record.
    expect(currentThread(store, "conv-a")).toBeUndefined();
    store.dispose();
  });
});

describe("the digest", () => {
  it("stays empty when this is the only thread", async () => {
    // A single-thread session pays nothing: no header, no tokens, no
    // behavioural noise about coordination that is not happening.
    const store = makeStore({ tabId: "tab-a" });
    await announcePresence(identity(), store);
    expect(threadDigestFor(store, { threadId: "conv-a", now: clock })).toBe("");
    store.dispose();
  });

  it("names the peer, its repository, its branch and the path it holds", async () => {
    const a = makeStore({ tabId: "tab-a" });
    const b = makeStore({ tabId: "tab-b" });

    await claimThreadPaths(identity(), ["src/auth.ts"], a);
    await announcePresence(
      identity({
        ...threadIdentity({
          conversationId: "conv-b",
          title: "Add analytics",
          repo: { owner: "acme", repo: "app", branch: "main" },
          intent: "instrument the login flow",
        }),
      }),
      b
    );

    // `b` adopts `a`'s registry through the channel, so its snapshot has both.
    const digest = threadDigestFor(b, { threadId: "conv-b", now: clock, paths: ["src/auth.ts"] });

    expect(digest).toContain("Fix the redirect loop");
    expect(digest).toContain("acme/app");
    expect(digest).toContain("intab/auth-1");
    // The conflict block is the part that changes what the reader should do,
    // so the held path is named in it, not merely in the thread list.
    expect(digest).toContain("src/auth.ts is claimed by");

    a.dispose();
    b.dispose();
  });

  it("never throws, whatever the store holds", () => {
    const store = makeStore({ tabId: "tab-a" });
    expect(() =>
      threadDigestFor(store, { threadId: "conv-a", paths: ["../etc/passwd"], now: clock })
    ).not.toThrow();
    expect(threadDigestFor(store, { threadId: "conv-a", now: NaN })).toBe("");
    store.dispose();
  });
});
