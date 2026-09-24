// ============================================================
// Message Item — Chat Bubble with Markdown, Reasoning & Actions
// ============================================================
// User messages render in an aligned neutral bubble; assistant
// messages render full-width with markdown + highlighted code
// blocks. Reasoning-model output gets a collapsible "thinking"
// panel above the answer. Error messages use Geist red tokens.
// Streaming content is rendered inline with a blinking caret.

import React from "react";
import { Brain, Check, ChevronDown, Copy, Image as ImageIcon, RefreshCw, TriangleAlert, Zap } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { MarkdownContent } from "./markdown";
import { ToolCallBlock } from "./ToolCallBlock";
import { ProviderMark } from "./ProviderLogo";
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

/** Tokens per second from usage + latency, or null when unknown */
function tokensPerSecond(message: ChatMessage): number | null {
  const tokens = message.usage?.completionTokens;
  if (!tokens || !message.latencyMs) return null;
  const seconds = message.latencyMs / 1000;
  if (seconds <= 0) return null;
  return tokens / seconds;
}

interface MessageItemProps {
  message: ChatMessage;
  /** True while this message's content is still streaming */
  isStreaming?: boolean;
  /** Live streaming text; overrides message.content when set */
  streamingContentOverride?: string;
  /** Live reasoning text for the in-flight message */
  streamingReasoningOverride?: string;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  /** Full transcript — lets tool blocks find their paired results */
  allMessages?: ChatMessage[];
  /**
   * A live transcript search matched this message.
   *
   * `current` is the one Enter is standing on. Passed as a prop rather than
   * applied to the DOM after the fact because the transcript re-renders on every
   * streamed token, which is exactly when an imperatively-added class gets
   * silently dropped.
   */
  findHit?: "match" | "current";
}

