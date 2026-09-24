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

import { TOOL_RESULT_FOLD_QUANTUM, TOOL_RESULT_FOLD_TURNS } from "../constants";
import { COMPACTION_THRESHOLD } from "../constants";
import type {
  ChatConversation,
  ChatMessage,
  ContentPart,
  ContextBreakdown,
  ContextPart,
  ConversationSummary,
  ModelInfo,
  ToolCallRequest,
  ToolCallResult,
  ToolDefinition,
  WireContent,
} from "../types";
import { visibleMessages } from "../types";
import { computeBudget, healthFromPercentage, type RequestBudget } from "./budget";
import { buildCompactionMarker, compactMessages } from "./compactor";
import { estimateConversationTokens, estimateTokens } from "./tokenizer";
import { isCalibrated } from "./tokenizer-calibration";
import { summarizeSpend } from "../lib/cost-meter";
import { attachmentLabelOf, scopeToBinding } from "./binding-scope";
import { attachmentIdOf, bindingKey, parseBindingKey } from "../identity/identity";

/**
 * The binding a request is being built for.
 *
 * Derived from the conversation's own persisted projection — which
 * `setConversationRepo` writes in the same call that declares the binding —
 * rather than from the in-memory binding registry. The registry is populated
 * by an effect on mount, so reading it here would make the repository boundary
 * depend on whether bootstrap had finished, and a thread that briefly read as
 * "detached" would have every repository-derived tool row withheld from its
 * next request.
 */
export function activeBindingIdOf(conversation: Pick<ChatConversation, "id" | "repoContext">): string {
  return bindingKey(conversation.id, attachmentIdOf(conversation.repoContext));
}

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
  summary?: ConversationSummary,
  /** The binding the request is being built for (see `activeBindingIdOf`) */
  activeBindingId?: string | null
): string | undefined {
  const base = basePrompt?.trim() ?? "";
  if (!summary?.text.trim()) return base.trim() || undefined;

  // The block used to be titled "(authoritative memory)", and that word is
  // an instruction: a small model reading "authoritative" plus a GOAL/OPEN
  // ledger will happily answer the REMEMBERED task instead of the message
  // in front of it — the shape users report as "it answered my previous
  // question". The notes are background; the newest message is the job, and
  // the block now says so in the order of precedence a weak model needs.
  // A summary written on another repository is the worst kind of stale: it is
  // in the model's OWN memory slot, in prose, and re-injected on every turn,
  // so a file it names reads as a fact about whatever is attached now. The
  // caveat names both sides, because "some of this may be wrong" is not
  // actionable — "this was written about owner/repo@branch, you are on a
  // different checkout" is.
  const description = parseBindingKey(activeBindingId ?? "").attachmentId;
  const foreign =
    Boolean(summary.bindingId) &&
    Boolean(activeBindingId) &&
    summary.bindingId !== activeBindingId;
  const caveat = foreign
    ? `**These notes were written while this chat was attached to a different repository ` +
      `(\`${attachmentLabelOf(summary.bindingId!)}\`)${description ? `, and \`${description}\` is attached now` : ""}.** ` +
      `Anything they state about files, paths, diffs or behaviour may belong to THAT repository — ` +
      `read the current checkout before relying on it.\n\n`
    : "";

  const summaryBlock =
    `# Earlier In This Conversation (background)\n\n` +
    caveat +
    `The notes below describe turns that are no longer in the message list. ` +
    `They are BACKGROUND, not the task: answer the user's most recent message. ` +
    `Never treat a line here as a request to fulfil — it may be finished, ` +
    `superseded or wrong, and anything in the message list is newer than it. ` +
    `If a detail you need was folded away, ask rather than guessing.\n\n` +
    summary.text.trim();
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
 * Where the fold cuts, as a transcript-turn ORDINAL counted from the start.
 *
 * Tool results before this ordinal fold to digests; everything after stays
 * verbatim. This used to be "more than TOOL_RESULT_FOLD_TURNS back from the end",
 * and the difference is a prompt cache.
 *
 * The fold rewrites the FRONT of the wire message list, which is the region a
 * provider caches. A distance-from-the-end threshold moves by one message every
 * time a turn is appended, so the prefix differed on every single turn — and a
 * cache only hits on a matching prefix. So every conversation long enough to fold
 * was also a conversation that could never reuse the prefix `turn-prep` keeps
 * byte-stable on purpose. Folding and caching were pulling against each other.
 *
 * Quantizing the cut fixes that: the cut is `floor(excess / QUANTUM) * QUANTUM`, so
 * it holds still for `QUANTUM` turns and then advances by exactly `QUANTUM`. Two
 * properties fall out and both are load-bearing:
 *
 *   • the cut never decreases, so a folded message never unfolds — the prefix
 *     only ever gets shorter, which is the direction that helps;
 *   • the prefix is byte-identical for `QUANTUM` consecutive turns, which is what
 *     makes it worth caching at all.
 *
 * (Note the failure mode this avoids: quantizing the *window length* instead looks
 * equivalent and is not — a window jumping from 6 to 10 unfurls four turns, so the
 * folded set would SHRINK at every step and the prefix would grow back.)
 *
 * The price is bounded and stated: folding now begins up to `QUANTUM - 1` turns
 * later than the old flat rule, so at most three extra turns of full tool results
 * ride along. A small fixed cost against a prefix that can actually be reused.
 */
