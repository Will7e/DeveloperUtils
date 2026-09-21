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

/**
 * Wire message in the OpenAI tool protocol: an assistant row may carry
 * `tool_calls`, and every one of those calls is answered by a `tool`
 * row carrying the same `tool_call_id`.
 */
export interface WireMessage {
  role: ChatMessage["role"] | "tool";
  content: WireContent | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
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

/**
 * Turns one tool result message into a one-line digest. Exported so the
 * folded shape is pinnable in tests — it is the only thing the model
 * retains of an old tool result, so its contents are a contract.
 */
export function toolResultDigestText(tr: ToolResultMessageForFold): string {
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
 * Maps one stored message to its wire format. Agent-activity messages
 * map to the real OpenAI tool protocol: a tool-calls assistant message
 * carries `tool_calls`, and each result is a `tool` row bound to it by
 * `tool_call_id`. Providers validate that pairing and return 400 when
 * it is missing or mislabelled, so this must never degrade to plain
 * user text. Stale tool results (fold=true) collapse their *content*
 * to a digest line while keeping the pairing intact.
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
    return {
      role: "tool",
      tool_call_id: tr.callId,
      content: fold ? toolResultDigestText(tr) : tr.content,
    };
  }
  return { role: message.role, content: wireContent(message) };
}

/**
 * Makes the tool protocol well-formed for one request slice:
 *
 *  - an assistant turn keeps only the calls that have a matching
 *    result in the slice (a request must not reference an unanswered
 *    call — strict providers reject it);
 *  - a result whose call was truncated/folded away is dropped;
 *  - an assistant turn with no answered calls left degrades to plain
 *    text, and disappears when it has no text either;
 *  - a leading `tool` row (its call was cut off at the boundary) goes.
 *
 * Pure — never mutates the input messages.
 */
export function sanitizeToolProtocol(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.toolResult) answered.add(m.toolResult.callId);
  }

  const keptCallIds = new Set<string>();
  const out: ChatMessage[] = [];

  for (const m of messages) {
    if (m.toolCalls) {
      const calls = m.toolCalls.calls.filter((c) => answered.has(c.id));
      if (calls.length === 0) {
        // No answer will ever arrive for these calls — drop the
        // protocol row, keeping any prose the model wrote.
        if (!m.content.trim()) continue;
        out.push({ ...m, toolCalls: undefined });
        continue;
      }
      for (const c of calls) keptCallIds.add(c.id);
      out.push(
        calls.length === m.toolCalls.calls.length
          ? m
          : { ...m, toolCalls: { kind: "tool_calls", calls } }
      );
      continue;
    }
    if (m.toolResult) {
      if (!keptCallIds.has(m.toolResult.callId)) continue;
      out.push(m);
      continue;
    }
    out.push(m);
  }

  // A request may never open with a `tool` row: its assistant turn was
  // cropped by compaction, so the boundary moves forward.
  let start = 0;
  while (start < out.length && out[start]!.toolResult) start++;
  return start === 0 ? out : out.slice(start);
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

  // Truncation can orphan half of a tool exchange (a kept tail whose
  // tool_calls turn was cropped, or a cut turn whose results never
  // committed) — sanitize so the wire payload is always a valid
  // protocol sequence for strict providers.
  const cleanMessages = sanitizeToolProtocol(wireCandidates);

  // Fold stale tool results to digests (request-time only)
  const stale = staleToolResultIds(visible);
  const foldedToolResults = cleanMessages.filter((m) => stale.has(m.id)).length;

  const wire = cleanMessages.map((m) => wireMessage(m, stale.has(m.id)));

  // Session-log invariant (dev-mode): every wire payload must be
  // reconstructable from stored, model-visible history — "model-visible
  // means logged". The payload maps 1:1 onto the sanitized slice, and
  // that slice must itself be an ordered subsequence of the visible
  // transcript.
  assertLogInvariant(visible, cleanMessages, wire);

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
 *  (a) the sanitized slice is an ordered subsequence of the visible
 *      stored transcript, and
 *  (b) the wire payload maps 1:1 onto that slice, with matching roles.
 * Compaction markers are excluded — the summary rides in the system
 * prompt, not the message list.
 */
function assertLogInvariant(
  visible: ChatMessage[],
  sanitized: ChatMessage[],
  wire: WireMessage[]
): void {
  if (!import.meta.env?.DEV) return;

  if (wire.length !== sanitized.length) {
    reportLogInvariantViolation(visible.length, wire.length, "payload is not a 1:1 map of stored history");
    return;
  }

  let cursor = 0;
  for (const row of sanitized) {
    const idx = visible.indexOf(row, cursor);
    if (idx === -1) {
      reportLogInvariantViolation(visible.length, wire.length, "sanitized slice left stored order");
      return;
    }
    cursor = idx + 1;
  }

  for (let i = 0; i < wire.length; i++) {
    const stored = sanitized[i];
    const sent = wire[i];
    if (!stored || !sent) break;
    const storedRole = stored.toolResult ? "tool" : stored.role;
    if (storedRole !== sent.role) {
      reportLogInvariantViolation(visible.length, wire.length, `role mismatch at offset ${i}`);
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