export const MessageItem = React.memo(function MessageItem({
  message,
  isStreaming = false,
  streamingContentOverride,
  streamingReasoningOverride,
  canRegenerate = false,
  onRegenerate,
  allMessages = [],
  findHit,
}: MessageItemProps) {
  const [copied, setCopied] = React.useState(false);
  const [reasoningOpen, setReasoningOpen] = React.useState(false);

  const reasoning = isStreaming
    ? (streamingReasoningOverride ?? message.reasoning ?? "")
    : (message.reasoning ?? "");
  const hasReasoning = reasoning.trim().length > 0;

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

  // ── Agent-activity messages render as tool blocks, not bubbles ──
  // Standalone results (whose calls message was compacted away) render
  // as a subtle divider so the transcript never shows raw JSON bubbles.
  if (message.toolCalls && allMessages.length > 0) {
    return <ToolCallBlock message={message} allMessages={allMessages} />;
  }
  if (message.toolResult) {
    return null;
  }

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
  const tps = tokensPerSecond(message);
  const cachedTokens = message.usage?.cachedTokens ?? 0;

  return (
    <div
      className={`chat-msg ${isUser ? "chat-msg-user" : "chat-msg-assistant"} ${
        message.error ? "chat-msg-error" : ""
      } ${findHit === "current" ? "chat-msg-find-current" : findHit === "match" ? "chat-msg-find-hit" : ""}`}
      data-message-id={message.id}
    >
      <div className="chat-msg-meta">
        <span className="chat-msg-role">{isUser ? "You" : "Assistant"}</span>
        {message.model && !isUser && (
          <span className="chat-msg-model">
            <ProviderMark modelId={message.model} className="h-3 w-3 chat-msg-model-logo" />
            {message.model}
            {message.effort && (
              <span className="chat-msg-model-state" title="Reasoning effort">
                {message.effort}
              </span>
            )}
          </span>
        )}
        <span className="chat-msg-meta-time">{formatTime(message.timestamp)}</span>
        {/* Prompt tokens: what this turn actually cost to send. The
            number comes from the provider's usage frame, so it is
            exact — see usage.promptTokens on the message. */}
        {message.usage?.promptTokens != null && !isUser && (
          <span className="chat-msg-tokens" title="Prompt tokens sent with this request (exact)">
            {formatTokens(message.usage.promptTokens)} in
          </span>
        )}
        {message.usage?.completionTokens != null && !isUser && (
          <span className="chat-msg-tokens" title="Tokens this reply generated">
            {formatTokens(message.usage.completionTokens)} out
          </span>
        )}
        {cachedTokens > 0 && !isUser && (
          <span
            className="chat-msg-tokens chat-msg-cache"
            title={`${cachedTokens.toLocaleString()} prompt tokens were served from the prompt cache — billed at a discount`}
          >
            <Zap className="h-3 w-3" />
            {formatTokens(cachedTokens)} cached
          </span>
        )}
        {/* Which upstream provider answered. The same model id is served by
            many providers at different prices and quality, and with routing and
            failover the answer is not predictable from the request — so it is
            reported per reply rather than assumed. `X-Provider-Name`, when the
            deployment's CORS allows reading it. */}
        {message.usage?.providerName && !isUser && (
          <span
            className="chat-msg-tokens chat-msg-provider"
            title={
              `Provider \`${message.usage.providerName}\` served this reply. The same ` +
              "model is offered by many upstreams at different prices and quality, so the " +
              "reply is attributed to the one that actually answered it."
            }
          >
            {message.usage.providerName}
          </span>
        )}
        {tps !== null && !isUser && (
          <span className="chat-msg-tokens" title="Completion throughput">
            {tps.toFixed(1)} tok/s
          </span>
        )}
        {message.usage?.cost != null && !isUser && message.usage.cost > 0 && (
          <span className="chat-msg-tokens">${message.usage.cost.toFixed(4)}</span>
        )}
      </div>

      {/* Reasoning panel — collapsible chain-of-thought from reasoning models */}
      {hasReasoning && !isUser && (
        <div className={`chat-reasoning ${reasoningOpen ? "chat-reasoning-open" : ""}`}>
          <button
            type="button"
            className="chat-reasoning-header"
            onClick={() => setReasoningOpen((v) => !v)}
            aria-expanded={reasoningOpen}
          >
            <Brain className="chat-reasoning-icon h-3 w-3" aria-hidden="true" />
            <span className="chat-reasoning-label">
              {isStreaming && !content
                ? "Thinking…"
                : `Thought process${message.reasoningMs ? ` · ${(message.reasoningMs / 1000).toFixed(1)}s` : ""}`}
            </span>
            <ChevronDown className="chat-reasoning-chevron h-3 w-3" aria-hidden="true" />
          </button>
          {(reasoningOpen || (isStreaming && !content)) && (
            <div className="chat-reasoning-body">{reasoning}</div>
          )}
        </div>
      )}

      <div className={`chat-msg-bubble ${isUser ? "chat-msg-bubble-user" : "chat-msg-bubble-assistant"}`}>
        {/* Attached images — thumbnails above the text content; images
            excluded from Cloud Sync render as metadata-only chips */}
        {isUser && (message.attachments ?? []).length > 0 && (
          <div className="chat-msg-attachments">
            {(message.attachments ?? []).map((att) =>
              att.dataUrl ? (
                <a
                  key={att.id}
                  className="chat-msg-attachment"
                  href={att.dataUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`${att.name} — open full size`}
                >
                  <img
                    src={att.dataUrl}
                    alt={att.name}
                    className="chat-msg-attachment-img"
                    loading="lazy"
                  />
                </a>
              ) : (
                <span
                  key={att.id}
                  className="chat-msg-attachment-stub"
                  title={`${att.name} — image not synced (excluded in Chat Settings)`}
                >
                  <ImageIcon className="h-3 w-3 shrink-0" />
                  <span className="chat-msg-attachment-stub-name">{att.name}</span>
                  <span className="chat-msg-attachment-stub-note">not synced</span>
                </span>
              )
            )}
          </div>
        )}
        {message.error ? (
          <div className="chat-msg-error-content">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 chat-msg-error-icon" />
            <span>{message.content}</span>
          </div>
        ) : content ? (
          <MarkdownContent
            content={content}
            className="chat-md"
          />
        ) : null}
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
