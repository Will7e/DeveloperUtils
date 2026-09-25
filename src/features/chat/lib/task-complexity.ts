// ============================================================
// Task Complexity — The Initial Rung, From What The Request Looks Like
// ============================================================
// The effort rung used to have exactly one source: the user's choice,
// resolved once and applied to every turn of the conversation. That is
// the right default and it stays the default — but it means a one-line
// rename runs at the same depth as a multi-file refactor, and a
// "still broken" debugging turn runs at the depth of a greeting.
//
// This module classifies the REQUEST, before the turn starts, from
// signals cheap enough to compute on every send (in the spirit of
// `needsLeanProfile`: facts, not vendor folklore). The result sets the
// INITIAL rung for the turn:
//
//   low      — trivial work: run at `low`, the fastest replies
//   standard — the settings default stands
//   deep     — genuinely deep work: one rung ABOVE the default, capped
//              at `max`
//
// Two rules keep this honest rather than a cost lever in disguise:
//
//   • The user's explicit choice wins. A conversation with a
//     `reasoningEffort` set (or an effort override already in force on
//     this turn) is classified but never overridden — the classifier
//     only fills the rung when nobody has expressed a preference.
//   • Deep raises, trivial LOWERS. Both directions are real: the down
//     direction is the cost lever on per-token pricing, and it is only
//     taken when the request looks trivial AND there is no failing
//     evidence anywhere in the conversation — friction already on the
//     ledger disqualifies `low`, because the cheapest reading of "one
//     file changed" is not "nothing to think about".
//
// Pure: text and facts in, classification out. No stores, no catalog.

import type { ReasoningEffort } from "../types";

/** The classification, in the order the rung mapping consumes it */
export type TaskComplexity = "low" | "standard" | "deep";

export interface ComplexityInput {
  /** The user's message (the last one, already selected by the caller) */
  text: string;
  /**
   * True when a check failed against the current code, the preview is
   * throwing, or the plan has an open step — friction this conversation
   * is already carrying. Disqualifies the `low` classification.
   */
  failingEvidence?: boolean;
  /**
   * Steps in the conversation's published plan, when it has one. A live
   * plan with several open steps is deep work even when the message
   * that started it was short.
   */
  openPlanSteps?: number;
}

/**
 * Signals, kept as literal word lists rather than regexes with moods:
 * every list is a recognition aid a maintainer can read, and every
 * match is one a transcript can be audited against.
 */
const MULTI_STEP_MARKERS = [
  "step 1",
  "first,",
  "then,",
  "after that",
  "also update",
  "also add",
  "and then",
  "make sure",
  "as well as",
  "in addition",
];

const DEBUG_MARKERS = [
  "why does",
  "why doesn't",
  "why is it",
  "still broken",
  "still failing",
  "still doesn't work",
  "doesn't work",
  "not working",
  "crashes",
  "throws",
  "stack trace",
  "undefined is not",
  "cannot read",
  "is not a function",
  "failing test",
  "test fails",
  "flaky",
];

const DEEP_WORK_MARKERS = [
  "refactor",
  "architecture",
  "migrate",
  "across the repo",
  "every usage",
  "all call sites",
  "redesign",
  "root cause",
  "investigate",
  "race condition",
  "memory leak",
  "regression",
  "audit",
  "security",
];

const TRIVIAL_MARKERS = [
  "rename",
  "typo",
  "spell",
  "wording",
  "comment",
  "log line",
  "bump version",
  "update the readme",
  "fix the import",
  "capitalize",
];

// A path-shaped TOKEN, tested against whitespace/delimiter-split pieces of
// the message. Anchored (`^…$`) on purpose: the previous form ran an
// unanchored `text.match()` over the whole message, and on a long run of
// word characters with no `.` in it (a minified paste, a base64 blob) the
// greedy `[\w.-]+` backtracked from every position — O(n²), measured 4.8s
// on 100KB, and this classifier runs on EVERY send. Splitting first bounds
// the backtracking to one token's length.
const PATH_TOKEN_RE = /^(?:[\w.-]+\/)+[\w.-]+\.\w{1,4}$/;
/** A token longer than this cannot be a path worth counting */
const PATH_TOKEN_MAX_CHARS = 200;

/** Enough prose that the request is carrying real instructions */
const LONG_REQUEST_CHARS = 600;
/** A one-line request is the strongest `low` signal there is */
const SHORT_REQUEST_CHARS = 90;
/** Open plan steps past which the work is deep by construction */
const DEEP_PLAN_STEPS = 3;
/** File references past which the change probably spans modules */
const DEEP_FILE_REFS = 2;

/** Counts distinct occurrences of one marker in the text */
function countMarker(text: string, marker: string): number {
  // Word-edge anchored with a small English suffix allowance — the same
  // rule `triggerMatches` uses for skills, so the two classifiers agree
  // on what counts as a match.
  const words = marker
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return 0;
  const pattern = words
    .map((w, i) => (i === words.length - 1 ? `${w}(?:s|es|ed|ing)?` : w))
    .join("\\s+");
  const matches = text.toLowerCase().match(new RegExp(`(?<!\\w)${pattern}(?!\\w)`, "g"));
  return matches ? matches.length : 0;
}

