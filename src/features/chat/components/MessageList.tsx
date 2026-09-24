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
import { ArrowDown, Brain, RefreshCw, WifiOff } from "lucide-react";
import { selectReconnecting, selectStream, useChatStore } from "@/stores/chat.store";
import { MessageItem } from "./MessageItem";
import { ChatEmptyState } from "./ChatEmptyState";
import { QuestionCard } from "./QuestionCard";
import { TranscriptFind } from "./TranscriptFind";
import { TurnDiagnostics } from "./TurnDiagnostics";
import { useVerificationReadout } from "./useVerificationReadout";
import { turnDiagnostics, type TurnDiagnostic } from "../lib/turn-diagnostics";
import { visibleMessages } from "../types";
import type { ChatMessage, ConversationSummary } from "../types";
import { resumeUserTurn } from "../services/chat-runner";

/**
 * Collapsible "Compacted memory" chip rendered above the kept
 * transcript. The summary rides in the system prompt on every
 * request — this is its visible representation.
 */
const SummaryBlock = React.memo(function SummaryBlock({
  summary,
}: {
  summary: ConversationSummary;
}) {
  const [open, setOpen] = React.useState(false);
  if (!summary.text.trim()) return null;

  return (
    <div className="chat-summary-block">
      <button
        type="button"
        className="chat-summary-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Brain className="chat-summary-icon h-3 w-3" aria-hidden="true" />
        <span className="chat-summary-label">
          Compacted memory — summary of the first {summary.coversCount} messages
        </span>
        {summary.freedTokens > 0 && (
          <span className="chat-summary-freed">
            {(summary.freedTokens / 1000).toFixed(1)}k tokens held
          </span>
        )}
      </button>
      {open && (
        <div className="chat-summary-body">{summary.text}</div>
      )}
    </div>
  );
});

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
  /** Rolling LLM summary of the folded prefix (compact mode) */
  summary?: ConversationSummary;
  onSuggestion: (text: string) => void;
  onRegenerate: () => void;
  onOpenSettings: () => void;
}

