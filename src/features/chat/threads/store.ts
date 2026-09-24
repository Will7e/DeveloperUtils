// ============================================================
// Agent Thread Store — The Coordination Primitive
// ============================================================
// Owns the live thread registry for this browser profile and makes it
// visible to every tab. Four moving parts, each reusing a pattern that
// already exists in this codebase rather than inventing a new one:
//
//   • Persistence: the registry is vault-encrypted (AES-256-GCM, same
//     recipe as cloud token storage) and written through the IDB
//     key-value layer with its localStorage fallback. Encrypted, because
//     the doc holds conversation labels and intents — the same trust
//     domain as everything else the vault protects.
//   • Cross-tab fan-out: BroadcastChannel, one message per mutation,
//     carrying the whole registry. The doc is small (a handful of
//     threads) and "the doc is the unit" removes a class of merge bugs.
//   • Mutual exclusion: Web Locks, the API the cloud-sync leader
//     election already relies on. Claims are granted inside the lock
//     against the freshly-read persisted copy, so two tabs cannot both
//     claim the same path.
//   • Ordering: revision numbers, never timestamps. A peer message is
//     adopted only when strictly newer, so a clock-skewed tab cannot
//     resurrect claims that expired, and two tabs racing produce one
//     deterministic winner.
//
// Degradation is explicit, never silent. With no Web Locks the lock
// becomes a best-effort read-modify-write (documented at withLock);
// with no vault passphrase the registry is in-memory and says so via
// status(). Coordination is advisory: it prevents wasted work and
// confusing diffs, but branch-per-thread isolation is what prevents
// corruption — so no failure here is allowed to block a write.
// ============================================================

import { decrypt, encrypt, type CipherEnvelope } from "@/services/crypto.service";
import { readValue, writeValue } from "@/services/idb-storage.service";
import { getPassphrase } from "@/services/vault.service";
import {
  DEFAULT_CLAIM_TTL_MS,
  acceptRemote,
  claimPaths,
  emptyRegistry,
  parseRegistry,
  releasePaths,
  removeThread,
  upsertThread,
  type ClaimOutcome,
  type ThreadDraft,
  type ThreadRegistry,
} from "./registry";

const STORAGE_KEY = "intab_agent_threads";
const CHANNEL_NAME = "intab-agent-threads";
const LOCK_NAME = "intab-agent-threads";
/** Mirrors cloud-sync's device id key so both agree on the same id */
const DEVICE_ID_KEY = "intab_sync_device_id";

// ── Ports (injectable: the logic above must be testable without a browser) ──

/** Minimal shape of a BroadcastChannel subscription */
export interface ThreadChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface ThreadStorePorts {
  now(): number;
  tabId: string;
  deviceId(): string;
  /** Latest persisted registry, or null when none/unavailable */
  load(): Promise<ThreadRegistry | null>;
  save(registry: ThreadRegistry): Promise<void>;
  channel(): ThreadChannelLike | null;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

interface WireMessage {
  type: "hello" | "registry";
  from: string;
  registry?: ThreadRegistry;
}

export interface ThreadStoreStatus {
  /** "memory-only" once persistence proved unavailable (no vault, no IDB) */
  persistence: "ok" | "memory-only";
  /** Peers heard from through the channel */
  peers: number;
  revision: number;
}

export interface ThreadStore {
  /** Identity of this tab's store instance */
  readonly tabId: string;
  /** The thread this tab speaks for (set with attach) */
  readonly selfThreadId: string | null;
  status(): ThreadStoreStatus;
  snapshot(): ThreadRegistry;
  subscribe(listener: (registry: ThreadRegistry) => void): () => void;
  /** Bind this store to the conversation it represents */
  attach(thread: { threadId: string }): void;
  upsertThread(draft: ThreadDraft): Promise<ThreadRegistry>;
  /**
   * Claims paths for one thread.
   *
   * `threadId` is how a caller says WHOSE claim this is, and passing it is what
   * makes the claim safe once two conversations run in one page: the alternative
   * is the attach-then-act sequence, which has an await in the middle — so thread
   * B's attach lands between thread A's attach and thread A's claim, and A's claim
   * is recorded against B. That is not a lost write but a WRONG warning: B is
   * reported as holding a file it never touched, and A is reported as holding
   * none. Omitted, it falls back to the attached thread, which remains right for
   * the single-conversation case.
   */
  claimPaths(paths: string[], options?: { ttlMs?: number; threadId?: string }): Promise<ClaimOutcome>;
  releasePaths(paths?: string[], options?: { threadId?: string }): Promise<ThreadRegistry>;
  /** Refresh presence and renew this thread's own claims */
  heartbeat(): Promise<ThreadRegistry>;
  /** Forget this thread entirely (turn ended / conversation closed) */
  detachThread(): Promise<ThreadRegistry>;
  /** Ask peers for their copy and adopt it if newer */
  syncFromPeers(): Promise<ThreadRegistry>;
  dispose(): void;
}

// ── Default ports ────────────────────────────────────────────

function randomId(bytes = 8): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function defaultDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = randomId();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return "";
  }
}

