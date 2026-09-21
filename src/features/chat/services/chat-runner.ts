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
import { AGENT_ITERATIONS_MAX, AGENT_MAX_ITERATIONS } from "../constants";
import { visibleMessages } from "../types";
import type { ChatMessage } from "../types";
import { CHAT_COMMANDS, CHAT_COMMAND_BY_ID } from "../lib/commands";
import { resolveSlashInput } from "../lib/slash";
import { getCachedModelCatalog } from "../lib/model-catalog";
import { sessionHost } from "../session/session-client";
import {
  adoptTurn,
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
import { resolveModelInfo, ensureModelCatalog, modelDisplayName } from "../lib/model-catalog";
export { resolveModelInfo, ensureModelCatalog };

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
  // `isTurnRunning` closes the window between a send and the engine's
  // first streaming update, where `isStreaming` is still false.
  if (store.isStreaming || isTurnRunning()) return;

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
    const command = CHAT_COMMAND_BY_ID.get(resolution.id);
    if (command) {
      const live = useChatStore.getState();
      const outcome = command.run({
        conversationId,
        arg: resolution.arg,
        models: getCachedModelCatalog() ?? [],
        isStreaming: live.isStreaming && live.streamingConversationId === conversationId,
      });
      void Promise.resolve(outcome);
    }
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

    const plan = planResume(live.messages, live.pendingTurn);
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
export { AGENT_MAX_ITERATIONS, AGENT_ITERATIONS_MAX };
