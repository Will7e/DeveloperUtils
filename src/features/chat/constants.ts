// ============================================================
// Chat Constants — Defaults & Curated Model Fallbacks
// ============================================================

import type { ChatSettings, ChatSkill, ModelInfo } from "./types";

// ── GitHub Agent Mode ─────────────────────────────────────

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
/** Edge function that exchanges the OAuth code for a token (server-side secret) */
export const GITHUB_EXCHANGE_PATH = "/api/github";
/** OAuth scopes: full repo read access (private + public) */
export const GITHUB_OAUTH_SCOPES = "repo read:org";
/** OAuth popup dimensions (matches the cloud-sync popup conventions) */
export const GITHUB_POPUP_WIDTH = 640;
export const GITHUB_POPUP_HEIGHT = 720;

/** Files above this size are refused/tail-truncated by read_file */
export const GITHUB_MAX_FILE_BYTES = 64_000;
/** Repo trees larger than this are summarized rather than returned whole */
export const GITHUB_MAX_TREE_ENTRIES = 2_500;
/** Hard cap on agent iterations (model turns) per user message */
export const AGENT_MAX_ITERATIONS = 8;
/** Tool definitions are only sent when a repo is attached AND the model is known-capable */
export const TOOL_RESULT_MAX_CHARS = 12_000;

// ── InTab LLM (virtual model) ────────────────────────────
// "intab/intab-llm" is not a real OpenRouter model — the runner
// resolves it to a pool of free OpenRouter models (see
// lib/intab-llm.ts) with per-conversation sticky routing and
// silent failover. The UI presents it as an ordinary model.
export const INTAB_MODEL_ID = "intab/intab-llm";
export const INTAB_MODEL_NAME = "InTab LLM";
/** Synthetic catalog entry so the picker/header resolve the id */
export const INTAB_VIRTUAL_MODEL: ModelInfo = {
  id: INTAB_MODEL_ID,
  name: INTAB_MODEL_NAME,
  contextLength: 128000,
};

/**
 * Static InTab pool used before/without the live catalog. Kept in
 * preference order — strong general models first, fast ones after.
 * The live catalog replaces this wholesale when it loads (see
 * buildInTabPool), so stale entries here degrade gracefully: the
 * runner failover skips ids OpenRouter rejects with 404.
 */
export const INTAB_FALLBACK_POOL: ModelInfo[] = [
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    name: "Nemotron 3 Ultra (free)",
    contextLength: 1000000,
  },
  {
    id: "openai/gpt-oss-120b:free",
    name: "GPT-OSS 120B (free)",
    contextLength: 131072,
  },
  {
    id: "google/gemma-4-31b:free",
    name: "Gemma 4 31B (free)",
    contextLength: 262144,
  },
  {
    id: "openai/gpt-oss-20b:free",
    name: "GPT-OSS 20B (free)",
    contextLength: 131072,
  },
  {
    id: "google/gemma-4-26b:free",
    name: "Gemma 4 26B (free)",
    contextLength: 262144,
  },
];

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_CONSOLE_URL = "https://openrouter.ai/settings/keys";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/models";

export const OUTPUT_RESERVE_TOKENS = 4096;
export const COMPACTION_THRESHOLD = 0.85;
/** Compact down to this fraction of the budget when triggered */
export const COMPACTION_TARGET = 0.5;
/** Cap for the non-streaming summary completion */
export const SUMMARY_MAX_TOKENS = 1024;
/** Never fold the most recent N messages into the summary */
export const COMPACTION_KEEP_RECENT = 2;
/** Auto-compaction retries before falling back to plain truncation */
export const COMPACTION_MAX_RETRIES = 2;
/** Streaming watchdogs: no-headers budget / mid-stream silence budget */
export const STREAM_FIRST_BYTE_TIMEOUT_MS = 30_000;
export const STREAM_STALL_TIMEOUT_MS = 60_000;

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  defaultModel: INTAB_MODEL_ID,
  apiKey: "",
  temperature: 0.7,
  systemPrompt:
    "You are InTab AI, an expert developer assistant built into the developer workstation. Provide clear, accurate, concise answers with production-ready code examples.",
  skills: [],
  syncImageAttachments: true,
  github: {
    token: "",
    mode: null,
    login: null,
    avatarUrl: null,
    connectedAt: null,
  },
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
  INTAB_MODEL_ID,
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
