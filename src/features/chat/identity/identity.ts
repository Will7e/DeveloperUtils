// ============================================================
// Binding Identity — What A Piece Of State Is A Copy Of
// ============================================================
// This application has three identities, and for a long time only two of them
// were represented anywhere:
//
//   • the THREAD   — a conversation, which owns the transcript;
//   • the REPO     — owner/repo at a branch, which owns the facts;
//   • the BINDING  — "this thread is working on this repo" — which owns every
//     artifact derived from the pair: the working copy, the change set, the
//     published document, the verification ledger.
//
// The binding had no name, so it had to be re-derived at every read site, and
// a site that got it wrong served another binding's artifact. That is the whole
// family of reported symptoms: a diff still showing the previous repository,
// a new chat opening on someone else's app, a switch of repo that changed
// nothing on screen, and proof recorded against one repository being read as
// proof about another.
//
// So the binding gets a name, and everything derived is keyed by it. The rule
// this module exists to make expressible is one sentence:
//
//   Nothing derived from a binding may be read, shown, counted or persisted
//   under a different binding.
//
// Pure: no store, no clock, no network. Every rule here is a unit test, which
// is what lets the transition matrix in ./transitions be a statement about
// strings rather than about a running app.
// ============================================================

/** The repository a thread works against, pinned to one branch */
export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * The identity of an ATTACHMENT: which repository, at which branch.
 *
 * Deliberately NOT including the base commit. A workspace's base commit is a
 * REVISION of an attachment, not a different attachment, and conflating the two
 * loses work: the persisted working copy is looked up by (thread, owner, repo,
 * branch), so if a push moved the branch head and the head were part of the
 * identity, every page load would fail to match the stored workspace and start
 * a fresh one — silently discarding unpushed edits. Revision is compared where
 * freshness matters (see ./revision), never used as a key.
 */
export type AttachmentId = string;

/** The pair every user-visible artifact belongs to */
export type BindingId = string;

/**
 * The attachment id for "nothing is attached".
 *
 * Cannot collide with a real attachment: every real one contains an "@"
 * (`owner/repo@branch`), and this contains none.
 */
export const DETACHED = "detached";

/** Separates the thread from the attachment in a binding id */
const SEPARATOR = "::";

/** `owner/repo@branch` — the attachment a thread is working on */
export function attachmentIdFor(ref: RepoRef): AttachmentId {
  return `${ref.owner}/${ref.repo}@${ref.branch}`;
}

/**
 * The attachment id of any value that carries a repo ref, or null when it has
 * none.
 *
 * Takes `unknown` fields rather than a `RepoRef` on purpose: the things that
 * carry a ref are not all shaped like one — a `RepoContext` also has an
 * `attachedAt`, a workspace also has a base commit — and narrowing at the call
 * site is how a half-built id (`owner//@main`) gets constructed and then matches
 * nothing while looking legitimate.
 */
export function attachmentIdOf(
  value: { owner?: unknown; repo?: unknown; branch?: unknown } | null | undefined
): AttachmentId | null {
  const owner = value?.owner;
  const repo = value?.repo;
  const branch = value?.branch;
  if (typeof owner !== "string" || owner.length === 0) return null;
  if (typeof repo !== "string" || repo.length === 0) return null;
  if (typeof branch !== "string" || branch.length === 0) return null;
  return attachmentIdFor({ owner, repo, branch });
}

/** The binding of one thread: which thread, on which attachment */
export function bindingKey(threadId: string, attachmentId: AttachmentId | null): BindingId {
  return `${threadId}${SEPARATOR}${attachmentId ?? DETACHED}`;
}

/**
 * The two halves of a binding id.
 *
 * Splits on the FIRST separator, so a thread id is never mis-read from inside
 * an attachment. An id with no separator at all is treated as a bare thread
 * with nothing attached rather than as an error: a malformed key must degrade
 * to "no binding", which is the safe direction — a wrong binding shows another
 * repository's app, while no binding shows an empty pane.
 */
export function parseBindingKey(id: BindingId): {
  threadId: string;
  attachmentId: AttachmentId | null;
} {
  const at = id.indexOf(SEPARATOR);
  if (at === -1) return { threadId: id, attachmentId: null };
  const attachmentId = id.slice(at + SEPARATOR.length);
  return {
    threadId: id.slice(0, at),
    attachmentId: attachmentId === DETACHED ? null : attachmentId,
  };
}

/** True when a binding names a real attachment */
export function isAttached(bindingId: BindingId): boolean {
  return parseBindingKey(bindingId).attachmentId !== null;
}

/**
 * The binding a stored artifact declares, or null when it declares none.
 *
 * Null is the fail-closed answer: an artifact that cannot say which binding it
 * is a copy of is treated as belonging to nothing, so no reader can adopt it by
 * accident. Every mutating setter in the app now requires a binding id, and
 * this is how a value that predates that requirement is handled — unreadable
 * rather than assumed.
 */
export function declaredBinding(value: {
  bindingId?: string | null;
} | null | undefined): BindingId | null {
  const id = value?.bindingId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** True when an artifact's declared binding is the one currently in scope */
export function isCurrentBinding(
  declared: BindingId | null | undefined,
  active: BindingId | null | undefined
): boolean {
  return Boolean(declared) && declared === active;
}

/**
 * A binding id as prose, for logs, diagnostics and the identity inspector.
 *
 * The pane and the console both need to answer "what is this showing?", and a
 * raw `thread::owner/repo@branch` string is not that answer.
 */
export function describeBinding(bindingId: BindingId | null): string {
  if (!bindingId) return "nothing";
  const { threadId, attachmentId } = parseBindingKey(bindingId);
  if (!attachmentId) return `thread ${shortId(threadId)} (no repository attached)`;
  return `${attachmentId} (thread ${shortId(threadId)})`;
}

/** A stable, human-greppable prefix of a long id */
export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}
