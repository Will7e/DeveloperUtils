// ============================================================
// Agent Workspace — Virtual Working Copy of the Attached Repo
// ============================================================
// The coding agent edits here, never directly on GitHub. The
// workspace mirrors the repo structure (lazy-loaded contents),
// tracks per-file status against the base commit, and persists to
// IndexedDB per conversation so long agent sessions survive
// reloads. GitHub writes happen only through the gated push flow
// (see lib/github-write.ts), which consumes snapshots from here.
//
// Store-free: mutation functions take the current state and return
// a new one; the chat store and IDB layer wire around them.

import {
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_SAVE_DEBOUNCE_MS,
} from "../constants";
import { recordDelete, recordWrite } from "./undo";
import { getRepoTree, readFileContent } from "../lib/github-client";
import type {
  WorkspaceFile,
  WorkspaceFileStatus,
  WorkspaceState,
  WorkspaceTreeEntry,
} from "../types";
import { readValue, writeValue } from "@/services/idb-storage.service";

const IDB_KEY_PREFIX = "intab_workspace_";

// ── Creation & hydration ─────────────────────────────────────

/** Creates an empty workspace bound to a conversation's repo context */
export function createWorkspace(
  conversationId: string,
  owner: string,
  repo: string,
  branch: string,
  baseCommitSha: string
): WorkspaceState {
  return {
    conversationId,
    owner,
    repo,
    branch,
    baseCommitSha,
    workingBranch: null,
    tree: [],
    files: {},
    updatedAt: Date.now(),
  };
}

/** Loads the repo tree into the workspace (structure only) */
export async function hydrateTree(
  ws: WorkspaceState,
  token: string
): Promise<WorkspaceState> {
  if (ws.tree.length > 0) return ws;
  const entries = await getRepoTree(token, ws.owner, ws.repo, ws.branch);
  const tree: WorkspaceTreeEntry[] = entries.map((e) => ({
    path: e.path,
    type: e.type,
    ...(e.type === "blob" && typeof e.size === "number" ? { size: e.size } : {}),
  }));
  return { ...ws, tree, updatedAt: Date.now() };
}

// ── Persistence (IDB, debounced per conversation) ────────────

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(conversationId: string, state: WorkspaceState): void {
  const existing = saveTimers.get(conversationId);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    conversationId,
    setTimeout(() => {
      saveTimers.delete(conversationId);
      void persistWorkspace(state);
    }, WORKSPACE_SAVE_DEBOUNCE_MS)
  );
}

/** Immediate IDB write (used on flush and before pushes) */
export async function persistWorkspace(ws: WorkspaceState): Promise<void> {
  try {
    await writeValue(IDB_KEY_PREFIX + ws.conversationId, JSON.stringify(ws));
  } catch (err) {
    console.warn("Workspace persistence failed:", err);
  }
}

