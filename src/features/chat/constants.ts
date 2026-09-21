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
/** Default agent iteration cap (settings-overridable, hard-capped) */
export const AGENT_ITERATIONS_DEFAULT = 24;
export const AGENT_ITERATIONS_MAX = 50;
/** Tool definitions are only sent when a repo is attached AND the model is known-capable */
export const TOOL_RESULT_MAX_CHARS = 12_000;

/**
 * run_tool_program — batched read-only tool programs (PTC-lite).
 * One program = one transcript round trip instead of one per tool call.
 */
export const TOOL_PROGRAM_MAX_STEPS = 8;
/** Aggregated, model-facing output budget across all steps of one program */
export const TOOL_PROGRAM_MAX_CHARS = 24_000;
/** Max bytes of a workspace file the preview bundler will inline */
export const WORKSPACE_MAX_FILE_BYTES = 1_500_000;
/** Debounce for workspace IDB persistence (ms) */
export const WORKSPACE_SAVE_DEBOUNCE_MS = 600;
/** Debounce for preview rebuilds after workspace edits (ms) */
export const PREVIEW_REBUILD_DEBOUNCE_MS = 450;
/** Branch prefix for agent-pushed working branches */
export const AGENT_BRANCH_PREFIX = "agent/";

// ── InTab Flash (virtual model) ──────────────────────────
// "intab/intab-llm*" ids are not real OpenRouter models — the
// runner resolves each to a pool of free OpenRouter models (see
// lib/intab-llm.ts) with per-conversation sticky routing and
// silent failover. The UI presents them as ordinary models.
//
// Three tiers share one router:
//   · Light — fastest replies (small/quick models first)
//   · High  — balanced quality/speed (default; = the legacy id)
//   · Max   — strongest reasoning (large agentic models first)
// The legacy id stays mapped to the default tier so existing
// conversations, stored settings, and the v1 chat-store default
// keep working unchanged.
export const INTAB_MODEL_ID = "intab/intab-llm";
export const INTAB_MODEL_NAME = "InTab Flash 5.5";
/** Tagline shown under the default (High) tier in pickers & menus */
export const INTAB_MODEL_TAGLINE = "Adaptive multi-model routing · v6.0";

/**
 * Tier registry. `id` is the synthetic conversation-facing model id;
 * `baseId` is the legacy id kept for isIntabModel prefix matching.
 * Order matters: Light first, then the default, then Max.
 */
export type InTabTierId =
  | "intab/intab-llm-light"
  | "intab/intab-llm"
  | "intab/intab-llm-max";

export interface InTabTierMeta {
  /** Synthetic wire-facing model id (never goes to OpenRouter) */
  id: InTabTierId;
  /** User-facing picker name */
  name: string;
  /** One-liner shown under the tier in pickers & command menus */
  tagline: string;
  /** Display context length (largest window in the tier's pool) */
  contextLength: number;
}

/** All tiers, in picker order (Light, High, Max) */
export const INTAB_MODEL_TIERS: readonly InTabTierMeta[] = [
  {
    id: "intab/intab-llm-light",
    name: "InTab Flash · Light",
    tagline: "Fastest free models · instant replies",
    contextLength: 262144,
  },
  {
    id: INTAB_MODEL_ID,
    name: "InTab Flash · High",
    tagline: INTAB_MODEL_TAGLINE,
    contextLength: 262144,
  },
  {
    id: "intab/intab-llm-max",
    name: "InTab Flash · Max",
    tagline: "Deepest reasoning · strongest free models",
    contextLength: 1000000,
  },
] as const;

/** Look up a tier by synthetic id (undefined for non-InTab ids) */
export function intabTierById(modelId: string): InTabTierMeta | undefined {
  return INTAB_MODEL_TIERS.find((t) => t.id === modelId);
}

/** Synthetic catalog entries so pickers/headers resolve every tier id */
export const INTAB_TIER_VIRTUAL_MODELS: ModelInfo[] = INTAB_MODEL_TIERS.map(
  (t) => ({
    id: t.id,
    name: t.name,
    contextLength: t.contextLength,
  })
);

/** Virtual model entry for the default (legacy) id — existing imports.
 *  Carries the product name ("InTab Flash 5.5"), NOT the High tier
 *  name — the tier is a state chosen beside the model, not the model. */
