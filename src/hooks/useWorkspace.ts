// ============================================================
// useWorkspace — Subscribe to the Active Thread's Attachment
// ============================================================
// Thin selectors so ChatPage can react to workspace/attachment
// changes without prop-drilling through the store's conversation
// list. Kept dependency-light on purpose.
//
// The effect below keys on the ATTACHMENT ID, not on "is a repository
// attached". That boolean cannot tell one repository from another, so switching
// a thread from repo A to repo B left it `true`, the effect never re-ran, and
// nothing about the workspace was re-derived — the reported "switching
// repository does nothing". An id changes when the repository does.

import { useEffect } from "react";
import { useChatStore } from "@/stores/chat.store";
import { ensureWorkspaceReady } from "@/features/chat/services/workspace-bootstrap";
import { attachmentIdOf } from "@/features/chat/identity/identity";

/** The active conversation's workspace (or undefined) */
export function useWorkspaceStoreSlice(): {
  conversationId: string | null;
  repoAttached: boolean;
} {
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const attachmentId = useChatStore((s) => {
    const repo = s.conversations.find((c) => c.id === s.activeConversationId)?.repoContext;
    return attachmentIdOf(repo);
  });
  const repoAttached = attachmentId !== null;

  useEffect(() => {
    if (activeConversationId && attachmentId) {
      void ensureWorkspaceReady(activeConversationId);
    }
  }, [activeConversationId, attachmentId]);

  return { conversationId: activeConversationId, repoAttached };
}
