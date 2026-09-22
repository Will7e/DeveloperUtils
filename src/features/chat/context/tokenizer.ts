// ============================================================
// Token Estimator — Fast Heuristic Context Accounting
// ============================================================
// Characters-per-token heuristic (~3.8 chars/token for code and
// prose). Exact provider counts replace estimates as soon as
// OpenRouter's usage frame arrives for a given exchange — and via
// tokenizer-calibration.ts the learned per-model ratio is applied
// back onto the heuristic so budgets and the ContextMeter stay
// honest across model families.

import type { ChatMessage, ToolDefinition } from "../types";
import { getCalibrationRatio } from "./tokenizer-calibration";

/** Framing overhead per message (role tags, separators) */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** Fixed estimate per attached image (vision tokens vary by model) */
export const IMAGE_TOKEN_ESTIMATE = 800;

/**
 * Fast token estimation for text. Code-heavy content has a denser
 * token distribution, so it uses a slightly lower chars/token ratio.
 * Pass a modelId to apply that model's learned calibration ratio.
 */
export function estimateTokens(text?: string | null, modelId?: string): number {
  if (!text) return 0;
  if (text.length === 0) return 0;

  const codeFenceCount = (text.match(/```/g) ?? []).length;
  const isCodeHeavy = codeFenceCount >= 2;
  const charRatio = isCodeHeavy ? 3.5 : 3.9;

  const raw = Math.ceil(text.length / charRatio);
  if (modelId) {
    const ratio = getCalibrationRatio(modelId);
    if (ratio !== 1) return Math.max(1, Math.round(raw * ratio));
  }
  return Math.max(1, raw);
}

/** Tokens for a single chat message including framing overhead */
export function estimateMessageTokens(message: ChatMessage, modelId?: string): number {
  // Compaction markers carry no payload — just the marker overhead
  if (message.compactedFrom !== undefined) return MESSAGE_OVERHEAD_TOKENS;
  // Tool protocol messages: estimate the serialized payload they carry
  if (message.toolCalls) {
    const callsJson = message.toolCalls.calls
      .map((c) => c.arguments + c.name)
      .join("");
    return (
      estimateTokens(callsJson, modelId) +
      estimateTokens(message.content, modelId) +
      MESSAGE_OVERHEAD_TOKENS * 2
    );
  }
  if (message.toolResult) {
    return estimateTokens(message.toolResult.content, modelId) + MESSAGE_OVERHEAD_TOKENS * 2;
  }
  const imageTokens = (message.attachments?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
  return estimateTokens(message.content, modelId) + MESSAGE_OVERHEAD_TOKENS + imageTokens;
}

/**
 * Total tokens for a message list. Kept as estimates per message so
 * per-category attribution (system / tools / memory / messages) can
 * reuse exactly the same arithmetic as the budget check.
 */
export function estimateConversationTokens(messages: ChatMessage[], modelId?: string): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m, modelId), 0);
}

/**
 * Wire tokens of the tool definitions a request carries. The JSON
 * schema payload is serialized exactly as it goes on the wire (minus
 * the transport envelope), because tool schemas are the single
 * largest fixed cost of an agent request — fifteen schemas are worth
 * several thousand prompt tokens on EVERY iteration, and a budget
 * that ignores them under-reports the window and compacts too late.
 *
 * Memoized on array identity: the tool surface is built once per turn
 * and re-read on every render of the context meter.
 */
const TOOL_SCHEMA_CACHE = new WeakMap<readonly ToolDefinition[], number>();

export function estimateToolSchemaTokens(
  tools?: readonly ToolDefinition[] | null,
  modelId?: string
): number {
  if (!tools || tools.length === 0) return 0;

  const cached = TOOL_SCHEMA_CACHE.get(tools);
  if (cached !== undefined) return cached;

  // Only the `function` block is billed — `type` is a constant tag.
  const serialized = tools
    .map((t) => JSON.stringify(t.function))
    .join("\n");
  const tokens = estimateTokens(serialized, modelId);
  TOOL_SCHEMA_CACHE.set(tools, tokens);
  return tokens;
}
