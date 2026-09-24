// ============================================================
// Thread Session — Binding Thread Awareness to a Live Turn
// ============================================================
// `registry.ts` holds the rules and `store.ts` holds the transport, and
// until this file existed nothing called either one: ~60 tests' worth of
// built, tested coordination with no importers. This is the adapter that
// puts it on the paths where two threads can actually collide:
//
//   • turn start      — announce presence, so peers know this file, its
//                       repository and its intent exist at all.
//   • write tools     — claim the path just written, so a peer editing it
//                       in another tab finds out while it still matters.
//   • the turn note   — the digest the model reads, which is the only
//                       channel through which a thread can change its plan
//                       because of another thread.
//   • the push gate   — the reviewer's warning, in the same voice as the
//                       existing preflight warnings.
//
// Three rules govern everything here, and they are the same rules the
// store is built on:
//
//   1. FAIL OPEN, ALWAYS. Coordination is an optimisation: it prevents
//      wasted work and confusing diffs, never corruption (branch-per-thread
//      isolation does that). So every entry point swallows its own failures
//      and returns "nothing to report" — a vault-less profile, a
//      BroadcastChannel-less browser or a slow lock must not be able to
//      fail a write, block a push or stall a turn.
//   2. NEVER BLOCK THE WORK. Announcements and claims are best-effort and
//      bounded; the digest is read from the in-memory snapshot (sync) so a
//      turn never waits on IDB to find out about a peer.
//   3. PRESENCE BEFORE CLAIMS. `claimPaths` refuses a thread it has never
//      heard of (there is nothing to record a claim against), so every
//      claim path here announces first — which is also why a write that
//      happens outside a prepared turn still ends up in the registry.
// ============================================================

import { formatClaimWarnings, formatThreadDigest } from "./awareness";
import {
  type AgentThread,
  type ClaimConflict,
  type ThreadDraft,
  type ThreadStatus,
} from "./registry";
import { getThreadStore, type ThreadStore } from "./store";

/** Longest intent we keep — the registry clips at 200, and a digest is read. */
const MAX_INTENT = 160;

/**
 * Who a conversation is, as a thread record. Deliberately a plain value
 * built by the caller: this module never reads the chat store, so it stays
 * testable against an injected store and cannot become a second source of
 * truth about conversations.
 */
export interface ThreadIdentity {
  /** The conversation id — one thread per conversation, forever */
  threadId: string;
  /** Short human label (the conversation title) */
  label: string;
  /** Repository this thread works on; null for a chat with none attached */
  repo: { owner: string; repo: string; branch: string } | null;
  /** Branch this thread writes to (its working branch when it has one) */
  branch: string;
  /** Branch this thread forked from (the base it integrates into) */
  base: string;
  /** One line: what this thread is trying to accomplish */
  intent: string;
  /** Current plan step, when the turn has one */
  planStep?: string;
  status: ThreadStatus;
}

export function threadIdentity(input: {
  conversationId: string;
  title: string;
  repo: { owner: string; repo: string; branch: string } | null;
  /** The branch the thread actually writes to, when it has a working branch */
  workingBranch?: string | null;
  intent: string;
  planStep?: string;
  status?: ThreadStatus;
}): ThreadIdentity {
  const attached = input.repo?.branch ?? "";
  return {
    threadId: input.conversationId,
    label: input.title.trim() || input.conversationId,
    repo: input.repo,
    branch: input.workingBranch || attached,
    base: attached,
    intent: clipIntent(input.intent),
    planStep: input.planStep,
    status: input.status ?? "planning",
  };
}

/**
 * The registry record for this thread.
 *
 * `branch` is the thread's WORKING branch when it has one, because that is
 * where its writes actually land; `base` is the branch it forked from and
 * will integrate into. Two threads on the same repository but different
 * working branches still share paths and still deserve the warning, which
 * is why conflicts are scoped by repository rather than by branch (see
 * sameRepository).
 */
export function presenceDraft(identity: ThreadIdentity): ThreadDraft {
  return {
    threadId: identity.threadId,
    label: identity.label,
    // Left to the store, which stamps the tab and device id it knows itself:
    // the session layer's job is to say WHO the thread is, and the store is the
    // only thing that knows where it is running from.
    tabId: "",
    deviceId: "",
    owner: identity.repo?.owner ?? "",
    repo: identity.repo?.repo ?? "",
    branch: identity.branch,
    base: identity.base,
    intent: identity.intent,
    planStep: identity.planStep,
    status: identity.status,
  };
}

export interface ClaimResult {
  /** Paths this thread now holds */
  granted: string[];
  /** Paths a peer already holds, which is the actionable half */
  conflicts: ClaimConflict[];
}

