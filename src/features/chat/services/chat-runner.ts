// ============================================================
// Chat Runner — Public Turn API (Facade)
// ============================================================
// This module is what the UI calls: send a message, stop, retry,
// resume after reload, export. The turn machinery itself lives in
// session/turn-engine.ts (rounds, rendering, watchdog, transport
// fallback, tool execution) so there is exactly ONE implementation
// of turn semantics — shared by the SharedWorker host and the
// page-local fallback — instead of two that drift apart.

import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { AGENT_ITERATIONS } from "../constants";
import { visibleMessages } from "../types";
import type { ChatMessage } from "../types";
import { serializeToolResult } from "../lib/tools";
import { answerSummary, questionResultPayload, sanitizeAnswer } from "../lib/agent-question";
import { settlePendingQuestion } from "./ask-user";
import { CHAT_COMMANDS, runCommandById } from "../lib/commands";
import { resolveSlashInput } from "../lib/slash";
import { getCachedModelCatalog } from "../lib/model-catalog";
import { sessionHost } from "../session/session-client";
import {
  adoptTurn,
  deliverQueuedMessages,
  isTurnRunning,
  isTurnUnrecoverable,
  runTurn,
  stopTurn,
} from "../session/turn-engine";
import { logTurnEvent } from "../session/turn-log";
import { planResume, danglingToolRange } from "../session/resume-plan";

// Model metadata resolution lives in a leaf module so the compaction
// service can use it without an import cycle. Re-exported here for
// existing UI imports.
import {
  resolveModelInfo,
  ensureModelCatalog,
  ensureCompetenceIndex,
  modelDisplayName,
} from "../lib/model-catalog";
export { resolveModelInfo, ensureModelCatalog, ensureCompetenceIndex };

/** UI-facing model name (no masking) — defined in the leaf catalog module */
export { modelDisplayName };

/**
 * True when the resolved model advertises image input. Unknown when
 * the catalog hasn't loaded — treated as capable (providers enforce).
 */
export function modelSupportsImages(modelId?: string): boolean | null {
  const info = resolveModelInfo(modelId);
  if (!info?.inputModalities) return null;
  return info.inputModalities.includes("image");
}

// ── Sending ─────────────────────────────────────────────────

/** Starts a user turn: appends the message and runs the turn engine */
export function sendUserMessage(
  conversationId: string,
  text: string,
  attachments?: ChatMessage["attachments"]
): void {
  const trimmed = text.trim();
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!trimmed && !hasAttachments) return;

  const store = useChatStore.getState();

  // ── Slash input is a command, never a prompt ──
  // The composer resolves commands before calling here, but this is
  // the single choke point every caller (suggestions, future
  // surfaces, scripts) funnels through, so it re-checks: a draft that
  // names a command runs it, and an unknown bare token is refused
  // with an explanation instead of being sent to a model as a prompt.
  const resolution = resolveSlashInput(trimmed, CHAT_COMMANDS);
  if (resolution.kind === "unknown") {
    useAppStore.getState().addToast({
      message: `Unknown command “/${resolution.token}” — press / to browse commands.`,
      type: "error",
      duration: 4000,
    });
    return;
  }
  if (resolution.kind === "command") {
    const live = useChatStore.getState();
    // Same executor the composer's menu uses (lib/commands.runCommandById),
    // so a command cannot behave differently depending on how it was
    // submitted — the two paths used to run `command.run` separately, which
    // is how one came to apply a returned draft while the other dropped it.
    void runCommandById(resolution.id, {
      conversationId,
      arg: resolution.arg,
      models: getCachedModelCatalog() ?? [],
      isStreaming: live.isStreaming && live.streamingConversationId === conversationId,
    }).then((outcome) => {
      // An explicit draft (a command handing its prefix back) is honored here
      // too. Only an explicit one: this entry point is not the composer, so
      // it must never blank text the user is still typing.
      if (outcome && typeof outcome === "object" && typeof outcome.draft === "string") {
        useChatStore.getState().setComposerDraft(conversationId, outcome.draft);
      }
    });
    return;
  }

  // ── A turn is already running ──
  //
  // This used to be a silent `return`: the message was thrown away and the
  // user was left believing they had sent it. Neither extreme is right —
  // interleaving it into the round in flight would put an instruction in
  // front of tool results the model has not read yet — so it is QUEUED and
  // delivered at the next round boundary (session/turn-engine.ts).
  //
  // The one exception is a turn parked on a question: there, the user's
  // words ARE the answer, and typing them is the natural way to give it.
  if (store.isStreaming || isTurnRunning()) {
    const live = useChatStore.getState().conversations.find((c) => c.id === conversationId);
    if (live?.pendingQuestion) {
      answerQuestion(conversationId, { note: trimmed });
      return;
    }
    store.enqueueUserMessage(conversationId, {
      text: trimmed,
      ...(hasAttachments ? { attachments } : {}),
    });
    store.setSuggestions(conversationId, undefined);
    useAppStore.getState().addToast({
      message: "Queued — sent at the next step of the reply in progress.",
      type: "info",
      duration: 3500,
    });
    return;
  }

  // Warn (don't block) when images ride a text-only model
  const conv = store.conversations.find((c) => c.id === conversationId);
  const modelId = conv?.model ?? store.settings.defaultModel;
  if (
    modelSupportsImages(modelId) === false &&
    (attachments ?? []).some((a) => a.dataUrl)
  ) {
    useAppStore.getState().addToast({
      message: "This model may not accept images — pick a vision model for best results.",
      type: "info",
      duration: 4000,
    });
  }

  const titleSource = trimmed || attachments?.[0]?.name || "New Chat";

  // Chips from the previous turn described a moment that has passed.
  store.setSuggestions(conversationId, undefined);

  // Anything still queued (a turn that was stopped before it could deliver
  // them) is OLDER than this message, so it goes into the transcript first —
  // the model must read the conversation in the order it happened.
  deliverQueuedMessages(conversationId);

  store.addMessage(conversationId, {
    role: "user",
    content: trimmed,
    ...(hasAttachments ? { attachments } : {}),
  });

  // Auto-title new conversations from the first user message
  const conv2 = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  if (conv2 && conv2.title === "New Chat") {
    const title = titleSource.slice(0, 48) + (titleSource.length > 48 ? "…" : "");
    useChatStore.getState().renameConversation(conversationId, title);
  }

  // Marker for reload-resume; the engine clears it on every exit path.
  useChatStore.getState().markPendingTurn(conversationId);

  void runTurn(conversationId);
}

