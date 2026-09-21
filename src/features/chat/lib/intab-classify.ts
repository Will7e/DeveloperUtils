// ============================================================
// InTab Turn Classifier — Task-Aware Routing Input
// ============================================================
// A cheap, deterministic classifier that buckets each user turn
// into a task kind so the router can pick a fitting pool model
// (coder for code, big-context for analysis, small/fast for chat).
//
// No ML and no network: features are computed from the last user
// message and conversation state in microseconds. Ambiguity is
// resolved toward the general pool (empty features → "quick" only
// for very short turns; everything else leans "analysis"), and
// callers may always fall back to the static base order.

import type { ChatMessage } from "../types";
import { INTAB_TURN_KINDS } from "../constants";

export type TurnKind = (typeof INTAB_TURN_KINDS)[number];

/** Normalized weights per detected signal (higher wins; ties → priority order) */
const SIGNALS = {
  // Code authoring: fenced blocks, imperative build/fix verbs, code-ish shapes
  code: 0,
  // Vision: image attachments present
  vision: 0,
  // Agent: repo attached (tool loop context)
  agent: 0,
  // Analysis: long prose, explain/compare asks, questions about why/how
  analysis: 0,
  // Quick: short social turn with no strong signal elsewhere
  quick: 0,
} as const;

type SignalKey = keyof typeof SIGNALS;

/** Imperative verbs that mark code-authoring requests */
const CODE_VERBS =
  /\b(write|create|build|implement|add|fix|refactor|debug|optimize|migrate|convert|generate|update|patch|extend|port|rewrite|unit[- ]test|type)\b/i;

/** Analytical asks: comprehension, comparison, explanation */
const ANALYSIS_VERBS =
  /\b(explain|why|how does|what does|review|analyze|analyse|compare|summarize|summarise|evaluate|audit|walk me through|difference between|pros and cons|understand)\b/i;

/** Code-shaped fragments that suggest the turn is about code */
const CODE_SHAPE =
  /(```)|(\bfunction\b)|(\bclass\b)|(\bconst\b|\blet\b|\bvar\b)|(\bdef\b)|(\bimport\b|\bfrom\b\s+\S)|(\basync\b|\bawait\b)|(=>)|(\bSELECT\b[\s\S]+\bFROM\b)|(\/\/|#\s)/;

export interface ClassifyTurnParams {
  /** The latest user message (may be empty when regenerating) */
  lastUserMessage?: ChatMessage;
  /** Full stored conversation (for context features) */
  messages: ChatMessage[];
  /** A GitHub repo is attached to this conversation */
  hasRepo: boolean;
}

/**
 * Buckets a turn. Priority when scores tie (after weights):
 * vision > code > agent > analysis > quick — specific modalities
 * and code intent beat generic heuristics.
 */
export function classifyTurn(params: ClassifyTurnParams): TurnKind {
  const { lastUserMessage, hasRepo } = params;
  const text = (lastUserMessage?.content ?? "").trim();
  const hasImages =
    (lastUserMessage?.attachments ?? []).some((a) => a.dataUrl) ?? false;

  const scores: Record<SignalKey, number> = { ...SIGNALS };

  if (hasImages) scores.vision += 4;

  if (text) {
    const words = text.split(/\s+/).length;
    const fences = (text.match(/```/g) ?? []).length;
    const asksCode = CODE_VERBS.test(text) ? 1 : 0;
    const looksLikeCode = CODE_SHAPE.test(text) ? 1 : 0;
    const asksAnalysis = ANALYSIS_VERBS.test(text) ? 1 : 0;

    // Fenced code or strong code phrasing is a decisive code signal
    if (fences >= 2) scores.code += 3;
    if (asksCode && (looksLikeCode || fences >= 1)) scores.code += 2;
    else if (asksCode) scores.code += 1;
    if (!asksCode && looksLikeCode && words < 80) scores.code += 1;

    // Long, question-shaped, or explicitly analytical turns
    if (asksAnalysis) scores.analysis += 2;
    if (words > 120) scores.analysis += 2;
    else if (words > 45) scores.analysis += 1;
    if (/\?$/.test(text) && words > 25) scores.analysis += 1;

    // Short pleasantries / follow-ups with no technical content
    if (words <= 12 && !looksLikeCode && !asksCode) scores.quick += 2;
  }

  // Repo context turns are tool-flavored, but never outweigh an
  // explicit code ask — the router prefers coder models then.
  if (hasRepo) scores.agent += 1;

  // Priority order breaks ties deliberately: vision and code are
  // hard modality/intent constraints, agent and analysis are soft.
  const priority: SignalKey[] = ["vision", "code", "agent", "analysis", "quick"];
  let best: SignalKey = "analysis";
  let bestScore = -1;
  for (const key of priority) {
    if (scores[key] > bestScore) {
      best = key;
      bestScore = scores[key];
    }
  }

  // All-zero (e.g. regenerate with no user text): general pool
  if (bestScore <= 0) return "analysis";
  return best;
}
