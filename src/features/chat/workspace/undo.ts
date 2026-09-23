// ============================================================
// Workspace Effect Log — Reversible Agent Mutations
// ============================================================
// Inspired by the Cordis "compositional recovery" guarantee behind
// DeepSeek Harness: every tracked effect records its exact inverse,
// so undoing lands the workspace in the state it would have had if
// the mutation never happened. Applied here at the workspace level:
//
//   • write_file / delete_file (agent mutations) append a
//     WorkspaceMutation with the file's BEFORE state to ws.mutations
//   • undoLast(ws) applies the newest mutation's inverse (LIFO)
//   • rewindTo(ws, id) rewinds across mutations back to a point
//
// User-initiated state changes (revert file/all, push/markPushed)
// truncate the log instead of recording — the log tracks AGENT
// mutations, and a push moves the base anyway. Mutations are capped
// (MUTATIONS_MAX) and persisted inside WorkspaceState by the
// existing debounced IDB save — no new storage layer.
//
// Pure functions over WorkspaceState; callers wire the store and the
// persistence flush (same contract as the rest of workspace.ts).

import { generateId } from "@/lib/utils";
import { nextRevision } from "../identity/revision";
import type {
  WorkspaceFile,
  WorkspaceFileStatus,
  WorkspaceState,
} from "../types";

/** Maximum recorded mutations per workspace (oldest dropped) */
export const MUTATIONS_MAX = 100;

export type WorkspaceMutationKind = "write" | "delete";

/** Snapshot of the file state before a mutation */
export interface WorkspaceMutationBefore {
  content: string;
  status: WorkspaceFileStatus;
  baseSha: string | null;
  /**
   * Snapshot content was dropped (over UNDO_CONTENT_MAX_CHARS) —
   * the record stays for audit but undo skips past it.
   */
  dropped?: boolean;
}

/** One recorded agent mutation with its undo information */
export interface WorkspaceMutation {
  id: string;
  /** Epoch ms — for display ordering only (LIFO is array order) */
  at: number;
  kind: WorkspaceMutationKind;
  path: string;
  /**
   * File state BEFORE the mutation (the inverse's target).
   * `null` means the path had NO file before — the inverse is a
   * removal. Oversized snapshots carry `dropped: true`.
   */
  before: WorkspaceMutationBefore | null;
  /** Short label for the undo UI */
  summary?: string;
}

/**
 * Content kept per `before` snapshot. Snapshots larger than this
 * record a `null` content, which makes that mutation non-restorable
 * (undo stops before it) — far better than megabytes of history.
 * Most agent edits are far below this cap.
 */
export const UNDO_CONTENT_MAX_CHARS = 200_000;

// ── Recording ────────────────────────────────────────────────

/** Appends a mutation record, dropping the oldest beyond the cap */
function appendMutation(ws: WorkspaceState, m: Omit<WorkspaceMutation, "id" | "at">): WorkspaceState {
  const record: WorkspaceMutation = { ...m, id: generateId(), at: Date.now() };
  const mutations = [...ws.mutations ?? [], record];
  return {
    ...ws,
    mutations: mutations.length > MUTATIONS_MAX ? mutations.slice(mutations.length - MUTATIONS_MAX) : mutations,
  };
}

/** Shapes a before-snapshot, marking oversized contents as dropped */
function shapeBefore(
  before: { content: string; status: WorkspaceFile["status"]; baseSha: string | null }
): WorkspaceMutationBefore {
  if (before.content.length <= UNDO_CONTENT_MAX_CHARS) {
    return { content: before.content, status: before.status, baseSha: before.baseSha };
  }
  return { content: "", status: before.status, baseSha: before.baseSha, dropped: true };
}

/** Called by writeFile AFTER a successful mutation of `path` */
export function recordWrite(
  ws: WorkspaceState,
  path: string,
  before: { content: string; status: WorkspaceFile["status"]; baseSha: string | null } | null,
  next: WorkspaceState,
  summary?: string
): WorkspaceState {
  return appendMutation(next, {
    kind: "write",
    path,
    before: before ? shapeBefore(before) : null,
    summary,
  });
}

/** Called by deleteFile AFTER a successful deletion of `path` */
export function recordDelete(
  ws: WorkspaceState,
  path: string,
  before: { content: string; status: WorkspaceFile["status"]; baseSha: string | null } | null,
  next: WorkspaceState,
  summary?: string
): WorkspaceState {
  return appendMutation(next, {
    kind: "delete",
    path,
    before: before ? shapeBefore(before) : null,
    summary,
  });
}

// ── Undo ─────────────────────────────────────────────────────

