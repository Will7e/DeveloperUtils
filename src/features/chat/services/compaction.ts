// ============================================================
// Compaction Service — Background LLM Summarization
// ============================================================
// Compact mode: when history nears the context limit (or the user
// runs /compact), the oldest messages are folded into a rolling
// LLM summary that rides in the system prompt. Falls back to the
// engine's truncation compaction if summarization fails, so a
// send is never blocked by a failing side call.
//
// Four rules this module exists to keep, each of which was broken
// before and produced a compaction that reported success and freed
// nothing (or "nothing to compact" on a full window):
//
//   1. FOLD ON THE TRIGGER'S YARDSTICK. The threshold that decides
//      compaction is needed is measured against the real request —
//      prompt, skills, rolling summary AND tool schemas. The fold has
//      to be measured the same way or it under-folds by the size of
//      the preamble it forgot. See conversationBudget.
//   2. FOLD MODEL-VISIBLE HISTORY ONLY. Cleared (/clear) and
//      soft-deleted rows are not in the request: they are neither
//      summarized nor evicted, so the clear stays what it promised —
//      hidden, not destroyed.
//   3. MAKE THE TAIL FIT. The fold exists to bring the kept tail back
//      inside the budget, not merely to spend half a budget on the
//      oldest messages.
//   4. REMOVE BY ID, not by count: hidden rows sit anywhere in the
//      array, and coversCount is cumulative (see ConversationSummary).

import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { completeChat, OpenRouterError } from "../lib/openrouter-client";
import { resolveModelInfo } from "../lib/model-catalog";
import { modelSupportsTools } from "../lib/model-state";
import { buildEffectiveSystemPrompt } from "../lib/skills";
import { resolveToolSurface } from "../lib/tool-profiles";
import {
  COMPACTION_MAX_PASSES,
  COMPACTION_MAX_RETRIES,
  COMPACTION_TARGET,
  SUMMARY_MAX_TOKENS,
} from "../constants";
import { computeBudget, type RequestBudget } from "../context/budget";
import { compactMessages } from "../context/compactor";
import { activeBindingIdOf, composeSystemPrompt } from "../context/engine";
import { scopeToBinding } from "../context/binding-scope";
import {
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryUserText,
  isRetryableError,
  pickCompactionBoundary,
} from "../context/summarizer";
import { estimateMessageTokens, estimateTokens } from "../context/tokenizer";
import {
  visibleMessages,
  type ChatConversation,
  type ChatMessage,
  type ChatSettings,
  type ConversationSummary,
  type ModelInfo,
} from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-flight compactions per conversation (join instead of duplicate) */
const inflight = new Map<string, Promise<CompactionOutcome>>();

/** Why a compaction run changed nothing */
export type CompactionNoopReason =
  | "no-conversation"
  | "no-api-key"
  | "nothing-foldable"
  | "already-fits"
  | "aborted";

export interface CompactionOutcome {
  /** "summary" = LLM summarization applied; "truncated" = fallback */
  mode: "summary" | "truncated" | "noop";
  /** Messages folded away (0 for noop) */
  foldedCount: number;
  /** Estimated tokens freed (0 for noop) */
  freedTokens: number;
  /** Why truncation was used instead of a summary (when so) */
  fallbackReason?: string;
  /**
   * Why nothing happened (mode === "noop"). The caller reports the
   * actual cause: "nothing to compact" for all five of these sent the
   * user hunting for a bug in their own conversation.
   */
  reason?: CompactionNoopReason;
  /** Share of the usable window in use when the run finished */
  usedPercent?: number;
  /**
   * Set on a successful summary when the kept tail is STILL outside the
   * target: the history was larger than the stages allowed (see
   * COMPACTION_MAX_PASSES), so the caller should offer another run
   * rather than implying the window was freed.
   */
  incomplete?: boolean;
}

export interface EnsureCompactionOptions {
  /**
   * Fold even when the window is comfortable — what an explicit
   * "/compact" asks for. It summarizes the oldest exchange rather than
   * answering "nothing to compact" to the person who asked for a
   * summary; a pressured window folds down to the target either way.
   */
  force?: boolean;
  signal?: AbortSignal;
}

const noop = (reason: CompactionNoopReason, usedPercent?: number): CompactionOutcome => ({
  mode: "noop",
  foldedCount: 0,
  freedTokens: 0,
  reason,
  usedPercent,
});

