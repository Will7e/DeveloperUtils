// ============================================================
// Agent Thread Registry — Pure Model
// ============================================================
// A "thread" is one agent workstream: a conversation, with its own
// working branch (see create_working_branch / ws.workingBranch), that
// may run in its own tab. Several threads can be live at once in the
// same browser profile, and they share one repository.
//
// Isolation is what makes that safe: each thread writes to its own
// branch, so two threads never race on the same ref. What isolation
// does NOT give you is awareness — a thread has no idea that another
// one is mid-refactor in the same file, that a path it is about to
// rewrite was just rewritten elsewhere, or that its branch is already
// three commits behind someone else's integrated work.
//
// This module is the pure half of that awareness: thread records and
// path-scoped claims, expressed as deterministic functions over an
// immutable registry value. It performs no I/O, reads no clock (every
// entry point takes `now`), and never mutates its input — so the rules
// below are unit-testable in isolation from IndexedDB, Web Locks and
// BroadcastChannel (that half lives in ./store.ts).
//
// Two rules are load-bearing:
//
//   1. Claims are advisory to the USER but binding inside the loop.
//      A claim must never be the only thing preventing a write — the
//      branch-per-thread isolation already does that. Claims exist to
//      prevent wasted work and confusing diffs, so a lost claim is an
//      inconvenience, never a corruption. Every API here therefore
//      fails open (conflict reported, unknown peers dropped) rather
//      than throwing.
//   2. Ordering is by `revision`/`epoch`, never by wall clock. Wall
//      clock ordering already cost us silent edit loss once (see the
//      cloud-sync conflict comparison); nothing here compares
//      timestamps for anything but expiry.
// ============================================================

/** What a thread says it is doing right now (UI + awareness digest) */
export type ThreadStatus =
  | "planning"
  | "editing"
  | "verifying"
  | "waiting-approval"
  | "idle";

export const THREAD_STATUSES: readonly ThreadStatus[] = [
  "planning",
  "editing",
  "verifying",
  "waiting-approval",
  "idle",
];

/** A path-scoped, expiring lease held by exactly one thread */
export interface PathClaim {
  /** Repo-relative path, or a directory prefix when it ends with "/" */
  path: string;
  threadId: string;
  /** Claim stops blocking others at this instant (ms since epoch) */
  expiresAt: number;
}

export interface AgentThread {
  /** Stable id for the workstream; one per conversation */
  threadId: string;
  /** Short human label (conversation title, trimmed by the caller) */
  label: string;
  /** Tab/window running it — presence is per tab, ownership is per thread */
  tabId: string;
  /** Device id, so another device's threads are distinguishable */
  deviceId: string;
  owner: string;
  repo: string;
  /** Branch this thread writes to (workingBranch ?? base branch) */
  branch: string;
  /** Branch it forked from / integrates into */
  base: string;
  /** One line: what this thread is trying to accomplish */
  intent: string;
  /** Current plan step, when it has one */
  planStep?: string;
  status: ThreadStatus;
  /** Monotonic per-thread counter: bumped on every accepted update */
  epoch: number;
  /** Last moment this thread published something */
  heartbeatAt: number;
  claims: PathClaim[];
}

/** Caller-supplied part of a thread record; epoch/claims are managed here */
export type ThreadDraft = Omit<AgentThread, "epoch" | "heartbeatAt" | "claims"> &
  Partial<Pick<AgentThread, "planStep" | "status">> & { claims?: PathClaim[] };

export interface ThreadRegistry {
  /** Bumped on every accepted mutation (the only ordering we trust) */
  revision: number;
  threads: Record<string, AgentThread>;
}

export interface ClaimConflict {
  path: string;
  heldBy: string;
  heldByLabel: string;
  expiresAt: number;
}

export interface ClaimOutcome {
  registry: ThreadRegistry;
  /** Paths now claimed by the requesting thread */
  granted: string[];
  /** Paths refused because another thread holds an overlapping claim */
  conflicts: ClaimConflict[];
}

