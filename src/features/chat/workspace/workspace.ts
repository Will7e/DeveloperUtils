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
import { readFileContent } from "../lib/github-client";
import { nextRevision } from "../identity/revision";
import {
  getRepoBaseFile,
  getRepoBaseTree,
  rememberRepoBaseFile,
  type RepoIdentity,
} from "./repo-base";
import type {
  WorkspaceFile,
  WorkspaceFileStatus,
  WorkspaceState,
  WorkspaceTreeEntry,
} from "../types";
import { readValue, writeValue } from "@/services/idb-storage.service";
import { registerScopedResource } from "../identity/scoped-resources";

const IDB_KEY_PREFIX = "intab_workspace_";
const IDB_INDEX_PREFIX = "intab_workspace_index_";

/**
 * The key a workspace is PERSISTED under.
 *
 * `(conversation, repo@branch)`, not `conversation` alone. The key used to be
 * the conversation id, so attaching a second repository to a chat wrote over
 * the first one's record on the next save — silently discarding whatever was
 * uncommitted there. The workspace is the working copy OF A REPO, so the repo
 * belongs in its identity; with it, going back to the earlier repo restores
 * that work instead of losing it.
 */
export function workspaceRecordKey(
  conversationId: string,
  repo: { owner: string; repo: string; branch: string }
): string {
  return `${IDB_KEY_PREFIX}${conversationId}__${repo.owner}__${repo.repo}__${repo.branch}`;
}

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
    pushedAt: null,
    tree: [],
    files: {},
    updatedAt: Date.now(),
  };
}

/**
 * Loads the repo tree into the workspace (structure only).
 *
 * Through the shared repo base (see ./repo-base): the tree is a fact about
 * the REPOSITORY, identical for every chat on it, so the second chat pays
 * nothing for it. A miss falls through to GitHub exactly as before.
 */
export async function hydrateTree(
  ws: WorkspaceState,
  token: string
): Promise<WorkspaceState> {
  if (ws.tree.length > 0) return ws;
  const { tree } = await getRepoBaseTree(identityOf(ws), token, ws.baseCommitSha);
  // Listing the tree is not an edit: `updatedAt` is the revision the
  // verification ledger compares against (types.ts, WorkspaceState), so a
  // hydrate must leave it exactly where it was.
  return { ...ws, tree };
}

/** The repository a workspace is a working copy of */
function identityOf(ws: WorkspaceState): RepoIdentity {
  return { owner: ws.owner, repo: ws.repo, branch: ws.branch };
}

// ── Persistence (IDB, debounced per conversation) ────────────

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounce key: one pending save per persisted workspace, not per chat */
function saveSlot(ws: WorkspaceState): string {
  return workspaceRecordKey(ws.conversationId, ws);
}

/**
 * Every record written for a conversation, so deleting the chat can delete
 * all of its workspaces rather than the one that happened to be active.
 *
 * A tiny index record instead of a field on the conversation: the chat list
 * is persisted and synced elsewhere, and the set of repos a chat has touched
 * is storage bookkeeping, not part of what a conversation IS.
 */
async function rememberRecord(conversationId: string, key: string): Promise<void> {
  try {
    const raw = await readValue(IDB_INDEX_PREFIX + conversationId);
    const known = raw ? (JSON.parse(raw) as string[]) : [];
    if (known.includes(key)) return;
    await writeValue(IDB_INDEX_PREFIX + conversationId, JSON.stringify([...known, key]));
  } catch {
    /* best-effort: a missing index only costs a stale record */
  }
}

/**
 * Debounced save. The debounce slot is the WORKSPACE (chat + repo), so a
 * burst of edits in one chat cannot postpone the save of another chat's
 * workspace — and the conversation argument the internal callers pass is
 * already carried by `state`.
 */
function scheduleSave(_conversationId: string, state: WorkspaceState): void {
  const slot = saveSlot(state);
  const existing = saveTimers.get(slot);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    slot,
    setTimeout(() => {
      saveTimers.delete(slot);
      void persistWorkspace(state);
    }, WORKSPACE_SAVE_DEBOUNCE_MS)
  );
}

/**
 * Cancels any pending debounced save for one conversation's workspaces.
 *
 * A save is debounced, so a timer scheduled a moment before a chat is deleted
 * fires AFTER the deletion and writes the record straight back — the chat is
 * gone from the list and its working copy is on disk again, invisible. Nothing
 * had ever cancelled one, because the timer map is private to this module and
 * deletion happens in the store.
 */
