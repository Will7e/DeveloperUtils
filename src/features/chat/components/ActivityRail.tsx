// ============================================================
// Activity Rail — What The Agent Is Doing, Right Now
// ============================================================
// One line, above the composer, answering the question a person actually asks
// while watching an agent work: what is it doing? The transcript answers "what
// happened" — in order, at the end. It cannot answer this, and a turn that spends
// two minutes reading and type-checking is indistinguishable there from a turn
// that hung.
//
// The content is derived from state the page already holds (lib/activity.ts), so
// this component owns only the presentation and two behaviours that need a clock
// or a memory:
//
//   • ELAPSED TIME, keyed on the activity's identity. The store records no
//     timestamp per phase, so the clock starts when the identity changes — and
//     uses the transcript's own start time when it has one (a pending tool call).
//   • THE LINGER. A rail that vanishes the instant the last token lands takes the
//     one sentence the user wanted ("3 files changed") with it, so a finished
//     turn is held on screen briefly, clickable into the Changes pane.
//
// Announcing is deliberately narrow: the phase line is a live region, but it
// changes once per tool call, not once per token — a live region on the streaming
// text would narrate the entire reply to a screen reader.

import React from "react";
import { ArrowRight, Check, Loader2, ShieldAlert } from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { deriveActivity, justFinished, type Activity } from "../lib/activity";
import { useVerificationReadout } from "./useVerificationReadout";

/** How long a finished turn stays on screen before the rail goes quiet */
export const RAIL_LINGER_MS = 6000;

/** mm:ss — a clock that changes width is a jitter in a one-line strip */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface ActivityRailProps {
  conversationId: string | null;
  /** Changed-file count for the finished-turn line (0 hides the line) */
  filesChanged?: number;
  /** Opens the Changes pane when the finished-turn line is clicked */
  onOpenChanges?: () => void;
}

