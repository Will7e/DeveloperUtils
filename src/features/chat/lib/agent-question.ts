// ============================================================
// Agent Question — Validating What The Agent Asks, And Reading The Answer
// ============================================================
// The harness had exactly one way for a turn to end "I need something from
// you": prose. The completion gate even instructs the model to do it ("ask
// that question directly"), and with no tool to ask with, that instruction
// degrades into narrated uncertainty at the end of a turn or — far worse —
// into a confident guess. `ask_user` is the missing half: a question with
// options, a turn that pauses, and an answer that arrives as an ordinary
// tool result.
//
// This module is the PURE half of that pair: the argument rules, the result
// payload, and the reading of an answer back out of a stored result. No
// store, no clock, no transport — so the rules that decide whether a
// question is well-formed and whether an answer is one of the offered
// options are testable without a turn engine.
//
// The rules are deliberately the SAME limits the JSON schema advertises.
// A schema is a suggestion to most models: it caps nothing server-side, so
// the executor re-checks and answers with a precise error instead of
// rendering a card with eleven options and a 400-character headline.

import type { AgentQuestion, AgentQuestionAnswer, AgentSuggestion } from "../types";

/** Question-card limits (mirrored in the registry schema) */
export const QUESTION_HEADER_MAX = 40;
export const QUESTION_TEXT_MAX = 300;
export const QUESTION_OPTIONS_MAX = 4;
export const QUESTION_OPTION_LABEL_MAX = 80;
export const QUESTION_OPTION_DESCRIPTION_MAX = 200;

/** suggestion-chip limits (mirrored in the registry schema) */
export const SUGGESTIONS_MIN = 2;
export const SUGGESTIONS_MAX = 4;
export const SUGGESTION_LABEL_MAX = 24;
export const SUGGESTION_PROMPT_MAX = 300;

/**
 * Options that are not answers.
 *
 * "Other" is the anti-pattern this rejects: it spends one of the few slots
 * describing the free-text box that is always there, and it teaches the
 * user to click instead of typing what they actually meant. The model gets
 * a precise error rather than a card with a dead option on it.
 */
const CATCH_ALL = /^(other|others|something else|anything else|none|none of the above|n\/a)\b/i;

export function isCatchAllOption(label: string): boolean {
  return CATCH_ALL.test(label.trim());
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The question itself, before it is paired with a call id */
export type ParsedQuestion = Omit<AgentQuestion, "callId" | "askedAt">;

/**
 * Validates one `ask_user` argument object.
 *
 * Fails loudly and specifically: each error says what to send instead,
 * because the caller is a model that will retry, and a generic rejection
 * makes it retry with the same shape.
 */
export function parseQuestionArgs(args: Record<string, unknown>): ParseResult<ParsedQuestion> {
  const header = asString(args.header);
  if (header.length < 2) return { ok: false, error: "`header` must be a short title (2-40 characters)." };
  if (header.length > QUESTION_HEADER_MAX) {
    return {
      ok: false,
      error: `\`header\` is ${header.length} characters; keep it to ${QUESTION_HEADER_MAX} or fewer.`,
    };
  }

  const question = asString(args.question);
  if (question.length < 4) {
    return { ok: false, error: "`question` must be the one sentence you are asking (4-300 characters)." };
  }
  if (question.length > QUESTION_TEXT_MAX) {
    return {
      ok: false,
      error: `\`question\` is ${question.length} characters; ask ONE thing in ${QUESTION_TEXT_MAX} or fewer.`,
    };
  }

  const rawOptions = args.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    return {
      ok: false,
      error:
        "`options` must be a non-empty array of { label, description? } — give the concrete choices you would act on.",
    };
  }
  if (rawOptions.length > QUESTION_OPTIONS_MAX) {
    return {
      ok: false,
      error: `\`options\` has ${rawOptions.length} entries; ${QUESTION_OPTIONS_MAX} is the maximum. Merge or drop the least likely.`,
    };
  }

  const options: ParsedQuestion["options"] = [];
  for (const [index, raw] of rawOptions.entries()) {
    const option = asRecord(raw);
    const label = option ? asString(option.label) : typeof raw === "string" ? asString(raw) : "";
    if (!label) return { ok: false, error: `option ${index + 1} needs a \`label\` (the choice itself).` };
    if (label.length > QUESTION_OPTION_LABEL_MAX) {
      return {
        ok: false,
        error: `option ${index + 1} label is too long (${label.length} > ${QUESTION_OPTION_LABEL_MAX}); it is a choice, not a sentence.`,
      };
    }
    if (isCatchAllOption(label)) {
      return {
        ok: false,
        error:
          `option ${index + 1} ("${label}") is a catch-all: the user can ALWAYS type their own answer, ` +
          "so an \"other\"/\"none\" option wastes a slot. Offer concrete choices, or ask with one option.",
      };
    }
    if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) {
      return { ok: false, error: `option ${index + 1} duplicates the label "${label}".` };
    }
    const description = option ? asString(option.description) : "";
    options.push({
      label,
      ...(description ? { description: description.slice(0, QUESTION_OPTION_DESCRIPTION_MAX) } : {}),
    });
  }

  const multiSelect = args.multiSelect === true;
  if (multiSelect && options.length < 2) {
    return { ok: false, error: "`multiSelect` is meaningless with a single option — drop it or offer more." };
  }

  return { ok: true, value: { header, question, options, ...(multiSelect ? { multiSelect } : {}) } };
}

