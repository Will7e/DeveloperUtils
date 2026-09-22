// ============================================================
// Bindings — The Store Of Record For What Each Thread Works On
// ============================================================
// Before this module, "which repository is this thread on" lived in two places
// that could disagree: the conversation's `repoContext`, and the repository
// fields inside whichever workspace happened to be in memory. Read sites chose
// between them by heuristic (`workspaceMatchesRepo`), and a site that chose
// wrong served another repository's state.
//
// There is now ONE record per thread, and it is the only thing a binding is
// derived from. `conversations[].repoContext` remains, but only as the
// PERSISTED PROJECTION of this record — written by the same call path, for
// saving and for the sidebar — never as an independent opinion.
//
// Every change goes through a transition, and every transition is announced to
// the scoped-resource registry, so a cache cannot be left holding the previous
// repository's state (see ./scoped-resources).
//
// Two decisions worth stating, because both were bugs:
//
//   • Re-attaching the SAME repository is not a transition. `setConversationRepo`
//     is called more than once on an ordinary attach, and treating each call as a
//     move evicted caches the user was relying on and rebuilt them from nothing —
//     the "why did it reset" report.
//   • Pinning the base commit is not a change of binding. The base is a REVISION
//     of an attachment, so `base.moved` invalidates evidence and build sessions
//     without evicting a document, and — critically — without touching the
//     persisted working copy, which is found by thread and repository.
// ============================================================

import {
  attachmentIdFor,
  bindingKey,
  describeBinding,
  type AttachmentId,
  type BindingId,
  type RepoRef,
} from "./identity";
import {
  releaseScoped,
  type ReleaseFailure,
  type Transition,
  type TransitionType,
} from "./scoped-resources";

export interface BindingRecord {
  threadId: string;
  attachmentId: AttachmentId | null;
  ref: RepoRef | null;
  baseCommitSha: string | null;
  bindingId: BindingId;
  /** Bumped on every real move; the inspector shows it, tests assert it */
  generation: number;
}

const records = new Map<string, BindingRecord>();
let version = 0;
const listeners = new Set<() => void>();

/** Test seam */
export function resetBindings(): void {
  records.clear();
  version = 0;
  listeners.clear();
}

function detachedRecord(threadId: string): BindingRecord {
  return {
    threadId,
    attachmentId: null,
    ref: null,
    baseCommitSha: null,
    bindingId: bindingKey(threadId, null),
    generation: 0,
  };
}

/** A thread's current binding record, or the detached one */
export function bindingRecord(threadId: string): BindingRecord {
  return records.get(threadId) ?? detachedRecord(threadId);
}

/** The binding id a thread is on right now — the key every artifact uses */
export function bindingIdOf(threadId: string): BindingId {
  return bindingRecord(threadId).bindingId;
}

/** Every binding record, for the identity inspector */
export function allBindings(): BindingRecord[] {
  return [...records.values()];
}

/** True when some thread is still attached to this repository */
export function isAttachmentInUse(attachmentId: AttachmentId): boolean {
  for (const record of records.values()) {
    if (record.attachmentId === attachmentId) return true;
  }
  return false;
}

export function subscribeBindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function bindingsVersion(): number {
  return version;
}

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** What a move did, for the caller to report */
export interface BindingMove {
  transition: Transition;
  failures: ReleaseFailure[];
}

/** Announces one move and returns it, with whatever the caches reported */
async function move(
  type: TransitionType,
  threadId: string,
  previous: BindingId | null,
  next: BindingId | null,
  ref: RepoRef | null,
  baseCommitSha: string | null
): Promise<BindingMove> {
  const transition: Transition = { type, threadId, previous, next, ref, baseCommitSha };
  const failures = await releaseScoped({ transition, isAttachmentInUse });
  return { transition, failures };
}

function write(record: BindingRecord): BindingRecord {
  records.set(record.threadId, record);
  publish();
  return record;
}

/**
 * Puts a thread on a repository. Idempotent for the same repository.
 *
 * Returns null when nothing moved — re-attaching the same repository, which
 * must not evict anything.
 */
export async function setAttachment(
  threadId: string,
  ref: RepoRef
): Promise<BindingMove | null> {
  const before = bindingRecord(threadId);
  const attachmentId = attachmentIdFor(ref);
  if (before.attachmentId === attachmentId) return null;

  const after = write({
    threadId,
    attachmentId,
    ref,
    // The base commit is pinned later, by pinBase, once GitHub has been asked.
    // Carrying the previous one forward would claim a revision that does not
    // apply to the new repository.
    baseCommitSha: null,
    bindingId: bindingKey(threadId, attachmentId),
    generation: before.generation + 1,
  });

  return move("attachment.set", threadId, before.bindingId, after.bindingId, ref, null);
}

/**
 * Records the base commit a thread's working copy was created from.
 *
 * A different base under the same attachment is `base.moved`: the code beneath
 * the thread has changed, so evidence and build sessions are released — but the
 * binding is unchanged, so nothing keyed by the binding is evicted and the
 * persisted working copy is untouched.
 */
export async function pinBase(
  threadId: string,
  ref: RepoRef,
  baseCommitSha: string
): Promise<BindingMove | null> {
  const before = bindingRecord(threadId);
  const attachmentId = attachmentIdFor(ref);

  // A base may be pinned before anything declared the attachment (the workspace
  // bootstrap runs first on a fresh load). That is an attach, not a move.
  if (before.attachmentId !== attachmentId) {
    const attached = await setAttachment(threadId, ref);
    void attached;
    return pinBase(threadId, ref, baseCommitSha);
  }
  if (before.baseCommitSha === baseCommitSha) return null;

  write({ ...before, baseCommitSha });
  return move("base.moved", threadId, before.bindingId, before.bindingId, ref, baseCommitSha);
}

/** Detaches the repository from a thread, without destroying the thread */
export async function clearAttachment(threadId: string): Promise<BindingMove | null> {
  const before = bindingRecord(threadId);
  if (before.attachmentId === null && !records.has(threadId)) return null;

  const after = detachedRecord(threadId);
  const next: BindingRecord = { ...after, generation: before.generation + 1 };
  write(next);

  return move("attachment.cleared", threadId, before.bindingId, next.bindingId, before.ref, null);
}

/** Forgets a deleted thread entirely */
export async function forgetThread(threadId: string): Promise<BindingMove | null> {
  const before = bindingRecord(threadId);
  const existed = records.delete(threadId);
  if (existed) publish();
  if (!existed) return null;

  return move("thread.deleted", threadId, before.bindingId, null, before.ref, null);
}

/**
 * Announces a newly created thread.
 *
 * A new thread has no artifacts to release, but the event exists so the
 * transition matrix is total: "a thread was opened" is one of the moves this
 * application makes, and a matrix with a gap in it is how the next bug hides.
 */
export async function announceThreadCreated(threadId: string): Promise<BindingMove> {
  publish();
  return move("thread.created", threadId, null, bindingIdOf(threadId), null, null);
}

/** One clause for the pane and the console: what this thread is on */
export function describeThreadBinding(threadId: string): string {
  return describeBinding(bindingIdOf(threadId));
}
