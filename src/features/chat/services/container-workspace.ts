// ============================================================
// Container Workspace — Store-Side Glue For The Browser Workspace
// ============================================================
// `container/*` knows about trees and processes and nothing about this app's
// store; `agent-actions` knows about the store and nothing about mounts. This
// module is the seam, and it exists in `services/` because that is where the
// store is allowed to be read.
//
// Three things live here, and each is here because TWO callers need the same
// answer: `run_command` (a command the model chose) and the preview (a dev
// server the harness owns). A private copy in each would be two answers to "what
// does this thread's revision contain", and the preview would eventually start a
// server over a tree the executor never mounted.
//
// The file reader is the interesting one. Reads go: the workspace's own working
// copy first (an edited file is the revision being proven, not the repository's
// copy of it), then the shared per-repository base cache, then GitHub. The base
// cache matters more here than anywhere else in the app: hydrating a project
// means hundreds of reads, and they are the same bytes every thread on that
// repository would fetch.
// ============================================================

import { selectWorkspace, useChatStore } from "@/stores/chat.store";
import { getRepoBaseFile, rememberRepoBaseFile } from "../workspace/repo-base";
import { readFileContent } from "../lib/github-client";
import type { WorkspaceState } from "../types";
import { planWorkspaceMount, type MountPlanResult } from "../container/workspace-mount";
import { startPreview, stopPreview } from "../container/preview-bridge";
import { type WorkspaceOwner } from "../container/container-host";

/**
 * The thread a workspace operation belongs to, named for the other thread's sake.
 *
 * The label is not decoration: the only moment it is read is a handoff, when the
 * other agent is told — in its own turn note — which thread's tree it just took
 * over, and the user is told which agent's preview stopped. The conversation id
 * is the right label when the thread has no title yet, and the fallback is a
 * phrase rather than an id, because the sentence it lands in is shown to a person.
 */
export function workspaceOwnerFor(conversationId: string): WorkspaceOwner {
  const conversation = useChatStore.getState().conversations.find((entry) => entry.id === conversationId);
  const label = conversation?.title?.trim();
  return { threadId: conversationId, label: label && label.length > 0 ? label : "a thread without a title yet" };
}

/**
 * The repository's text at this workspace's base commit.
 *
 * Null is a normal outcome (binary, absent, unreadable) and is counted by the
 * hydrator rather than thrown — a project with one unreadable file still has a
 * test suite worth running.
 */
export async function readRepoFileAt(
  ws: WorkspaceState,
  path: string,
  token: string | null
): Promise<string | null> {
  // The working copy wins: reading the repository's version of a file the agent
  // just edited would mount the OLD bytes and then report a passing test about
  // code nobody wrote.
  const local = ws.files[path];
  if (local) return local.status === "deleted" ? null : local.content;

  const identity = { owner: ws.owner, repo: ws.repo, branch: ws.branch };
  const known = await getRepoBaseFile(identity, path, ws.baseCommitSha);
  if (known) return known.content;
  if (!token) return null;

  try {
    const file = await readFileContent(token, ws.owner, ws.repo, path, ws.branch);
    if (file.text === null || file.isBinary) return null;
    // Fire-and-forget: the cache is an optimisation and the mount must not wait
    // on it (or fail with it).
    void rememberRepoBaseFile(identity, path, ws.baseCommitSha, {
      content: file.text,
      sha: file.sha ?? null,
    });
    return file.text;
  } catch {
    return null;
  }
}

/**
 * One binary asset's raw bytes at this workspace's base commit.
 *
 * The order mirrors `readRepoFileAt` on purpose: the working copy wins (an
 * asset the agent replaced is served as replaced), then the base cache, then
 * the network. GitHub hands bytes over as base64 in `GitHubFileContent.base64`
 * — decoded here, once, at the boundary where bytes are the point.
 */
export async function readRepoAssetAt(
  ws: WorkspaceState,
  path: string,
  token: string | null
): Promise<Uint8Array | null> {
  const identity = { owner: ws.owner, repo: ws.repo, branch: ws.branch };
  const known = await getRepoBaseFile(identity, path, ws.baseCommitSha);
  if (known?.base64) return base64ToBytes(known.base64);
  if (!token) return null;

  try {
    const file = await readFileContent(token, ws.owner, ws.repo, path, ws.branch);
    // `base64` is set whenever the API returned bytes, text or not; `text`
    // alone would lose the file. Assets under the Contents API's 1 MB limit
    // ride the first call; the Blob fallback covers the rest.
    if (!file.base64) return null;
    void rememberRepoBaseFile(identity, path, ws.baseCommitSha, {
      content: file.text ?? "",
      sha: file.sha ?? null,
      base64: file.base64,
    });
    return base64ToBytes(file.base64);
  } catch {
    return null;
  }
}

/** base64 → bytes (no atob unicode path — this IS the bytes path) */
function base64ToBytes(payload: string): Uint8Array {
  const binary = atob(payload);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The container tree for the revision the caller is about to run against.
 *
 * The workspace is passed in rather than re-read from the store, because the
 * caller is the one that knows WHICH revision the result will be labelled with:
 * `run_command` records the ledger entry against `ws.updatedAt`, so the tree it
 * mounts has to be the tree that stamp describes. The GitHub token, by contrast,
 * is read here — it is a setting, not a revision, and threading it through every
 * caller would give each of them a chance to get it wrong.
 */
export async function mountPlanForWorkspace(
  ws: WorkspaceState
): Promise<{ ok: true; result: MountPlanResult } | { ok: false; error: string }> {
  const token = useChatStore.getState().settings.github.token ?? null;
  return planWorkspaceMount({
    ws,
    read: (path) => readRepoFileAt(ws, path, token),
    readBinary: (path) => readRepoAssetAt(ws, path, token),
  });
}

/**
 * Starts the thread's dev server — the one action the preview affordance offers.
 *
 * The revision is read HERE rather than passed in, because this is the only place
 * that knows the difference between "the revision the user is looking at" and
 * "the revision a button was rendered against": a click that is a second late
 * after an agent write would otherwise start a server over code that no longer
 * exists, and the preview would be showing the wrong thing without saying so.
 */
export async function startPreviewForConversation(
  conversationId: string
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const live = selectWorkspace(useChatStore.getState(), conversationId);
  const ws = live ?? (await useChatStore.getState().ensureWorkspace(conversationId));
  if (!ws) return { ok: false, error: "No workspace available — attach a repository first." };

  const mount = await mountPlanForWorkspace(ws);
  if (!mount.ok) return { ok: false, error: mount.error };
  const started = await startPreview({
    plan: mount.result.plan,
    revision: ws.updatedAt,
    mountNotes: mount.result.notes,
    owner: workspaceOwnerFor(conversationId),
  });
  if (!started.ok) return { ok: false, error: started.error };
  return { ok: true, url: started.url };
}

/** Stops it, with the reason recorded on the status (the strip shows it) */
export function stopPreviewForConversation(): void {
  stopPreview("The preview was stopped. The workspace is still running, so commands still work in it.");
}
