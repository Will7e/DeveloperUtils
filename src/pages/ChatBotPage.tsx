// ============================================================
// ChatBotPage — AI Assistant Full-Workspace Page
// ============================================================

import { useEffect } from "react";
import { ChatBot } from "@/features/chat/ChatBot";

export function ChatBotPage() {
  useEffect(() => {
    document.title = "AI Chat | InTab";
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full w-full overflow-hidden bg-bg-0">
      <ChatBot />
    </div>
  );
}
