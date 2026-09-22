// ============================================================
// Scoped Resources — Every Cache Declares What It Is A Cache OF
// ============================================================
// The application keeps a dozen module-level caches, each with its own idea of
// when it stops being valid, and nothing that knows about all of them. So
// switching a thread to another repository cleared whichever ones somebody
// happened to remember, and the rest went on serving the previous repository's
// state: a cached file read, a published URL, a proof recorded against code
// that is no longer on screen.
//
// A registry turns "remember to invalidate" into "declare what you hold". Every
// cache registers itself once, at module load, with the scope it caches over and
// a release function; a transition then fans out to all of them. A cache that
// forgets to register is a test failure (see the structural check in
// ./registry.test.ts), which is the property this file exists to make possible.
//
// Two rules the implementation enforces, because both were bugs:
//
//   • A release NEVER throws into a transition. One cache failing to evict must
//     not leave the app half-moved, with the store updated and the caches not.
//     Failures are collected and reported instead.
//   • A release runs for the binding being LEFT, not for the app in general.
//     Over-eviction is not a safe default either: dropping a background thread's
//     build because another thread moved is the same class of mistake in the
//     opposite direction, and it is what made switching chats feel like it
//     destroyed work.
// ============================================================

import type { AttachmentId, BindingId, RepoRef } from "./identity";

/**
 * What a cache is keyed by, which decides what a transition can invalidate.
 *
 *   • binding — state for one thread-on-repository (a working copy, a session)
 *   • repo    — facts about a repository, shared by every thread on it
 *   • thread  — state for one conversation, independent of repository
 *   • url     — content identity, genuinely scope-free (see module-cache)
 */
export type ResourceScope = "binding" | "repo" | "thread" | "url";

export type TransitionType =
  | "thread.created"
  | "thread.deleted"
  | "attachment.set"
  | "attachment.cleared"
  | "base.moved";

/** One move the application made, as the caches need to see it */
export interface Transition {
  type: TransitionType;
  threadId: string;
  /** The binding the thread was on, or null when it had none */
  previous: BindingId | null;
  /** The binding the thread is on now, or null when nothing is attached */
  next: BindingId | null;
  /** The repository in play — the new one when attaching, the old one when clearing */
  ref: RepoRef | null;
  /** The base commit in play, for a `base.moved` */
  baseCommitSha: string | null;
}

/** What a release is told, so it can decide what exactly to drop */
export interface ReleaseContext {
  transition: Transition;
  /** True when some thread is still attached to this repository */
  isAttachmentInUse: (attachmentId: AttachmentId) => boolean;
}

export interface ScopedResource {
  /** A stable name, for the inspector and the structural registry test */
  name: string;
  scope: ResourceScope;
  /**
   * Drop whatever this resource holds for the binding being left.
   *
   * Called for every transition; a resource that holds nothing relevant should
   * return immediately rather than guess. May be async — a release that talks to
   * a network service is.
   */
  release: (context: ReleaseContext) => void | Promise<void>;
}

const resources = new Map<string, ScopedResource>();

/** A release that failed, kept so a transition can report rather than swallow */
export interface ReleaseFailure {
  resource: string;
  error: string;
}

/**
 * Declares a cache. Call once at module load, from the module that owns the
 * state, so a cache is registered exactly when the code that holds it loads.
 */
export function registerScopedResource(resource: ScopedResource): void {
  resources.set(resource.name, resource);
}

/** Every registered resource, for the inspector and the structural test */
export function registeredResources(): Array<Pick<ScopedResource, "name" | "scope">> {
  return [...resources.values()]
    .map((r) => ({ name: r.name, scope: r.scope }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Test seam: forget registrations so a suite can register its own */
export function resetScopedResources(): void {
  resources.clear();
}

/**
 * Tells every cache about a move, and reports the ones that failed.
 *
 * Sequential on purpose: a release may be async (releasing a published URL
 * is a request), and running them in parallel would make the ORDER of ownership
 * changes unobservable — which is exactly the thing that is hard to debug in
 * this area.
 */
export async function releaseScoped(
  context: ReleaseContext
): Promise<ReleaseFailure[]> {
  const failures: ReleaseFailure[] = [];
  for (const resource of resources.values()) {
    try {
      await resource.release(context);
    } catch (err) {
      failures.push({
        resource: resource.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return failures;
}
