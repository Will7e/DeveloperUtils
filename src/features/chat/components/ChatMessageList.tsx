// ============================================================
// ChatMessageList — Message history with auto-scroll & streaming
// ============================================================

import { useEffect, useRef } from "react";
import { useChatStore } from "@/stores/chat.store";
import { ChatMessageItem } from "./ChatMessageItem";
import { ChatEmptyState } from "./ChatEmptyState";
import { Loader2 } from "lucide-react";
import { ProviderIcon } from "./ProviderIcon";

export function ChatMessageList() {
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const conversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === activeConversationId)
  );
  const activeProvider = useChatStore((s) => s.settings.activeProvider);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const scrollRef = useRef<HTMLDivElement>(null);

  const provider = conversation?.provider || activeProvider;
  const modelId = conversation?.model;

  // Auto-scroll to bottom on message changes and during streaming
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation?.messages, streamingContent, isStreaming]);

  const messages = conversation?.messages || [];

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="chat-scroll-area flex flex-col justify-center">
        <ChatEmptyState />
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="chat-scroll-area">
      <div className="chat-messages-inner">
        {messages.map((msg) => (
          <ChatMessageItem
            key={msg.id}
            message={msg}
            provider={provider}
            modelId={modelId}
          />
        ))}

        {/* Live streaming bubble */}
        {isStreaming && (
          streamingContent ? (
            <ChatMessageItem
              message={{
                id: "streaming-temp",
                role: "assistant",
                content: streamingContent,
                timestamp: Date.now(),
              }}
              provider={provider}
              modelId={modelId}
            />
          ) : (
            <div className="chat-message-row assistant">
              <div className="chat-avatar assistant">
                <ProviderIcon
                  provider={provider}
                  modelId={modelId}
                  className="w-4 h-4 animate-pulse"
                />
              </div>
              <div className="chat-bubble-assistant">
                <div className="flex items-center gap-2 text-text-3 text-xs py-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                  <span>Generating response...</span>
                </div>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
