// ============================================================
// Agent Thread Awareness — What One Thread Knows About the Others
// ============================================================
// The registry (./registry.ts) holds the facts. This module turns them
// into the two shapes that actually get read:
//
//   1. A digest for the model's context. It must be cheap enough to
//      include on every turn: it returns "" when there is nothing to
//      say, caps its own length, and is written to be *acted on* —
//      which paths are taken, by whom, and for how long.
//   2. A warning for the push approval gate, in the reviewer's voice:
//      "this file is being changed in another thread too" is exactly the
//      kind of fact the existing preflight warnings exist to surface.
//
// Both are pure functions of a registry snapshot, so both are testable
// without a store, a channel or a clock of their own, and neither can
// perform I/O.
// ============================================================

import {
  STALE_AFTER_MS,
  conflictsFor,
  isStale,
  type AgentThread,
  type ClaimConflict,
  type ThreadRegistry,
  type ThreadStatus,
} from "./registry";

/** Default ceiling for the model-facing digest (roughly 300 tokens) */
export const DIGEST_CHAR_BUDGET = 1200;

/** Statuses rendered as activity, so the digest reads like a work log */
const STATUS_VERB: Record<ThreadStatus, string> = {
  planning: "planning",
  editing: "editing",
  verifying: "verifying",
  "waiting-approval": "waiting for approval",
  idle: "idle",
};

const MAX_LISTED_CONFLICTS = 8;

export interface ThreadSummary {
  threadId: string;
  label: string;
  branch: string;
  status: ThreadStatus;
  intent: string;
  planStep?: string;
  /** Claimed paths, capped for display */
  paths: string[];
  /** Total live claims held, including any capped away */
  pathCount: number;
  ageMs: number;
  stale: boolean;
}

export interface AwarenessView {
  /** Threads other than the caller's, most recently active first */
  others: ThreadSummary[];
  /** Other threads' live claims overlapping the caller's paths */
  conflicts: ClaimConflict[];
}

export interface AwarenessOptions {
  /** The asking thread; excluded from `others` */
  selfThreadId?: string;
  now: number;
  /** Paths the caller cares about, for the conflict check */
  paths?: string[];
  /** Max paths listed per thread */
  maxPathsPerThread?: number;
}

/** Reads a registry into a display + conflict view */
export function describeThreads(
  registry: ThreadRegistry,
  options: AwarenessOptions
): AwarenessView {
  const { selfThreadId, now } = options;
  const maxPaths = options.maxPathsPerThread ?? 3;

  const others: ThreadSummary[] = [];
  for (const thread of Object.values(registry.threads)) {
    if (selfThreadId && thread.threadId === selfThreadId) continue;
    const live = thread.claims.filter((c) => c.expiresAt > now);
    others.push({
      threadId: thread.threadId,
      label: thread.label || thread.threadId,
      branch: thread.branch,
      status: thread.status,
      intent: thread.intent,
      planStep: thread.planStep,
      paths: live.slice(0, maxPaths).map((c) => c.path),
      pathCount: live.length,
      ageMs: Math.max(0, now - thread.heartbeatAt),
      stale: isStale(thread, now, STALE_AFTER_MS),
    });
  }

  // Freshest signal first: a thread that spoke 10s ago matters more than
  // one that has been idle for an hour.
  others.sort((a, b) => a.ageMs - b.ageMs);

  const conflicts =
    (options.paths ?? []).length > 0
      ? conflictsFor(registry, {
          threadId: selfThreadId ?? "",
          paths: options.paths ?? [],
          now,
        })
      : [];

  return { others, conflicts };
}

/**
 * The model-facing digest. Returns "" when there is no other thread, so
 * a single-thread session pays nothing: no header, no tokens, and no
 * behavioural noise about coordination that is not happening.
 */
export function formatThreadDigest(
  registry: ThreadRegistry,
  options: AwarenessOptions & { charBudget?: number }
): string {
  const budget = options.charBudget ?? DIGEST_CHAR_BUDGET;
  const view = describeThreads(registry, options);
  if (view.others.length === 0) return "";

  const blocks: string[] = [];

  // Conflicts go first and are never trimmed away: they are the only part
  // of this digest that changes what the reader should do next.
  if (view.conflicts.length > 0) {
    const lines = view.conflicts.slice(0, MAX_LISTED_CONFLICTS).map(
      (c) =>
        `- ${c.path} is claimed by "${c.heldByLabel}" (${formatRemaining(c.expiresAt, options.now)})`
    );
    if (view.conflicts.length > MAX_LISTED_CONFLICTS) {
      lines.push(`- …and ${view.conflicts.length - MAX_LISTED_CONFLICTS} more`);
    }
    blocks.push(["Other threads currently hold these paths:", ...lines].join("\n"));
  }

  let used = blocks.join("\n\n").length;
  const threadLines: string[] = [];
  for (const thread of view.others) {
    const line = formatThreadLine(thread);
    if (used + line.length + 1 > budget) break;
    threadLines.push(line);
    used += line.length + 1;
  }

  if (threadLines.length > 0) {
    const hidden = view.others.length - threadLines.length;
    if (hidden > 0) {
      threadLines.push(`- …and ${hidden} more thread${hidden === 1 ? "" : "s"}`);
    }
    blocks.push(["Other agent threads in this browser:", ...threadLines].join("\n"));
  }

  return blocks.join("\n\n");
}

function formatThreadLine(thread: ThreadSummary): string {
  const extra = thread.pathCount - thread.paths.length;
  const parts = [
    `"${thread.label}"`,
    STATUS_VERB[thread.status],
    thread.branch ? `branch ${thread.branch}` : "",
    thread.paths.length > 0 ? `touching ${thread.paths.join(", ")}` : "",
    extra > 0 ? `+${extra} more` : "",
    thread.stale ? "STALE (no recent heartbeat)" : `${formatAge(thread.ageMs)} ago`,
    thread.intent ? `— ${thread.intent}` : "",
  ].filter(Boolean);
  return `- ${parts.join(" · ")}`;
}

/**
 * Reviewer-facing warnings for the push gate. Deliberately concrete: a
 * warning that names the path and the other thread is actionable, while
 * "conflicts detected" is not.
 */
export function formatClaimWarnings(conflicts: ClaimConflict[], now: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of conflicts) {
    const key = `${c.path}\u0000${c.heldBy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      `Another agent thread ("${c.heldByLabel}") is working on ${c.path} right now ` +
        `(its claim lapses in ${formatRemaining(c.expiresAt, now)}). Merging both sets of changes ` +
        `will need a real merge, and that thread may still rewrite the file.`
    );
  }
  return out;
}

// ── Prose helpers ────────────────────────────────────────────

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function formatRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  // Checked before rounding: ceil() of any positive remainder is >= 1, so
  // comparing rounded minutes against 1 can never catch a sub-minute claim.
  if (ms < 60_000) return "under a minute";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes === 1) return "1 minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** One thread by id, for UI lookups */
export function threadById(registry: ThreadRegistry, threadId: string): AgentThread | undefined {
  return registry.threads[threadId];
}