export const INTAB_VIRTUAL_MODEL: ModelInfo = {
  id: INTAB_MODEL_ID,
  name: INTAB_MODEL_NAME,
  contextLength: 262144,
};

/**
 * Per-tier DESIRED state — the "background" half of the tier
 * selector. OpenRouter models expose per-request state (see the
 * catalog's `supported_parameters` + `reasoning.supported_efforts`):
 *
 *  · reasoning_effort — xhigh|high|medium|low|minimal|none: how much
 *    the model may think internally before answering.
 *  · reasoning.exclude — keep thinking tokens out of the response
 *    (faster render, fewer tokens over the wire).
 *
 * These are DESIRES, not wire payloads: pool models differ in which
 * efforts they accept (some only ["xhigh","medium"], some none at
 * all), so lib/intab-llm.ts snaps the desired effort to each model's
 * declared capabilities per request (snapRequestStateForModel).
 *
 * Light optimizes latency (low effort, thinking suppressed), High
 * balances (medium effort), Max thinks hard (high effort, thinking
 * visible in the reasoning panel). Applied for InTab turns only;
 * real OpenRouter models pass through untouched.
 */
export const INTAB_TIER_DESIRED_STATE: Record<
  InTabTierId,
  { reasoningEffort: "low" | "medium" | "high"; excludeThinking: boolean }
> = {
  "intab/intab-llm-light": { reasoningEffort: "low", excludeThinking: true },
  "intab/intab-llm": { reasoningEffort: "medium", excludeThinking: false },
  "intab/intab-llm-max": { reasoningEffort: "high", excludeThinking: false },
};

// ── Task-aware routing (see lib/intab-classify.ts) ────────
// Each turn is classified (quick/code/analysis/vision/agent) and
// routed by a per-kind preference order. A kind list REFINES the
// tier's base pool: candidates are scored by the tier order first,
// then nudged by the kind order (see scoreCandidate in
// lib/intab-llm.ts) — a kind can lift a model within the tier but
// can never pull a model in from another tier's pool.
//
// Pool refresh (Sep 2026): the new-generation free families lead —
// dots-studio/dots-3-note-preview (280B MoE, only 16B active → very
// fast TTFT), inclusionai/ling-3.0-flash (262k ctx), and nex-agi/
// nex-n2.5-pro|mini (262k ctx, agentic). The old heavy-first orders
// (nemotron-550b leading every analysis turn) were the main source
// of slow time-to-first-token.

/** Per-kind pool preference orders (prefix match, like the base list) */
export const INTAB_TURN_KIND_PREFERENCE = {
  // Short social/follow-up turns — smallest fastest models first
  quick: ["dots-studio/dots-3-note-preview", "inclusionai/ling-3.0-flash", "openai/gpt-oss-20b"],
  // Code authoring/debugging — coder/agentic-tuned models first
  code: ["qwen/qwen3-coder", "nex-agi/nex-n2.5-pro", "openai/gpt-oss-120b", "dots-studio/dots-3-note-preview"],
  // Long-context comprehension/analysis — big windows first
  analysis: ["nex-agi/nex-n2.5-pro", "inclusionai/ling-3.0-flash", "openai/gpt-oss-120b", "dots-studio/dots-3-note-preview"],
  // Vision turns: ordering is secondary (the vision gate filters)
  vision: ["openai/gpt-oss-120b", "nex-agi/nex-n2.5-pro", "inclusionai/ling-3.0-flash"],
  // Agent/tool turns — strong instruction-following & tool use
  agent: ["nex-agi/nex-n2.5-pro", "qwen/qwen3-coder", "openai/gpt-oss-120b", "dots-studio/dots-3-note-preview"],
} as const;

/** Turn kinds the classifier can emit */
export const INTAB_TURN_KINDS = ["quick", "code", "analysis", "vision", "agent"] as const;

/**
 * Extra requests a pool model may serve after its daily free cap is
 * believed exhausted before it is fully demoted for the day.
 */
