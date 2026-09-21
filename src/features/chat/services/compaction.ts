// ============================================================
// Compaction Service — Background LLM Summarization
// ============================================================
// Compact mode: when history nears the context limit (or the user
// runs /compact), the oldest messages are folded into a rolling
// LLM summary that rides in the system prompt. Falls back to the
// engine's truncation compaction if summarization fails, so a
// send is never blocked by a failing side call.

import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { completeChat, OpenRouterError } from "../lib/openrouter-client";
import { resolveModelInfo } from "../lib/model-catalog";
import {
  COMPACTION_MAX_RETRIES,
  COMPACTION_TARGET,
  SUMMARY_MAX_TOKENS,
} from "../constants";
import { computeBudget } from "../context/budget";
import { compactMessages } from "../context/compactor";
import {
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryUserText,
  isRetryableError,
  pickCompactionBoundary,
} from "../context/summarizer";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-flight compactions per conversation (join instead of duplicate) */
const inflight = new Map<string, Promise<CompactionOutcome>>();

export interface CompactionOutcome {
  /** "summary" = LLM summarization applied; "truncated" = fallback */
  mode: "summary" | "truncated" | "noop";
  /** Messages folded away (0 for noop) */
  foldedCount: number;
  /** Estimated tokens freed (0 for noop) */
  freedTokens: number;
  /** Why truncation was used instead of a summary (when so) */
  fallbackReason?: string;
}

export interface EnsureCompactionOptions {
  /** Compact even when little history exists (explicit user request) */
  force?: boolean;
  signal?: AbortSignal;
}

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
  if (existing) return existing;

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
  if (!conversation) {
    return { mode: "noop", foldedCount: 0, freedTokens: 0 };
  }

  const apiKey = store.settings.apiKey?.trim();
  if (!apiKey) {
    return { mode: "noop", foldedCount: 0, freedTokens: 0 };
  }

  // ── Resolve the summarizer model. The conversation's own model
  // summarizes its history (any text model works — image attachments
  // are summarized by name, never re-sent). Retries with backoff on
  // transient failure; then the truncation fallback below.
  const modelId = conversation.model ?? store.settings.defaultModel;
  const modelInfo = resolveModelInfo(modelId);

  // Budget for the kept tail: window minus output reserve minus the
  // system prompt (base + skills). The summary itself is small
  // (SUMMARY_MAX_TOKENS cap) and rides in the system block.
  const basePrompt =
    conversation.systemPrompt?.trim() || store.settings.systemPrompt.trim() || "";
  const budget = computeBudget({ model: modelInfo, systemPrompt: basePrompt });
  const budgetTokens = Math.max(0, budget.available);

  const { foldCount, foldTokens } = pickCompactionBoundary(
    conversation.messages,
    budgetTokens,
    COMPACTION_TARGET,
    modelId
  );

  if (foldCount <= 0) {
    // Nothing worth folding (too recent / too small). A forced run
    // with nothing to do is a noop, not an error.
    return { mode: "noop", foldedCount: 0, freedTokens: 0 };
  }

  const priorSummary = conversation.summary;
  const foldSlice = conversation.messages.slice(0, foldCount);

  // ── Attempt LLM summarization (retry with backoff) ──
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= COMPACTION_MAX_RETRIES; attempt++) {
    if (options.signal?.aborted) {
      return { mode: "noop", foldedCount: 0, freedTokens: 0 };
    }
    try {
      const result = await completeChat({
        apiKey,
        model: modelId,
        temperature: 0,
        maxTokens: SUMMARY_MAX_TOKENS,
        // Summaries stay cheap/fast regardless of tier — never think
        // hard about folding history. Keep the provider default.
        requestState: undefined,
        signal: options.signal,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildSummaryUserText(foldSlice, priorSummary),
          },
        ],
      });

      const text = result.content.trim();
      if (!text) {
        throw new OpenRouterError("The summarizer returned an empty summary.", 200);
      }

      useChatStore.getState().applyCompaction(conversationId, {
        text,
        coversCount: foldCount,
        createdAt: Date.now(),
        model: modelId,
        freedTokens: foldTokens,
      });

      return { mode: "summary", foldedCount: foldCount, freedTokens: foldTokens };
    } catch (err) {
      if (options.signal?.aborted) {
        return { mode: "noop", foldedCount: 0, freedTokens: 0 };
      }
      lastError = err;
      if (!isRetryableError(err) || attempt === COMPACTION_MAX_RETRIES) break;
      // 1.2s then 3.6s — clears short rate-limit windows
      await sleep(1200 * 3 ** attempt);
    }
  }

  // ── Fallback: truncation compaction (keeps the send unblocked) ──
  const reason =
    lastError instanceof Error && lastError.message
      ? lastError.message
      : "Summarization unavailable";

  // Truncate down to the target share of the budget. Reuses the
  // engine's rules (user-role snap, never drop everything).
  const targetTokens = Math.max(0, Math.floor(budgetTokens * COMPACTION_TARGET));
  const { hiddenCount, freedTokens } = compactMessages(
    conversation.messages,
    targetTokens,
    modelId
  );

  if (hiddenCount > 0) {
    // Fold lossy: keep a prior summary's text if one exists, but the
    // UI marks this as truncation (no new memory was created).
    useChatStore.getState().applyCompaction(conversationId, {
      text: priorSummary?.text ?? "",
      coversCount: hiddenCount,
      createdAt: Date.now(),
      model: undefined,
      freedTokens,
    });

    return {
      mode: "truncated",
      foldedCount: hiddenCount,
      freedTokens,
      fallbackReason: reason,
    };
  }

  return { mode: "noop", foldedCount: 0, freedTokens: 0 };
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

/**
 * Forces a compaction cycle for the conversation and reports the
 * outcome as a toast. Shared by the /compact menu command and the
 * typed "/compact" fallback in sendUserMessage.
 */
export async function runCompactCommand(conversationId: string): Promise<void> {
  const addToast = (message: string, type: "success" | "error" | "info") =>
    useAppStore.getState().addToast({ message, type, duration: 5000 });

  try {
    const outcome = await ensureCompaction(conversationId, { force: true });
    if (outcome.mode === "summary") {
      addToast(
        `Context compacted — ${outcome.foldedCount} messages summarized (${formatTokenShort(outcome.freedTokens)} tokens freed).`,
        "success"
      );
    } else if (outcome.mode === "truncated") {
      addToast(
        `Summarizer unavailable — removed the oldest ${outcome.foldedCount} messages instead (${formatTokenShort(outcome.freedTokens)} tokens freed).`,
        "info"
      );
    } else {
      addToast("Nothing to compact yet — keep chatting.", "info");
    }
  } catch {
    addToast("Compaction failed — check your connection and try again.", "error");
  }
}
