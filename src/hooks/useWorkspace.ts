// ============================================================
// useWorkspace — Subscribe to the Active Conversation's Workspace
// ============================================================
// Thin selectors so ChatPage can react to workspace/attachment
// changes without prop-drilling through the store's conversation
// list. Kept dependency-light on purpose.

import { useEffect } from "react";
import { useChatStore } from "@/stores/chat.store";
import { ensureWorkspaceReady } from "@/features/chat/services/workspace-bootstrap";

/** The active conversation's workspace (or undefined) */
export function useWorkspaceStoreSlice(): {
  conversationId: string | null;
  repoAttached: boolean;
} {
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const repoAttached = useChatStore(
    (s) => !!s.conversations.find((c) => c.id === s.activeConversationId)?.repoContext
  );

  useEffect(() => {
    if (activeConversationId && repoAttached) {
      void ensureWorkspaceReady(activeConversationId);
    }
  }, [activeConversationId, repoAttached]);

  return { conversationId: activeConversationId, repoAttached };
}
