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
  ContentPart,
  ContextBreakdown,
  ConversationSummary,
  ModelInfo,
  ToolCallRequest,
  WireContent,
} from "../types";
import { computeBudget, healthFromPercentage, type RequestBudget } from "./budget";
import { buildCompactionMarker, compactMessages } from "./compactor";
import { estimateConversationTokens, estimateTokens } from "./tokenizer";

/** Wire message with optional OpenAI tool_calls (assistant) payload */
export interface WireMessage {
  role: ChatMessage["role"];
  content: WireContent | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface PreparedRequest {
  /** Message list to send — fits the budget, starts with "user" */
  messages: WireMessage[];
  /** Number of messages hidden by compaction */
  hiddenCount: number;
  /** Tokens actually being sent (estimate) */
  sentTokens: number;
  budget: RequestBudget;
}

/**
 * Appends the rolling conversation summary to the effective system
 * prompt. The summary lives in the system block (deterministic text,
 * stable position) so provider-side prompt caches keep hitting.
 */
export function composeSystemPrompt(
  basePrompt: string | undefined,
  summary?: ConversationSummary
): string | undefined {
  const base = basePrompt?.trim() ?? "";
  if (!summary?.text.trim()) return base.trim() || undefined;

  const summaryBlock = `# Conversation Summary (authoritative memory)\n\n${summary.text.trim()}`;
  return base ? `${base}\n\n${summaryBlock}` : summaryBlock;
}

/**
 * Maps one stored message to its wire format. Agent-activity
 * messages map to the OpenAI tool protocol: a tool-calls assistant
 * message carries `tool_calls`; each result rides as a user-role
 * message with a labeled JSON payload (widely compatible with
 * OpenRouter models, including those without native tool support).
 */
function wireMessage(message: ChatMessage): WireMessage {
  if (message.toolCalls) {
    const calls: ToolCallRequest[] = message.toolCalls.calls;
    return {
      role: "assistant",
      // OpenAI requires null (not empty string) when tool_calls carry the turn
      content: message.content || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    } as unknown as WireMessage;
  }
  if (message.toolResult) {
    const tr = message.toolResult;
    return {
      role: "user",
      content: `[Tool result: ${tr.name}${tr.ok ? "" : " — ERROR"}]\n${tr.content}`,
    };
  }
  return { role: message.role, content: wireContent(message) };
}

/**
 * Builds the wire content for one message: plain text when there are
 * no image attachments, otherwise an OpenAI-compatible part array.
 */
function wireContent(message: ChatMessage): string | ContentPart[] {
  const images = (message.attachments ?? []).filter((a) => a.dataUrl);
  if (message.role !== "user" || images.length === 0) {
    return message.content;
  }

  const parts: ContentPart[] = [];
  if (message.content.trim()) {
    parts.push({ type: "text", text: message.content });
  }
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: img.dataUrl! } });
  }
  return parts;
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

  // Compaction markers are UI state, not conversation content —
  // the summary itself rides in the system prompt.
  const wireMessages = messages.filter((m) => m.compactedFrom === undefined);

  // Truncation can orphan tool results (a kept tail starting with a
  // result whose tool_calls assistant message was folded away) —
  // drop them so requests never reference unknown call ids.
  let start = 0;
  while (start < wireMessages.length && wireMessages[start]?.toolResult) {
    start++;
  }
  const cleanMessages = wireMessages.slice(start);

  return {
    messages: cleanMessages.map(wireMessage),
    hiddenCount,
    sentTokens: estimateConversationTokens(cleanMessages),
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

  // System tokens already include the rolling summary when the
  // caller composed the prompt via composeSystemPrompt().
  const stored = estimateConversationTokens(params.conversation.messages);
  const totalTokens = budget.systemTokens + stored;
  const summary = params.conversation.summary;
  const compactedTokens = summary?.freedTokens ?? 0;
  const pct = Math.min(
    100,
    (totalTokens / Math.max(1, budget.window - budget.outputReserve)) * 100
  );

  return {
    totalTokens,
    sentTokens: stored,
    compactedTokens,
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
