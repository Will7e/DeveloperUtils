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

// ── Model state (reasoning effort) ───────────────────────
// OpenRouter normalizes reasoning control across providers through
// the request's `reasoning` object (`effort`, `max_tokens`, `exclude`)
// plus the OpenAI-style `reasoning_effort` alias. Every model declares
// what it accepts in the catalog (`supported_parameters` and
// `reasoning.supported_efforts`), so one effort selector can drive ANY
// model — free or paid — and lib/model-state.ts snaps the chosen rung
// to what that model actually supports.
//
//   low    — minimal thinking: fastest time-to-first-token
//   medium — balanced (the default)
//   high   — deeper reasoning for hard problems
//   max    — the model's deepest setting (xhigh/max where offered)
export const REASONING_EFFORTS = ["low", "medium", "high", "max"] as const;
export const DEFAULT_REASONING_EFFORT = "medium" as const;

/** Agent modes: build edits the workspace, plan is read-only */
export const CHAT_MODES = ["build", "plan"] as const;
export const DEFAULT_CHAT_MODE = "build" as const;

/**
 * Free model shipped as the default for new chats. A real OpenRouter
 * slug (unlike the retired "InTab Flash" virtual model) so the picker,
 * the transcript, and exports all name the model that actually ran.
 * Chosen for tool calling + a reasoning-capable catalog entry + a
 * 131k window, which makes it a usable coding-agent default at $0.
 */
export const DEFAULT_CHAT_MODEL = "openai/gpt-oss-120b:free";

/**
 * Legacy virtual-model ids that used to identify the InTab router.
 * Kept ONLY so stored conversations/settings can be migrated onto a
 * real model — every routing behaviour behind them is gone.
 */
export const LEGACY_INTAB_MODEL_IDS: readonly string[] = [
  "intab/intab-llm",
  "intab/intab-llm-light",
  "intab/intab-llm-max",
];

