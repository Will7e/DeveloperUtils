// ============================================================
// Message List — Scrolling Transcript with Auto-Stick
// ============================================================
// Renders the conversation transcript. Auto-scrolls to the bottom
// while streaming unless the user has scrolled up (then a
// "jump to latest" pill with a missed-message count appears).
// Streaming state is read directly from the chat store so token
// appends never re-render the page, sidebar, header, or composer.
//
// Scroll mechanics: a ResizeObserver on the transcript body reacts
// to ANY height change (streamed tokens, code-block wrapping,
// image loads, font swaps) while the user is pinned to bottom;
// an IntersectionObserver sentinel decides "pinned" so pinning
// stays correct during streaming-induced scrolls. Honors
// prefers-reduced-motion by disabling smooth scrolling.

import React from "react";
import { ArrowDown } from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
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
  /** Display name of the active model */
  defaultModel: string;
  /** OpenRouter key present — controls the empty-state CTA */
  hasApiKey: boolean;
  onSuggestion: (text: string) => void;
  onRegenerate: () => void;
  onOpenSettings: () => void;
}

export function MessageList({
  messages,
  defaultModel,
  hasApiKey,
  onSuggestion,
  onRegenerate,
  onOpenSettings,
}: MessageListProps) {
  // Subscribe to streaming state here — the page, header, sidebar and
  // composer stay untouched while tokens arrive. This component is
  // keyed by conversation id, so "streaming in the active conversation"
  // is exactly "streaming here".
  const streamingContent = useChatStore((s) => s.streamingContent);
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const isStreamingHere = useChatStore(
    (s) => s.isStreaming && s.streamingConversationId === s.activeConversationId
  );

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const innerRef = React.useRef<HTMLDivElement>(null);
  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const jumpUntilRef = React.useRef(0);
  const [isPinned, setIsPinned] = React.useState(true);
  const [unseenCount, setUnseenCount] = React.useState(0);
  const [reducedMotion, setReducedMotion] = React.useState(false);

  const scrollToBottom = React.useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const el = scrollRef.current;
      if (!el) return;
      const smooth = behavior === "smooth" && !reducedMotion;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    },
    [reducedMotion]
  );

  // Track prefers-reduced-motion
  React.useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Pinning via bottom sentinel: fires when the sentinel scrolls in
  // or out of view, including when streaming grows the content while
  // we program-scroll — so the flag never gets stale. The generous
  // bottom rootMargin defines "near the bottom" (it must exceed the
  // list's bottom padding or the sentinel never intersects at rest);
  // it matches the old scroll-handler threshold. A short grace window
  // after an explicit jump keeps smooth-scroll flights pinned.
  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const pinned = entry.isIntersecting || Date.now() < jumpUntilRef.current;
        setIsPinned(pinned);
        if (entry.isIntersecting) setUnseenCount(0);
      },
      { root: scrollRef.current, rootMargin: "0px 0px 80px 0px", threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Follow content growth while pinned: any size change of the
  // transcript body (tokens, wrapping, media) re-anchors to bottom.
  // Height is only ever written, never read — no layout thrash.
  React.useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const observer = new ResizeObserver(() => {
      if (isPinned) scrollToBottom("auto");
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [isPinned, scrollToBottom]);

  // While unpinned, count committed messages the user hasn't seen
  // (streaming growth itself is continuous, so it isn't counted).
  const seenCountRef = React.useRef(messages.length);
  React.useEffect(() => {
    if (messages.length > seenCountRef.current && !isPinned) {
      setUnseenCount((c) => c + (messages.length - seenCountRef.current));
    }
    seenCountRef.current = messages.length;
  }, [messages.length, isPinned]);

  // Jump to latest resets the unseen counter and re-pins. The grace
  // window keeps the pin flag stable while the smooth scroll flies.
  const handleJump = React.useCallback(() => {
    setUnseenCount(0);
    jumpUntilRef.current = Date.now() + 500;
    scrollToBottom("smooth");
  }, [scrollToBottom]);

  // Initial scroll position on mount (per conversation — the parent
  // remounts this component with a key on conversation switch)
  React.useEffect(() => {
    scrollToBottom("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return i;
    }
    return -1;
  })();

  const showStreamingBubble = isStreamingHere && streamingContent !== "";
  const showThinking = isStreamingHere && streamingContent === "";

  if (messages.length === 0 && !isStreamingHere) {
    return (
      <ChatEmptyState
        onSuggestion={onSuggestion}
        defaultModel={defaultModel}
        hasApiKey={hasApiKey}
        onOpenSettings={onOpenSettings}
      />
    );
  }

  return (
    <div className="chat-message-list-wrap">
      <div ref={scrollRef} className="chat-message-list">
        <div ref={innerRef} className="chat-message-list-inner">
          {messages.map((message, idx) => (
            <MessageItem
              key={message.id}
              message={message}
              canRegenerate={!isStreamingHere && idx === lastAssistantIdx}
              onRegenerate={onRegenerate}
            />
          ))}

          {showStreamingBubble && (
            <MessageItem
              message={STREAMING_PLACEHOLDER_MESSAGE}
              streamingContentOverride={streamingContent}
              streamingReasoningOverride={streamingReasoning}
              isStreaming
            />
          )}

          {showThinking && (
            <div className="chat-msg chat-msg-assistant" aria-live="polite">
              <div className="chat-msg-bubble chat-msg-bubble-assistant">
                {streamingReasoning !== "" && (
                  <div className="chat-reasoning chat-reasoning-streaming">
                    <div className="chat-reasoning-header">
                      <span className="chat-reasoning-label">Thinking…</span>
                    </div>
                  </div>
                )}
                <span className="chat-thinking" role="status" aria-label="Assistant is thinking">
                  <span className="chat-thinking-dot" />
                  <span className="chat-thinking-dot" />
                  <span className="chat-thinking-dot" />
                </span>
              </div>
            </div>
          )}

          {/* Bottom sentinel — IntersectionObserver target for pinning */}
          <div ref={sentinelRef} className="chat-scroll-sentinel" aria-hidden="true" />
        </div>
      </div>

      {!isPinned && (
        <button
          type="button"
          className="chat-jump-latest"
          onClick={handleJump}
          aria-label={`Jump to latest${unseenCount > 0 ? ` (${unseenCount} new)` : ""}`}
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {unseenCount > 0 && <span className="chat-jump-badge">{unseenCount > 99 ? "99+" : unseenCount}</span>}
        </button>
      )}
    </div>
  );
}