export function ActivityRail({
  conversationId,
  filesChanged = 0,
  onOpenChanges,
}: ActivityRailProps) {
  // One primitive per subscription: tokens arrive many times a second, and a
  // selector returning a fresh object would re-render on every unrelated store
  // write too.
  const isStreamingHere = useChatStore(
    (s) => s.isStreaming && s.streamingConversationId === s.activeConversationId
  );
  const streamingContent = useChatStore((s) => s.streamingContent);
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const reconnecting = useChatStore((s) => s.reconnecting);
  const messages = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.activeConversationId)?.messages
  );
  const plan = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.activeConversationId)?.plan
  );
  const waitingForUser = useChatStore(
    (s) => Boolean(s.conversations.find((c) => c.id === s.activeConversationId)?.pendingQuestion)
  );
  const checkRunHere = useChatStore(
    (s) => s.checkRun !== null && s.checkRun.conversationId === s.activeConversationId
  );
  // The finished-turn line reports what has been proven about the change set it
  // is announcing, from the same read the header chip and the pane use.
  const { verifiedRevision: verified } = useVerificationReadout(conversationId);

  const activity = React.useMemo(
    () =>
      deriveActivity({
        isStreaming: isStreamingHere,
        reconnecting,
        streamingContent,
        streamingReasoning,
        messages: messages ?? [],
        plan,
        waitingForUser,
        runningChecks: checkRunHere,
      }),
    [
      isStreamingHere,
      reconnecting,
      streamingContent,
      streamingReasoning,
      messages,
      plan,
      waitingForUser,
      checkRunHere,
    ]
  );

  // ── The elapsed clock ──
  // Identity-keyed, not timestamp-keyed: `activity.key` changes exactly when the
  // phase does, and a start time the transcript knows (a pending call's own
  // timestamp) beats the moment this component noticed the change. Adjusted
  // during render — React's documented escape hatch for state derived from a
  // prop, and the same trick PlanStrip uses for a new plan.
  const [clock, setClock] = React.useState<{ key: string; at: number; since: number | null }>(
    () => ({ key: activity.key, at: Date.now(), since: activity.since })
  );
  if (clock.key !== activity.key) {
    setClock({ key: activity.key, at: Date.now(), since: activity.since });
  }
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!activity.busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity.busy]);

  // ── The linger ──
  // Tracked from the busy → idle EDGE rather than from a completion event, so a
  // reload mid-turn comes back to a quiet rail instead of a stale "done".
  const [lingerFiles, setLingerFiles] = React.useState<number | null>(null);
  const previous = React.useRef<Activity>(activity);
  React.useEffect(() => {
    const was = previous.current;
    previous.current = activity;
    if (!justFinished(was, activity)) return;
    // Nothing to add to the transcript when no file moved: echoing the reply the
    // user is about to read would be noise.
    if (filesChanged <= 0) return;
    setLingerFiles(filesChanged);
    const timer = window.setTimeout(() => setLingerFiles(null), RAIL_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [activity, filesChanged]);

  if (!activity.busy && lingerFiles !== null) {
    return (
      <div className="chat-activity chat-activity-done" role="status">
        <Check className="h-3.5 w-3.5 chat-activity-icon" aria-hidden="true" />
        <span className="chat-activity-verb">Done</span>
        <span className="chat-activity-target">
          {lingerFiles} file{lingerFiles === 1 ? "" : "s"} changed
        </span>
        {verified ? (
          <span className="chat-activity-chip chat-activity-chip-ok">verified</span>
        ) : (
          <span className="chat-activity-chip chat-activity-chip-warn">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            unverified
          </span>
        )}
        {onOpenChanges && (
          <button type="button" className="chat-activity-open" onClick={onOpenChanges}>
            Review
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  if (!activity.busy) return null;

  const startedAt = clock.since ?? clock.at;

  return (
    <div className="chat-activity" role="status" aria-live="polite" aria-atomic="true">
      <Loader2 className="h-3.5 w-3.5 chat-activity-icon spin" aria-hidden="true" />
      <span className="chat-activity-verb">{activity.verb}</span>
      {activity.target && (
        <span className="chat-activity-target" title={activity.target}>
          {activity.target}
        </span>
      )}
      {activity.stepTotal > 1 && (
        <span className="chat-activity-step">
          step {activity.stepIndex} of {activity.stepTotal}
        </span>
      )}
      {/* A parked turn has no clock: it is waiting on a person, not on time. */}
      {activity.phase !== "waiting" && (
        <span className="chat-activity-elapsed">{formatElapsed(now - startedAt)}</span>
      )}
    </div>
  );
}

/**
 * The shell's copy of the rail, plus the one thing the chat page cannot do for
 * you: tell you the work finished while you were somewhere else.
 *
 * A separate export rather than a mode on the rail: this one must render when the
 * ACTIVE conversation is NOT the streaming one — the case the rail above the
 * composer cannot serve — and it reads nothing from the active conversation to do
 * it.
 *
 * `chatVisible` rather than the router: the shell knows which page is mounted, and
 * a chat component importing the router to find out would make the rail
 * unrenderable anywhere else.
 */
export function ShellActivityPresence({
  onOpen,
  chatVisible,
  showPill,
}: {
  onOpen: (conversationId: string) => void;
  /** True while the chat page is the mounted route */
  chatVisible: boolean;
  /** Whether to draw the pill (false while the chat page is on screen) */
  showPill: boolean;
}) {
  // Two primitive subscriptions, deliberately: this lives in the app chrome, and
  // a selector returning an object would re-render the shell once per streamed
  // token.
  const streamingId = useChatStore((s) => (s.isStreaming ? s.streamingConversationId : null));
  const streamingTitle = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.streamingConversationId)?.title ?? "chat"
  );

  // ── The completion notice ──
  // Held in a ref rather than state: these are facts about the PREVIOUS render,
  // and putting them in state would make the notice depend on its own render
  // pass. The chat that was streaming is remembered when the streak begins,
  // because by the time it ends `streamingConversationId` is already cleared.
  const wasStreaming = React.useRef(false);
  const watching = React.useRef<{ id: string; title: string } | null>(null);
  const addToast = useAppStore((s) => s.addToast);

  React.useEffect(() => {
    if (streamingId) {
      wasStreaming.current = true;
      if (!watching.current) watching.current = { id: streamingId, title: streamingTitle };
      return;
    }
    const finished = wasStreaming.current;
    const target = watching.current;
    wasStreaming.current = false;
    watching.current = null;
    // Only when the user is NOT looking at the chat: interrupting someone who is
    // already reading the reply with a notice about it is noise.
    if (!finished || !target || chatVisible) return;
    addToast({
      message: `The agent finished in “${target.title}”.`,
      type: "info",
      duration: 8000,
    });
  }, [streamingId, streamingTitle, chatVisible, addToast]);

  if (!streamingId || !showPill) return null;

  return (
    <button
      type="button"
      className="shell-agent-pill"
      onClick={() => onOpen(streamingId)}
      title={`The agent is still working in "${streamingTitle}" — click to watch`}
    >
      <Loader2 className="h-3.5 w-3.5 spin" aria-hidden="true" />
      <span className="shell-agent-pill-text">Working in {streamingTitle}</span>
    </button>
  );
}
