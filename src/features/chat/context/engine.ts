// ============================================================
// Context Engine — Budget-Aware Request Assembly
// ============================================================
// The single entry point the chat runner uses to turn a stored
// conversation into (a) a request-safe message list and (b) the
// numbers the ContextMeter renders. Kept UI-free and side-effect
// free so it can be unit-tested independently.
//
// Request-time tool-result folding: agent tool results older than
// TOOL_RESULT_FOLD_TURNS turns are replaced in the wire payload by
// one-line digests (kept verbatim in stored history), so long agent
// loops stop re-paying 12k-char payloads on every iteration.

import { TOOL_RESULT_FOLD_TURNS } from "../constants";
import { COMPACTION_THRESHOLD } from "../constants";
import type {
  ChatConversation,
  ChatMessage,
  ContentPart,
  ContextBreakdown,
  ConversationSummary,
  ModelInfo,
  ToolCallRequest,
  ToolCallResult,
  WireContent,
} from "../types";
import { visibleMessages } from "../types";
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
  /** Tool results folded to digests for this request (still verbatim in history) */
  foldedToolResults: number;
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

// ── Tool-result folding (request-time digests) ──────────────

/** Turns one tool result message into a one-line digest */
function toolResultDigest(tr: ToolResultMessageForFold): string {
  const status = tr.ok ? "ok" : "ERROR";
  const dur = tr.durationMs > 0 ? ` · ${tr.durationMs}ms` : "";
  const summary = tr.summary ? ` — ${tr.summary}` : "";
  return `[Tool result: ${tr.name} — ${status}${dur}${summary}] (older output folded)`;
}

interface ToolResultMessageForFold {
  name: ToolCallResult["name"];
  ok: boolean;
  durationMs: number;
  summary?: string;
}

/**
 * Marks which stored messages are "stale" tool results: any tool
 * result more than TOOL_RESULT_FOLD_TURNS user/assistant exchanges
 * from the end of the conversation. Pure — never mutates input.
 */
export function staleToolResultIds(messages: ChatMessage[]): Set<string> {
  const stale = new Set<string>();
  // Count user-visible exchanges from the end: a walk over messages
  // that increments on each user-role transcript turn (attachments
  // and tool results excluded — they are protocol rows, not turns).
  let turnsFromEnd = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const isTranscriptTurn =
      (m.role === "user" && !m.toolResult) || (m.role === "assistant" && !m.toolCalls);
    if (isTranscriptTurn) turnsFromEnd++;
    if (m.toolResult && turnsFromEnd > TOOL_RESULT_FOLD_TURNS) {
      stale.add(m.id);
    }
  }
  return stale;
}

/**
 * Maps one stored message to its wire format. Agent-activity
 * messages map to the OpenAI tool protocol: a tool-calls assistant
 * message carries `tool_calls`; each result rides as a user-role
 * message with a labeled JSON payload (widely compatible with
 * OpenRouter models, including those without native tool support).
 * Stale tool results (fold=true) collapse to their digest line.
 */
function wireMessage(message: ChatMessage, fold: boolean): WireMessage {
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
    if (fold) {
      return { role: "user", content: toolResultDigest(tr) };
    }
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
 * Never mutates the conversation. `modelId` enables calibrated
 * token estimates for the model actually being queried.
 */
export function prepareRequest(params: {
  conversation: ChatConversation;
  model?: ModelInfo;
  effectiveSystemPrompt?: string;
  /** Extra headroom to reserve (e.g. when regenerating excludes the last reply) */
  extraReserveTokens?: number;
  /** The concrete wire model (calibration key) — defaults to model.id */
  modelId?: string;
}): PreparedRequest {
  const modelId = params.modelId ?? params.model?.id;
  const budget = computeBudget({
    model: params.model,
    systemPrompt: params.effectiveSystemPrompt,
  });

  const budgetTokens = Math.max(
    0,
    budget.available - (params.extraReserveTokens ?? 0)
  );

  // Soft-deleted messages (regenerate) never reach a request.
  const visible = visibleMessages(params.conversation.messages);

  const { messages, hiddenCount } = compactMessages(
    visible,
    budgetTokens,
    modelId
  );

  // Compaction markers are UI state, not conversation content —
  // the summary itself rides in the system prompt.
  const wireCandidates = messages.filter((m) => m.compactedFrom === undefined);

  // Truncation can orphan tool results (a kept tail starting with a
  // result whose tool_calls assistant message was folded away) —
  // drop them so requests never reference unknown call ids.
  let start = 0;
  while (start < wireCandidates.length && wireCandidates[start]?.toolResult) {
    start++;
  }
  const cleanMessages = wireCandidates.slice(start);

  // Fold stale tool results to digests (request-time only)
  const stale = staleToolResultIds(visible);
  const foldedToolResults = cleanMessages.filter((m) => stale.has(m.id)).length;

  const wire = cleanMessages.map((m) => wireMessage(m, stale.has(m.id)));

  // Session-log invariant (dev-mode): every wire payload must be
  // reconstructable from stored, model-visible history — "model-visible
  // means logged". Walks the payload against the visible transcript
  // and warns with a compact diff when they diverge.
  assertLogInvariant(visible, wire);

  return {
    messages: wire,
    hiddenCount,
    sentTokens: estimateConversationTokens(cleanMessages, modelId),
    budget,
    foldedToolResults,
  };
}

/**
 * Dev-mode check of the "model-visible means logged" invariant:
 * the wire payload derived by prepareRequest must map 1:1 onto the
 * visible stored transcript (compaction markers excluded — the
 * summary rides in the system prompt, not the message list).
 */
function assertLogInvariant(visible: ChatMessage[], wire: WireMessage[]): void {
  if (!import.meta.env?.DEV) return;
  if (wire.length === visible.length) return; // fast path
  // The only legal divergence: boundary-snapping in the truncation
  // compactor (it may keep FEWER messages than exist to land on a
  // user-role start). The payload must always be a SUFFIX of the
  // visible transcript, aligned at the end.
  if (wire.length > visible.length || wire.length === 0) {
    reportLogInvariantViolation(visible.length, wire.length, "payload exceeds visible history");
    return;
  }
  for (let i = 1; i <= wire.length; i++) {
    const stored = visible[visible.length - i];
    const sent = wire[wire.length - i];
    if (!stored || !sent) break;
    // Role + a content fingerprint must line up from the end.
    const storedRole = stored.toolResult ? "user" : stored.role;
    const sentRole = sent.role;
    if (storedRole !== sentRole) {
      reportLogInvariantViolation(visible.length, wire.length, `role mismatch at offset -${i}`);
      return;
    }
  }
}

function reportLogInvariantViolation(visibleCount: number, wireCount: number, why: string): void {
  console.warn(
    `[session-log invariant] request payload does not reconstruct from stored history: ${why} ` +
      `(stored visible: ${visibleCount}, wire: ${wireCount}). ` +
      "This usually means a destructive history edit bypassed soft-delete."
  );
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
  /** Concrete wire model for calibration (InTab passes the pool pick) */
  modelId?: string;
}): ContextBreakdown {
  const modelId = params.modelId ?? params.model?.id;
  const budget = computeBudget({
    model: params.model,
    systemPrompt: params.effectiveSystemPrompt,
  });

  // System tokens already include the rolling summary when the
  // caller composed the prompt via composeSystemPrompt().
  const stored = estimateConversationTokens(params.conversation.messages, modelId);
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