/** Aborts the in-flight turn (partial output is preserved) */
export function stopChatStream(): void {
  stopTurn();
}

/**
 * What clicking "Approve & build" sends.
 *
 * A sentence rather than a hidden flag on purpose: the instruction rides the
 * transcript like any other user turn, so the model reads an approval where
 * it would otherwise read an unexplained mode change, and the user can see
 * exactly what they authorized.
 */
export const PLAN_APPROVAL_MESSAGE =
  "The plan above is approved. Implement it now, in order: start with the first step, verify as you go, " +
  "and keep the plan updated with `update_plan` as steps land.";

/**
 * Authorizes a plan: switches the conversation to Build and starts the work.
 *
 * Plan mode's whole point is that the mode GATES the mutating tools, so the
 * approval has to flip the mode BEFORE the turn is prepared — a turn started
 * in plan mode would be sent a read-only surface and could not implement the
 * very plan the user just approved. That is what makes this an authorization
 * rather than a display: the button is the moment the plan becomes work.
 */
export function approvePlan(conversationId: string): void {
  const store = useChatStore.getState();
  store.setConversationMode(conversationId, "build");
  sendUserMessage(conversationId, PLAN_APPROVAL_MESSAGE);
}

/** What the user handed back for a parked question */
export interface QuestionAnswerInput {
  /** Labels of the options they clicked (filtered to what was offered) */
  selected?: string[];
  /** What they typed, when they typed instead of clicking */
  note?: string;
}

/**
 * Answers the question this conversation's turn is parked on.
 *
 * Two paths, one transcript. With a live turn the waiter resolves, the
 * `ask_user` call finishes with an ordinary result, and the loop continues
 * in place — tool results, plan and all. With no live turn (the page was
 * reloaded while the question was on screen) the call is still dangling in
 * the transcript, so the answer is committed as ITS result and the loop is
 * restarted from stored history: the model reads the same exchange either
 * way, and a question that survived a reload is not answered twice.
 *
 * The answer is filtered against the options the question actually offered
 * (`sanitizeAnswer`): a stale card must not be able to decide with a label
 * the model never proposed.
 */
