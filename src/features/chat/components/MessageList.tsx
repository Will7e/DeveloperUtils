// ============================================================
// Message List — Scrolling Transcript with Auto-Stick
// ============================================================
// Renders the conversation transcript. Auto-scrolls to the bottom
// while streaming unless the user has scrolled up (then a
// "jump to latest" pill appears).

import React from "react";
import { ArrowDown } from "lucide-react";
import { MessageItem } from "./MessageItem";
import { ChatEmptyState } from "./ChatEmptyState";
import type { ChatMessage } from "../types";

/** Stable placeholder object used for the in-flight streaming bubble */
const STREAMING_PLACEHOLDER_MESSAGE: ChatMessage = {
  id: "__streaming__",
  role: "assistant",
  content: "",
  timestamp: 0,
};

interface MessageListProps {
  messages: ChatMessage[];
  /** Streaming text appended after the last committed message */
  streamingContent: string;
  isStreaming: boolean;
  defaultModel: string;
  onSuggestion: (text: string) => void;
  onRegenerate: () => void;
}

export function MessageList({
  messages,
  streamingContent,
  isStreaming,
  defaultModel,
  onSuggestion,
  onRegenerate,
}: MessageListProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [isPinned, setIsPinned] = React.useState(true);

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Track whether the user is at (or near) the bottom.
  // Also re-pins when a new conversation mounts (new key from the parent).
  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsPinned(distance < 80);
  }, []);

  // Stick to bottom while streaming (only when the user hasn't scrolled up)
  React.useEffect(() => {
    if (isStreaming && isPinned) {
      scrollToBottom("auto");
    }
  }, [streamingContent, isStreaming, isPinned, scrollToBottom]);

  // Initial scroll position on mount (per conversation — the parent
  // remounts this component with a key on conversation switch)
  React.useEffect(() => {
    scrollToBottom("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleMessages = messages;
  const lastAssistantIdx = (() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i]?.role === "assistant") return i;
    }
    return -1;
  })();

  if (visibleMessages.length === 0 && !isStreaming) {
    return <ChatEmptyState onSuggestion={onSuggestion} defaultModel={defaultModel} />;
  }

  return (
    <div className="chat-message-list-wrap">
      <div ref={scrollRef} className="chat-message-list" onScroll={handleScroll}>
        <div className="chat-message-list-inner">
          {visibleMessages.map((message, idx) => (
            <MessageItem
              key={message.id}
              message={message}
              canRegenerate={!isStreaming && idx === lastAssistantIdx}
              onRegenerate={onRegenerate}
            />
          ))}

          {isStreaming && streamingContent !== "" && (
            <MessageItem
              message={STREAMING_PLACEHOLDER_MESSAGE}
              streamingContentOverride={streamingContent}
              isStreaming
            />
          )}
        </div>
      </div>

      {!isPinned && (
        <button
          type="button"
          className="chat-jump-latest"
          onClick={() => {
            setIsPinned(true);
            scrollToBottom();
          }}
          aria-label="Jump to latest"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
