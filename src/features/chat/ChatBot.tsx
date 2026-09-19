// ============================================================
// ChatBot — Main Chat Interface Orchestrator
// ============================================================

import { useEffect } from "react";
import { useChatStore } from "@/stores/chat.store";
import { useLocalStorageState } from "@/hooks/useLocalStorageState";
import { ChatSidebar } from "./components/ChatSidebar";
import { ChatHeader } from "./components/ChatHeader";
import { ChatMessageList } from "./components/ChatMessageList";
import { ChatInput } from "./components/ChatInput";
import { ChatSettingsModal } from "./components/ChatSettingsModal";
import "./chat.css";

export function ChatBot() {
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState(
    "intab_chat_sidebar_collapsed",
    false
  );

  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const createConversation = useChatStore((s) => s.createConversation);
  const selectConversation = useChatStore((s) => s.selectConversation);

  // Initialize first conversation on initial load if none exists or if active is orphaned
  useEffect(() => {
    if (conversations.length === 0) {
      createConversation();
    } else if (
      (!activeConversationId || !conversations.some((c) => c.id === activeConversationId)) &&
      conversations[0]
    ) {
      selectConversation(conversations[0].id);
    }
  }, [conversations, activeConversationId, createConversation, selectConversation]);

  return (
    <div className="chat-layout">
      {/* Collapsible conversation history sidebar */}
      <ChatSidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      {/* Main chat window */}
      <main className="chat-main">
        <ChatHeader
          sidebarOpen={!sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        />

        <ChatMessageList />

        <ChatInput />
      </main>

      {/* Settings Modal Dialog */}
      <ChatSettingsModal />
    </div>
  );
}
