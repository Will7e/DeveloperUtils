// ============================================================
// Turn Diagnostics — The Harness's Own Account Of A Turn, On Screen
// ============================================================
// lib/failure-taxonomy.ts already classifies ten ways a turn goes wrong, from the
// stored transcript alone, and names the mechanism that addresses each. Until now
// its only reader was the eval harness: a real failure became a permanent test
// case, and the person whose turn it was saw nothing. They read a confident
// paragraph and had no way to know the agent had written three source files and
// run nothing, or that it had gone quiet after a failed call.
//
// This is the bridge: the same classifier, attached to the turn it describes.
//
// Three rules keep it from becoming noise, and each is a way this feature could
// make things worse:
//
//   • It speaks only about turns that are FINISHED and have prose to hang from.
//     A note appearing mid-turn would move under the reader's cursor.
//   • It never contradicts the verification ledger. "Wrote code without running
//     anything" is suppressed once a check has passed against the revision on
//     screen — the header chip says "Verified", and two surfaces disagreeing about
//     the same bytes is worse than either being silent.
//   • Efficiency notes are not warnings. Reading five files one at a time is
//     worth knowing and not worth alarming anyone about, so severity is part of
//     the derivation rather than a styling decision at the call site.

import type { ChatConversation, ChatMessage } from "../types";
import {
  FAILURE_FIX,
  FAILURE_LABEL,
  classifyConversation,
  type FailureFinding,
  type FailureKind,
} from "./failure-taxonomy";

/** How loudly a note speaks: notes inform, warnings ask for attention */
export type DiagnosticSeverity = "warning" | "note";

export interface DiagnosticNote {
  kind: FailureKind;
  /** The taxonomy's words, so a note and a report name it identically */
  label: string;
  /** What happened in THIS turn, from the evidence */
  detail: string;
  /** The mechanism that addresses it — a note that points nowhere is a complaint */
  fix: string;
  severity: DiagnosticSeverity;
}

export interface TurnDiagnostic {
  /** 1-based turn index, matching the taxonomy's numbering */
  turn: number;
  /** The message this chip renders after: the turn's last assistant prose */
  endMessageId: string;
  notes: DiagnosticNote[];
}

/**
 * Note kinds carry no claim that anything went WRONG, so they are never warnings.
 * Everything else in the taxonomy describes a turn that lost work: a rejected
 * call, a repeat, a tool that does not exist, a failure the user was not told
 * about, a turn that wrote code and proved nothing.
 */
const NOTE_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "over-read",
  "ask-before-looking",
]);

/**
 * A note that a check has since made moot.
 *
 * `unverified-writes` is the one kind the verification ledger can answer
 * directly: it says a turn wrote source and ran nothing, and a fresh pass against
 * the current revision is exactly the fact that makes it no longer true. The
 * others are about how the turn was conducted and no later run changes them.
 */
const SUPERSEDED_BY_VERIFICATION: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "unverified-writes",
]);

export interface DiagnosticsInput {
  conversation: ChatConversation;
  /** A check passed against the revision currently on screen */
  verifiedRevision?: boolean;
}

/**
 * The notes for each finished turn, newest last.
 *
 * Turn numbering and turn boundaries come from the taxonomy's `splitTurns`, so the
 * `turn` on a note matches the `turn` in a failure report — one classifier, one
 * numbering, whether the reader is looking at the transcript or reading the
 * console diagnostics a failure printed.
 * Only the ANCHOR (which message the note hangs under) is computed here, and it is
 * checked against `splitTurns` by a test, because a walker that drifts would put a
 * turn's notes under the wrong reply.
 */
export function turnDiagnostics({
  conversation,
  verifiedRevision = false,
}: DiagnosticsInput): TurnDiagnostic[] {
  const anchors = turnAnchors(conversation.messages);
  if (anchors.size === 0) return [];

  const byTurn = new Map<number, FailureFinding[]>();
  for (const finding of classifyConversation(conversation)) {
    if (verifiedRevision && SUPERSEDED_BY_VERIFICATION.has(finding.kind)) continue;
    const list = byTurn.get(finding.turn);
    if (list) list.push(finding);
    else byTurn.set(finding.turn, [finding]);
  }

  const out: TurnDiagnostic[] = [];
  for (const [turn, findings] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const endMessageId = anchors.get(turn);
    // A turn with no assistant prose has no place to hang a note: it is either
    // still running or it ended on a tool call, and both are moments when a note
    // would appear under the reader's cursor.
    if (!endMessageId) continue;
    out.push({
      turn,
      endMessageId,
      notes: findings.map((finding) => ({
        kind: finding.kind,
        label: FAILURE_LABEL[finding.kind],
        detail: finding.detail,
        fix: FAILURE_FIX[finding.kind],
        severity: NOTE_KINDS.has(finding.kind) ? "note" : "warning",
      })),
    });
  }
  return out;
}

/**
 * The message that ends each turn, keyed by turn index.
 *
 * Boundaries mirror `splitTurns`: a user message that is not a tool row opens a
 * turn, and anything before the first one belongs to turn 1 (a resumed turn opens
 * on a tool row). Hidden messages are skipped there and skipped here.
 *
 * Exported for the drift test: a walker that disagreed with `splitTurns` would
 * hang a turn's notes under a different reply, and nothing on screen would look
 * wrong enough to notice.
 */
export function turnAnchors(messages: readonly ChatMessage[]): Map<number, string> {
  const out = new Map<number, string>();
  let turn = 0;

  for (const message of messages) {
    if (message.hidden) continue;
    const isToolMessage = message.toolCalls !== undefined || message.toolResult !== undefined;
    if (message.role === "user" && !isToolMessage) {
      turn += 1;
      continue;
    }
    // A leading tool row before any user message opens the first turn.
    if (turn === 0) turn = 1;
    // Assistant prose is the anchor, and the LAST one wins: a turn that ends with
    // a summary after its tool calls hangs its notes under that summary.
    if (message.role === "assistant" && !message.toolCalls) {
      out.set(turn, message.id);
    }
  }

  return out;
}

/**
 * Whether a chip is worth showing at all, and what to call it.
 *
 * A count of notes is only useful next to the word for them: "3 warnings" reads
 * as an alarm, "2 notes" reads as something to look at, and a single note needs
 * its own name rather than a number. Exported so the label is testable and the
 * component cannot invent a fourth way to count them.
 */
export function diagnosticsLabel(notes: readonly DiagnosticNote[]): string {
  const warnings = notes.filter((note) => note.severity === "warning").length;
  const count = notes.length;
  if (count === 1) return notes[0]!.label;
  return warnings > 0
    ? `${count} notes`
    : `${count} efficiency notes`;
}
