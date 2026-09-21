// ============================================================
// Workspace Bootstrap — Attach-Time Workspace + Preview Startup
// ============================================================
// Called from ChatPage when a conversation has a repo attached:
// ensures the IDB-backed workspace exists (creating it on first
// attach) and kicks the first preview build so the pane shows the
// pristine app immediately.

import { useChatStore } from "@/stores/chat.store";
import { usePreviewStore } from "../preview/preview.store";
import { runPreviewBuild, detectEntry, isPreviewSupported } from "../preview/preview-runtime";

/** True when the workspace has any changes worth pushing */
export function workspaceHasChanges(conversationId: string): boolean {
  const ws = useChatStore.getState().workspaces[conversationId];
  if (!ws) return false;
  return Object.values(ws.files).some((f) => f.status !== "unchanged");
}

/**
 * Ensures a workspace exists for the conversation's attached repo
 * and starts the initial preview build. Safe to call repeatedly.
 */
export async function ensureWorkspaceReady(conversationId: string): Promise<void> {
  const state = useChatStore.getState();
  const conv = state.conversations.find((c) => c.id === conversationId);
  if (!conv?.repoContext || !state.settings.github.token) return;

  const ws = await state.ensureWorkspace(conversationId);
  if (!ws) return;

  // Only auto-build when an entry actually exists (avoids a
  // permanent "error" pane on API/backend repos with no UI)
  const preview = usePreviewStore.getState();
  if (preview.conversationId !== conversationId) {
    preview.setConversation(conversationId);
  }
  if (isPreviewSupported() && detectEntry(ws)) {
    void runPreviewBuild(ws);
  } else if (!detectEntry(ws)) {
    preview.setStatus("idle");
  }
}
