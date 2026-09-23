// ============================================================
// Ask User — Parking A Turn On A Question
// ============================================================
// `ask_user` is not a tool that completes: it is a tool that WAITS. The turn
// parks inside the tool call, the question card renders from the
// conversation, and the answer resolves the pending promise so the loop
// continues with an ordinary tool result. That shape is the whole point —
// the alternative, ending the turn with a question in prose, throws away the
// tool results the model is holding and makes the user re-explain the task.
//
// Two pieces of state, deliberately in different places:
//
//   • the QUESTION lives on the conversation (persisted), because a reload
//     has to render the same card again and the answer has to be able to
//     resume a turn that no longer exists in memory; and
//   • the WAITER lives here (memory), because a promise cannot be persisted.
//     After a reload there is no waiter, and the answer takes the other path:
//     it is committed as the result of the dangling call and the loop is
//     restarted from stored history (see services/chat-runner.ts).
//
// A stop always wins: aborting the turn settles the question with no answer
// and returns a cancelled result, so the transcript says "stopped while
// asking" rather than pretending the user answered.

import { useChatStore } from "@/stores/chat.store";
import { logTurnEvent } from "../session/turn-log";
import { registerScopedResource } from "../identity/scoped-resources";
import {
  answerSummary,
  parseQuestionArgs,
  parseSuggestionArgs,
  questionResultPayload,
} from "../lib/agent-question";
import type { AgentQuestion, AgentQuestionAnswer, ToolCallResult } from "../types";

/** The identity of the call the turn is parked on */
export interface AskContext {
  /** The tool call id, so the question can be paired with its result */
  callId: string;
  signal?: AbortSignal;
}

interface Waiter {
  callId: string;
  resolve: (answer: AgentQuestionAnswer | null) => void;
}

/**
 * conversationId → the turn waiting on that conversation's question.
 *
 * Module state rather than store state because a promise is not renderable:
 * the store keeps what the UI draws, this keeps what the engine awaits.
 */
const waiters = new Map<string, Waiter>();

/**
 * Scoped by THREAD, because that is what a waiter is: one conversation's turn
 * parked on one question. Deleting the conversation has to settle it rather
 * than drop it — the awaiting call is inside a live turn and must finish — and
 * it must finish knowing there was no answer, which is the same outcome a stop
 * produces. A repository transition is deliberately NOT a release: the question
 * is about the user's intent, not about which checkout it was asked in.
 */
registerScopedResource({
  name: "ask-user.parked-questions",
  scope: "thread",
  release: ({ transition }) => {
    if (transition.type !== "thread.deleted") return;
    const waiter = waiters.get(transition.threadId);
    if (!waiter) return;
    waiters.delete(transition.threadId);
    waiter.resolve(null);
  },
});

/** The call id the turn is parked on, or null when nothing is waiting */
export function waitingCallId(conversationId: string): string | null {
  return waiters.get(conversationId)?.callId ?? null;
}

export function isWaitingForAnswer(conversationId: string): boolean {
  return waiters.has(conversationId);
}

/**
 * Hands an answer to a parked turn. Returns false when nothing was waiting
 * (the turn died with the page) — the caller then commits the answer as the
 * dangling call's result and restarts the loop.
 */
export function settlePendingQuestion(
  conversationId: string,
  answer: AgentQuestionAnswer | null
): boolean {
  const waiter = waiters.get(conversationId);
  if (!waiter) return false;
  waiters.delete(conversationId);
  useChatStore.getState().setPendingQuestion(conversationId, undefined);
  waiter.resolve(answer);
  return true;
}

/** Shared result shape for a call this harness refused before running it */
function failure(
  name: "ask_user" | "suggest_next",
  error: string,
  summary: string
): ToolCallResult {
  return { callId: "", name, ok: false, data: { error }, durationMs: 0, summary };
}

/**
 * Runs one `ask_user` call: publishes the question, then awaits the answer.
 *
 * Never rejects and never hangs past a stop: the promise is settled by
 * either an answer or the turn's abort signal.
 */
export async function runAskUser(
  conversationId: string,
  args: Record<string, unknown>,
  ctx: AskContext
): Promise<ToolCallResult> {
  const started = Date.now();
  const parsed = parseQuestionArgs(args);
  if (!parsed.ok) return failure("ask_user", parsed.error, "invalid question");
  if (ctx.signal?.aborted) {
    return failure("ask_user", "The user stopped the turn before this question was asked.", "not asked");
  }

  const question: AgentQuestion = {
    ...parsed.value,
    callId: ctx.callId,
    askedAt: Date.now(),
  };

  // Supersede anything still registered: a resume can leave a waiter behind
  // for a call the model has since replaced, and letting both resolve would
  // answer a question nobody is showing any more.
  const stale = waiters.get(conversationId);
  if (stale) {
    waiters.delete(conversationId);
    stale.resolve(null);
  }

  useChatStore.getState().setPendingQuestion(conversationId, question);
  logTurnEvent({
    turnId: null,
    conversationId,
    phase: "tool-phase",
    detail: `ask_user: ${question.header} (${question.options.length} option(s)) — turn parked`,
  });

  let onAbort: (() => void) | null = null;
  const answer = await new Promise<AgentQuestionAnswer | null>((resolve) => {
    waiters.set(conversationId, { callId: ctx.callId, resolve });
    if (!ctx.signal) return;
    onAbort = () => settlePendingQuestion(conversationId, null);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
  // The listener outlives the promise otherwise, and a long turn can park
  // more than once.
  if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);

  useChatStore.getState().setPendingQuestion(conversationId, undefined);

  if (!answer) {
    logTurnEvent({
      turnId: null,
      conversationId,
      phase: "tool-phase",
      detail: `ask_user: ${question.header} — turn stopped before an answer`,
    });
    return {
      callId: "",
      name: "ask_user",
      ok: false,
      data: {
        error:
          "The user stopped the turn before answering. The question is no longer on screen; " +
          "do not assume an answer, and do not ask it again unless they ask you to continue.",
        cancelled: true,
      },
      durationMs: Date.now() - started,
      summary: `unanswered: ${question.header}`,
    };
  }

  logTurnEvent({
    turnId: null,
    conversationId,
    phase: "tool-phase",
    detail: `ask_user: ${question.header} — ${answerSummary(answer)}`,
  });

  return {
    callId: "",
    name: "ask_user",
    ok: true,
    data: questionResultPayload(question, answer),
    durationMs: Date.now() - started,
    summary: answerSummary(answer),
  };
}

/**
 * Publishes clickable next steps on the conversation.
 *
 * Fire-and-forget by design: the chips are an affordance for the NEXT turn,
 * so this never blocks the loop and an invalid payload costs the model one
 * correctable error rather than a stuck turn.
 */
export function runSuggestNext(
  conversationId: string,
  args: Record<string, unknown>
): ToolCallResult {
  const started = Date.now();
  const parsed = parseSuggestionArgs(args);
  if (!parsed.ok) return failure("suggest_next", parsed.error, "invalid suggestions");
  useChatStore.getState().setSuggestions(conversationId, parsed.value);
  logTurnEvent({
    turnId: null,
    conversationId,
    phase: "tool-phase",
    detail: `suggest_next: ${parsed.value.map((s) => s.label).join(", ")}`,
  });
  return {
    callId: "",
    name: "suggest_next",
    ok: true,
    data: {
      shown: parsed.value.map((s) => s.label),
      note: "Shown to the user as clickable next steps. They are not sent — the user picks one.",
    },
    durationMs: Date.now() - started,
    summary: `${parsed.value.length} next step(s)`,
  };
}