/** Bound on a single claim request (a runaway tool call must not flood the doc) */
export const MAX_CLAIM_PATHS = 64;
/** Bound on the registry's size; peers beyond this are dropped, not trusted */
export const MAX_THREADS = 32;
/** Bound on stored strings, so a malformed peer cannot bloat the doc */
const MAX_TEXT = 200;
/** Default claim lifetime; a thread must heartbeat to keep it */
export const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;
/** A thread with no heartbeat for this long is shown as stale, not active */
export const STALE_AFTER_MS = 10 * 60 * 1000;

// ── Normalization ────────────────────────────────────────────

/**
 * Normalizes a repo-relative path. Returns null for anything that is
 * not a plausible repo path (absolute, traversing, empty, oversized),
 * because a claim we cannot interpret must never be treated as a claim.
 */
export function normalizePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p) return null;
  p = p.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!p) return null;
  if (p.length > MAX_TEXT) return null;
  if (p === "." || p.includes("\0")) return null;
  // Traversal: a path that escapes the repo is not something we can
  // scope a claim to, and it is never a legitimate workspace path.
  if (p.split("/").some((seg) => seg === "..")) return null;
  return p;
}

/**
 * Do two claims cover overlapping ground? Equal paths overlap; a
 * directory claim (trailing "/") overlaps everything beneath it, in
 * either direction, so `src/` conflicts with `src/a.ts` and a nested
 * `src/chat/` conflicts with an outer `src/`.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (b.endsWith("/") && a.startsWith(b)) return true;
  return false;
}

function isClaimExpired(claim: PathClaim, now: number): boolean {
  return !Number.isFinite(claim.expiresAt) || claim.expiresAt <= now;
}

/** Drops expired claims. Threads stay; only their leases lapse. */
export function expireClaims(registry: ThreadRegistry, now: number): ThreadRegistry {
  let changed = false;
  const threads: Record<string, AgentThread> = {};
  for (const [id, thread] of Object.entries(registry.threads)) {
    const live = thread.claims.filter((c) => !isClaimExpired(c, now));
    threads[id] = live.length === thread.claims.length ? thread : { ...thread, claims: live };
    if (live.length !== thread.claims.length) changed = true;
  }
  return changed ? { ...registry, threads, revision: registry.revision + 1 } : registry;
}

// ── Mutations (all return a new registry) ────────────────────

export function emptyRegistry(): ThreadRegistry {
  return { revision: 0, threads: {} };
}

/**
 * Inserts or updates a thread record. `epoch` is derived here so it is
 * always monotonic per thread, and unknown drafts are clamped to the
 * registry's bounds.
 */
export function upsertThread(
  registry: ThreadRegistry,
  draft: ThreadDraft,
  now: number
): ThreadRegistry {
  const threadId = String(draft.threadId ?? "").trim();
  if (!threadId) return registry;

  const existing = registry.threads[threadId];
  if (!existing && Object.keys(registry.threads).length >= MAX_THREADS) {
    // Evict the least recently heard-from thread rather than refusing the
    // update: a fresh thread is more likely to be the live one.
    const victim = Object.values(registry.threads).sort((a, b) => a.heartbeatAt - b.heartbeatAt)[0];
    if (!victim) return registry;
    const rest: Record<string, AgentThread> = {};
    for (const [id, thread] of Object.entries(registry.threads)) {
      if (id !== victim.threadId) rest[id] = thread;
    }
    return upsertThread({ ...registry, threads: rest }, draft, now);
  }

  const next: AgentThread = {
    threadId,
    label: clip(draft.label ?? existing?.label ?? threadId),
    tabId: clip(draft.tabId ?? existing?.tabId ?? ""),
    deviceId: clip(draft.deviceId ?? existing?.deviceId ?? ""),
    owner: clip(draft.owner ?? existing?.owner ?? ""),
    repo: clip(draft.repo ?? existing?.repo ?? ""),
    branch: clip(draft.branch ?? existing?.branch ?? ""),
    base: clip(draft.base ?? existing?.base ?? ""),
    intent: clip(draft.intent ?? existing?.intent ?? ""),
    planStep: draft.planStep === undefined ? existing?.planStep : clip(draft.planStep),
    status: draft.status && THREAD_STATUSES.includes(draft.status) ? draft.status : existing?.status ?? "idle",
    epoch: (existing?.epoch ?? 0) + 1,
    heartbeatAt: now,
    claims: draft.claims ?? existing?.claims ?? [],
  };

  return {
    revision: registry.revision + 1,
    threads: { ...registry.threads, [threadId]: next },
  };
}