/**
 * Ensures the conversation fits its context budget: runs LLM
 * summarization when there is history worth folding, with retry +
 * truncation fallback. Concurrent calls for the same conversation
 * join the in-flight promise.
 */
export async function ensureCompaction(
  conversationId: string,
  options: EnsureCompactionOptions = {}
): Promise<CompactionOutcome> {
  const existing = inflight.get(conversationId);
  if (existing) {
    const joined = await existing;
    // A forced request that landed on someone else's pass would inherit
    // that pass's decision — and a user who typed /compact during an
    // automatic no-op would be told "nothing to compact" by a run they
    // did not ask for. The in-flight entry is already cleared by the time
    // this await returns, so the forced pass is a real one.
    if (!options.force || joined.mode !== "noop") return joined;
  }

  const task = performCompaction(conversationId, options).finally(() => {
    inflight.delete(conversationId);
  });
  inflight.set(conversationId, task);
  return task;
}

async function performCompaction(
  conversationId: string,
  options: EnsureCompactionOptions
): Promise<CompactionOutcome> {
  const store = useChatStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  if (!conversation) return noop("no-conversation");

  const settings = store.settings;
  const apiKey = settings.apiKey?.trim();
  if (!apiKey) return noop("no-api-key");

  // The conversation's own model summarizes its history (any text model
  // works — image attachments are summarized by name, never re-sent).
  const modelId = conversation.model ?? settings.defaultModel;
  const modelInfo = resolveModelInfo(modelId);

  let foldedCount = 0;
  let freedTokens = 0;
  let passes = 0;
  let lastError: unknown = null;
  // Measured fresh at the start of every pass (and once after the loop,
  // for the outcome): usage is what the store holds NOW, not what it held
  // when the run began.
  let state = measure(conversation, settings, modelInfo, modelId);

  for (let pass = 0; pass < COMPACTION_MAX_PASSES; pass++) {
    // Re-read every pass: the previous pass removed messages and rewrote
    // the summary, and a turn may have appended while a call was in
    // flight. Removal is by id, so a concurrent append cannot make a
    // trusted index wrong.
    const live = useChatStore.getState().conversations.find((c) => c.id === conversationId);
    if (!live) break;
    state = measure(live, settings, modelInfo, modelId);

    const { visible, budgetTokens } = state;
    const { foldCount, foldTokens } = pickCompactionBoundary(
      visible,
      budgetTokens,
      COMPACTION_TARGET,
      modelId,
      {
        // Only the first pass answers the explicit request; the later
        // passes are already responding to it.
        force: options.force === true && pass === 0,
        // One call reads one window's worth: a history far larger than
        // the window is folded in stages, each extending the ledger.
        maxFoldTokens: summarizerReadBudget(modelInfo, live.summary?.text ?? ""),
      }
    );
    if (foldCount <= 0) break;

    if (options.signal?.aborted) {
      return foldedCount > 0
        ? { mode: "summary", foldedCount, freedTokens, usedPercent: state.usedPercent }
        : noop("aborted", state.usedPercent);
    }

    const foldSlice = visible.slice(0, foldCount);
    const priorSummary = live.summary;

    // ── Summarization (retry with backoff) ──
    let text: string | null = null;
    for (let attempt = 0; attempt <= COMPACTION_MAX_RETRIES; attempt++) {
      if (options.signal?.aborted) break;
      try {
        text = await summarizeFold({
          apiKey,
          modelId,
          foldSlice,
          priorSummary,
          signal: options.signal,
        });
        break;
      } catch (err) {
        lastError = err;
        if (options.signal?.aborted) break;
        if (!isRetryableError(err) || attempt === COMPACTION_MAX_RETRIES) break;
        // 1.2s then 3.6s — clears short rate-limit windows
        await sleep(1200 * 3 ** attempt);
      }
    }

    if (text === null) {
      if (options.signal?.aborted) {
        return foldedCount > 0
          ? { mode: "summary", foldedCount, freedTokens, usedPercent: state.usedPercent }
          : noop("aborted", state.usedPercent);
      }
      // Nothing has been summarized yet, so keep the send unblocked with
      // plain truncation. A LATER pass failing is not fatal: the stages
      // that already committed are real memory, so keep them and report.
      if (passes === 0) {
        return truncateInstead({
          conversationId,
          budgetTokens,
          modelId,
          lastError,
          usedPercent: state.usedPercent,
        });
      }
      break;
    }

    useChatStore.getState().applyCompaction(
      conversationId,
      {
        text,
        // Cumulative, by the type's own definition ("folded into `text`
        // and prior summaries"): the ledger in `text` now covers all of
        // it, and the meter reads this number as the memory size.
        coversCount: (priorSummary?.coversCount ?? 0) + foldCount,
        createdAt: Date.now(),
        model: modelId,
        freedTokens: (priorSummary?.freedTokens ?? 0) + foldTokens,
      },
      foldSlice.map((m) => m.id)
    );

    foldedCount += foldCount;
    freedTokens += foldTokens;
    passes += 1;
  }

  if (passes > 0) {
    const live = useChatStore.getState().conversations.find((c) => c.id === conversationId);
    if (live) state = measure(live, settings, modelInfo, modelId);
    return {
      mode: "summary",
      foldedCount,
      freedTokens,
      usedPercent: state.usedPercent,
      // Still outside the target after every stage it was allowed: say so
      // instead of letting the user believe the window was freed.
      ...(state.tailFits ? {} : { incomplete: true }),
    };
  }
  if (options.signal?.aborted) return noop("aborted", state.usedPercent);
  // A forced run on a comfortable conversation that still folded nothing
  // means there was no exchange to fold (one exchange, or a tail made
  // only of agent protocol rows) — not that the window was crowded.
  return noop(
    !options.force && state.tailFits ? "already-fits" : "nothing-foldable",
    state.usedPercent
  );
}

