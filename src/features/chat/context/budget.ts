// ============================================================
// Context Budget — Per-Request Token Budgeting
// ============================================================
// Budget = model context window − system prompt − output reserve.
// The engine builds requests that always fit within this budget.

import { OUTPUT_RESERVE_TOKENS } from "../constants";
import type { ContextHealth, ModelInfo, ToolDefinition } from "../types";
import { estimateTokens, estimateToolSchemaTokens } from "./tokenizer";

export interface RequestBudget {
  /** Model context window in tokens */
  window: number;
  /** Tokens reserved for the model's output */
  outputReserve: number;
  /** Tokens available for system prompt + tool schemas + history */
  available: number;
  /** Tokens consumed by the system prompt (0 when none) */
  systemTokens: number;
  /** Tokens consumed by the tool definitions (0 when the turn has none) */
  toolTokens: number;
}

/**
 * Computes the request budget for a model. Falls back to a
 * conservative 128k window when the model's context length is unknown.
 * The model's learned token-calibration ratio sharpens the system
 * prompt estimate when available.
 *
 * Tool schemas count against the same budget as history: they ride in
 * the request preamble, so a turn that sends fifteen of them has that
 * much less room for the conversation. Leaving them out made the
 * compaction trigger fire thousands of tokens late.
 */
export function computeBudget(params: {
  model?: ModelInfo;
  systemPrompt?: string;
  tools?: readonly ToolDefinition[];
}): RequestBudget {
  const window = params.model?.contextLength ?? 128_000;
  const outputReserve = Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(window * 0.1));
  const systemTokens = estimateTokens(params.systemPrompt, params.model?.id);
  const toolTokens = estimateToolSchemaTokens(params.tools, params.model?.id);

  return {
    window,
    outputReserve,
    available: Math.max(0, window - outputReserve - systemTokens - toolTokens),
    systemTokens,
    toolTokens,
  };
}

export function healthFromPercentage(pct: number): ContextHealth {
  if (pct >= 100) return "exceeded";
  if (pct >= 80) return "near-limit";
  if (pct >= 50) return "moderate";
  return "optimal";
}