export function MessageList({
  messages,
  defaultModel,
  hasApiKey,
  summary,
  onSuggestion,
  onRegenerate,
  onOpenSettings,
}: MessageListProps) {
  // Subscribe to streaming state here — the page, header, sidebar and
  // composer stay untouched while tokens arrive. This component is keyed by
  // conversation id, and it reads ITS OWN thread's buffer rather than "the"
  // stream: with several agents working at once, a token belonging to another
  // chat lands in another entry and re-renders nothing here.
  const activeId = useChatStore((s) => s.activeConversationId);
  const stream = useChatStore((s) => selectStream(s, s.activeConversationId));
  const streamingContent = stream?.content ?? "";
  const streamingReasoning = stream?.reasoning ?? "";
  const reconnecting = useChatStore((s) => selectReconnecting(s, s.activeConversationId));
  const isStreamingHere = stream !== null;

  // Interrupted-turn recovery affordance: when auto-resume failed
  // for this conversation, offer an explicit one-click Resume.
  //
  // Read straight from the store rather than mirrored into state by an
  // effect: the effect form called setState synchronously on mount and
  // on every change, which is a cascading render for a boolean the store
  // already publishes. The selector returns a primitive, so it re-renders
  // only when the answer actually flips.
  const hasUnresumable = useChatStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId);
    return conv?.pendingTurn?.outcome === "unresumable";
  });

  // ── Turn diagnostics ──
  // The harness's own account of each finished turn (lib/turn-diagnostics), from
  // the same classifier the eval harness uses. Derived here once per committed
  // change rather than per turn, and suppressed where the verification ledger has
  // already answered the finding: the header chip says "Verified", so the
  // transcript must not say "wrote code without running anything" about the same
  // revision.
  const activeConversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  );
  const { verifiedRevision } = useVerificationReadout(activeId);
  const diagnostics = React.useMemo(() => {
    const map = new Map<string, TurnDiagnostic>();
    if (!activeConversation) return map;
    const all = turnDiagnostics({ conversation: activeConversation, verifiedRevision });
    // While a turn is running, the newest one is withheld: it is still being
    // written, and a note about a turn in progress would change under the reader
    // ("wrote code without running anything" is not yet a fact about it). Earlier
    // turns keep theirs — a note that vanished every time the agent started
    // working again would be unreadable.
    const inProgressTurn = isStreamingHere && all.length > 0 ? all[all.length - 1]!.turn : -1;
    for (const diagnostic of all) {
      if (diagnostic.turn === inProgressTurn) continue;
      map.set(diagnostic.endMessageId, diagnostic);
    }
    return map;
  }, [activeConversation, verifiedRevision, isStreamingHere]);

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

  // Soft-deleted messages (regenerate) stay in storage but never render.
  const visible = React.useMemo(() => visibleMessages(messages), [messages]);

  // ── Find in transcript (⌘F) ──
  // Matches are MESSAGES, not substrings: see components/TranscriptFind.tsx for
  // why marking the message is the honest version of this on rendered markdown.
  const [findOpen, setFindOpen] = React.useState(false);
  const [findQuery, setFindQuery] = React.useState("");
  const [findIndex, setFindIndex] = React.useState(0);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      // Only while the transcript is on screen: the browser's own find has no
      // idea what is inside a scroll region it cannot read message by message.
      e.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener("keydown", handler);
    // The command palette opens this bar through an event rather than by mounting
    // a second search of its own: one implementation, two ways in.
    const openEvent = () => setFindOpen(true);
    window.addEventListener("intab:chat-find", openEvent);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("intab:chat-find", openEvent);
    };
  }, []);

  const findMatches = React.useMemo(() => {
    const needle = findQuery.trim().toLowerCase();
    if (needle === "") return [] as ChatMessage[];
    return visible.filter((message) => {
      if (message.content.toLowerCase().includes(needle)) return true;
      // A tool step is searchable by what it acted on, which is how a user looks
      // for "the file it edited" rather than for a shell command's stdout.
      if (message.toolResult) {
        return (message.toolResult.summary ?? "").toLowerCase().includes(needle);
      }
      if (message.toolCalls) {
        return message.toolCalls.calls.some((call) =>
          `${call.name} ${call.arguments}`.toLowerCase().includes(needle)
        );
      }
      return false;
    });
  }, [visible, findQuery]);

  // Clamp the cursor when the query narrows the match set under it.
  const currentMatch = findMatches.length > 0 ? findMatches[Math.min(findIndex, findMatches.length - 1)] : undefined;

  const step = React.useCallback(
    (delta: number) => {
      if (findMatches.length === 0) return;
      setFindIndex((i) => (i + delta + findMatches.length) % findMatches.length);
    },
    [findMatches.length]
  );

  // Scrolling is done through the DOM because the match may be far outside the
  // rendered window; the data attribute is on every message root for this reason.
  React.useEffect(() => {
    if (!currentMatch) return;
    const el = scrollRef.current?.querySelector(`[data-message-id="${CSS.escape(currentMatch.id)}"]`);
    el?.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
  }, [currentMatch, reducedMotion]);

  const showStreamingBubble = isStreamingHere && streamingContent !== "";
  const showThinking = isStreamingHere && streamingContent === "";

  if (visible.length === 0 && !isStreamingHere) {
    return (
      <ChatEmptyState
        onSuggestion={onSuggestion}
        defaultModel={defaultModel}
        hasApiKey={hasApiKey}
        onOpenSettings={onOpenSettings}
      />
    );
  }

  const findHitOf = (message: ChatMessage): "match" | "current" | undefined => {
    if (!findOpen || findMatches.length === 0) return undefined;
    if (currentMatch?.id === message.id) return "current";
    return findMatches.some((m) => m.id === message.id) ? "match" : undefined;
  };

  return (
    <div className="chat-message-list-wrap">
      {findOpen && (
        <TranscriptFind
          query={findQuery}
          onQueryChange={(next) => {
            setFindQuery(next);
            setFindIndex(0);
          }}
          count={findMatches.length}
          index={Math.min(findIndex, Math.max(0, findMatches.length - 1))}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onClose={() => setFindOpen(false)}
        />
      )}
      {reconnecting && (
        <div className="chat-reconnect-banner" role="status">
          <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Reconnecting to your response…</span>
        </div>
      )}
      {hasUnresumable && !isStreamingHere && (
        <button
          type="button"
          className="chat-resume-banner"
          onClick={() => {
            if (activeId) void resumeUserTurn(activeId);
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>A response was interrupted — click to resume</span>
        </button>
      )}
      <div ref={scrollRef} className="chat-message-list">
        {/* A transcript is a log: committed messages are ADDITIONS and
            only those are announced. `aria-relevant="additions"` is what
            keeps this from narrating every streamed token — the growing
            bubble mutates inside a node that already exists, so a screen
            reader hears the finished reply once, when it is committed.
            No aria-busy: holding announcements until the turn ends would
            also swallow tool-phase messages that arrive mid-turn. */}
        <div
          ref={innerRef}
          className="chat-message-list-inner"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Conversation transcript"
        >
          {summary && <SummaryBlock summary={summary} />}
          {visible.map((message, idx) => {
            const diagnostic = diagnostics.get(message.id);
            return (
              <React.Fragment key={message.id}>
                <MessageItem
                  message={message}
                  allMessages={visible}
                  canRegenerate={!isStreamingHere && idx === lastAssistantIdx}
                  onRegenerate={onRegenerate}
                  findHit={findHitOf(message)}
                />
                {/* Rendered OUTSIDE the bubble: it is the harness speaking
                    about the turn, not the assistant's own reply. */}
                {diagnostic && <TurnDiagnostics diagnostic={diagnostic} />}
              </React.Fragment>
            );
          })}

          {/* A parked turn's question sits at the END of the transcript,
              where the user is already looking, and the answer is one click.
              It renders from the conversation rather than from a prop so a
              reload brings back the same question the turn is waiting on. */}
          {activeId && <QuestionCard conversationId={activeId} />}

          {showStreamingBubble && (
            <MessageItem
              message={STREAMING_PLACEHOLDER_MESSAGE}
              streamingContentOverride={streamingContent}
              streamingReasoningOverride={streamingReasoning}
              isStreaming
            />
          )}

          {/* The inner status span announces the wait. A live region on
              this wrapper would re-announce on every dot frame. */}
          {showThinking && (
            <div className="chat-msg">
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