/**
 * The history a request for this conversation would actually read — scoped
 * exactly as `prepareRequest` scopes it.
 *
 * The fold is a READ of the transcript that sits outside the repository
 * boundary, and it decides three things: which rows the summarizer is shown,
 * which rows LEAVE the transcript, and how full the window looks. The window is
 * the one that bites in practice — a chat that just switched away from a
 * repository keeps that repository's file bodies in storage, and measuring them
 * made this service report a window far fuller than the next request would be,
 * and fold history that did not need folding. (What the summarizer can carry
 * forward is narrower than it looks: `messageLine` emits prose and tool NAMES,
 * never tool payloads, so the ledger was never a copy of A's file contents. The
 * boundary belongs here anyway — the honest reasons are the measurement and the
 * eviction, and a future summarizer that reads payloads must not be the thing
 * that discovers this.)
 */
function requestVisible(conversation: ChatConversation): ChatMessage[] {
  const move = conversation.bindingMove;
  return scopeToBinding(visibleMessages(conversation.messages), activeBindingIdOf(conversation), {
    ...(move ? { legacy: move } : {}),
  }).messages;
}

/**
 * What the conversation costs RIGHT NOW: the model-visible tail, the
 * budget its next request would get, and whether that tail is inside the
 * target. The fold, the trigger and the toast all read this same number.
 *
 * `visible` is the SCOPED history, because that is what a request carries:
 * measuring the unscoped list would count tokens the next request never sends
 * and keep the window looking fuller than it is.
 */
function measure(
  conversation: ChatConversation,
  settings: ChatSettings,
  modelInfo: ModelInfo | undefined,
  modelId: string
): {
  visible: ChatMessage[];
  budget: RequestBudget;
  budgetTokens: number;
  targetTokens: number;
  tailTokens: number;
  usedPercent: number;
  tailFits: boolean;
} {
  const visible = requestVisible(conversation);
  const { budget } = conversationBudget(conversation, settings, modelInfo);
  const budgetTokens = Math.max(0, budget.available);
  const usable = Math.max(1, budget.window - budget.outputReserve);
  const targetTokens = Math.floor(budgetTokens * COMPACTION_TARGET);
  const tailTokens = visible.reduce((s, m) => s + estimateMessageTokens(m, modelId), 0);
  return {
    visible,
    budget,
    budgetTokens,
    targetTokens,
    tailTokens,
    usedPercent: Math.round((1 - budgetTokens / usable) * 100),
    tailFits: tailTokens <= targetTokens,
  };
}