/** Validates one `suggest_next` argument object */
export function parseSuggestionArgs(args: Record<string, unknown>): ParseResult<AgentSuggestion[]> {
  const raw = args.suggestions;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "`suggestions` must be an array of { label, prompt } (2-4 entries).",
    };
  }
  if (raw.length < SUGGESTIONS_MIN || raw.length > SUGGESTIONS_MAX) {
    return {
      ok: false,
      error: `\`suggestions\` needs between ${SUGGESTIONS_MIN} and ${SUGGESTIONS_MAX} entries; got ${raw.length}.`,
    };
  }
  const suggestions: AgentSuggestion[] = [];
  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry);
    const label = record ? asString(record.label) : "";
    const prompt = record ? asString(record.prompt) : "";
    if (!label || !prompt) {
      return { ok: false, error: `suggestion ${index + 1} needs both a \`label\` and a \`prompt\`.` };
    }
    if (label.length > SUGGESTION_LABEL_MAX) {
      return {
        ok: false,
        error: `suggestion ${index + 1} label is too long (${label.length} > ${SUGGESTION_LABEL_MAX}); it is chip text.`,
      };
    }
    if (prompt.length > SUGGESTION_PROMPT_MAX) {
      return { ok: false, error: `suggestion ${index + 1} prompt is too long (> ${SUGGESTION_PROMPT_MAX}).` };
    }
    suggestions.push({ label, prompt });
  }
  return { ok: true, value: suggestions };
}

/**
 * Drops anything the question never offered.
 *
 * Fail-closed on purpose: a stale card (or a hand-edited transcript) must
 * not be able to answer with a label the model never proposed, because the
 * model reads the answer as a decision it can act on. An empty selection is
 * still a valid answer when the user typed a note instead.
 */
export function sanitizeAnswer(
  question: Pick<AgentQuestion, "options">,
  input: { selected?: unknown; note?: unknown }
): AgentQuestionAnswer {
  const offered = new Map(question.options.map((o) => [o.label.toLowerCase(), o.label]));
  const selected: string[] = [];
  if (Array.isArray(input.selected)) {
    for (const value of input.selected) {
      const label = asString(value).toLowerCase();
      const canonical = offered.get(label);
      if (canonical && !selected.includes(canonical)) selected.push(canonical);
    }
  }
  const note = asString(input.note);
  return {
    selected,
    ...(note ? { note } : {}),
    answeredAt: Date.now(),
  };
}

/** True when the answer carries nothing at all (an empty click) */
export function isEmptyAnswer(answer: AgentQuestionAnswer): boolean {
  return answer.selected.length === 0 && !answer.note;
}

/**
 * Model-facing one-liner for the result's `summary` and the transcript row.
 *
 * Names the choice rather than the question, because the model already has
 * the question in its own call and what it needs next is the decision.
 */
export function answerSummary(answer: AgentQuestionAnswer): string {
  if (isEmptyAnswer(answer)) return "answer not given";
  if (answer.note && answer.selected.length === 0) return `answered: ${answer.note}`;
  const picked = answer.selected.join(" + ");
  return answer.note ? `answered: ${picked} — ${answer.note}` : `answered: ${picked}`;
}

/**
 * The result payload the model reads.
 *
 * The question is echoed back deliberately: it is what makes the exchange
 * legible in a transcript whose tool call may be far above the fold, and it
 * is the only place the OPTION DESCRIPTIONS survive (the model wrote them,
 * but they are not guaranteed to still be in its context by the time the
 * answer arrives).
 */
export function questionResultPayload(
  question: AgentQuestion,
  answer: AgentQuestionAnswer
): Record<string, unknown> {
  return {
    question: {
      header: question.header,
      asked: question.question,
      options: question.options,
      multiSelect: question.multiSelect === true,
    },
    answer: {
      selected: answer.selected,
      ...(answer.note ? { note: answer.note } : {}),
    },
    note:
      answer.note && answer.selected.length === 0
        ? "The user replied in their own words rather than picking an option — follow their wording where it differs from your options."
        : "Act on this decision; do not ask the same question again in this turn.",
  };
}

/** Serialized shape of a completed `ask_user` call (also parsed by the UI) */
export interface StoredQuestionResult {
  question: { header: string; asked: string; options: AgentQuestion["options"] };
  answer: { selected: string[]; note?: string };
}

/**
 * Reads the answer back out of a stored tool result.
 *
 * Used by the transcript to render an answered card from persisted history
 * — which is why it tolerates an old or hand-edited transcript by returning
 * null rather than throwing: one unreadable row must not take out the page.
 */
export function readStoredQuestionResult(payload: unknown): StoredQuestionResult | null {
  const record = asRecord(payload);
  const question = record ? asRecord(record.question) : null;
  const answer = record ? asRecord(record.answer) : null;
  if (!question || !answer) return null;
  const header = asString(question.header);
  const asked = asString(question.asked);
  const selected = Array.isArray(answer.selected)
    ? answer.selected.filter((v): v is string => typeof v === "string")
    : [];
  const note = asString(answer.note);
  if (!header && !asked) return null;
  return {
    question: {
      header,
      asked,
      options: Array.isArray(question.options)
        ? (question.options as AgentQuestion["options"]).filter(
            (o) => o && typeof o.label === "string"
          )
        : [],
    },
    answer: { selected, ...(note ? { note } : {}) },
  };
}