export function cancelWorkspaceSaves(conversationId: string): void {
  const marker = `${IDB_KEY_PREFIX}${conversationId}__`;
  for (const [slot, timer] of [...saveTimers]) {
    if (slot.startsWith(marker)) {
      clearTimeout(timer);
      saveTimers.delete(slot);
    }
  }
}

/**
 * Registered for deletion, because a deleted chat's pending save is the one
 * thing here that outlives the chat it belongs to.
 */
registerScopedResource({
  name: "workspace.pending-saves",
  scope: "thread",
  release: ({ transition }) => {
    if (transition.type === "thread.deleted") cancelWorkspaceSaves(transition.threadId);
  },
});

/** Immediate IDB write (used on flush and before pushes) */
export async function persistWorkspace(ws: WorkspaceState): Promise<void> {
  try {
    const key = saveSlot(ws);
    await writeValue(key, JSON.stringify(ws));
    await rememberRecord(ws.conversationId, key);
  } catch (err) {
    console.warn("Workspace persistence failed:", err);
  }
}

/**
 * Loads the persisted workspace for a conversation's repo and branch, or null
 * when that pair has no record yet.
 *
 * The repo is part of the lookup, which is what makes re-attaching a first
 * repo come back to the work that was left there — and what stops a second
 * repo's workspace from overwriting the first.
 */
