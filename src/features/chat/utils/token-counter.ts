// ============================================================
// Token Counter Utility — Context Calculation for LLMs
// ============================================================

import type { ChatMessage, ChatSkill } from "../types";

/**
 * Numeric context window limits for curated models
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Google Gemini
  "gemini-2.0-flash": 1048576, // 1M tokens
  "gemini-2.0-pro-exp-02-05": 2097152, // 2M tokens
  "gemini-1.5-pro": 2097152, // 2M tokens

  // OpenAI
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "o3-mini": 200000,

  // Anthropic Claude
  "claude-3-7-sonnet-20250219": 200000,
  "claude-3-5-sonnet-20241022": 200000,
  "claude-3-5-haiku-20241022": 200000,
};

const DEFAULT_CONTEXT_LIMIT = 128000;

/**
 * Get maximum token capacity for a given model ID
 */
export function getModelContextLimit(modelId?: string): number {
  if (!modelId) return DEFAULT_CONTEXT_LIMIT;
  return MODEL_CONTEXT_LIMITS[modelId] || DEFAULT_CONTEXT_LIMIT;
}

/**
 * Fast, accurate token estimator for code and prose without heavy external libraries.
 * Follows the standard OpenAI / Anthropic / Gemini benchmark:
 * ~3.8 to 4 characters per token for English text, code, symbols and whitespaces.
 */
export function estimateTokens(text?: string | null): number {
  if (!text || text.length === 0) return 0;

  // Code blocks, punctuation, and multi-byte characters often have higher token densities
  const codeBlockCount = (text.match(/```/g) || []).length;
  const isCodeHeavy = codeBlockCount > 1;

  // Characters per token ratio: ~3.7 for code, ~4.0 for standard prose
  const charRatio = isCodeHeavy ? 3.7 : 4.0;
  const estimated = Math.ceil(text.length / charRatio);

  return Math.max(1, estimated);
}

export interface ContextTokensBreakdown {
  systemPromptTokens: number;
  skillsTokens: number;
  messagesTokens: number;
  totalTokens: number;
  maxTokens: number;
  percentageUsed: number;
  remainingTokens: number;
  health: "optimal" | "moderate" | "near-limit" | "exceeded";
}

/**
 * Calculates complete context token usage for an active conversation
 */
export function calculateConversationTokens({
  messages,
  systemPrompt,
  skills,
  modelId,
}: {
  messages?: ChatMessage[];
  systemPrompt?: string;
  skills?: ChatSkill[];
  modelId?: string;
}): ContextTokensBreakdown {
  const maxTokens = getModelContextLimit(modelId);

  // 1. System Prompt Tokens
  const systemPromptTokens = estimateTokens(systemPrompt);

  // 2. Active Enabled Skills Tokens
  let skillsTokens = 0;
  if (skills && skills.length > 0) {
    const activeSkills = skills.filter((s) => s.enabled);
    const combinedSkillsText = activeSkills
      .map((s) => `${s.name}: ${s.description}\n${s.content}`)
      .join("\n\n");
    skillsTokens = estimateTokens(combinedSkillsText);
  }

  // 3. Messages Tokens (including per-message framing overhead ~4 tokens per message)
  let messagesTokens = 0;
  if (messages && messages.length > 0) {
    for (const msg of messages) {
      // Content tokens + 4 tokens overhead per message (<|im_start|>role...<|im_end|>)
      const imageTokens = (msg.images?.length || 0) * 300;
      messagesTokens += estimateTokens(msg.content) + imageTokens + 4;
    }
  }

  const totalTokens = systemPromptTokens + skillsTokens + messagesTokens;
  const percentageUsed = Math.min(100, (totalTokens / maxTokens) * 100);
  const remainingTokens = Math.max(0, maxTokens - totalTokens);

  let health: ContextTokensBreakdown["health"] = "optimal";
  if (percentageUsed >= 100) {
    health = "exceeded";
  } else if (percentageUsed >= 80) {
    health = "near-limit";
  } else if (percentageUsed >= 50) {
    health = "moderate";
  }

  return {
    systemPromptTokens,
    skillsTokens,
    messagesTokens,
    totalTokens,
    maxTokens,
    percentageUsed,
    remainingTokens,
    health,
  };
}

/**
 * Format numbers cleanly (e.g. 1,420 -> 1.4k, 1,048,576 -> 1.0M)
 */
export function formatTokenCount(num: number): string {
  if (num >= 1000000) {
    const m = num / 1000000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (num >= 1000) {
    const k = num / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return num.toLocaleString();
}