/** One summarization call for a fold slice (retries handled by the caller) */
async function summarizeFold(params: {
  apiKey: string;
  modelId: string;
  foldSlice: ChatMessage[];
  priorSummary?: ConversationSummary;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await completeChat({
    apiKey: params.apiKey,
    model: params.modelId,
    temperature: 0,
    maxTokens: SUMMARY_MAX_TOKENS,
    // Summaries stay cheap/fast regardless of tier — never think hard
    // about folding history. Keep the provider default.
    requestState: undefined,
    signal: params.signal,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildSummaryUserText(params.foldSlice, params.priorSummary),
      },
    ],
  });

  const text = result.content.trim();
  if (!text) {
    throw new OpenRouterError("The summarizer returned an empty summary.", 200);
  }
  return text;
}

/**
 * The budget a request for this conversation would actually get.
 *
 * Mirrors turn-prep's assembly (base prompt + enabled skills + rolling
 * summary + the tool schemas of this turn). Using the base prompt alone
 * — as this service used to — measured the fold against a window that
 * did not exist: a repo-attached turn carries tens of tool schemas
 * (thousands of tokens) that the fold then ignored, so a "successful"
 * compaction still left the next request over budget and the engine
 * truncated it anyway.
 *
 * The repo's AGENTS.md prose and the plan block are the only pieces left
 * out; both are small next to the schemas and the repo text is stable
 * (see ensureRepoInstructions in turn-prep).
 *
 * Exported so the fold's yardstick can be pinned in tests: the two
 * numbers drifting apart is the bug this function exists to prevent.
 */
export function conversationBudget(
  conversation: ChatConversation,
  settings: ChatSettings,
  modelInfo: ModelInfo | undefined
): { budget: RequestBudget; effectivePrompt: string } {
  const base = conversation.systemPrompt?.trim() || settings.systemPrompt.trim() || "";
  const withSkills = buildEffectiveSystemPrompt(base, settings.skills ?? []);
  // The binding is passed because a PRIOR summary may have been written on a
  // repository this thread has since left: the caveat must be in the prompt
  // the summarizer reads too, or the new summary inherits the old one's
  // claims as if they were about the current checkout.
  const effectivePrompt =
    composeSystemPrompt(withSkills, conversation.summary, activeBindingIdOf(conversation)) ?? "";
  const repoAttached = Boolean(conversation.repoContext && settings.github.token);
  const tools = modelSupportsTools(modelInfo)
    ? resolveToolSurface(conversation.mode ?? settings.defaultMode, modelInfo, { repoAttached }).tools
    : undefined;

  return {
    budget: computeBudget({ model: modelInfo, systemPrompt: effectivePrompt, tools }),
    effectivePrompt,
  };
}

/**
 * How much folded history one summarization call can read: the model's
 * own window minus the reply reserve, the summarization instruction and
 * the prior ledger, with 10% slack. The token estimator is a chars/token
 * heuristic and runs optimistic on high-entropy content (base64 blobs,
 * minified bundles); blowing the summarizer's window turns a compaction
 * into a failed call, and the caller folds the rest in the next pass.
 */
function summarizerReadBudget(
  modelInfo: ModelInfo | undefined,
  priorSummaryText: string
): number {
  const window = modelInfo?.contextLength ?? 128_000;
  const reserve = Math.min(SUMMARY_MAX_TOKENS, Math.floor(window * 0.1));
  const fixed = estimateTokens(SUMMARY_SYSTEM_PROMPT) + estimateTokens(priorSummaryText);
  return Math.max(2_000, Math.floor((window - reserve - fixed) * 0.9));
}

/**
 * Fallback when summarization is unavailable: drop the oldest
 * model-visible messages so the send still fits, and say so in the
 * memory slot.
 *
 * With no prior summary this used to write an EMPTY one — the messages
 * were removed and nothing replaced them, so the model received a
 * conversation that begins mid-thread with no sign that anything came
 * before, and answered confidently from what little remained. Say what
 * happened instead: a model that knows a gap exists asks about it, one
 * that does not know invents it.
 */
