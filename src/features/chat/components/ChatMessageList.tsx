// ============================================================
// ChatMessageList — Enterprise Message Stream with Smart Auto-Scroll,
// Non-Disruptive Scroll Lock, Thinking State, and Floating Scroll Button
// ============================================================

import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronDown } from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
import { ChatMessageItem } from "./ChatMessageItem";
import { ChatEmptyState } from "./ChatEmptyState";
import { ProviderIcon } from "./ProviderIcon";
import { executeChatStream } from "../services/chat-runner";

/**
 * Hook to measure live elapsed seconds while streaming
 */
function useStreamingTimer(isStreaming: boolean, hasContent: boolean) {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!isStreaming || hasContent) {
      setElapsedSec(0);
      return;
    }

    const start = Date.now();
    const interval = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 100) / 10);
    }, 100);

    return () => clearInterval(interval);
  }, [isStreaming, hasContent]);

  return elapsedSec;
}

export function ChatMessageList() {
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const conversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === activeConversationId)
  );
  const activeProvider = useChatStore((s) => s.settings.activeProvider);
  const activeModel = useChatStore((s) => s.settings.activeModel);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const truncateMessagesFrom = useChatStore((s) => s.truncateMessagesFrom);
  const addMessage = useChatStore((s) => s.addMessage);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  const provider = conversation?.provider || activeProvider;
  const modelId = conversation?.model || activeModel;
  const messages = conversation?.messages || [];

  const elapsedThinkingTime = useStreamingTimer(isStreaming, Boolean(streamingContent));

  // Detect user scroll position to avoid hijacking scroll when reading past history
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    setIsScrolledUp(distanceFromBottom > 70);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  // Follow stream to bottom only if user hasn't scrolled up to read earlier history
  useEffect(() => {
    if (!isScrolledUp && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streamingContent, isStreaming, isScrolledUp]);

  // Handle regenerating an assistant response
  const handleRegenerate = useCallback(
    (messageId: string, modelOverride?: string) => {
      if (!activeConversationId || isStreaming) return;
      // Truncate from this assistant message onwards
      truncateMessagesFrom(activeConversationId, messageId);
      executeChatStream(activeConversationId, modelOverride);
    },
    [activeConversationId, isStreaming, truncateMessagesFrom]
  );

  // Handle editing a previous user prompt
  const handleEditAndResubmit = useCallback(
    (messageId: string, newContent: string) => {
      if (!activeConversationId || isStreaming) return;
      // Truncate from this user message onwards
      truncateMessagesFrom(activeConversationId, messageId);
      // Add the edited message and execute
      addMessage(activeConversationId, {
        role: "user",
        content: newContent,
      });
      executeChatStream(activeConversationId);
    },
    [activeConversationId, isStreaming, truncateMessagesFrom, addMessage]
  );

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="chat-scroll-area flex flex-col justify-center">
        <ChatEmptyState />
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="chat-scroll-area"
      >
        <div className="chat-messages-inner">
          {messages.map((msg) => (
            <ChatMessageItem
              key={msg.id}
              message={msg}
              provider={provider}
              modelId={modelId}
              onRegenerate={handleRegenerate}
              onEditAndResubmit={handleEditAndResubmit}
            />
          ))}

          {/* Live streaming assistant response */}
          {isStreaming && (
            streamingContent ? (
              <ChatMessageItem
                message={{
                  id: "streaming-live",
                  role: "assistant",
                  content: streamingContent,
                  timestamp: Date.now(),
                  model: modelId,
                }}
                provider={provider}
                modelId={modelId}
                isStreamingMessage={true}
              />
            ) : (
              /* Pre-Token Shimmer Thinking State */
              <div className="chat-message-row assistant">
                <div className="chat-avatar assistant">
                  <ProviderIcon
                    provider={provider}
                    modelId={modelId}
                    className="w-4 h-4 animate-pulse text-accent"
                  />
                </div>
                <div className="chat-bubble-assistant">
                  <div className="chat-thinking-container">
                    <div className="chat-thinking-header">
                      <span>Reasoning with {modelId}...</span>
                      <div className="chat-thinking-dots">
                        <span className="chat-thinking-dot" />
                        <span className="chat-thinking-dot" />
                        <span className="chat-thinking-dot" />
                      </div>
                      <span className="chat-thinking-timer">
                        {elapsedThinkingTime.toFixed(1)}s
                      </span>
                    </div>
                    <div className="chat-thinking-skeleton-line w-3/4" />
                    <div className="chat-thinking-skeleton-line w-1/2" />
                  </div>
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Floating "Scroll to Bottom" Pill when scrolled up */}
      {isScrolledUp && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="chat-scroll-bottom-btn"
          aria-label="Scroll to bottom"
        >
          {isStreaming ? (
            <>
              <span className="chat-scroll-bottom-dot" />
              <span>Generating response</span>
            </>
          ) : (
            <span>Scroll to bottom</span>
          )}
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