export function answerQuestion(conversationId: string, input: QuestionAnswerInput): void {
  const store = useChatStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  const question = conversation?.pendingQuestion;
  if (!question) return;

  const answer = sanitizeAnswer(question, input);
  // The chips described the world before this decision.
  store.setSuggestions(conversationId, undefined);

  if (settlePendingQuestion(conversationId, answer)) return;

  store.setPendingQuestion(conversationId, undefined);

  const payload = questionResultPayload(question, answer);
  const dangling = conversation?.messages.some(
    (m) => !m.hidden && m.toolCalls?.calls.some((c) => c.id === question.callId)
  );

  if (dangling) {
    const result = {
      callId: question.callId,
      name: "ask_user" as const,
      ok: true,
      data: payload,
      durationMs: 0,
      summary: answerSummary(answer),
    };
    useChatStore.getState().commitToolResult(conversationId, result, serializeToolResult(result));
  } else {
    // The call is gone from the transcript, so there is nothing to pair a
    // result with and a bare tool_result would be an orphan the wire
    // payload cannot carry. The user's answer still has to reach the model,
    // so it goes as the message it would have been.
    useChatStore.getState().addMessage(conversationId, {
      role: "user",
      content: `Answer to your question "${question.header}": ${answerSummary(answer)}`,
    });
  }

  useChatStore.getState().markPendingTurn(conversationId);
  void runTurn(conversationId);
}

/**
 * Regenerates the last assistant reply: hides it and re-streams.
 *
 * Session-log discipline ("model-visible means logged"): the
 * discarded reply is soft-deleted (`hidden: true`), never removed —
 * the stored history stays a complete, reconstructable record of
 * everything the model has seen. Regenerating the same user turn
 * again un-hides the previous attempts' slot so attempts stack
 * instead of duplicating the user message.
 *
 * The regenerate is recorded as negative feedback for the model that
 * produced the discarded reply.
 */
export async function regenerateLastResponse(conversationId: string): Promise<void> {
  const store = useChatStore.getState();
  const conv = store.conversations.find((c) => c.id === conversationId);
  if (!conv || store.isStreaming || isTurnRunning()) return;

  const visible = visibleMessages(conv.messages);
  const last = visible[visible.length - 1];
  if (!last || last.role !== "assistant") return;

  const lastIdx = conv.messages.findIndex((m) => m.id === last.id);
  const priorUser = [...conv.messages.slice(0, lastIdx)]
    .reverse()
    .find((m) => m.hidden && m.role === "user" && !m.toolResult);
  if (priorUser) {
    store.restoreHiddenFrom(conversationId, priorUser.id);
    // Restore un-hid the prior user turn AND everything after it.
    // Re-hide everything from the old replies on, keeping only the
    // user turn visible as the final turn.
    const after = useChatStore
      .getState()
      .conversations.find((c) => c.id === conversationId);
    if (after) {
      const userIdx = after.messages.findIndex((m) => m.id === priorUser.id);
      const firstReplyIdx = after.messages.findIndex(
        (m, i) => i > userIdx && m.role === "assistant"
      );
      if (firstReplyIdx !== -1) {
        store.truncateFrom(conversationId, after.messages[firstReplyIdx]!.id);
      }
    }
  } else {
    store.truncateFrom(conversationId, last.id);
  }

  // Same reload-resume contract as sendUserMessage
  useChatStore.getState().markPendingTurn(conversationId);
  await runTurn(conversationId);
}

// ── Resume after reload ─────────────────────────────────────

/**
 * Re-entrancy guard: React StrictMode (dev) and double hydration
 * effects invoke resume twice concurrently, which used to adopt the
 * same stream twice and render every token in duplicate.
 */
let resumeInFlight = false;

/**
 * Resumes a turn that was in flight when the page reloaded: adopt
 * the live host stream when it still exists, otherwise follow the
 * pure resume planner (re-stream / continue the tool loop / clean up).
 */