function truncateInstead(params: {
  conversationId: string;
  budgetTokens: number;
  modelId: string;
  lastError: unknown;
  usedPercent: number;
}): CompactionOutcome {
  const live = useChatStore
    .getState()
    .conversations.find((c) => c.id === params.conversationId);
  if (!live) return noop("no-conversation", params.usedPercent);

  // Scoped for the same reason as the fold: a truncation that "replaced the
  // removed messages with a note" must not have been reading another
  // repository's rows in the first place.
  const visible = requestVisible(live);
  const targetTokens = Math.max(0, Math.floor(params.budgetTokens * COMPACTION_TARGET));
  const { hiddenCount, freedTokens } = compactMessages(visible, targetTokens, params.modelId);
  if (hiddenCount <= 0) return noop("nothing-foldable", params.usedPercent);

  const removed = visible.slice(0, hiddenCount);
  const priorSummary = live.summary;
  const truncatedNote =
    `TRUNCATED: ${hiddenCount} earlier message(s) of this conversation were removed to fit the ` +
    "context window and were not summarized. Their content is not available — if you need a detail " +
    "that is missing, say so and ask rather than reconstructing it.";
  const text = priorSummary?.text.trim()
    ? `${priorSummary.text.trim()}\n${truncatedNote}`
    : truncatedNote;

  useChatStore.getState().applyCompaction(
    params.conversationId,
    {
      text,
      coversCount: (priorSummary?.coversCount ?? 0) + hiddenCount,
      createdAt: Date.now(),
      model: undefined,
      freedTokens: (priorSummary?.freedTokens ?? 0) + freedTokens,
    },
    removed.map((m) => m.id)
  );

  const reason =
    params.lastError instanceof Error && params.lastError.message
      ? params.lastError.message
      : "Summarization unavailable";

  return {
    mode: "truncated",
    foldedCount: hiddenCount,
    freedTokens,
    fallbackReason: reason,
    usedPercent: params.usedPercent,
  };
}

// ============================================================
// /compact command — user-invoked forced compaction with toasts
// ============================================================
// Lives here (not in the command registry) so the composer's
// command menu and the typed fallback in sendUserMessage share one
// implementation without creating a runner ↔ commands import cycle.

/** Compact token count for toasts (12k, 3.4k, 870) */
function formatTokenShort(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** What a noop run should tell the user (five causes, five answers) */
function noopMessage(outcome: CompactionOutcome): string {
  switch (outcome.reason) {
    case "no-api-key":
      return "Add an OpenRouter API key in Chat Settings — summarizing history needs a model.";
    case "no-conversation":
      return "This conversation no longer exists.";
    case "aborted":
      return "Compaction cancelled — nothing was changed.";
    case "already-fits":
      return `Context is only ${outcome.usedPercent ?? 0}% full — older history already fits, so there was nothing to fold.`;
    default:
      return "Not enough history to summarize yet — there is only one exchange to keep.";
  }
}

/**
 * Forces a compaction cycle for the conversation and reports the
 * outcome as a toast. Shared by the /compact menu command and the
 * typed "/compact" fallback in sendUserMessage.
 */
export async function runCompactCommand(conversationId: string): Promise<void> {
  const addToast = (message: string, type: "success" | "error" | "info") =>
    useAppStore.getState().addToast({ message, type, duration: 5000 });

  // A reply in flight owns the transcript: this turn's system prompt and
  // message list were assembled before the summary would exist, so
  // folding now spends a call to change state that the running request
  // can never read (each turn builds one request; see prepareTurn).
  // /clear and /retry refuse for the same reason.
  const store = useChatStore.getState();
  if (store.isStreaming && store.streamingConversationId === conversationId) {
    addToast("Stop the reply that is streaming before compacting context.", "error");
    return;
  }

  try {
    const outcome = await ensureCompaction(conversationId, { force: true });
    if (outcome.mode === "summary") {
      // A run that used every stage and is still over target says so: the
      // alternative is a success toast on a window that is still crowded,
      // which is indistinguishable from the bug this replaced.
      addToast(
        `Context compacted — ${outcome.foldedCount} messages summarized (${formatTokenShort(outcome.freedTokens)} tokens freed).` +
          (outcome.incomplete
            ? ` Context is still ${outcome.usedPercent ?? 0}% full — run /compact again to fold more.`
            : ""),
        "success"
      );
    } else if (outcome.mode === "truncated") {
      addToast(
        `Summarizer unavailable — removed the oldest ${outcome.foldedCount} messages instead (${formatTokenShort(outcome.freedTokens)} tokens freed).`,
        "info"
      );
    } else {
      addToast(noopMessage(outcome), "info");
    }
  } catch {
    // ensureCompaction resolves every expected failure internally, so
    // reaching here means an unexpected throw — most likely the store
    // rejecting the write. Say what is true: nothing was committed.
    addToast("Compaction failed — nothing in this chat was changed.", "error");
  }
}
