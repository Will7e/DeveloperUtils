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

export const DEFAULT_SKILLS: ChatSkill[] = [
  {
    id: "full-stack-architect",
    name: "Full-Stack Architect",
    description: "Modular TypeScript, clean architecture, and production engineering",
    enabled: true,
    isBuiltin: true,
    content: `---
name: full-stack-architect
description: Modular TypeScript, clean architecture, and production engineering
---
# Full-Stack Architect Skill
- Provide clean, modern, production-grade TypeScript code.
- Adhere to clean architecture, separation of concerns, and defensive programming.
- Prioritize type-safety, maintainability, and optimal runtime performance.`,
  },
  {
    id: "code-reviewer",
    name: "Strict Code Reviewer",
    description: "Scrutinizes code for security, memory leaks, and performance edge cases",
    enabled: false,
    isBuiltin: true,
    content: `---
name: code-reviewer
description: Scrutinizes code for security, memory leaks, and performance edge cases
---
# Strict Code Reviewer Skill
- Audit code for security vulnerabilities, OWASP threats, and unescaped inputs.
- Identify memory leaks, unhandled edge cases, and performance bottlenecks.
- Suggest concise, modern, and idiomatic refactorings.`,
  },
  {
    id: "servicenow-specialist",
    name: "ServiceNow Specialist",
    description: "Scoped Script Includes, GlideRecordSecure, and ServiceNow best practices",
    enabled: false,
    isBuiltin: true,
    content: `---
name: servicenow-specialist
description: Scoped Script Includes, GlideRecordSecure, and ServiceNow best practices
---
# ServiceNow Specialist Skill
- Always use GlideRecordSecure rather than GlideRecord when checking user ACLs.
- Write scoped Script Includes with initialize functions and proper scope isolation.
- Follow ServiceNow performance best practices (never query GlideRecord in loops).`,
  },
  {
    id: "test-qa-engineer",
    name: "Test & QA Engineer",
    description: "Vitest, mock fixtures, edge cases, and high assertion coverage",
    enabled: false,
    isBuiltin: true,
    content: `---
name: test-qa-engineer
description: Vitest, mock fixtures, edge cases, and high assertion coverage
---
# Test & QA Engineer Skill
- Write comprehensive unit and integration tests using Vitest or Jest.
- Create realistic mock data fixtures and test boundary edge cases (null, empty, error states).
- Keep assertions clean, deterministic, and self-documenting.`,
  },
];

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
