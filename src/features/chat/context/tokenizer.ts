// ============================================================
// Token Estimator — Fast Heuristic Context Accounting
// ============================================================
// Characters-per-token heuristic (~3.8 chars/token for code and
// prose). Exact provider counts replace estimates as soon as
// OpenRouter's usage frame arrives for a given exchange.

import type { ChatMessage } from "../types";

/** Framing overhead per message (role tags, separators) */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Fast token estimation for text. Code-heavy content has a denser
 * token distribution, so it uses a slightly lower chars/token ratio.
 */
export function estimateTokens(text?: string | null): number {
  if (!text) return 0;
  if (text.length === 0) return 0;

  const codeFenceCount = (text.match(/```/g) ?? []).length;
  const isCodeHeavy = codeFenceCount >= 2;
  const charRatio = isCodeHeavy ? 3.5 : 3.9;

  return Math.max(1, Math.ceil(text.length / charRatio));
}

/** Tokens for a single chat message including framing overhead */
export function estimateMessageTokens(message: ChatMessage): number {
  // Compaction markers carry no payload — just the marker overhead
  if (message.compactedFrom !== undefined) return MESSAGE_OVERHEAD_TOKENS;
  return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

/** Total tokens for a message list */
export function estimateConversationTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