const NOTHING: ClaimResult = { granted: [], conflicts: [] };

/**
 * Publishes this thread's presence (and binds the store to it, so later
 * claims are made as this thread rather than as nobody).
 *
 * Called at turn start. Cheap: one encrypted write and one broadcast per
 * turn, which is exactly what a heartbeat is for.
 *
 * The record already published is merged in rather than overwritten, because
 * callers publish at different levels of knowledge: the turn layer knows the
 * intent and the branch, while a write tool that has to announce all by itself
 * (a write outside a prepared turn) knows only the path it is editing. An
 * empty field here means "nothing new to say", never "forget what you said" —
 * a later write must not erase the intent a peer is reading.
 */
export async function announcePresence(
  identity: ThreadIdentity,
  store: ThreadStore = getThreadStore()
): Promise<void> {
  try {
    store.attach({ threadId: identity.threadId });
    const existing = store.snapshot().threads[identity.threadId];
    const draft = presenceDraft(identity);
    await store.upsertThread({
      ...draft,
      label: draft.label || existing?.label || "",
      owner: draft.owner || existing?.owner || "",
      repo: draft.repo || existing?.repo || "",
      branch: draft.branch || existing?.branch || "",
      base: draft.base || existing?.base || "",
      intent: draft.intent || existing?.intent || "",
      planStep: draft.planStep ?? existing?.planStep,
    });
  } catch {
    // Presence is best-effort by design: a turn must run whether or not
    // anybody else can hear about it.
  }
}

/**
 * Claims paths for this thread, announcing presence first when the store
 * has not heard of it (or is still attached to another conversation).
 *
 * Returns conflicts rather than throwing, so a caller can surface them
 * without guarding the call — and returns nothing at all on failure, which
 * is what "fail open" means in practice: an uncoordinated write is a
 * normal write.
 */
export async function claimThreadPaths(
  identity: ThreadIdentity,
  paths: string[],
  store: ThreadStore = getThreadStore()
): Promise<ClaimResult> {
  if (paths.length === 0) return NOTHING;
  try {
    // The store speaks for ONE thread at a time (`selfThreadId`), so the thread
    // this claim belongs to is named explicitly AND attached. Naming it is the
    // load-bearing half now that two conversations run in one page: this function
    // awaits between the attach and the claim (announce below), which is exactly
    // the window in which the other conversation's write attaches and its paths
    // get claimed under this thread's identity. The attach stays because the
    // heartbeat and the detach still speak for "this page's thread".
    store.attach({ threadId: identity.threadId });
    const existing = store.snapshot().threads[identity.threadId];
    // Presence first: a claim against a thread the registry has never heard of
    // is dropped on the floor (see claimPaths), which would look exactly like
    // "no conflicts" to the caller.
    //
    // A status change is the other reason to write: this is what turns a
    // thread from "planning" into "editing" at the moment it first writes a
    // file, without a write per tool call.
    if (!existing || existing.status !== identity.status) {
      await announcePresence(identity, store);
    }
    const outcome = await store.claimPaths(paths, { threadId: identity.threadId });
    return { granted: outcome.granted, conflicts: outcome.conflicts };
  } catch {
    return NOTHING;
  }
}

/**
 * The model-facing digest: which other threads are live, and which of the
 * paths this thread has touched are held by someone else.
 *
 * Synchronous on purpose. The store's snapshot is in memory, so asking
 * "who else is here" cannot become a turn-start I/O wait; the caller that
 * wants a fresh answer awaits `announcePresence` first (see prepareTurn).
 */
export function threadDigestFor(
  store: ThreadStore,
  input: { threadId: string; paths?: string[]; now: number; charBudget?: number }
): string {
  try {
    return formatThreadDigest(store.snapshot(), {
      selfThreadId: input.threadId,
      now: input.now,
      paths: input.paths ?? [],
      charBudget: input.charBudget,
    });
  } catch {
    return "";
  }
}

/** Reviewer-facing warnings for the push gate, one per held path */
export function claimWarningLines(conflicts: ClaimConflict[], now: number): string[] {
  try {
    return formatClaimWarnings(conflicts, now);
  } catch {
    return [];
  }
}

/** The thread record for this thread, when the registry has one */
export function currentThread(
  store: ThreadStore,
  threadId: string
): AgentThread | undefined {
  try {
    return store.snapshot().threads[threadId];
  } catch {
    return undefined;
  }
}

function clipIntent(intent: string): string {
  const one = intent.replace(/\s+/g, " ").trim();
  return one.length > MAX_INTENT ? `${one.slice(0, MAX_INTENT - 1)}…` : one;
}