/**
 * Grants as many of `paths` as nothing else holds. Every requested path
 * is evaluated against the *current* holdings of other threads, so a
 * request is all-or-nothing per path — partial success is normal and is
 * reported per path rather than throwing.
 */
export function claimPaths(
  registry: ThreadRegistry,
  request: { threadId: string; paths: string[]; ttlMs?: number; now: number }
): ClaimOutcome {
  const { threadId, now } = request;
  const ttlMs = clampTtl(request.ttlMs);

  const thread = registry.threads[threadId];
  if (!thread) {
    // Unknown thread: nothing to record a claim against. Failing open with
    // no grants keeps the caller honest (it must register presence first)
    // without turning a coordination hiccup into a failed write.
    return {
      registry,
      granted: [],
      conflicts: [],
    };
  }

  const pruned = expireClaims(registry, now);
  const granted: string[] = [];
  const conflicts: ClaimConflict[] = [];

  const requested: string[] = [];
  for (const raw of request.paths.slice(0, MAX_CLAIM_PATHS)) {
    const path = normalizePath(raw);
    if (path && !requested.includes(path)) requested.push(path);
  }

  // Peers that still hold live claims, excluding our own thread.
  const holders: Array<{ claim: PathClaim; thread: AgentThread }> = [];
  for (const other of Object.values(pruned.threads)) {
    if (other.threadId === threadId) continue;
    for (const claim of other.claims) {
      if (!isClaimExpired(claim, now)) holders.push({ claim, thread: other });
    }
  }

  for (const path of requested) {
    const clash = holders.find((h) => pathsOverlap(h.claim.path, path));
    if (clash) {
      conflicts.push({
        path,
        heldBy: clash.thread.threadId,
        heldByLabel: clash.thread.label || clash.thread.threadId,
        expiresAt: clash.claim.expiresAt,
      });
    } else {
      granted.push(path);
    }
  }

  if (granted.length === 0) {
    // Nothing changed except possibly expiries.
    return { registry: pruned, granted, conflicts };
  }

  const merged = new Map<string, PathClaim>();
  for (const claim of thread.claims) {
    if (!isClaimExpired(claim, now)) merged.set(claim.path, claim);
  }
  for (const path of granted) {
    merged.set(path, { path, threadId, expiresAt: now + ttlMs });
  }

  const updated: AgentThread = { ...thread, claims: [...merged.values()] };
  return {
    registry: {
      revision: pruned.revision + 1,
      threads: { ...pruned.threads, [threadId]: updated },
    },
    granted,
    conflicts,
  };
}

/** Releases some or all of a thread's claims */
export function releasePaths(
  registry: ThreadRegistry,
  threadId: string,
  paths?: string[]
): ThreadRegistry {
  const thread = registry.threads[threadId];
  if (!thread || thread.claims.length === 0) return registry;

  const wanted = paths
    ? new Set(paths.map(normalizePath).filter((p): p is string => p !== null))
    : null;
  const remaining = wanted
    ? thread.claims.filter((c) => !wanted.has(c.path))
    : [];
  if (remaining.length === thread.claims.length) return registry;

  return {
    revision: registry.revision + 1,
    threads: { ...registry.threads, [threadId]: { ...thread, claims: remaining } },
  };
}

/** Forgets a thread entirely (its claims go with it) */
export function removeThread(registry: ThreadRegistry, threadId: string): ThreadRegistry {
  if (!registry.threads[threadId]) return registry;
  const rest: Record<string, AgentThread> = {};
  for (const [id, thread] of Object.entries(registry.threads)) {
    if (id !== threadId) rest[id] = thread;
  }
  return { revision: registry.revision + 1, threads: rest };
}

/** Threads whose presence has gone stale (still shown, marked not active) */
export function isStale(thread: AgentThread, now: number, staleAfterMs = STALE_AFTER_MS): boolean {
  return now - thread.heartbeatAt > staleAfterMs;
}

