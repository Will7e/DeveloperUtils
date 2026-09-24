// ============================================================
// Scorecard — Is The Agent Actually Finishing?
// ============================================================
// Every claim about an agent ("it gives up too early", "it works until the
// job is done") is a claim about a RATE, and a rate needs a numerator and a
// denominator that are counted the same way every time. This module is the
// counting, and it reads only what the transcript already stores, so it
// survives a reload and covers chats from before the metric existed.
//
// Five numbers, each answering a question somebody actually asks:
//
//   • rounds per turn — is it working, or is it talking?
//   • harness continuations — how often did the model stop with work open?
//   • handoffs — how often did the USER have to say "continue"?
//   • question rate — how often did it ask instead of guessing?
//   • tool failures — how much of the loop is the agent fighting itself?
//
// The handoff rate is the honest headline: a turn that ends with the harness
// asking the user to continue is a turn the agent did not finish, regardless
// of how good the work inside it was. It is deliberately NOT "turns without
// errors" — an agent that never fails is an agent that never tried.
//
// Pure: conversations, log entries and a clock go in; a report comes out. No
// store, so the numbers can be unit-tested against a hand-built transcript
// instead of against whatever the app happens to have done today.

import type { ChatConversation, ChatMessage } from "../types";
import type { TurnLogEntry } from "../session/turn-log";
import { isContinuationNudge, isHandoffNotice } from "./harness-notices";
import {
  FAILURE_KINDS,
  FAILURE_LABEL,
  classifyConversation,
  taxonomyCounts,
  type FailureFinding,
  type FailureKind,
  type TaxonomyCounts,
} from "./failure-taxonomy";

export interface ConversationScore {
  chats: number;
  /** User turns that are not tool results */
  turns: number;
  /** Assistant messages that requested tools */
  toolRounds: number;
  /** Tool results that came back `ok: false` */
  toolFailures: number;
  /** Cases where the model ASKED rather than guessed */
  questions: number;
  /** Harness continuations: the gate kept a stopped turn going */
  nudges: number;
  /** Turns the harness handed back to the user to finish */
  handoffs: number;
}

export interface Scorecard extends ConversationScore {
  /**
   * WHY the failures happened, classified (lib/failure-taxonomy.ts).
   *
   * The counts above say how much the loop cost; these say which mechanism is
   * producing the cost, which is the only version anybody can act on. Kept
   * separate from `toolFailures` on purpose: one failed call can be one
   * classified failure, none, or several (a withheld call that was then
   * repeated is two).
   */
  failures: TaxonomyCounts;
  /** The findings themselves, for the report's "most recent" lines */
  findings: FailureFinding[];
  /** Handoffs as a share of turns, 0-100 (0 when there are no turns) */
  handoffRate: number;
  /** Tool rounds per turn, one decimal */
  roundsPerTurn: number;
  /** Turns ended per tool failure, one decimal (Infinity → "—") */
  turnsPerFailure: number;
  /** Turn-log facts for THIS session (not persisted; labeled as such) */
  session: {
    events: number;
    failovers: number;
    aborts: number;
    completionGates: number;
    escalations: number;
  };
}

function isToolMessage(message: ChatMessage): boolean {
  return message.toolCalls !== undefined || message.toolResult !== undefined;
}

/** Counts one conversation. Exported so the numbers can be tested directly. */
export function scoreConversation(conversation: ChatConversation): ConversationScore {
  const score: ConversationScore = {
    chats: 1,
    turns: 0,
    toolRounds: 0,
    toolFailures: 0,
    questions: 0,
    nudges: 0,
    handoffs: 0,
  };
  for (const message of conversation.messages) {
    if (message.hidden) continue;
    if (message.role === "user" && !isToolMessage(message)) score.turns += 1;
    if (message.toolCalls) {
      score.toolRounds += 1;
      if (message.toolCalls.calls.some((c) => c.name === "ask_user")) score.questions += 1;
    }
    if (message.toolResult && message.toolResult.ok === false) score.toolFailures += 1;
    if (message.role === "assistant" && !message.toolCalls) {
      if (isContinuationNudge(message.content)) score.nudges += 1;
      else if (isHandoffNotice(message.content)) score.handoffs += 1;
    }
  }
  return score;
}

function add(target: ConversationScore, part: ConversationScore): void {
  target.chats += part.chats;
  target.turns += part.turns;
  target.toolRounds += part.toolRounds;
  target.toolFailures += part.toolFailures;
  target.questions += part.questions;
  target.nudges += part.nudges;
  target.handoffs += part.handoffs;
}

const EMPTY: ConversationScore = {
  chats: 0,
  turns: 0,
  toolRounds: 0,
  toolFailures: 0,
  questions: 0,
  nudges: 0,
  handoffs: 0,
};