/**
 * Encrypt-then-store, mirroring cloud token storage. A vault-less
 * environment (no passphrase) reports "memory-only" instead of writing
 * plaintext: the registry is never allowed to be an unencrypted copy of
 * user activity.
 */
async function defaultLoad(): Promise<ThreadRegistry | null> {
  const raw = await readValue(STORAGE_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const envelope = parsed as CipherEnvelope;
  if (typeof envelope?.ct === "string" && typeof envelope?.iv === "string") {
    const passphrase = await getPassphrase();
    if (!passphrase) return null;
    try {
      const plaintext = await decrypt(envelope, passphrase);
      return parseRegistry(plaintext);
    } catch {
      // Undecryptable (rotated key, corruption): treat as absent rather
      // than throwing. It is rewritten on the next mutation.
      return null;
    }
  }

  // Legacy/plaintext shape (never written by this module, but tolerated).
  return parseRegistry(parsed);
}

async function defaultSave(registry: ThreadRegistry): Promise<void> {
  const passphrase = await getPassphrase();
  if (!passphrase) throw new Error("Vault unavailable");
  const envelope = await encrypt(JSON.stringify(registry), passphrase);
  await writeValue(STORAGE_KEY, JSON.stringify(envelope));
}

function defaultChannel(): ThreadChannelLike | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(CHANNEL_NAME) as unknown as ThreadChannelLike;
}

/** Minimal shape of the Web Locks API (absent from some TS lib targets) */
interface LockManagerLike {
  request<T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T>;
}

function lockManager(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

/**
 * Web Locks serializes read-modify-write across tabs, which is what
 * makes claim granting a real compare-and-swap. Where the API is absent
 * the mutation body simply runs unserialized; two tabs can then both
 * grant themselves the same path, which surfaces as a duplicate claim
 * rather than as lost work. Acceptable because claims are advisory and
 * lapse on expiry; not acceptable as a data-integrity mechanism, which
 * is why isolation does not depend on them.
 */
async function defaultWithLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (!locks) return fn();
  return locks.request(LOCK_NAME, { mode: "exclusive" }, fn);
}

// ── Store ────────────────────────────────────────────────────

