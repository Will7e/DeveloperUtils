// ============================================================
// Compactor — Oldest-First History Truncation
// ============================================================
// When history would exceed the request budget, drop the oldest
// messages until it fits, leaving a visible marker so users know
// earlier context was elided. Designed with a seam for LLM
// summarization to replace blind truncation later.

import type { ChatMessage } from "../types";
import { estimateMessageTokens } from "./tokenizer";

export interface CompactionResult {
  /** Messages to send (never includes hidden ones) */
  messages: ChatMessage[];
  /** Number of original messages hidden */
  hiddenCount: number;
  /** Estimated tokens freed by compaction */
  freedTokens: number;
}

/**
 * Drops oldest messages until the remaining ones fit the budget.
 * Always keeps at least the most recent exchange. Prefer dropping
 * complete user/assistant pairs so the alternation invariant holds.
 */
export function compactMessages(
  messages: ChatMessage[],
  budgetTokens: number
): CompactionResult {
  const totalTokens = messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  if (totalTokens <= budgetTokens || messages.length <= 2) {
    return { messages, hiddenCount: 0, freedTokens: 0 };
  }

  let acc = 0;
  let cutIndex = 0;

  // Walk from the newest message backwards, accumulating tokens,
  // until adding the next message would exceed the budget.
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(messages[i]!);
    if (acc + t > budgetTokens) break;
    acc += t;
    cutIndex = i;
  }

  // Keep at least the last message even if it alone busts the budget
  if (cutIndex >= messages.length - 1) {
    cutIndex = messages.length - 1;
  }

  // Snap to a user-role boundary so requests start with "user",
  // which every provider requires.
  while (cutIndex < messages.length - 1 && messages[cutIndex]?.role !== "user") {
    cutIndex++;
  }

  const kept = messages.slice(cutIndex);
  const hiddenCount = messages.length - kept.length;
  const keptTokens = kept.reduce((s, m) => s + estimateMessageTokens(m), 0);

  return {
    messages: kept,
    hiddenCount,
    freedTokens: Math.max(0, totalTokens - keptTokens),
  };
}

/**
 * Builds the visible compaction marker message shown in the UI
 * between hidden history and the kept tail.
 */
export function buildCompactionMarker(hiddenCount: number): ChatMessage {
  return {
    id: `compacted-${hiddenCount}`,
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    compactedFrom: hiddenCount,
  };
}