/**
 * Rolls the stored conversations up into a scorecard.
 *
 * `turnLog` is the in-memory event ring, so its numbers describe THIS
 * session only — the report labels them that way rather than folding them
 * into the transcript-derived counts, which cover everything still stored.
 */
export function buildScorecard(
  conversations: ChatConversation[],
  turnLog: TurnLogEntry[] = []
): Scorecard {
  const totals = { ...EMPTY };
  for (const conversation of conversations) add(totals, scoreConversation(conversation));

  const session = { events: 0, failovers: 0, aborts: 0, completionGates: 0, escalations: 0 };
  for (const entry of turnLog) {
    session.events += 1;
    if (entry.phase === "failover") session.failovers += 1;
    if (entry.phase === "abort" || entry.phase === "orphan-abort") session.aborts += 1;
    if (entry.phase === "completion-gate") {
      session.completionGates += 1;
      // A gate event that says the model was continued on a different model
      // is the escalation, and the log already distinguishes the two.
      if (/→/.test(entry.detail ?? "")) session.escalations += 1;
    }
  }

  // Classified failures, from the same transcripts. Computed here rather than
  // asked of the caller so a scorecard always has both halves and the two can
  // never disagree about which conversations were counted.
  const findings = conversations.flatMap((c) => classifyConversation(c));
  const failures = taxonomyCounts(conversations, findings);

  const handoffRate = totals.turns > 0 ? (totals.handoffs / totals.turns) * 100 : 0;
  const roundsPerTurn = totals.turns > 0 ? totals.toolRounds / totals.turns : 0;
  return {
    ...totals,
    failures,
    findings,
    handoffRate,
    roundsPerTurn,
    turnsPerFailure: totals.toolFailures > 0 ? totals.turns / totals.toolFailures : Number.POSITIVE_INFINITY,
    session,
  };
}

function pct(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

/**
 * The report, as aligned text.
 *
 * Text rather than a chart because a command's job is to be copyable into an
 * issue: the numbers next to the sentence that explains what they mean.
 */
export function formatScorecard(card: Scorecard): string {
  if (card.turns === 0) {
    return "No finished turns to score yet — send a message and the numbers start here.";
  }
  const rows: Array<[string, string]> = [
    ["Chats", String(card.chats)],
    ["Turns", String(card.turns)],
    ["Tool rounds", `${card.toolRounds} (${card.roundsPerTurn.toFixed(1)} per turn)`],
    ["Harness continuations", String(card.nudges)],
    [
      "Handed back to you",
      `${card.handoffs} (${pct(card.handoffRate)} of turns)`,
    ],
    ["Finished without a nudge", pct(100 - card.handoffRate)],
    ["Questions asked", String(card.questions)],
    [
      "Failed tool calls",
      `${card.toolFailures}${
        Number.isFinite(card.turnsPerFailure)
          ? ` (one per ${card.turnsPerFailure.toFixed(1)} turns)`
          : ""
      }`,
    ],
  ];
  // Only the kinds that fired: a report with ten rows of zero teaches the
  // reader to skim, and the fix line beside each one is the actionable half.
  const fired: Array<[FailureKind, number]> = FAILURE_KINDS.map(
    (kind) => [kind, card.failures.byKind[kind]] as [FailureKind, number]
  ).filter(([, n]) => n > 0);
  if (fired.length > 0) {
    rows.push(["", ""]);
    for (const [kind, count] of fired.sort((a, b) => b[1] - a[1])) {
      rows.push([FAILURE_LABEL[kind], String(count)]);
    }
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  const recent = card.findings.slice(0, 3);
  const recentLines =
    recent.length > 0
      ? ["", "Most recent:", ...recent.map((f) => [`  turn ${f.turn}: ${f.detail}`.trimEnd()])]
      : [];
  return [
    "Agent scorecard — every stored chat",
    "",
    ...rows.map(([label, value]) => (label === "" ? "" : `${label.padEnd(width)}  ${value}`)),
    ...recentLines,
    "",
    `This session (not persisted): ${card.session.events} turn-log events · ` +
      `${card.session.completionGates} gate continuations · ${card.session.failovers} failovers · ` +
      `${card.session.aborts} aborts`,
  ].join("\n");
}

/** One-line version, for a status row or a toast subtitle */
export function summarizeScorecard(card: Scorecard): string {
  if (card.turns === 0) return "no turns yet";
  const failures = card.failures.total > 0 ? ` · ${card.failures.total} classified failure(s)` : "";
  return (
    `${card.turns} turns · ${card.roundsPerTurn.toFixed(1)} rounds/turn · ` +
    `${pct(card.handoffRate)} handed back · ${card.questions} question(s)${failures}`
  );
}
