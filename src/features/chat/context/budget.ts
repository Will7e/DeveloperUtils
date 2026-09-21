// ============================================================
// Context Budget — Per-Request Token Budgeting
// ============================================================
// Budget = model context window − system prompt − output reserve.
// The engine builds requests that always fit within this budget.

import { OUTPUT_RESERVE_TOKENS } from "../constants";
import type { ContextHealth, ModelInfo } from "../types";
import { estimateTokens } from "./tokenizer";

export interface RequestBudget {
  /** Model context window in tokens */
  window: number;
  /** Tokens reserved for the model's output */
  outputReserve: number;
  /** Tokens available for system prompt + history */
  available: number;
  /** Tokens consumed by the system prompt (0 when none) */
  systemTokens: number;
}

/**
 * Computes the request budget for a model. Falls back to a
 * conservative 128k window when the model's context length is unknown.
 * The model's learned token-calibration ratio sharpens the system
 * prompt estimate when available.
 */
export function computeBudget(params: {
  model?: ModelInfo;
  systemPrompt?: string;
}): RequestBudget {
  const window = params.model?.contextLength ?? 128_000;
  const outputReserve = Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(window * 0.1));
  const systemTokens = estimateTokens(params.systemPrompt, params.model?.id);

  return {
    window,
    outputReserve,
    available: Math.max(0, window - outputReserve - systemTokens),
    systemTokens,
  };
}

export function healthFromPercentage(pct: number): ContextHealth {
  if (pct >= 100) return "exceeded";
  if (pct >= 80) return "near-limit";
  if (pct >= 50) return "moderate";
  return "optimal";
}
