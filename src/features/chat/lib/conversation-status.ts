// ============================================================
// Conversation Status — What Each Thread Is Doing, At A Glance
// ============================================================
// The transcript answers "what happened". The activity rail answers "what is
// happening in the chat on screen". Neither answers the question a LIST of
// parallel threads raises, and it is the first question such a list asks:
// which of these is running, which one is waiting on ME, and which one finished
// while I was looking at something else?
//
// Every fact needed is already in the store — a stream names its conversation,
// a parked turn carries its question, a failed reply marks its own message, and
// "run checks" names the thread it belongs to. So this is a REDUCTION over state
// the page already holds, and the part worth pinning is the PRECEDENCE: a thread
// that is both running and unread is running (the dot would be describing the
// past), and a thread parked on a question outranks one that merely finished.
//
// Kept out of the component because the ordering has a right answer, and because
// a rule that can only be observed by watching a real turn is a rule that rots.
// ============================================================

import type { ChatConversation } from "../types";

export type ConversationStatusKind = "running" | "waiting" | "failed" | "unread" | "idle";

export interface ConversationStatus {
  kind: ConversationStatusKind;
  /** What the glyph means — a tooltip, and the row's screen-reader text */
  label: string;
  /** True when nothing moves again until a person answers */
  needsUser: boolean;
}

/** A thread at rest: no glyph, no announcement */
export const IDLE_STATUS: ConversationStatus = { kind: "idle", label: "", needsUser: false };

export interface ConversationStatusInput {
  conversation: ChatConversation;
  /** The thread the live stream belongs to, or null when nothing is streaming */
  streamingConversationId: string | null;
  /** That stream dropped and a resume is in flight */
  reconnecting: boolean;
  /** The thread a user-initiated "Run checks" is in flight for, if any */
  checksRunningFor: string | null;
  /** True for the thread on screen: its own open state is not news about it */
  isActive: boolean;
  /**
   * When this thread was last on screen.
   *
   * `undefined` means "not this session" and is deliberately NOT an alert — see
   * the unread branch below.
   */
  lastSeenAt: number | undefined;
}

/**
 * The one status a row shows.
 *
 * A status is a single value rather than a set of flags because a row can only
 * draw one glyph, and a set of flags would leave the drawing order to whoever
 * wrote the JSX last. The order is: running, waiting, failed, unread, idle.
 */
export function conversationStatus({
  conversation,
  streamingConversationId,
  reconnecting,
  checksRunningFor,
  isActive,
  lastSeenAt,
}: ConversationStatusInput): ConversationStatus {
  const id = conversation.id;

  // 1. Something is happening in it RIGHT NOW. Beats every historical fact:
  //    while a turn streams, "unread" would be describing the previous one.
  if (streamingConversationId === id) {
    if (reconnecting) {
      return { kind: "running", label: "Reconnecting to the stream", needsUser: false };
    }
    return { kind: "running", label: "The agent is working here", needsUser: false };
  }
  if (checksRunningFor === id) {
    return { kind: "running", label: "Running checks", needsUser: false };
  }

  // 2. Parked on a person. A question, or a turn whose outcome never committed
  //    and can only be picked up by hand (see session/resume-plan).
  if (conversation.pendingQuestion) {
    return { kind: "waiting", label: "Waiting for your answer", needsUser: true };
  }
  if (conversation.pendingTurn?.outcome === "unresumable") {
    return { kind: "waiting", label: "The last turn was interrupted — resume it", needsUser: true };
  }

  // 3. It ended badly. The transcript marks the reply itself, which is the only
  //    place that knows the difference between a failed call and a short answer.
  const messages = conversation.messages ?? [];
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.error) {
    return { kind: "failed", label: "The last turn failed", needsUser: true };
  }

  // 4. It moved while you were somewhere else.
  //
  //    `lastSeenAt === undefined` is NOT unread: a fresh session opening a list
  //    of thirty old chats must not look like thirty alerts, and the honest
  //    reading of "never seen" is "was already like this when you arrived".
  //    Activity is what earns the dot, which is why the store stamps a thread
  //    on screen and leaves the rest alone.
  if (!isActive && lastSeenAt !== undefined && conversation.updatedAt > lastSeenAt) {
    return { kind: "unread", label: "Finished while you were away", needsUser: false };
  }

  return IDLE_STATUS;
}

/** Loudest first — the order a folded group's header uses */
const STATUS_RANK: Record<ConversationStatusKind, number> = {
  running: 4,
  waiting: 3,
  failed: 2,
  unread: 1,
  idle: 0,
};

/**
 * One status for a whole repository's threads.
 *
 * A folded group still has to say whether anything inside it wants attention,
 * and a group header has room for one glyph — so the loudest thread inside wins.
 * Empty groups (a repo whose only threads all read as idle) collapse to idle.
 */
export function rollupConversationStatus(
  kinds: readonly ConversationStatusKind[]
): ConversationStatusKind {
  let winner: ConversationStatusKind = "idle";
  for (const kind of kinds) {
    if (STATUS_RANK[kind] > STATUS_RANK[winner]) winner = kind;
  }
  return winner;
}

/** The status a group header draws, including its label */
export function groupStatus(kinds: readonly ConversationStatusKind[]): ConversationStatus {
  const kind = rollupConversationStatus(kinds);
  switch (kind) {
    case "running":
      return { kind, label: "A chat on this repository is working", needsUser: false };
    case "waiting":
      return { kind, label: "A chat on this repository is waiting for you", needsUser: true };
    case "failed":
      return { kind, label: "A chat on this repository ended in an error", needsUser: true };
    case "unread":
      return { kind, label: "A chat on this repository finished while you were away", needsUser: false };
    default:
      return IDLE_STATUS;
  }
}
