// ============================================================
// Context Engine — Budget-Aware Request Assembly
// ============================================================
// The single entry point the chat runner uses to turn a stored
// conversation into (a) a request-safe message list and (b) the
// numbers the ContextMeter renders. Kept UI-free and side-effect
// free so it can be unit-tested independently.

import { COMPACTION_THRESHOLD } from "../constants";
import type {
  ChatConversation,
  ChatMessage,
  ContextBreakdown,
  ModelInfo,
} from "../types";
import { computeBudget, healthFromPercentage, type RequestBudget } from "./budget";
import { buildCompactionMarker, compactMessages } from "./compactor";
import { estimateConversationTokens, estimateTokens } from "./tokenizer";

export interface PreparedRequest {
  /** Message list to send — fits the budget, starts with "user" */
  messages: Array<Pick<ChatMessage, "role" | "content">>;
  /** Number of messages hidden by compaction */
  hiddenCount: number;
  /** Tokens actually being sent (estimate) */
  sentTokens: number;
  budget: RequestBudget;
}

/**
 * Assembles a budget-safe request from a stored conversation.
 * Never mutates the conversation.
 */
export function prepareRequest(params: {
  conversation: ChatConversation;
  model?: ModelInfo;
  effectiveSystemPrompt?: string;
  /** Extra headroom to reserve (e.g. when regenerating excludes the last reply) */
  extraReserveTokens?: number;
}): PreparedRequest {
  const budget = computeBudget({
    model: params.model,
    systemPrompt: params.effectiveSystemPrompt,
  });

  const budgetTokens = Math.max(
    0,
    budget.available - (params.extraReserveTokens ?? 0)
  );

  const { messages, hiddenCount } = compactMessages(
    params.conversation.messages,
    budgetTokens
  );

  return {
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    hiddenCount,
    sentTokens: estimateConversationTokens(messages),
    budget,
  };
}

/**
 * Context meter numbers for the active conversation. Estimates are
 * used throughout; the ContextMeter can refine per-message with
 * exact usage once the runner has recorded it (kept simple here:
 * exacts live in usage metadata and this estimate stays stable).
 */
export function getConversationContext(params: {
  conversation: ChatConversation;
  model?: ModelInfo;
  effectiveSystemPrompt?: string;
}): ContextBreakdown {
  const budget = computeBudget({
    model: params.model,
    systemPrompt: params.effectiveSystemPrompt,
  });

  const sentTokens = estimateConversationTokens(params.conversation.messages);
  const totalTokens = budget.systemTokens + sentTokens;
  const pct = Math.min(
    100,
    (totalTokens / Math.max(1, budget.window - budget.outputReserve)) * 100
  );

  return {
    totalTokens,
    sentTokens,
    compactedTokens: 0,
    maxTokens: budget.window,
    percentageUsed: Math.round(pct * 10) / 10,
    health: healthFromPercentage(pct),
  };
}

/**
 * True when the next send should trigger compaction (used by the
 * runner to warn or by the UI to show a hint).
 */
export function needsCompaction(context: ContextBreakdown): boolean {
  return context.percentageUsed >= COMPACTION_THRESHOLD * 100;
}

/** Re-export for convenience in UI layers */
export { buildCompactionMarker, estimateTokens };
