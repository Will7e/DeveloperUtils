// ============================================================
// AI Chat Types & Provider Definitions
// ============================================================

export type AIProvider = "openai" | "anthropic" | "gemini";

export interface ChatImageAttachment {
  id: string;
  url: string; // Base64 data URL
  name: string;
  mimeType: string;
  size?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  error?: boolean;
  images?: ChatImageAttachment[];
  model?: string;
  latencyMs?: number;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  provider: AIProvider;
  model: string;
  systemPrompt?: string;
  pinned?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: AIProvider;
  contextWindow: string;
  description: string;
  isDefault?: boolean;
}

export interface ChatSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  isBuiltin?: boolean;
}

export interface ChatSettings {
  activeProvider: AIProvider;
  activeModel: string;
  defaultProvider: AIProvider;
  defaultModel: string;
  apiKeys: Record<AIProvider, string>;
  baseUrls: Record<AIProvider, string>;
  skills: ChatSkill[];
  systemPrompt: string;
  temperature: number;
  useProxy: boolean;
}

export const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  gemini: "Google Gemini",
};

export const PROVIDER_CONSOLE_URLS: Record<AIProvider, string> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/app/apikey",
};

export const CURATED_MODELS: ModelInfo[] = [
  // OpenAI
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    contextWindow: "128k context",
    description: "High-performance multimodal reasoning engine",
    isDefault: true,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    provider: "openai",
    contextWindow: "128k context",
    description: "Fast, cost-efficient model for everyday coding & text",
  },
  {
    id: "o3-mini",
    name: "o3-mini",
    provider: "openai",
    contextWindow: "200k context",
    description: "Advanced STEM & coding reasoning model with chain of thought",
  },

  // Anthropic
  {
    id: "claude-3-7-sonnet-20250219",
    name: "Claude 3.7 Sonnet",
    provider: "anthropic",
    contextWindow: "200k context",
    description: "State-of-the-art hybrid reasoning & fast coding intelligence",
    isDefault: true,
  },
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
    contextWindow: "200k context",
    description: "Highly capable programming & architectural assistant",
  },
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude 3.5 Haiku",
    provider: "anthropic",
    contextWindow: "200k context",
    description: "Ultra-fast response times with high accuracy",
  },

  // Google Gemini
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    provider: "gemini",
    contextWindow: "1M context",
    description: "Google's latest, most capable Flash model for coding, agents, and complex workflows",
    isDefault: true,
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    provider: "gemini",
    contextWindow: "1M context",
    description: "Google's recommended high-speed multimodal reasoning model with 1M context",
  },
];

export const DEFAULT_MODELS = CURATED_MODELS;

export const DEFAULT_SYSTEM_PROMPT =
  "You are InTab AI, an expert developer assistant built directly into the developer workstation. Provide clear, accurate, concise answers with production-ready code examples, thorough explanations, and best practices.";

export const DEFAULT_SKILLS: ChatSkill[] = [];

export function buildEffectiveSystemPrompt(
  skills: ChatSkill[] = [],
  basePrompt = DEFAULT_SYSTEM_PROMPT
): string {
  const enabledSkills = skills.filter((s) => s.enabled);
  if (enabledSkills.length === 0) {
    return basePrompt;
  }
  const skillsMarkdown = enabledSkills
    .map((s) => `### Skill: ${s.name}\n${s.content.trim()}`)
    .join("\n\n---\n\n");

  return `${basePrompt}\n\n# Active Agent Skills (SKILL.md):\n\n${skillsMarkdown}`;
}