export const INTAB_DAILY_CAP_GRACE_REQUESTS = 2;
/** Slack between the reported cap and when we consider a model spent */
export const INTAB_DAILY_CAP_SAFETY_MARGIN = 0;
/** Milliseconds of silence before a hedged race fires the backup model.
 *  2s (was 3s): free-tier TTFT tails are the #1 latency complaint, and
 *  a duplicated request on free models costs nothing. */
export const INTAB_HEDGE_TRIGGER_MS = 2_000;
/** Maximum simultaneous streams in one hedged race (primary + 1 hedge) */
export const INTAB_HEDGE_MAX_STREAMS = 2;
/**
 * Static InTab pool used before/without the live catalog. Kept in
 * preference order — fast general models first, larger ones after.
 * The live catalog replaces this wholesale when it loads (see
 * buildInTabPool), so stale entries here degrade gracefully: the
 * runner failover skips ids OpenRouter rejects with 404.
 *
 * Every entry MUST carry isFree: true — buildInTabPool filters the
 * fallback through the same isFree/≥32k gate as the live catalog.
 * (The pre-refresh list omitted it and produced an EMPTY cold-start
 * pool — the "does not even respond" bug on first run.)
 */
export const INTAB_FALLBACK_POOL: ModelInfo[] = [
  {
    id: "dots-studio/dots-3-note-preview:free",
    name: "Dots3-Note Preview (free)",
    contextLength: 262144,
    isFree: true,
  },
  {
    id: "nex-agi/nex-n2.5-pro:free",
    name: "Nex-N2.5 Pro (free)",
    contextLength: 262144,
    isFree: true,
  },
  {
    id: "inclusionai/ling-3.0-flash:free",
    name: "Ling 3.0 Flash (free)",
    contextLength: 262144,
    isFree: true,
  },
  {
    id: "openai/gpt-oss-120b:free",
    name: "GPT-OSS 120B (free)",
    contextLength: 131072,
    isFree: true,
  },
  {
    id: "openai/gpt-oss-20b:free",
    name: "GPT-OSS 20B (free)",
    contextLength: 131072,
    isFree: true,
  },
  {
    id: "google/gemma-4-31b:free",
    name: "Gemma 4 31B (free)",
    contextLength: 262144,
    isFree: true,
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

// ── Session host (SharedWorker stream ownership) ─────────
/** Bump when the host ⇄ page message contract changes */
export const HOST_PROTOCOL_VERSION = 1;
/** Pages must re-attach within this window or the orphan turn aborts */
export const HOST_ORPHAN_GRACE_MS = 45_000;
/** Default hedge delay inside the host (client passes its own per turn) */
export const HOST_HEDGE_TRIGGER_MS = 3_000;
/** Pages heartbeat the host at this cadence to prove liveness */
export const HOST_HEARTBEAT_MS = 15_000;
/** In-memory cap on buffered content replayable to late attachers */
export const HOST_SNAPSHOT_MAX_CHARS = 200_000;
/**
 * Distinct pool models the host walks per round before asking the
 * page for fresh candidates (parity with the page-side attempt cap,
 * so a dead provider pool can't spin for minutes unnoticed).
 */
export const HOST_MAX_ATTEMPTS = 4;
/**
 * Renderer ceiling: with no event for this long the transport is
 * considered dead (worker killed, port dropped) and the turn ends
 * with an honest error instead of a spinner that never stops. Above
 * the client's own 30s first-byte / 60s stall watchdogs, so a merely
 * slow model still ends via a normal END.
 */
export const TURN_INACTIVITY_TIMEOUT_MS = 90_000;

// ── Tool-result folding (agent context efficiency) ────────
/** Tool results older than this many turns fold to digests in wire requests */
export const TOOL_RESULT_FOLD_TURNS = 6;
/** A folded result keeps at most this many characters of digest */
export const TOOL_RESULT_DIGEST_MAX_CHARS = 240;

/** Concurrency cap for parallel independent tool execution */
export const TOOL_EXECUTION_CONCURRENCY = 3;

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  defaultModel: INTAB_MODEL_ID,
  apiKey: "",
  temperature: 0.7,
  systemPrompt:
    "You are InTab AI, an expert developer assistant built into the developer workstation. Provide clear, accurate, concise answers with production-ready code examples.",
  skills: [],
  syncImageAttachments: true,
  agentMaxIterations: AGENT_ITERATIONS_DEFAULT,
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
