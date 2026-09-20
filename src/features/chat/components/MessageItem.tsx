// ============================================================
// Message Item — Chat Bubble with Markdown & Actions
// ============================================================
// User messages render in an aligned neutral bubble; assistant
// messages render full-width with markdown + code blocks. Error
// messages use Geist red tokens. Streaming content is rendered
// inline with a blinking caret.

import React from "react";
import { Check, Copy, RefreshCw, TriangleAlert } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { MarkdownContent } from "./markdown";
import type { ChatMessage } from "../types";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTokens(n: number | null): string {
  if (n === null) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface MessageItemProps {
  message: ChatMessage;
  /** True while this message's content is still streaming */
  isStreaming?: boolean;
  /** Live streaming text; overrides message.content when set */
  streamingContentOverride?: string;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
}

export const MessageItem = React.memo(function MessageItem({
  message,
  isStreaming = false,
  streamingContentOverride,
  canRegenerate = false,
  onRegenerate,
}: MessageItemProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(streamingContentOverride ?? message.content).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard unavailable */
      }
    );
  }, [message.content, streamingContentOverride]);

  // Compaction marker — renders as a subtle divider chip
  if (message.compactedFrom !== undefined) {
    return (
      <div className="chat-compaction-divider" role="separator">
        <span className="chat-compaction-line" />
        <span className="chat-compaction-label">
          {message.compactedFrom} earlier message
          {message.compactedFrom === 1 ? "" : "s"} hidden to fit the context window
        </span>
        <span className="chat-compaction-line" />
      </div>
    );
  }

  const content = streamingContentOverride ?? message.content;
  const isUser = message.role === "user";

  return (
    <div className={`chat-msg ${isUser ? "chat-msg-user" : "chat-msg-assistant"} ${message.error ? "chat-msg-error" : ""}`}>
      <div className="chat-msg-meta">
        <span className="chat-msg-role">{isUser ? "You" : "Assistant"}</span>
        {message.model && !isUser && (
          <span className="chat-msg-model">{message.model}</span>
        )}
        <span className="chat-msg-meta-time">{formatTime(message.timestamp)}</span>
        {message.usage?.completionTokens != null && !isUser && (
          <span className="chat-msg-tokens">
            {formatTokens(message.usage.completionTokens)} tok
          </span>
        )}
        {message.usage?.cost != null && !isUser && message.usage.cost > 0 && (
          <span className="chat-msg-tokens">${message.usage.cost.toFixed(4)}</span>
        )}
      </div>

      <div className={`chat-msg-bubble ${isUser ? "chat-msg-bubble-user" : "chat-msg-bubble-assistant"}`}>
        {message.error ? (
          <div className="chat-msg-error-content">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            <span>{message.content}</span>
          </div>
        ) : (
          <MarkdownContent
            content={content}
            className="chat-md chat-md-assistant"
          />
        )}
        {isStreaming && <span className="chat-streaming-caret" aria-hidden="true" />}
      </div>

      {!isStreaming && !message.error && content && (
        <div className="chat-msg-actions">
          <SimpleTooltip content={copied ? "Copied" : "Copy"} side="top">
            <button
              type="button"
              className="chat-msg-action"
              onClick={handleCopy}
              aria-label="Copy message"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </button>
          </SimpleTooltip>
          {!isUser && canRegenerate && onRegenerate && (
            <SimpleTooltip content="Regenerate" side="top">
              <button
                type="button"
                className="chat-msg-action"
                onClick={onRegenerate}
                aria-label="Regenerate response"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </SimpleTooltip>
          )}
        </div>
      )}
    </div>
  );
});
