// ============================================================
// AI Chat Types — OpenRouter-Backed Multi-Model Chat
// ============================================================

export interface UsageInfo {
  /** Exact prompt tokens reported by the provider (null when estimated) */
  promptTokens: number | null;
  /** Exact completion tokens reported by the provider (null when estimated) */
  completionTokens: number | null;
  /** Cost in OpenRouter credits for this response */
  cost: number | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  error?: boolean;
  /** Model that generated this message (assistant messages) */
  model?: string;
  /** End-to-end latency in ms (assistant messages) */
  latencyMs?: number;
  /** Usage accounting (assistant messages) */
  usage?: UsageInfo;
  /** Number of earlier messages hidden by compaction (marker message) */
  compactedFrom?: number;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** Model override for this conversation; falls back to settings default */
  model?: string;
  systemPrompt?: string;
  pinned?: boolean;
}

export type SkillScope = "global" | "conversation";

export interface ChatSkill {
  id: string;
  name: string;
  description: string;
  /** Skill body injected into the system prompt when enabled */
  content: string;
  enabled: boolean;
  /** Builtins reappear after deletion (with updated=true when edited) */
  builtin?: boolean;
  updated?: boolean;
}

export interface ChatSettings {
  defaultModel: string;
  apiKey: string;
  temperature: number;
  systemPrompt: string;
  /** Skill modules — enabled ones are injected into every system prompt */
  skills: ChatSkill[];
}

export interface ModelInfo {
  id: string;
  name: string;
  /** Prompt pricing in USD per 1M tokens */
  promptPrice?: number;
  /** Completion pricing in USD per 1M tokens */
  completionPrice?: number;
  contextLength?: number;
  isFree?: boolean;
}

export type ContextHealth = "optimal" | "moderate" | "near-limit" | "exceeded";

export interface ContextBreakdown {
  /** Tokens of the full stored conversation (estimates + exacts where known) */
  totalTokens: number;
  /** Tokens of what will actually be sent next request */
  sentTokens: number;
  /** Tokens hidden by compaction in the last request */
  compactedTokens: number;
  maxTokens: number;
  percentageUsed: number;
  health: ContextHealth;
}