/**
 * True when the newest mutation can be undone: it exists, and its
 * before-snapshot was fully captured (not dropped for size).
 */
export function canUndo(ws: WorkspaceState): boolean {
  const last = ws.mutations?.[ws.mutations.length - 1];
  return last !== undefined && last.before?.dropped !== true;
}

/**
 * Restores the file to its before-mutation state. `before: null`
 * means the path had no file before — the inverse is a removal.
 * `carry` preserves the CURRENT content through an undo step: a
 * deletion's before-snapshot holds empty content (the tombstone),
 * so undoing across it must re-take the content from the state the
 * undo chain started from.
 */
function restoreBefore(
  ws: WorkspaceState,
  m: WorkspaceMutation,
  now: number,
  carry?: string
): WorkspaceState {
  const files = { ...ws.files };
  const b = m.before;
  if (!b || b.status === "added") {
    // The file did not exist before — remove it entirely
    delete files[m.path];
  } else {
    const current = files[m.path];
    const content = carry !== undefined && current?.status === "deleted" ? carry : b.content;
    files[m.path] = {
      path: m.path,
      content,
      baseContent: current?.baseContent ?? b.content,
      baseSha: b.baseSha,
      status: b.status,
      updatedAt: now,
    };
  }
  // Undoing restores code, so it moves the revision — and it must move it
  // strictly, since an undo usually follows the mutation it reverses by
  // less than a millisecond's worth of clock (identity/revision.ts).
  return { ...ws, files, updatedAt: nextRevision(ws.updatedAt) };
}

/**
 * The content undo/rewind carries across deletion tombstones: the
 * content of the target path at the moment the chain started (or
 * undefined when no file exists to carry).
 */
function carriedContent(ws: WorkspaceState, path: string): string | undefined {
  const f = ws.files[path];
  return f && f.status !== "deleted" ? f.content : undefined;
}

/**
 * Undoes the newest agent mutation (LIFO). The undone record is
 * removed from the log, so undo is itself re-runnable step by step.
 * Dropped-snapshot records are skipped (they only note that a
 * restorable inverse is unavailable). Returns the input state
 * unchanged when there is nothing to undo.
 */
export function undoLast(ws: WorkspaceState): WorkspaceState {
  const mutations = ws.mutations ?? [];
  const last = mutations[mutations.length - 1];
  if (!last) return ws;
  const now = Date.now();
  if (last.before?.dropped === true) {
    // No restorable inverse; drop the dead record so undo reaches
    // the next restorable mutation. Nothing was restored, so this is
    // bookkeeping and the revision stays where it is.
    return { ...ws, mutations: mutations.slice(0, -1) };
  }
  const carry = last.before?.status === "deleted" ? carriedContent(ws, last.path) : undefined;
  const next = restoreBefore(ws, last, now, carry);
  return { ...next, mutations: mutations.slice(0, -1) };
}

/**
 * Rewinds the workspace to the state right AFTER `mutationId` was
 * applied: every later mutation is undone; the target and earlier
 * records stay in the log. Exclusive semantics make "back to this
 * edit" mean what the label says. Unknown ids are a no-op.
 */
export function rewindTo(ws: WorkspaceState, mutationId: string): WorkspaceState {
  const mutations = ws.mutations ?? [];
  const targetIdx = mutations.findIndex((m) => m.id === mutationId);
  if (targetIdx === -1) return ws;

  let next = ws;
  const now = Date.now();
  for (let i = mutations.length - 1; i > targetIdx; i--) {
    const m = mutations[i]!;
    if (m.before?.dropped === true) continue;
    const carry = m.before?.status === "deleted" ? carriedContent(next, m.path) : undefined;
    next = restoreBefore(next, m, now, carry);
  }
  return { ...next, mutations: mutations.slice(0, targetIdx + 1) };
}

/**
 * Drops the whole mutation log (user-initiated revert / push): the
 * remaining records would describe a state the user just replaced
 * on purpose.
 */
export function clearMutationLog(ws: WorkspaceState): WorkspaceState {
  if (!ws.mutations?.length) return ws;
  // Dropping the log is bookkeeping: the code is untouched, so the
  // revision is too (workspace.ts `markPushed` does the same on a push).
  return { ...ws, mutations: [] };
}

/** True when the file state differs from what the mutation recorded */
export function isUndoableState(ws: WorkspaceState, m: WorkspaceMutation): boolean {
  if (m.before?.dropped === true) return false;
  const f = ws.files[m.path];
  if (m.before === null) return f !== undefined; // creation: undoable while the file exists
  if (!f) return true; // file gone since: restore still applies
  return f.content !== m.before.content || f.status !== m.before.status;
}