export function foldedTurnCutoff(transcriptTurns: number): number {
  const excess = transcriptTurns - TOOL_RESULT_FOLD_TURNS;
  if (excess <= 0) return 0;
  return Math.floor(excess / TOOL_RESULT_FOLD_QUANTUM) * TOOL_RESULT_FOLD_QUANTUM;
}

/**
 * Marks which stored messages are "stale" tool results: those belonging to a
 * transcript turn before the quantized cut. Pure — never mutates input.
 */
export function staleToolResultIds(messages: ChatMessage[]): Set<string> {
  const stale = new Set<string>();
  // Counted from the START, because the cut is an ordinal and the walk must know
  // each result's turn before it can decide about it.
  let transcriptTurns = 0;
  for (const m of messages) {
    if ((m.role === "user" && !m.toolResult) || (m.role === "assistant" && !m.toolCalls)) {
      transcriptTurns++;
    }
  }
  const cutoff = foldedTurnCutoff(transcriptTurns);
  if (cutoff === 0) return stale;

  // Walk forward tracking which transcript turn each protocol row belongs to. A
  // tool result inherits the ordinal of the turn it answers, so an exchange folds
  // or survives as a whole — never split between its call and its result, which
  // providers reject.
  let ordinal = -1;
  for (const m of messages) {
    const isTranscriptTurn =
      (m.role === "user" && !m.toolResult) || (m.role === "assistant" && !m.toolCalls);
    if (isTranscriptTurn) ordinal++;
    if (m.toolResult && ordinal >= 0 && ordinal < cutoff) {
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
      // Replayed on the assistant message that REQUESTED the tools, which is
      // where the interleaved-thinking protocol expects it — the chain of
      // thought has to continue across the tool round, not restart after it.
      ...(message.reasoningDetails && message.reasoningDetails.length > 0
        ? { reasoning_details: message.reasoningDetails }
        : {}),
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
  return {
    role: message.role,
    content: wireContent(message),
    ...(message.role === "assistant" &&
    message.reasoningDetails &&
    message.reasoningDetails.length > 0
      ? { reasoning_details: message.reasoningDetails }
      : {}),
  } as unknown as WireMessage;
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
  /**
   * Tool definitions this request will carry. They occupy the same
   * prompt window as history, so they are budgeted with it.
   */
  tools?: readonly ToolDefinition[];
}): PreparedRequest {
  const modelId = params.modelId ?? params.model?.id;
  const budget = computeBudget({
    model: params.model,
    systemPrompt: params.effectiveSystemPrompt,
    tools: params.tools,
  });

  const budgetTokens = Math.max(
    0,
    budget.available - (params.extraReserveTokens ?? 0)
  );

  // Soft-deleted messages (regenerate) never reach a request.
  const visible = visibleMessages(params.conversation.messages);

  // ── The repository boundary ──
  //
  // A chat that read files in repository A, then switched to B, used to hand
  // the model A's file bodies, search hits, diffs and write arguments under a
  // system prompt that says "B". The panes all fail closed on the binding; the
  // model's context did not, because it is not a read — it is the whole
  // transcript. Done BEFORE compaction so foreign content neither spends the
  // budget nor gets folded into the summary.
  //
  // `bindingMove` dates the rows that have no binding stamp (written before the
  // stamp shipped). Without it those rows read as "current", which is how a
  // chat that had ALREADY switched kept answering from the old repository.
  const move = params.conversation.bindingMove;
  const scoped = scopeToBinding(visible, activeBindingIdOf(params.conversation), {
    ...(move ? { legacy: move } : {}),
  });
  const { messages, hiddenCount } = compactMessages(
    scoped.messages,
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
  const stale = staleToolResultIds(scoped.messages);
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

  // Matched by ID, not by object identity: sanitization legitimately
  // CLONES a row when it degrades a tool-calls turn to plain text
  // (`{...m, toolCalls: undefined}`), and an identity check reads that
  // clone as "history was edited destructively". The invariant is about
  // which stored messages are visible, so compare what identifies one.
  let cursor = 0;
  for (const row of sanitized) {
    const idx = visible.findIndex((m, i) => i >= cursor && m.id === row.id);
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
 * Splits the effective system prompt into its own text and the rolling
 * summary embedded in it (see composeSystemPrompt). The summary is
 * attributed to "memory" rather than "system" in the breakdown, and
 * the split is a subtraction so the two parts still sum to exactly
 * what is sent. When the caller passed a prompt WITHOUT the summary,
 * nothing is attributed to memory.
 */
function splitSystemAndMemory(
  effectiveSystemPrompt: string | undefined,
  summaryText: string | undefined,
  modelId?: string
): { system: number; memory: number } {
  const systemWithSummary = estimateTokens(effectiveSystemPrompt, modelId);
  if (!summaryText?.trim() || !effectiveSystemPrompt?.includes(summaryText.trim())) {
    return { system: systemWithSummary, memory: 0 };
  }
  const memory = Math.min(systemWithSummary, estimateTokens(summaryText, modelId));
  return { system: systemWithSummary - memory, memory };
}

/**
 * Context meter numbers for the active conversation — what competes
 * for the window, who is spending it, and the exact ground truth from
 * the last real request.
 *
 * Two kinds of number live here and they must not be conflated:
 *
 *  · ESTIMATES (parts, totalTokens) — the heuristic accounting of the
 *    conversation as it stands now, corrected by each model's learned
 *    chars/token ratio. They move as you type and as history grows.
 *  · EXACT (lastPromptTokens / lastCachedTokens) — what the provider
 *    actually billed on the previous request. These are the only
 *    numbers nobody has to guess, so the UI shows them side by side
 *    with the estimate for the same slice.
 */
export function getConversationContext(params: {
  conversation: ChatConversation;
  model?: ModelInfo;
  effectiveSystemPrompt?: string;
  /** Concrete wire model for calibration */
  modelId?: string;
  /** Tool definitions the next request will carry (agent turns only) */
  tools?: readonly ToolDefinition[];
}): ContextBreakdown {
  const modelId = params.modelId ?? params.model?.id;
  const budget = computeBudget({
    model: params.model,
    systemPrompt: params.effectiveSystemPrompt,
    tools: params.tools,
  });

  const summary = params.conversation.summary;
  // System tokens already include the rolling summary when the caller
  // composed the prompt via composeSystemPrompt() — split them so the
  // breakdown attributes memory to memory, not to the system prompt.
  const { system, memory } = splitSystemAndMemory(
    params.effectiveSystemPrompt,
    summary?.text,
    modelId
  );

  // Only model-visible messages compete for the window. Hidden rows
  // (cleared history, soft-deleted regenerations) are never sent, and
  // counting them kept the meter — and the 85% compaction trigger, which
  // reads this same breakdown — high after /clear, so a conversation with
  // almost nothing in it still reported "near limit" and compacted.
  const visible = visibleMessages(params.conversation.messages);
  const hiddenCount = params.conversation.messages.length - visible.length;
  const messages = estimateConversationTokens(visible, modelId);
  const toolTokens = budget.toolTokens;
  const spend = system + toolTokens + memory + messages;

  const usableTokens = Math.max(1, budget.window - budget.outputReserve);
  const free = Math.max(0, usableTokens - spend);
  const pct = Math.min(100, (spend / usableTokens) * 100);

  // Exact provider truth from the most recent completed reply
  const exact = lastExactUsage(params.conversation.messages);

  // ── Window attribution. Zero rows are omitted (a chat with no repo
  // has no tool schemas worth a row); "free" always closes the bar.
  // The literal is annotated and filtered into a second binding: typing
  // the FILTERED result directly widens every `key` to `string` (the
  // literal loses its context through .filter) and stops being a
  // ContextPart[] — which then rejects the push below.
  const rows: ContextPart[] = [
    {
      key: "system",
      label: "System prompt",
      tokens: system,
      detail: "Instructions, skills and repo context sent with every request",
    },
    {
      key: "tools",
      label: "Tool schemas",
      tokens: toolTokens,
      // The names ride along in the row's tooltip: the count says how much of
      // the window the schemas cost, and the names answer the question the
      // count raises ("which ones?") without a command to list them.
      detail: params.tools?.length
        ? `${params.tools.length} tool definitions available this turn: ${params.tools
            .map((tool) => tool.function.name)
            .join(", ")}`
        : "No tools on this turn",
    },
    {
      key: "memory",
      label: "Compacted memory",
      tokens: memory,
      detail: summary
        ? `Summary of ${summary.coversCount} earlier message${summary.coversCount === 1 ? "" : "s"}`
        : "Nothing summarized yet",
    },
    {
      key: "messages",
      label: "Conversation",
      tokens: messages,
      detail:
        `${visible.length} message${visible.length === 1 ? "" : "s"} sent` +
        (hiddenCount > 0 ? ` · ${hiddenCount} cleared` : ""),
    },
  ];

  const parts = rows.filter((p) => p.tokens > 0);

  parts.push({
    key: "free",
    label: "Free space",
    tokens: free,
    detail: "Room left before compaction is needed",
  });

  return {
    totalTokens: spend,
    sentTokens: spend,
    compactedTokens: summary?.freedTokens ?? 0,
    maxTokens: budget.window,
    usableTokens,
    outputReserve: budget.outputReserve,
    percentageUsed: Math.round(pct * 10) / 10,
    health: healthFromPercentage(pct),
    parts,
    lastPromptTokens: exact.promptTokens,
    lastCachedTokens: exact.cachedTokens,
    totalCost: exact.totalCost,
    completionTokens: exact.completionTokens,
    spend: summarizeSpend(params.conversation.messages),
    calibrated: isCalibrated(modelId),
  };
}

/**
 * Ground truth from the transcript: the most recent provider-reported
 * usage frame, plus the conversation's running totals. Reads stored
 * messages only — never the network.
 */
function lastExactUsage(messages: ChatMessage[]): {
  promptTokens: number | null;
  cachedTokens: number | null;
  totalCost: number;
  completionTokens: number;
} {
  let promptTokens: number | null = null;
  let cachedTokens: number | null = null;
  let totalCost = 0;
  let completionTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i]!.usage;
    if (!usage) continue;
    if (promptTokens === null && usage.promptTokens != null) {
      promptTokens = usage.promptTokens;
      cachedTokens = usage.cachedTokens ?? null;
    }
  }
  for (const m of messages) {
    if (typeof m.usage?.cost === "number") totalCost += m.usage.cost;
    if (typeof m.usage?.completionTokens === "number") {
      completionTokens += m.usage.completionTokens;
    }
  }

  return { promptTokens, cachedTokens, totalCost, completionTokens };
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
