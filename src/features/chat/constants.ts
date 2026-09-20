// ============================================================
// Chat Constants — Defaults & Curated Model Fallbacks
// ============================================================

import type { ChatSettings, ChatSkill, ModelInfo } from "./types";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_CONSOLE_URL = "https://openrouter.ai/settings/keys";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/models";

export const OUTPUT_RESERVE_TOKENS = 4096;
export const COMPACTION_THRESHOLD = 0.85;
/** Compact down to this fraction of the budget when triggered */
export const COMPACTION_TARGET = 0.5;

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  defaultModel: "openai/gpt-4o-mini",
  apiKey: "",
  temperature: 0.7,
  systemPrompt:
    "You are InTab AI, an expert developer assistant built into the developer workstation. Provide clear, accurate, concise answers with production-ready code examples.",
  skills: [],
};

/**
 * Built-in skill presets for developers. These ship with the app,
 * are disabled by default, and reappear after deletion (an edited
 * builtin keeps `updated: true` so it is not overwritten again).
 */
export const BUILTIN_SKILLS: ChatSkill[] = [
  {
    id: "builtin-code-reviewer",
    name: "Code Reviewer",
    description: "Rigorous review with severity-tagged findings",
    enabled: false,
    builtin: true,
    content:
      "When reviewing code, structure findings by severity: [BLOCKER] bugs or security issues, [MAJOR] correctness or performance problems, [MINOR] style and clarity. For each finding quote the exact line, explain the failure mode, and show a corrected version. End with a one-paragraph overall assessment.",
  },
  {
    id: "builtin-sql-explainer",
    name: "SQL Explainer",
    description: "Explain and optimize SQL queries",
    enabled: false,
    builtin: true,
    content:
      "When given SQL: (1) restate what the query returns in plain English, (2) walk through execution order (FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT → ORDER BY), (3) flag full scans, non-sargable predicates, and N+1 risks, (4) provide an optimized rewrite with an explanation of why it is faster.",
  },
  {
    id: "builtin-regex-debugger",
    name: "Regex Debugger",
    description: "Decode, test, and fix regular expressions",
    enabled: false,
    builtin: true,
    content:
      "When given a regular expression: break it into a token-by-token table (pattern, meaning), list what it matches and — critically — what it over-matches or misses, provide 5 test strings with expected outcomes, and suggest a corrected or more efficient pattern when applicable. Note the target flavor (JS, PCRE, RE2) explicitly.",
  },
  {
    id: "builtin-commit-writer",
    name: "Commit Writer",
    description: "Conventional-commit messages from diffs",
    enabled: false,
    builtin: true,
    content:
      "When given a diff or change description, write a conventional commit: type(scope): summary under 72 characters, then a body explaining WHY the change was made, then a Footer with breaking changes or issue references. Prefer `why` over `what` in the body. Never invent changes not present in the diff.",
  },
  {
    id: "builtin-security-auditor",
    name: "Security Auditor",
    description: "OWASP-minded security review",
    enabled: false,
    builtin: true,
    content:
      "When reviewing code for security: check injection (SQL, command, XSS), authn/authz gaps, secrets in code, unsafe deserialization, SSRF, and misconfigured CORS/headers. Rate each finding Critical/High/Medium/Low with the OWASP category, a concrete exploit scenario, and the fix. Be specific — never generic advice.",
  },
  {
    id: "builtin-docs-simplifier",
    name: "Docs Simplifier",
    description: "Rewrite technical docs for clarity",
    enabled: false,
    builtin: true,
    content:
      "Rewrite technical documentation to be clear and direct: lead with the task, use second person and active voice, prefer lists over paragraphs for procedures, keep code examples minimal but runnable, and flag any assumption the reader must hold. Preserve all technical accuracy — simplify language only.",
  },
  {
    id: "builtin-api-designer",
    name: "API Designer",
    description: "REST/GraphQL design review",
    enabled: false,
    builtin: true,
    content:
      "When designing or reviewing APIs: check resource naming and URL structure, HTTP method semantics and status codes, pagination and filtering conventions, error response shape (RFC 7807 style), versioning strategy, and idempotency of mutating endpoints. Show concrete request/response examples for every recommendation.",
  },
  {
    id: "builtin-test-writer",
    name: "Test Writer",
    description: "Thorough unit test generation",
    enabled: false,
    builtin: true,
    content:
      "When asked to write tests: cover the happy path first, then boundary values, then error paths and edge cases (empty, null, huge, unicode, concurrent). Use descriptive test names that state the expected behavior. Prefer table-driven tests for similar cases. Mock only external boundaries — never the unit under test.",
  },
];

/**
 * Curated fallback models shown before/without the live catalog.
 * IDs follow OpenRouter slugs.
 */
export const CURATED_FALLBACK_MODELS: ModelInfo[] = [
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o mini",
    contextLength: 128000,
    isFree: false,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    contextLength: 128000,
  },
  {
    id: "anthropic/claude-3.5-sonnet",
    name: "Claude 3.5 Sonnet",
    contextLength: 200000,
  },
  {
    id: "anthropic/claude-3.5-haiku",
    name: "Claude 3.5 Haiku",
    contextLength: 200000,
  },
  {
    id: "google/gemini-flash-1.5",
    name: "Gemini Flash 1.5",
    contextLength: 1000000,
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B",
    contextLength: 131072,
  },
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3",
    contextLength: 64000,
  },
];

export const PINNED_MODEL_IDS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-3.5-sonnet",
  "anthropic/claude-3.5-haiku",
  "google/gemini-flash-1.5",
  "google/gemini-pro-1.5",
  "meta-llama/llama-3.3-70b-instruct",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-r1",
  "mistralai/mistral-large",
  "x-ai/grok-2",
  "qwen/qwen-2.5-72b-instruct",
];