/** Live claims of other threads that overlap `paths` */
export function conflictsFor(
  registry: ThreadRegistry,
  request: { threadId: string; paths: string[]; now: number }
): ClaimConflict[] {
  const requested = request.paths
    .map(normalizePath)
    .filter((p): p is string => p !== null);
  if (requested.length === 0) return [];

  const out: ClaimConflict[] = [];
  for (const thread of Object.values(registry.threads)) {
    if (thread.threadId === request.threadId) continue;
    for (const claim of thread.claims) {
      if (isClaimExpired(claim, request.now)) continue;
      const hit = requested.find((p) => pathsOverlap(claim.path, p));
      if (hit) {
        out.push({
          path: hit,
          heldBy: thread.threadId,
          heldByLabel: thread.label || thread.threadId,
          expiresAt: claim.expiresAt,
        });
      }
    }
  }
  return out;
}

/**
 * Accepts a peer's registry only when it is strictly newer. Revision,
 * not timestamp: two tabs pushing at once must resolve to one winner
 * deterministically, and a clock-skewed peer must not be able to
 * resurrect dropped claims.
 */
export function acceptRemote(
  local: ThreadRegistry,
  remote: ThreadRegistry
): { registry: ThreadRegistry; accepted: boolean } {
  if (remote.revision <= local.revision) return { registry: local, accepted: false };
  return { registry: remote, accepted: true };
}

// ── Serialization (untrusted input boundary) ─────────────────

/**
 * Validates and rebuilds a registry from persisted bytes or a channel
 * message. A peer (or a corrupted store) can send anything, so nothing
 * is trusted: unknown statuses, oversized strings, traversal paths and
 * malformed claims are dropped rather than propagated into the model.
 */
export function parseRegistry(raw: unknown): ThreadRegistry | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;

  const source = value as Partial<ThreadRegistry>;
  const revision = Number(source.revision);
  if (!Number.isFinite(revision) || revision < 0) return null;
  if (!source.threads || typeof source.threads !== "object") return null;

  const threads: Record<string, AgentThread> = {};
  for (const [id, candidate] of Object.entries(source.threads as Record<string, unknown>)) {
    if (Object.keys(threads).length >= MAX_THREADS) break;
    const thread = sanitizeThread(id, candidate);
    if (thread) threads[thread.threadId] = thread;
  }

  return { revision, threads };
}

function sanitizeThread(id: string, candidate: unknown): AgentThread | null {
  if (!candidate || typeof candidate !== "object") return null;
  const t = candidate as Partial<AgentThread>;
  const threadId = clip(typeof t.threadId === "string" && t.threadId.trim() ? t.threadId : id);
  if (!threadId) return null;

  const claims: PathClaim[] = [];
  if (Array.isArray(t.claims)) {
    for (const raw of t.claims.slice(0, MAX_CLAIM_PATHS)) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Partial<PathClaim>;
      const path = typeof c.path === "string" ? normalizePath(c.path) : null;
      const expiresAt = Number(c.expiresAt);
      if (!path || !Number.isFinite(expiresAt)) continue;
      claims.push({ path, threadId, expiresAt });
    }
  }

  return {
    threadId,
    label: clip(t.label),
    tabId: clip(t.tabId),
    deviceId: clip(t.deviceId),
    owner: clip(t.owner),
    repo: clip(t.repo),
    branch: clip(t.branch),
    base: clip(t.base),
    intent: clip(t.intent),
    planStep: t.planStep === undefined ? undefined : clip(t.planStep),
    status: typeof t.status === "string" && THREAD_STATUSES.includes(t.status as ThreadStatus)
      ? (t.status as ThreadStatus)
      : "idle",
    epoch: Number.isFinite(Number(t.epoch)) ? Math.max(0, Math.floor(Number(t.epoch))) : 0,
    heartbeatAt: Number.isFinite(Number(t.heartbeatAt)) ? Number(t.heartbeatAt) : 0,
    claims,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function clip(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

function clampTtl(ttlMs: number | undefined): number {
  if (!Number.isFinite(ttlMs) || (ttlMs as number) <= 0) return DEFAULT_CLAIM_TTL_MS;
  // A claim that outlives a stale heartbeat would block peers for no reason.
  return Math.min(ttlMs as number, STALE_AFTER_MS);
}
