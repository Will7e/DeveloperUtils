// ============================================================
// Revision — Which Version Of A Binding Something Was Produced For
// ============================================================
// A binding says WHICH repository a piece of state belongs to. It does not say
// which VERSION of it, and evidence is only evidence about a version.
//
// The verification ledger derived staleness from `workspace.updatedAt` alone,
// and that is a claim about a number, not about a repository. Two workspaces
// created in the same millisecond — attach one repo, switch to another, and the
// clock has not moved — compare EQUAL, so proof recorded against the first
// repository read as a fresh pass on the second. That is worse than a stale
// pane: it is a reviewer being told that code was verified when it never was.
//
// So an artifact records the whole revision: the binding it belongs to, the
// base commit it was taken from, and the working copy's revision counter. All
// three must match for anything to be called fresh, and a record that cannot
// name its binding is stale by definition — fail closed, because the failure
// direction of "assume it is still good" is an unverified ship.
// ============================================================

import type { BindingId } from "./identity";

export interface Revision {
  /** Which thread-on-repository this describes */
  bindingId: BindingId;
  /** The base commit the working copy was created from */
  baseCommitSha: string;
  /** The working copy's revision counter — moves on every edit */
  updatedAt: number;
}

/** A value that carries its binding and revision, as stored artifacts do */
export interface Versioned {
  bindingId?: string | null;
  baseCommitSha?: string | null;
  updatedAt?: number;
}

/**
 * The revision of a workspace-shaped value, or null when it does not declare
 * one. Null is never "fresh" — see isSameRevision.
 */
export function revisionOf(value: Versioned | null | undefined): Revision | null {
  const bindingId = value?.bindingId;
  const baseCommitSha = value?.baseCommitSha;
  const updatedAt = value?.updatedAt;
  if (typeof bindingId !== "string" || !bindingId) return null;
  if (typeof baseCommitSha !== "string" || !baseCommitSha) return null;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  return { bindingId, baseCommitSha, updatedAt };
}

/**
 * True only when an artifact was produced for EXACTLY this revision.
 *
 * Every clause is load-bearing:
 *   • same binding     — otherwise the answer belongs to another repository;
 *   • same base commit — otherwise the code underneath has moved;
 *   • same counter     — otherwise the working copy has been edited since.
 *
 * An artifact or a current value that declares no revision compares false, so
 * the answer to "is this still proven?" is no whenever the question cannot be
 * answered — the safe direction.
 */
export function isSameRevision(
  recorded: Revision | null | undefined,
  current: Revision | null | undefined
): boolean {
  if (!recorded || !current) return false;
  return (
    recorded.bindingId === current.bindingId &&
    recorded.baseCommitSha === current.baseCommitSha &&
    recorded.updatedAt === current.updatedAt
  );
}

/**
 * The revision a working copy moves TO when its code changes.
 *
 * `Date.now()` alone is not enough, because the counter has to be strictly
 * monotonic to answer the only question asked of it: "did the code move since
 * this proof?" Two edits inside one millisecond — a write and its fix, or an
 * agent's write plus the delete that follows — stamp the SAME number, so the
 * second edit leaves the first one's evidence reading as fresh and a passing
 * run about code that no longer exists survives to the push gate.
 *
 * So the wall clock is a floor, not the value: time going backwards (a
 * corrected clock, a restored backup) and a clock that has not ticked both
 * still produce a number greater than the revision being replaced.
 */
export function nextRevision(previous: number): number {
  const wall = Date.now();
  return Number.isFinite(previous) && previous >= wall ? previous + 1 : wall;
}

/**
 * True when the two describe the same code, ignoring the revision counter.
 *
 * Used where a move of the counter is not a move of the code: a no-op write
 * still bumps `updatedAt`, and calling the previous evidence stale for a write
 * that changed nothing would train the user to ignore the warning.
 */
export function isSameCode(
  recorded: Revision | null | undefined,
  current: Revision | null | undefined
): boolean {
  if (!recorded || !current) return false;
  return recorded.bindingId === current.bindingId && recorded.baseCommitSha === current.baseCommitSha;
}