export function createThreadStore(overrides: Partial<ThreadStorePorts> = {}): ThreadStore {
  const ports: ThreadStorePorts = {
    now: () => Date.now(),
    tabId: randomId(),
    deviceId: defaultDeviceId,
    load: defaultLoad,
    save: defaultSave,
    channel: defaultChannel,
    withLock: defaultWithLock,
    ...overrides,
  };

  let registry: ThreadRegistry = emptyRegistry();
  let selfThreadId: string | null = null;
  let persistence: ThreadStoreStatus["persistence"] = "ok";
  let disposed = false;
  const listeners = new Set<(registry: ThreadRegistry) => void>();
  const peers = new Set<string>();
  const channel = ports.channel();

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener(registry);
      } catch {
        // A failing subscriber must not break coordination for the rest.
      }
    }
  }

  function broadcast(message: WireMessage): void {
    try {
      channel?.postMessage(message);
    } catch {
      // Channel closed or structured clone failed: presence is best-effort.
    }
  }

  /** Adopts a peer registry when it is strictly newer than ours */
  function adopt(incoming: ThreadRegistry): boolean {
    const { registry: next, accepted } = acceptRemote(registry, incoming);
    if (!accepted) return false;
    registry = next;
    notify();
    return true;
  }

  function onMessage(event: { data: unknown }): void {
    if (disposed) return;
    const message = event.data as WireMessage | null;
    if (!message || typeof message !== "object") return;
    if (message.from === ports.tabId) return; // our own broadcast

    if (message.type === "hello") {
      peers.add(message.from);
      // Answer with our copy so a fresh tab starts from the real state
      // instead of an empty registry.
      broadcast({ type: "registry", from: ports.tabId, registry });
      return;
    }
    if (message.type === "registry") {
      peers.add(message.from);
      if (message.registry) adopt(message.registry);
    }
  }

  channel?.addEventListener("message", onMessage);

  /**
   * Read-modify-write against the persisted copy. Reading *inside* the
   * lock is the point: the stored doc, not our in-memory copy, is the
   * authority, so a claim cannot be granted over one another tab just
   * wrote.
   */
  async function mutate<T>(
    fn: (base: ThreadRegistry) => { next: ThreadRegistry; result: T }
  ): Promise<T> {
    return ports.withLock(async () => {
      if (!disposed) {
        // Inside the lock, the persisted doc is the authority: adopting a
        // newer copy here is what stops two tabs from appending to the same
        // revision and silently dropping each other's threads.
        const stored = await safeLoad();
        if (stored && stored.revision > registry.revision) adopt(stored);
      }

      const { next, result } = fn(registry);
      registry = next;
      await safeSave(next);
      broadcast({ type: "registry", from: ports.tabId, registry: next });
      notify();
      return result;
    });
  }

  async function safeLoad(): Promise<ThreadRegistry | null> {
    try {
      const loaded = await ports.load();
      if (loaded) persistence = "ok";
      return loaded;
    } catch {
      return null;
    }
  }

  async function safeSave(next: ThreadRegistry): Promise<void> {
    try {
      await ports.save(next);
      persistence = "ok";
    } catch {
      // No vault / no writable storage: the registry stays in memory for
      // this tab and says so. Never fatal — see the file header.
      persistence = "memory-only";
    }
  }

  return {
    tabId: ports.tabId,
    get selfThreadId() {
      return selfThreadId;
    },

    status() {
      return { persistence, peers: peers.size, revision: registry.revision };
    },

    snapshot() {
      return registry;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    attach(thread) {
      selfThreadId = thread.threadId;
    },

    async upsertThread(draft) {
      const now = ports.now();
      const stamped: ThreadDraft = {
        ...draft,
        tabId: draft.tabId || ports.tabId,
        deviceId: draft.deviceId || ports.deviceId(),
      };
      return mutate((base) => {
        const next = upsertThread(base, stamped, now);
        return { next, result: next };
      });
    },

    async claimPaths(paths, options) {
      const threadId = options?.threadId ?? selfThreadId;
      const now = ports.now();
      const ttlMs = options?.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
      if (!threadId || paths.length === 0) {
        return { registry, granted: [], conflicts: [] };
      }
      return mutate((base) => {
        const outcome = claimPaths(base, { threadId, paths, ttlMs, now });
        return { next: outcome.registry, result: outcome };
      });
    },

    async releasePaths(paths, options) {
      const threadId = options?.threadId ?? selfThreadId;
      if (!threadId) return registry;
      return mutate((base) => {
        const next = releasePaths(base, threadId, paths);
        return { next, result: next };
      });
    },

    async heartbeat() {
      const threadId = selfThreadId;
      if (!threadId) return registry;
      const now = ports.now();
      return mutate((base) => {
        const thread = base.threads[threadId];
        if (!thread) return { next: base, result: base };

        // Renewing is a re-claim of our own paths: our claims never
        // conflict with ourselves, so this extends them in one write.
        const held = thread.claims.map((c) => c.path);
        const renewed = held.length > 0
          ? claimPaths(base, { threadId, paths: held, ttlMs: DEFAULT_CLAIM_TTL_MS, now }).registry
          : base;

        const next = upsertThread(
          renewed,
          { ...thread, status: thread.status, claims: renewed.threads[threadId]?.claims ?? thread.claims },
          now
        );
        return { next, result: next };
      });
    },

    async detachThread() {
      const threadId = selfThreadId;
      if (!threadId) return registry;
      selfThreadId = null;
      return mutate((base) => {
        const next = removeThread(base, threadId);
        return { next, result: next };
      });
    },

    async syncFromPeers() {
      broadcast({ type: "hello", from: ports.tabId });
      const stored = await safeLoad();
      if (stored) adopt(stored);
      return registry;
    },

    dispose() {
      disposed = true;
      listeners.clear();
      try {
        channel?.removeEventListener("message", onMessage);
        channel?.close();
      } catch {
        // Already closed.
      }
    },
  };
}

// ── Singleton ────────────────────────────────────────────────

let singleton: ThreadStore | null = null;

/** The profile-wide thread store (one per document) */
export function getThreadStore(): ThreadStore {
  if (!singleton) singleton = createThreadStore();
  return singleton;
}

/** Test hook: drop the singleton so a fresh one can be built */
export function resetThreadStore(): void {
  singleton?.dispose();
  singleton = null;
}
