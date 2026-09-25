// ============================================================
// Fork — Strand Workspace Snapshot / Restore (Braid P2)
// ============================================================
// A strand needs its own copy of the working copy so its edits can be
// thrown away wholesale. It must capture EVERYTHING the main turn could
// have changed, because a strand that forked from a mid-turn state and
// then lost its race would otherwise erase the winner's work on
// restore — and it must restore the tombstones too, because a strand
// that deleted a file must be able to undo that deletion exactly.
//
// This module is PURE: it takes a WorkspaceState value and returns
// values. The strand runtime owns calling it and committing results via
// the store's single workspace choke point (`setWorkspace`).
//
//   snapshot: deep-copy now → WorkspaceFork (immutable evidence)
//   restore:  deep-copy back   → exactly the bytes that were captured
//
// `nextRevision` stamps every mutated value, so a restored workspace
// is never revision-equal to the live one it replaced: the verification
// ledger's staleness comparison then invalidates evidence recorded
// against the pre-restore revision — which is correct, because the
// restore genuinely changed the bytes.

import { nextRevision } from "../identity/revision";
import type { WorkspaceFile, WorkspaceState } from "../types";

/** One strand's isolated copy of the working copy */
export interface WorkspaceFork {
  /** Epoch ms — provenance for the braid decision row */
  forkedAt: number;
  /** The revision (workspace.updatedAt) the fork was taken at */
  forkedAtRevision: number;
  /** Deep copy of the workspace at fork time */
  snapshot: WorkspaceState;
}

/** Deep-copies one workspace file record */
function cloneFile(file: WorkspaceFile): WorkspaceFile {
  return { ...file, content: file.content, baseContent: file.baseContent };
}

/** Deep-copies the workspace value */
function cloneWs(ws: WorkspaceState): WorkspaceState {
  return {
    ...ws,
    files: Object.fromEntries(Object.entries(ws.files).map(([p, f]) => [p, cloneFile(f)])),
    tree: ws.tree.map((entry) => ({ ...entry })),
    mutations: ws.mutations ? ws.mutations.map((m) => ({ ...m })) : undefined,
  };
}

/**
 * Captures an immutable fork of the CURRENT workspace value. The caller
 * passes the live value from the store; the returned fork shares no
 * mutable structure with it.
 */
export function forkWorkspace(ws: WorkspaceState): WorkspaceFork {
  return {
    forkedAt: Date.now(),
    forkedAtRevision: ws.updatedAt,
    snapshot: cloneWs(ws),
  };
}

/**
 * Restores a fork: returns a NEW WorkspaceState value with the exact
 * bytes (and tombstones) captured at fork time. Never mutates the
 * input; the caller commits the result through `setWorkspace`.
 *
 * The restored value keeps the forked conversation id — it is the same
 * thread's workspace, restored — and its revision is bumped strictly
 * past both the snapshot's and anything the live value reached, so
 * evidence recorded against any state the restore replaces goes stale.
 */
export function restoreWorkspace(fork: WorkspaceFork, live: WorkspaceState): WorkspaceState {
  const restored = cloneWs(fork.snapshot);
  return {
    ...restored,
    updatedAt: nextRevision(Math.max(fork.snapshot.updatedAt, live.updatedAt)),
  };
}