/** Loads a persisted workspace, or null when none exists */
export async function loadWorkspace(conversationId: string): Promise<WorkspaceState | null> {
  try {
    const raw = await readValue(IDB_KEY_PREFIX + conversationId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (parsed && typeof parsed === "object" && parsed.conversationId === conversationId) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Flushes any pending debounced save for the conversation */
export async function flushWorkspaceSave(conversationId: string, ws: WorkspaceState): Promise<void> {
  const timer = saveTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(conversationId);
  }
  await persistWorkspace(ws);
}

/** Removes the persisted workspace (conversation deleted / repo detached) */
export async function deleteWorkspace(conversationId: string): Promise<void> {
  const timer = saveTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(conversationId);
  }
  try {
    await writeValue(IDB_KEY_PREFIX + conversationId, null);
  } catch {
    /* best-effort */
  }
}

// ── Reads ────────────────────────────────────────────────────

/**
 * Reads a file's working content. Loads from GitHub on first touch
 * (lazy) and records it as unchanged. Never throws — read errors
 * return a null content with the error message.
 */
export async function readFile(
  ws: WorkspaceState,
  token: string,
  path: string
): Promise<{ ws: WorkspaceState; content: string | null; error?: string }> {
  const existing = ws.files[path];
  if (existing) {
    if (existing.status === "deleted") {
      return { ws, content: null, error: `File '${path}' is deleted in the workspace.` };
    }
    return { ws, content: existing.content };
  }

  // Verify the path exists in the tree before hitting the network
  const entry = ws.tree.find((e) => e.path === path);
  if (ws.tree.length > 0 && !entry) {
    return { ws, content: null, error: `File '${path}' not found in the repository tree.` };
  }

  try {
    const file = await readFileContent(token, ws.owner, ws.repo, path, ws.branch);
    if (file.isBinary || file.text === null) {
      return { ws, content: null, error: `File '${path}' is binary or too large to read.` };
    }
    const text = file.text;
    if (text.length > WORKSPACE_MAX_FILE_BYTES) {
      return {
        ws,
        content: null,
        error: `File '${path}' exceeds the workspace size cap (${Math.round(WORKSPACE_MAX_FILE_BYTES / 1024)} KB).`,
      };
    }
    const wf: WorkspaceFile = {
      path,
      content: text,
      baseContent: text,
      baseSha: file.sha || null,
      status: "unchanged",
      updatedAt: Date.now(),
    };
    const next: WorkspaceState = {
      ...ws,
      files: { ...ws.files, [path]: wf },
      updatedAt: Date.now(),
    };
    scheduleSave(ws.conversationId, next);
    return { ws: next, content: text };
  } catch (err) {
    return {
      ws,
      content: null,
      error: err instanceof Error ? err.message : "Failed to read the file from GitHub.",
    };
  }
}

/** True when the file has been loaded locally (no network read needed) */
export function isFileLoaded(ws: WorkspaceState, path: string): boolean {
  return ws.files[path] !== undefined;
}

// ── Mutations ────────────────────────────────────────────────

/**
 * Writes (creates or overwrites) a file. Content must already be
 * loaded for modifications of existing repo files — the agent tool
 * flow guarantees a read happens first; for brand-new files the
 * base is empty and status is "added".
 */
export function writeFile(
  ws: WorkspaceState,
  path: string,
  content: string
): { ws: WorkspaceState; ok: boolean; error?: string } {
  const existing = ws.files[path];
  const now = Date.now();

  // Capture the BEFORE state for the effect log (undo). Recorded
  // below only when the write actually changes the file.
  const before = existing && existing.status !== "deleted"
    ? { content: existing.content, status: existing.status, baseSha: existing.baseSha }
    : null;

  if (!existing) {
    // New file. If the tree knows the path (not yet loaded locally),
    // we cannot base a diff on it — force a load first via readFile.
    const inTree = ws.tree.length > 0 && ws.tree.some((e) => e.path === path && e.type === "blob");
    if (inTree) {
      return {
        ws,
        ok: false,
        error: `File '${path}' exists in the repo but is not loaded — read it before writing.`,
      };
    }
    if (content.length > WORKSPACE_MAX_FILE_BYTES) {
      return { ws, ok: false, error: `Content exceeds the ${Math.round(WORKSPACE_MAX_FILE_BYTES / 1024)} KB workspace cap.` };
    }
    const wf: WorkspaceFile = {
      path,
      content,
      baseContent: "",
      baseSha: null,
      status: "added",
      updatedAt: now,
    };
    const mutated: WorkspaceState = {
      ...ws,
      files: { ...ws.files, [path]: wf },
      tree: upsertTreeEntry(ws.tree, path),
      updatedAt: now,
    };
    const next = recordWrite(ws, path, before, mutated, `created ${path}`);
    scheduleSave(ws.conversationId, next);
    return { ws: next, ok: true };
  }

  if (existing.status === "deleted") {
    // Resurrect a deleted file with the new content
    const status: WorkspaceFileStatus = existing.baseSha === null ? "added" : "modified";
    const wf: WorkspaceFile = { ...existing, content, status, updatedAt: now };
    const mutated: WorkspaceState = {
      ...ws,
      files: { ...ws.files, [path]: wf },
      updatedAt: now,
    };
    const next = recordWrite(ws, path, before, mutated, `wrote ${path}`);
    scheduleSave(ws.conversationId, next);
    return { ws: next, ok: true };
  }

  if (content === existing.content) {
    return { ws, ok: true }; // no-op write — not an error
  }
  if (content.length > WORKSPACE_MAX_FILE_BYTES) {
    return { ws, ok: false, error: `Content exceeds the ${Math.round(WORKSPACE_MAX_FILE_BYTES / 1024)} KB workspace cap.` };
  }

  const status: WorkspaceFileStatus = existing.status === "added" ? "added" : "modified";
  const wf: WorkspaceFile = { ...existing, content, status, updatedAt: now };
  const mutated: WorkspaceState = {
    ...ws,
    files: { ...ws.files, [path]: wf },
    updatedAt: now,
  };
  const next = recordWrite(ws, path, before, mutated, `wrote ${path}`);
  scheduleSave(ws.conversationId, next);
  return { ws: next, ok: true };
}

/** Marks a file deleted (kept as a tombstone until push or revert) */
export function deleteFile(ws: WorkspaceState, path: string): { ws: WorkspaceState; ok: boolean; error?: string } {
  const existing = ws.files[path];
  if (!existing) {
    const inTree = ws.tree.length > 0 && ws.tree.some((e) => e.path === path && e.type === "blob");
    if (!inTree) {
      return { ws, ok: false, error: `File '${path}' not found in the workspace or repo tree.` };
    }
    return {
      ws,
      ok: false,
      error: `File '${path}' must be read before it can be deleted (contents not loaded).`,
    };
  }
  const deletionBefore = {
    content: existing.content,
    status: existing.status,
    baseSha: existing.baseSha,
  };
  const wf: WorkspaceFile = { ...existing, content: "", status: "deleted", updatedAt: Date.now() };
  const mutated: WorkspaceState = {
    ...ws,
    files: { ...ws.files, [path]: wf },
    updatedAt: Date.now(),
  };
  const next = recordDelete(ws, path, deletionBefore, mutated, `deleted ${path}`);
  scheduleSave(ws.conversationId, next);
  return { ws: next, ok: true };
}

/** Reverts one file to its base content (or removes it if added) */
export function revertFile(ws: WorkspaceState, path: string): WorkspaceState {
  const existing = ws.files[path];
  if (!existing) return ws;
  const files = { ...ws.files };
  if (existing.status === "added") {
    delete files[path];
  } else {
    files[path] = {
      ...existing,
      content: existing.baseContent,
      status: "unchanged",
      updatedAt: Date.now(),
    };
  }
  // User-initiated revert replaces agent history for this file — the
  // effect log would describe states the user just discarded.
  const cleared: WorkspaceState = {
    ...ws,
    files,
    mutations: (ws.mutations ?? []).filter((m) => m.path !== path),
    updatedAt: Date.now(),
  };
  scheduleSave(ws.conversationId, cleared);
  return cleared;
}

/** Reverts every changed file back to the base commit state */
export function revertAll(ws: WorkspaceState): WorkspaceState {
  const files: Record<string, WorkspaceFile> = {};
  for (const [path, f] of Object.entries(ws.files)) {
    if (f.status === "added") continue;
    files[path] = { ...f, content: f.baseContent, status: "unchanged", updatedAt: Date.now() };
  }
  const next: WorkspaceState = { ...ws, files, mutations: [], updatedAt: Date.now() };
  scheduleSave(ws.conversationId, next);
  return next;
}

/** Updates baseShas + base content after a successful push */
export function markPushed(ws: WorkspaceState, commitSha: string): WorkspaceState {
  const files: Record<string, WorkspaceFile> = {};
  for (const [path, f] of Object.entries(ws.files)) {
    if (f.status === "deleted") {
      delete files[path];
      continue;
    }
    files[path] = { ...f, baseContent: f.content, baseSha: null, status: "unchanged", updatedAt: Date.now() };
  }
  // The push moved the base — the effect log's before-states are
  // stale from here on.
  return { ...ws, files, baseCommitSha: commitSha, mutations: [], updatedAt: Date.now() };
}

// ── Push snapshots ───────────────────────────────────────────

export interface PushFile {
  path: string;
  /** null → delete the file in the new tree */
  content: string | null;
  baseSha: string | null;
  status: WorkspaceFileStatus;
}

/** All changed files (modified/added/deleted) to include in a push */
export function collectChanges(ws: WorkspaceState): PushFile[] {
  const out: PushFile[] = [];
  for (const f of Object.values(ws.files)) {
    if (f.status === "unchanged") continue;
    out.push({
      path: f.path,
      content: f.status === "deleted" ? null : f.content,
      baseSha: f.baseSha,
      status: f.status,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Paths of loaded files (for the preview bundler's virtual FS) */
export function loadedFilePaths(ws: WorkspaceState): string[] {
  return Object.values(ws.files)
    .filter((f) => f.status !== "deleted")
    .map((f) => f.path);
}

// ── Tree helpers ─────────────────────────────────────────────

function upsertTreeEntry(tree: WorkspaceTreeEntry[], path: string): WorkspaceTreeEntry[] {
  if (tree.some((e) => e.path === path)) return tree;
  return [...tree, { path, type: "blob" as const }];
}
