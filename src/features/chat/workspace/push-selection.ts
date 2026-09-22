// ============================================================
// Push selection — what the user actually chose to ship
// ============================================================
// The approval gate is the last place a human sees the change set, so
// "approve" has to be able to mean "these eleven files, not that one".
// All-or-nothing was the gap: a reviewer who spotted one bad file could
// only reject everything and re-prompt, which discards work and trains
// people to approve blindly.
//
// This module is deliberately pure. The decision arrives from the UI as
// plain path strings, and a path that is not in the change set is
// ignored rather than trusted — a stale modal, a renamed file, or a
// hand-rolled caller must never be able to steer the commit.

import type { PushFile } from "./workspace";

export interface PushSelection {
  /** Files that go into this commit, in the original (sorted) order */
  push: PushFile[];
  /** Files the user unchecked — still pending in the workspace */
  excluded: PushFile[];
}

/**
 * Slashes, `./` prefixes and case are normalised so a path matched by the
 * UI (which renders exactly what the diff produced) still matches after a
 * round-trip through the store.
 */
function normalize(path: string): string {
  return path.trim().replace(/^\.?\//, "").replace(/\/+/g, "/");
}

/** Splits a change set by the user's exclusions. No exclusions → push all. */
export function partitionPushChanges(
  changes: readonly PushFile[],
  excludePaths?: readonly string[] | null
): PushSelection {
  if (!excludePaths || excludePaths.length === 0) {
    return { push: [...changes], excluded: [] };
  }
  const excludedPaths = new Set(excludePaths.map(normalize).filter((p) => p.length > 0));
  const push: PushFile[] = [];
  const excluded: PushFile[] = [];
  for (const change of changes) {
    if (excludedPaths.has(normalize(change.path))) excluded.push(change);
    else push.push(change);
  }
  return { push, excluded };
}

/**
 * The line the agent is given after a partial push. It has to say two
 * things plainly: those files were not committed, and they were not
 * thrown away — otherwise the model either assumes they shipped (and
 * tells the user so) or assumes they were discarded (and rewrites them).
 */
export function describeExclusions(excluded: readonly PushFile[]): string {
  if (excluded.length === 0) return "";
  const paths = excluded.map((f) => f.path);
  const list = paths.slice(0, 6).join(", ") + (paths.length > 6 ? `, … (${paths.length} total)` : "");
  return (
    `The user excluded ${paths.length} file${paths.length === 1 ? "" : "s"} from this commit: ${list}. ` +
    "They were NOT pushed — the branch does not contain them — and they are still pending in the workspace, " +
    "content intact. Do not push them again unless the user asks; if they were excluded because something " +
    "is wrong with them, fix that first."
  );
}
