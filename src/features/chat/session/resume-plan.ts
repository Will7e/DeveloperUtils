// ============================================================
// Resume Plan — Pure State Machine for Interrupted-Turn Recovery
// ============================================================
// After a reload, the persisted transcript tail determines what
// recovery means. This module maps (pendingTurn marker, message
// tail) → a ResumePlan the runner executes. Pure functions only:
// the logic is unit-tested without stores or DOM.
//
// Shapes handled:
//  - trailing plain user message → the reply was still streaming
//    when the page died → re-stream the full response.
//  - trailing assistant content → a partial reply was committed
//    before teardown (pagehide flush) → preserve it, then re-stream
//    from the last user turn so the model answers the same prompt.
//  - trailing tool_calls / tool results → the agent loop was
//    interrupted mid-phase → continue the loop (prepareRequest
//    rebuilds a valid wire payload from stored history).
//  - anything else (empty, trailing error-only assistant) → no
//    safe automatic action; surface the Resume affordance instead
//    of guessing.
//
// Stale markers (older than PENDING_TURN_MAX_AGE_MS) downgrade to
// "cleanup" so hydration can clear them without user-visible churn.

import type { ChatMessage } from "../types";

/** A pending marker older than this is stale (crash leftover) */
export const PENDING_TURN_MAX_AGE_MS = 24 * 60 * 60_000;

export type ResumeAction =
  /** Re-stream the answer to the trailing user turn */
  | "restream"
  /** Preserve the committed partial reply, then re-stream */
  | "restream-after-partial"
  /** Continue the agent tool loop from stored tool messages */
  | "continue-tool-loop"
  /**
   * The turn is PARKED on an `ask_user` question, not lost. Nothing to
   * replay: the card is already rendered from the persisted question, and
   * answering it commits the result and restarts the loop (chat-runner's
   * `answerQuestion`). Treating this as a dangling tool call instead would
   * drop the question and make the model ask it a second time.
   */
  | "await-answer"
  /** Keep the marker (host may still own the turn — dual safety) */
  | "keep"
  /** Clear the marker; nothing recoverable */
  | "cleanup"
  /** Interrupted turn exists but needs explicit user action */
  | "needs-user-action";

export interface ResumePlan {
  action: ResumeAction;
  /**
   * For "restream-after-partial": the trailing assistant message id
   * to keep visible as the partial answer.
   */
  partialMessageId?: string;
  /**
   * For "continue-tool-loop": the last tool_result callId (the wire
   * payload must end with tool results — never mid-pair).
   */
  trimToCallId?: string;
  /** For "await-answer": the unanswered `ask_user` call */
  questionCallId?: string;
  /** Human-readable reason (turn log / diagnostics) */
  reason: string;
}

/** The last non-hidden message, or undefined for an empty transcript */
function lastVisible(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && !m.hidden) return m;
  }
  return undefined;
}

/**
 * True when the trailing assistant message is a plain content
 * reply committed by the pagehide partial flush (marked resumed
 * partial) — as opposed to tool activity or error notices.
 */
function isPartialReply(last: ChatMessage): boolean {
  return (
    last.role === "assistant" &&
    last.toolCalls === undefined &&
    last.toolResult === undefined &&
    Boolean(last.content.trim()) &&
    last.error !== true &&
    last.resumedPartial === true
  );
}

/**
 * Maps a persisted conversation tail to a recovery plan.
 *
 * @param messages full stored transcript (hidden messages included;
 *                 the function looks at the visible tail)
 * @param pendingTurn the persisted marker ({startedAt}), when present
 * @param now current epoch ms (injectable for tests)
 * @param pendingQuestion the conversation's parked question, when present
 */
export function planResume(
  messages: ChatMessage[],
  pendingTurn: { startedAt: number } | undefined,
  now: number = Date.now(),
  pendingQuestion?: { callId: string }
): ResumePlan {
  if (!pendingTurn) return { action: "keep", reason: "no pending marker" };

  // Stale marker: the turn is long gone (crash days ago, or the
  // host finished it and the END event was missed). Don't replay
  // ancient requests into free-tier caps.
  if (now - pendingTurn.startedAt > PENDING_TURN_MAX_AGE_MS) {
    return { action: "cleanup", reason: "pending marker is stale (>24h)" };
  }

  const last = lastVisible(messages);
  if (!last) {
    // Marker without any message: the user message itself may have
    // been lost to a torn write — nothing to recover against.
    return { action: "cleanup", reason: "marker with empty transcript" };
  }

  // 1) Plain user turn at the tail → response never committed.
  if (last.role === "user" && !last.toolResult) {
    return { action: "restream", reason: "trailing user turn lost its response" };
  }

  // 2) Tool result at the tail → the agent loop was interrupted
  //    between iterations. Safe to continue: the wire payload ends
  //    with tool results, which is a valid OpenAI-compatible state.
  if (last.toolResult) {
    return {
      action: "continue-tool-loop",
      reason: "agent loop interrupted after tool results",
    };
  }

  // 3) Parked on a question the user has not answered. This outranks the
  //    dangling-call rules below: the call is not orphaned, it is WAITING,
  //    and restarting the loop would discard the question instead of
  //    resuming it.
  if (
    pendingQuestion &&
    last.toolCalls?.calls.some((c) => c.id === pendingQuestion.callId)
  ) {
    return {
      action: "await-answer",
      questionCallId: pendingQuestion.callId,
      reason: "turn parked on an unanswered question",
    };
  }

  // 4) Tool-calls message at the tail → interrupted before any
  //    results committed. Results must pair with requests; drop the
  //    dangling calls so the wire payload stays model-valid.
  if (last.toolCalls) {
    return {
      action: "continue-tool-loop",
      trimToCallId: last.toolCalls.calls[last.toolCalls.calls.length - 1]?.id,
      reason: "agent loop interrupted before tool execution",
    };
  }

  // 5) Committed partial reply (pagehide flush) → keep it visible,
  //    re-stream the same turn for the full answer.
  if (isPartialReply(last)) {
    return {
      action: "restream-after-partial",
      partialMessageId: last.id,
      reason: "partial reply committed at teardown; completing it",
    };
  }

  // 6) Plain committed assistant reply that does NOT carry the
  //    partial marker: the turn actually completed but the END
  //    event/clear was lost (host finished after reload). Done —
  //    just clean the marker.
  if (last.role === "assistant" && last.error !== true) {
    return { action: "cleanup", reason: "turn completed before the marker cleared" };
  }

  // 7) Error-only tail: retryable by the user, not automatically.
  return { action: "needs-user-action", reason: "tail is an error notice" };
}

/**
 * The number of trailing tool messages (results + the calls message)
 * to soft-hide when resuming with `trimToCallId` — drops the dangling
 * tool_calls message so the wire ends at the last result.
 */
export function danglingToolRange(messages: ChatMessage[], trimToCallId: string): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.hidden) continue;
    if (m.toolResult) {
      count++;
      continue;
    }
    if (m.toolCalls && m.toolCalls.calls.some((c) => c.id === trimToCallId)) {
      count++;
      return count;
    }
    break;
  }
  return count;
}
