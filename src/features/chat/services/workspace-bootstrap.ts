// ============================================================
// Workspace Bootstrap — Attach-Time Binding + Workspace
// ============================================================
// Called from ChatPage when a conversation has a repo attached.
//
// The order of the two steps below is the whole point. The BINDING is declared
// first and the workspace is built second, so every artifact that follows —
// the working copy, the change set, the recorded evidence — is created already
// knowing which repository it belongs to. Building first and binding afterwards
// is how a workspace came to exist in memory with no record of what it was a
// copy of, and the read sites that followed had to guess.
//
// This function is also the one place a repository switch lands, because it is
// driven by the ATTACHMENT (see hooks/useWorkspace.ts), not by a boolean that
// cannot tell one repository from another.

import { useChatStore } from "@/stores/chat.store";
import { pinBase, setAttachment } from "../identity/bindings";

/** True when the workspace has any changes worth pushing */
export function workspaceHasChanges(conversationId: string): boolean {
  const ws = useChatStore.getState().workspaces[conversationId];
  if (!ws) return false;
  return Object.values(ws.files).some((f) => f.status !== "unchanged");
}

/**
 * Ensures a workspace exists for the conversation's attached repo.
 * Safe to call repeatedly.
 */
export async function ensureWorkspaceReady(conversationId: string): Promise<void> {
  const state = useChatStore.getState();
  const conv = state.conversations.find((c) => c.id === conversationId);
  const repo = conv?.repoContext;
  if (!repo || !state.settings.github.token) return;

  // 1. Declare the binding. Idempotent for the same repository, so re-attaching
  //    the repository a thread is already on evicts nothing.
  await setAttachment(conversationId, repo);

  const ws = await state.ensureWorkspace(conversationId);
  if (!ws) return;

  // 2. Record the revision the working copy was created from. A different base
  //    under the same attachment is a `base.moved`, which invalidates evidence
  //    and build sessions without touching the working copy.
  await pinBase(conversationId, repo, ws.baseCommitSha);
}