export async function resumeInterruptedTurn(conversationId: string): Promise<boolean> {
  if (resumeInFlight) return false;
  const store = useChatStore.getState();
  const conv = store.conversations.find((c) => c.id === conversationId);
  if (!conv?.pendingTurn || store.isStreaming || isTurnRunning()) return false;

  resumeInFlight = true;
  try {
    // Fast path: the host still owns this turn (reload mid-stream).
    if (await adoptTurn(conversationId)) return true;

    const live = useChatStore.getState().conversations.find((c) => c.id === conversationId);
    if (!live?.pendingTurn) return false;

    const plan = planResume(live.messages, live.pendingTurn, Date.now(), live.pendingQuestion);
    logTurnEvent({
      turnId: null,
      conversationId,
      phase: "resume",
      detail: plan.action,
    });

    switch (plan.action) {
      case "cleanup":
        useChatStore.getState().clearPendingTurn(conversationId);
        return false;

      case "needs-user-action":
      case "keep":
        // Recoverable by the user (error tail) — keep the marker so the
        // explicit Resume affordance stays available.
        return false;

      case "await-answer":
        // The turn is waiting, not broken. The question card is already on
        // screen from persisted state, and answering it is what restarts
        // the loop — so there is nothing to replay here, and re-running the
        // round would throw the question away instead of resuming it.
        return false;

      case "continue-tool-loop": {
        if (plan.trimToCallId) {
          // Drop the dangling tool_calls message (results must pair
          // with requests in the wire payload).
          const range = danglingToolRange(live.messages, plan.trimToCallId);
          const visible = live.messages.filter((m) => !m.hidden);
          const tail = visible.slice(Math.max(0, visible.length - range));
          for (const m of tail) {
            useChatStore.getState().truncateFrom(conversationId, m.id);
          }
        }
        await runTurn(conversationId);
        return true;
      }

      case "restream":
      case "restream-after-partial":
        await resumeUserTurn(conversationId);
        return true;
    }
  } finally {
    resumeInFlight = false;
  }
}

/**
 * User-initiated (or auto) resume of an interrupted turn: re-streams
 * with one offline-aware retry. When the engine could not run at all
 * (offline, or a turn already owned the page), the marker is flagged
 * "unresumable" so the explicit Resume affordance stays available
 * without retriggering on every load.
 */
export async function resumeUserTurn(conversationId: string): Promise<void> {
  const store = useChatStore.getState();
  const conv = store.conversations.find((c) => c.id === conversationId);
  if (!conv?.pendingTurn) return;
  if (store.isStreaming || isTurnRunning()) return;

  store.setReconnecting(true);
  try {
    await runTurn(conversationId);
    if (!navigator.onLine) {
      // The network went away mid-attempt — keep the marker for a retry
      await new Promise((r) => setTimeout(r, 1500));
      const live = useChatStore.getState();
      if (!live.isStreaming && !isTurnRunning()) await runTurn(conversationId);
    }
  } finally {
    useChatStore.getState().setReconnecting(false);
  }

  // The engine clears the marker whenever it ran. A still-present
  // marker means the turn never started — surface the manual Resume.
  const after = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  if (after?.pendingTurn) {
    useChatStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId && c.pendingTurn
          ? { ...c, pendingTurn: { ...c.pendingTurn, outcome: "unresumable" as const } }
          : c
      ),
    }));
  }
}

// ── Pagehide safety net ─────────────────────────────────────

/**
 * Commits streamed-but-uncommitted content as a partial reply so the
 * resume planner can complete it after reload.
 *
 * Only for turns whose output dies with the page (page-local
 * transport, tool execution): a host-owned stream keeps producing in
 * the worker and adoption replays it in full, so committing here
 * would duplicate that content in the transcript.
 */
export function commitPartialReply(conversationId: string): string | null {
  const state = useChatStore.getState();
  if (!state.isStreaming) return null;
  if (isTurnRunning() && !isTurnUnrecoverable()) return null;
  const content = state.streamingContent;
  if (!content.trim()) return null;

  const conv = state.conversations.find((c) => c.id === conversationId);
  const last =
    conv && conv.messages.length > 0 ? conv.messages[conv.messages.length - 1] : undefined;
  // Idempotent: flushing twice (visibilitychange → pagehide) must not
  // duplicate the partial.
  if (last?.resumedPartial && last.content === content) return last.id;

  const reasoning = state.streamingReasoning;
  const id = state.commitDirectAssistantMessage(conversationId, {
    content,
    reasoning: reasoning || undefined,
    resumedPartial: true,
  });
  useChatStore.setState({ streamingContent: "", streamingReasoning: "" });
  logTurnEvent({
    turnId: null,
    conversationId,
    phase: "stream-end",
    detail: "pagehide partial commit",
  });
  return id;
}

// ── Export ──────────────────────────────────────────────────
// Moved to a leaf module (services/export-conversation.ts) so the
// slash-command registry can offer /export without importing the
// turn engine. Re-exported here for existing callers.

export { downloadConversation, exportConversationToMarkdown } from "./export-conversation";

// Re-exported so callers can pre-connect the host without importing
// the session layer directly.
export { sessionHost };
export { AGENT_ITERATIONS };