/** True when a stored model id came from the retired InTab router */
export function isLegacyIntabModelId(modelId: string | undefined): boolean {
  return Boolean(modelId && LEGACY_INTAB_MODEL_IDS.includes(modelId));
}

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
  defaultModel: DEFAULT_CHAT_MODEL,
  defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
  defaultMode: DEFAULT_CHAT_MODE,
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

  // ── Task-shaped skills ─────────────────────────────────────
  // The skills above are shaped like languages (SQL, regex); these are
  // shaped like JOBS. A coding agent is asked to do jobs, so the jobs
  // are where the harness discipline belongs — and because they are
  // listed in the standing skill index with triggers, the model can
  // load the right one on demand instead of paying for every skill on
  // every turn.
  {
    id: "builtin-fix-failing-build",
    name: "Fix Failing Build",
    description: "Reproduce, fix, and re-verify a broken build",
    enabled: false,
    builtin: true,
    triggers: [
      "failing build",
      "build fails",
      "build error",
      "does not compile",
      "type error",
      "tsc",
      "cannot find module",
      "broken build",
    ],
    content:
      "A broken build is fixed by evidence, not by guessing. Work in this order and do not skip a step:\n1. REPRODUCE: read the actual error text (get_preview_feedback for build errors). Never start from a plausible-looking cause — start from the error you can see.\n2. LOCATE: read the exact file and line the error names, plus the immediate surroundings. If the error is a type mismatch, find the type's definition before editing the usage.\n3. FIX THE CAUSE: make the smallest change that removes the error. Do not disable checks, loosen types to `any`, or delete the failing code to make the error disappear.\n4. RE-VERIFY: call get_preview_feedback again and confirm the same error is gone and no new one appeared. A fix that was never re-checked is a guess.\n5. If a second attempt fails, change strategy: read wider (the caller, the type, the config), state what you now believe, and say so explicitly rather than retrying the same edit.",
  },
  {
    id: "builtin-verify-before-push",
    name: "Verify Before Push",
    description: "Definition of done before shipping a change set",
    enabled: false,
    builtin: true,
    triggers: ["push", "ship", "open a pr", "pull request", "commit", "done"] ,
    content:
      "Before calling push_changes, satisfy this definition of done and report it:\n1. REVIEW THE WHOLE CHANGE SET with get_workspace_diff and confirm every file in it was intended. Unrelated edits are bugs in the change set.\n2. VERIFY RUNTIME BEHAVIOUR where the workspace allows it: get_preview_feedback for build/console errors, and run_in_preview or query_preview_dom to confirm the changed behaviour actually happens.\n3. SAY WHAT YOU COULD NOT CHECK. Some checks need a shell (test suites, linters, type-checkers). You cannot run them here. State plainly which ones you did NOT run instead of implying they passed — an unverified claim that reaches a reviewer costs more than an honest gap.\n4. NAME THE EVIDENCE: for each change, the file and the reason. If you cannot point at a tool result that justifies a change, do not claim it works.\n5. Write a conventional commit message and a PR body that explains WHY. Reviewers approve intent, not diffs.",
  },
  {
    id: "builtin-add-tests-for-change",
    name: "Add Tests For Change",
    description: "Tests that pin the change you just made",
    enabled: false,
    builtin: true,
    triggers: ["add tests", "write tests", "unit test", "coverage", "regression test", "spec"],
    content:
      "When adding tests for an existing change:\n1. Read the file you changed and the tests that already cover it — match the existing framework, file location, and naming conventions. Do not introduce a second test style.\n2. Write the test that would have FAILED before your change. That is the only test that proves the change did something.\n3. Add one boundary case (empty, null, zero, maximum) and one error-path case.\n4. Keep tests deterministic: no real network, no real clock, no ordering dependence. Inject or freeze what varies.\n5. State clearly that you could not run the suite (there is no shell here) — the user must run it. Do not report a green suite you never executed.",
  },
  {
    id: "builtin-review-this-diff",
    name: "Review This Diff",
    description: "Adversarial review of a pending change set",
    enabled: false,
    builtin: true,
    triggers: ["review the diff", "review this change", "audit", "what's wrong", "code review"],
    content:
      "Review adversarially — your job is to find what is WRONG, not to confirm the change is fine.\n1. Call get_workspace_diff and read the whole change set before commenting on any part of it.\n2. For each hunk ask: what input breaks this? What did the author assume that may not hold? What existing behaviour could this change silently? Was something removed that callers still depend on?\n3. Check that the change is actually complete: every new function is called, every removed symbol has no remaining references (search_workspace), every new file is reachable.\n4. Report findings by severity — [BLOCKER] correctness/security, [MAJOR] design/performance, [MINOR] style — quoting the exact line. Lead with the most severe finding; never bury it under praise.\n5. If the change set is small, read the surrounding file anyway: most regressions live in the code just outside the diff.",
  },
  {
    id: "builtin-explore-unknown-repo",
    name: "Explore Unknown Repo",
    description: "Map an unfamiliar codebase before touching it",
    enabled: false,
    builtin: true,
    triggers: [
      "how does",
      "where is",
      "where does",
      "understand the codebase",
      "architecture",
      "explore",
      "onboard",
    ],
    content:
      "Mapping an unfamiliar repository:\n1. START BROAD: get_repo_overview for structure and the README's opening, then list_repo_files on the subtrees that matter. Do not read files at random — navigate.\n2. FIND THE ENTRY POINTS: the app entry, the route/command table, the main config. Entry points explain the shape of everything else.\n3. BATCH YOUR READS: one run_tool_program with several read_file steps beats six separate calls — cheaper, faster, and it keeps related facts in one context block.\n4. ANSWER WITH PATHS: every claim cites a file you actually read. Say explicitly when you are inferring rather than reporting.\n5. BUILD THE MODEL IN ORDER: what it does → how it is wired → where a change of the requested kind would go. Finish by naming the files a change would touch, so the next step is obvious.",
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
  DEFAULT_CHAT_MODEL,
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