export async function loadWorkspace(
  conversationId: string,
  repo: { owner: string; repo: string; branch: string }
): Promise<WorkspaceState | null> {
  try {
    const raw = await readValue(workspaceRecordKey(conversationId, repo));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (!parsed || typeof parsed !== "object") return null;
    // The record names its own repo: a key that disagrees with its contents
    // is a record this code cannot trust.
    const matches =
      parsed.conversationId === conversationId &&
      parsed.owner === repo.owner &&
      parsed.repo === repo.repo &&
      parsed.branch === repo.branch;
    return matches ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Flushes any pending debounced save for this workspace.
 *
 * The conversation argument stays in the signature because the callers pass
 * it (ChatPage, the agent tools, the mention context) and it must equal
 * `ws.conversationId` — the workspace is authoritative for its own identity.
 */
export async function flushWorkspaceSave(_conversationId: string, ws: WorkspaceState): Promise<void> {
  const slot = saveSlot(ws);
  const timer = saveTimers.get(slot);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(slot);
  }
  await persistWorkspace(ws);
}

/** Removes every persisted workspace for a conversation */
export async function deleteWorkspace(conversationId: string): Promise<void> {
  try {
    const raw = await readValue(IDB_INDEX_PREFIX + conversationId);
    const keys = raw ? (JSON.parse(raw) as string[]) : [];
    for (const key of keys) {
      const timer = saveTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        saveTimers.delete(key);
      }
      await writeValue(key, null);
    }
    await writeValue(IDB_INDEX_PREFIX + conversationId, null);
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

  // Contents another chat on this repo already read: at the same base commit
  // the bytes are the same, so this is a hit rather than a second download.
  const identity = identityOf(ws);
  const known = await getRepoBaseFile(identity, path, ws.baseCommitSha);
  if (known) {
    const merged = mergeFetchedFile(ws, path, { text: known.content, sha: known.sha });
    if (!merged.ok) {
      return { ws, content: null, error: merged.error ?? `Could not load '${path}'.` };
    }
    return { ws: merged.ws, content: merged.ws.files[path]?.content ?? "" };
  }

  try {
    const file = await readFileContent(token, ws.owner, ws.repo, path, ws.branch);
    if (!file.isBinary && file.text !== null) {
      // Fire-and-forget: the shared cache is an optimisation, and the read
      // must not wait on it (or fail with it).
      void rememberRepoBaseFile(identity, path, ws.baseCommitSha, {
        content: file.text,
        sha: file.sha ?? null,
      });
    }
    const merged = mergeFetchedFile(ws, path, file);
    if (!merged.ok) {
      return { ws, content: null, error: merged.error ?? `Could not load '${path}'.` };
    }
    return { ws: merged.ws, content: merged.ws.files[path]?.content ?? "" };
  } catch (err) {
    return {
      ws,
      content: null,
      error: err instanceof Error ? err.message : "Failed to read the file from GitHub.",
    };
  }
}

/**
 * Folds already-fetched file text into the workspace. Pure: no
 * network, no store. Callers that fetch many files at once fetch in
 * parallel but must MERGE sequentially —
 * a workspace is a read-modify-write value, so concurrent merges on
 * one snapshot would silently drop all but the last file.
 */
export function mergeFetchedFile(
  ws: WorkspaceState,
  path: string,
  fetched: { text: string | null; sha: string | null; isBinary?: boolean }
): { ws: WorkspaceState; ok: boolean; error?: string } {
  // Already loaded (or tombstoned) — nothing to fold in.
  if (ws.files[path]) return { ws, ok: true };
  if (fetched.isBinary || fetched.text === null) {
    return { ws, ok: false, error: `File '${path}' is binary or too large to read.` };
  }
  const text = fetched.text;
  if (text.length > WORKSPACE_MAX_FILE_BYTES) {
    return {
      ws,
      ok: false,
      error: `File '${path}' exceeds the workspace size cap (${Math.round(WORKSPACE_MAX_FILE_BYTES / 1024)} KB).`,
    };
  }
  const wf: WorkspaceFile = {
    path,
    content: text,
    baseContent: text,
    baseSha: fetched.sha || null,
    status: "unchanged",
    updatedAt: Date.now(),
  };
  const next: WorkspaceState = {
    ...ws,
    files: { ...ws.files, [path]: wf },
  };
  scheduleSave(ws.conversationId, next);
  return { ws: next, ok: true };
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
  // Every branch of this function changes a file, so they all move the
  // revision — strictly, so two writes inside one millisecond cannot leave
  // the first one's evidence looking current (identity/revision.ts).
  const revision = nextRevision(ws.updatedAt);

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
      updatedAt: revision,
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
      updatedAt: revision,
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
    updatedAt: revision,
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
    updatedAt: nextRevision(ws.updatedAt),
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
    updatedAt: nextRevision(ws.updatedAt),
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
  const next: WorkspaceState = { ...ws, files, mutations: [], updatedAt: nextRevision(ws.updatedAt) };
  scheduleSave(ws.conversationId, next);
  return next;
}

/**
 * Updates baseShas + base content after a successful push.
 *
 * `paths` names the files actually committed. Anything outside it is left
 * pending on purpose: a file the user unchecked at the approval gate is
 * still only on this side of the branch, and marking it "unchanged" would
 * make the workspace claim content the repo does not have.
 */
export function markPushed(
  ws: WorkspaceState,
  commitSha: string,
  paths?: string[]
): WorkspaceState {
  const shipped = paths ? new Set(paths) : null;
  const files: Record<string, WorkspaceFile> = {};
  const stillPending = new Set<string>();
  for (const [path, f] of Object.entries(ws.files)) {
    if (shipped && !shipped.has(path)) {
      files[path] = f;
      stillPending.add(path);
      continue;
    }
    if (f.status === "deleted") {
      delete files[path];
      continue;
    }
    files[path] = { ...f, baseContent: f.content, baseSha: null, status: "unchanged", updatedAt: Date.now() };
  }
  // The push moved the base — the effect log's before-states are stale
  // from here on, except for excluded files: their change is still
  // pending, so their history has to stay rewindable.
  const mutations = (ws.mutations ?? []).filter((m) => stillPending.has(m.path));
  // The base moved, so the revision is expressed by `baseCommitSha` now —
  // the bytes on disk are the ones that were just pushed. Bumping the
  // counter here would retire evidence about EXACTLY those bytes, and the
  // binding release (binding.moved / base-moved) already says that proof
  // recorded against the old base no longer applies.
  return { ...ws, files, baseCommitSha: commitSha, mutations, pushedAt: Date.now() };
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

/**
 * Whether a workspace is a working copy of THAT repository and branch.
 *
 * Its own function because the check was missing twice: the in-memory guard
 * in `ensureWorkspace` returned whatever workspace the chat had, so attaching
 * a second repository kept reading the first one's files — with the evidence
 * (a tree, a base commit, edits) all naming the other repo. A workspace is
 * identified by its repo and branch, and anything that reuses one has to say
 * so out loud.
 */
export function workspaceMatchesRepo(
  ws: WorkspaceState | undefined | null,
  repo: { owner: string; repo: string; branch: string }
): boolean {
  return Boolean(
    ws && ws.owner === repo.owner && ws.repo === repo.repo && ws.branch === repo.branch
  );
}

/**
 * How many files a workspace has changed, or 0 when there is none.
 *
 * The chat list's summary of a thread's work. It is derived, never stored on
 * the workspace: the workspace IS the count's source of truth, and a second
 * copy inside it is a number that can disagree with the files.
 */
export function pendingChangeCount(ws: WorkspaceState | undefined | null): number {
  if (!ws) return 0;
  return Object.values(ws.files).filter((f) => f.status !== "unchanged").length;
}

/** Paths of files currently loaded into the workspace */
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
