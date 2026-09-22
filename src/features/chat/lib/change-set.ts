// ============================================================
// Change Set — The Agent's Code Changes, as Readable Diffs
// ============================================================
// One place turns a workspace snapshot into what a human actually
// wants to read: the changed files in path order, each with a
// unified diff and +/− stats, plus the totals for the whole set.
//
// Pure by design (same shape as lib/push-policy.ts). The panel that
// shows the agent's work, the push-approval gate and any future
// export all describe the SAME change set with the same diff
// algorithm — there is no second implementation to drift out of
// agreement with what is about to be shipped.

import type { WorkspaceChange, WorkspaceState } from "../types";
import { diffFile } from "../workspace/diff";

export interface ChangeSet {
  /** Changed files, path-ordered; each carries its unified diff */
  files: WorkspaceChange[];
  fileCount: number;
  additions: number;
  deletions: number;
  /** True when the agent has not edited anything yet */
  empty: boolean;
}

/** Nothing changed — the shape the panel renders when it has no work to show */
export const EMPTY_CHANGE_SET: ChangeSet = {
  files: [],
  fileCount: 0,
  additions: 0,
  deletions: 0,
  empty: true,
};

/**
 * Diffs every changed file in the workspace.
 *
 * Only files whose status left "unchanged" appear: the workspace also
 * holds files that were merely READ (to edit them), and a panel that
 * listed every read would bury the three real edits under thirty
 * untouched files.
 */
export function collectChangeSet(ws?: WorkspaceState | null): ChangeSet {
  if (!ws) return EMPTY_CHANGE_SET;

  const files: WorkspaceChange[] = [];
  for (const file of Object.values(ws.files)) {
    if (file.status === "unchanged") continue;
    const status =
      file.status === "added" || file.status === "deleted" ? file.status : "modified";
    files.push(diffFile(file.path, status, file.baseContent, file.content));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }

  return {
    files,
    fileCount: files.length,
    additions,
    deletions,
    empty: files.length === 0,
  };
}

/** One-line summary of a change set, for headers and toasts */
export function summarizeChangeSet(set: ChangeSet): string {
  if (set.empty) return "No changes yet";
  return `${set.fileCount} file${set.fileCount === 1 ? "" : "s"} · +${set.additions} −${set.deletions}`;
}