function countAny(text: string, markers: readonly string[]): number {
  let total = 0;
  for (const marker of markers) total += countMarker(text, marker);
  return total;
}

/**
 * Classifies the request the turn is about to run.
 *
 * Scoring is additive and every rule has a named reason, though only
 * the RESULT is consumed today (the rung mapping lives with the caller
 * in turn-prep) — the reasons are exported on the type because the
 * next consumer (the scorecard, a golden case) will want them.
 */
export function classifyRequest(input: ComplexityInput): {
  complexity: TaskComplexity;
  reasons: string[];
} {
  const text = input.text ?? "";
  const reasons: string[] = [];

  const debugHits = countAny(text, DEBUG_MARKERS);
  const deepHits = countAny(text, DEEP_WORK_MARKERS);
  const multiStepHits = countAny(text, MULTI_STEP_MARKERS);
  const trivialHits = countAny(text, TRIVIAL_MARKERS);
  // Split on anything that cannot appear in a path, then test each piece
  // against the anchored token shape. `foo=src/a.ts` still yields "src/a.ts";
  // `src/App.tsx:42:11` still yields "src/App.tsx".
  const fileRefs = new Set(
    text
      .split(/[^\w./\\-]+/)
      .filter((tok) => tok.length > 0 && tok.length <= PATH_TOKEN_MAX_CHARS && PATH_TOKEN_RE.test(tok))
  ).size;

  // ── Deep signals ──
  if (deepHits > 0) reasons.push(`deep-work phrasing (${deepHits})`);
  if (debugHits > 0) reasons.push(`debugging phrasing (${debugHits})`);
  if (multiStepHits > 0) reasons.push(`multi-step phrasing (${multiStepHits})`);
  if (fileRefs >= DEEP_FILE_REFS) reasons.push(`${fileRefs} distinct file paths named`);
  if (text.length >= LONG_REQUEST_CHARS) reasons.push("long, instruction-dense request");
  if (input.failingEvidence) reasons.push("failing checks or errors already on the ledger");
  // A pasted error (the classic debugging turn) is deep even when short:
  // lines with stack-trace shapes carry more information than their length
  // suggests.
  //
  // The `at` branch is line-anchored with a BOUNDED gap (`[^\n]{0,120}`),
  // not `.+`: an unbounded `.+` before a backtracking tail is O(n²) on a
  // long single-line paste (measured 5.3s on 100KB), and turn prep runs on
  // every send — a user pasting a big log must not stall it.
  if (/^\s*at [^\n]{0,120}:\d+:\d+|\bError:/.test(text)) {
    reasons.push("pasted error or stack trace");
  }

  // Deep by construction, not by accumulation:
  //  • two or more independent signals — the general rule;
  //  • ANY debugging phrasing — a root-cause question is investigation,
  //    and investigation is exactly when deeper thinking pays;
  //  • two or more deep-work markers — one word can be noise, two are a
  //    description of the work;
  //  • an open plan with several steps — the conversation's own ledger of
  //    outstanding work, already published by a previous turn.
  if ((input.openPlanSteps ?? 0) >= DEEP_PLAN_STEPS) {
    return { complexity: "deep", reasons: [`${input.openPlanSteps} open plan steps`, ...reasons] };
  }
  if (reasons.length >= 2 || debugHits > 0 || deepHits >= 2) {
    return { complexity: "deep", reasons };
  }

  // ── Trivial signals — only in the ABSENCE of friction ──
  // Friction disqualifies `low`, and so does any hint of multi-step work:
  // a "First… Then…" list is by definition not a single change, even when
  // one of its steps names a trivial edit ("update the readme").
  const friction =
    input.failingEvidence || debugHits > 0 || multiStepHits > 0 || fileRefs > 1;
  if (!friction && trivialHits > 0 && text.length <= SHORT_REQUEST_CHARS) {
    return { complexity: "low", reasons: ["short single-change request", ...reasons] };
  }

  return { complexity: "standard", reasons };
}

/**
 * Maps a classification onto the rung the turn should START at.
 *
 * `defaultEffort` is what the settings asked for; `deep` moves up one
 * rung (capped at `max`) and `low` moves DOWN one rung (floored at
 * `low` — never "off"). One rung per direction is the whole size of the
 * bet: a classifier that can move two rungs is a classifier that can
 * halve someone's thinking budget on its own.
 */
export function effortForComplexity(
  complexity: TaskComplexity,
  defaultEffort: ReasoningEffort
): ReasoningEffort {
  const order: ReasoningEffort[] = ["low", "medium", "high", "max"];
  const index = order.indexOf(defaultEffort);
  if (index === -1) return defaultEffort;
  if (complexity === "deep") return order[Math.min(index + 1, order.length - 1)]!;
  if (complexity === "low") return order[Math.max(index - 1, 0)]!;
  return defaultEffort;
}
