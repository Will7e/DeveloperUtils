// ============================================================
// AI Chat Types — OpenRouter-Backed Multi-Model Chat
// ============================================================

import type { SpendSummary } from "./lib/cost-meter";

export interface UsageInfo {
  /** Exact prompt tokens reported by the provider (null when estimated) */
  promptTokens: number | null;
  /** Exact completion tokens reported by the provider (null when estimated) */
  completionTokens: number | null;
  /** Cost in OpenRouter credits for this response */
  cost: number | null;
  /**
   * Prompt tokens served from the provider's prompt cache
   * (`usage.prompt_tokens_details.cached_tokens`). Cached reads are
   * billed at a discount, so this is the savings number worth showing.
   */
  cachedTokens?: number | null;
}

/**
 * How much the model may think before answering — the per-conversation
 * "model state". Four rungs map onto OpenRouter's effort vocabulary
 * (low → medium → high → max/xhigh); each is snapped to the levels the
 * selected model actually declares in its catalog `reasoning` block.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

/**
 * Agent operating mode. `build` is the normal coding agent (edits the
 * workspace, can ship via the push gate). `plan` is read-only: the
 * model may explore and propose a plan, but every mutating tool is
 * withheld from the request and refused by the executor.
 */
export type ChatMode = "build" | "plan";

/**
 * A file attached to a user message. Images carry a data URL so they
 * can be sent multimodally and re-rendered from history; text files
 * are inlined into the message content instead (no dataUrl).
 */
export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** Image payloads as a data URL; absent for text attachments */
  dataUrl?: string;
  /** Dimensions for image layout (px) */
  width?: number;
  height?: number;
}

/** GitHub repo a conversation is working against (agent mode context) */
export interface RepoContext {
  owner: string;
  repo: string;
  /** Branch the agent reads from; pinned at attach time */
  branch: string;
  /** When the repo was attached */
  attachedAt: number;
}

/** Name of a tool the agent can call (see lib/tool-registry.ts) */
export type ToolName =
  | "list_repo_files"
  | "read_file"
  | "search_code"
  | "search_workspace"
  | "get_repo_overview"
  | "write_file"
  | "edit_file"
  | "delete_file"
  | "get_workspace_diff"
  | "create_working_branch"
  | "push_changes"
  | "run_tool_program"
  | "read_skill"
  | "remember"
  | "delegate"
  | "run_checks"
  | "update_plan"
  // ── Harness-interaction tools: the two things an agent needs from the
  //    person it works for. `ask_user` parks the turn on a structured
  //    question instead of guessing; `suggest_next` hands back clickable
  //    next steps instead of ending in prose the user must retype.
  | "ask_user"
  | "suggest_next"
  | "list_mcp_tools"
  | "call_mcp_tool"
  | "run_command"
  | "verify_with_ci"
  | "search_web"
  | "fetch_url"
  // ── App tools: the workstation's own features (lib/app-tools.ts,
  //    services/app-actions.ts). They need no repository and no token —
  //    the compiler, formatter, comparators, diff engine, ServiceNow
  //    reference, DrawFlows canvas and the tool handoff are all local.
  | "run_code"
  | "format_code"
  | "compare_data"
  | "diff_text"
  | "search_library"
  | "http_request"
  | "http_write"
  | "create_diagram"
  | "open_in_tool";

/** One tool invocation requested by the model (assembled from stream deltas) */
export interface ToolCallRequest {
  id: string;
  name: ToolName;
  /** Raw JSON arguments string exactly as emitted by the model */
  arguments: string;
}

/** Outcome of executing one tool call (see lib/tools.ts executeToolCall) */
export interface ToolCallResult {
  /** Mirrors ToolCallRequest.id so results pair with requests */
  callId: string;
  name: ToolName;
  ok: boolean;
  /** Structured result for the model (JSON-serialized into the wire message) */
  data: unknown;
  /** Wall-clock execution time in ms (shown in the UI) */
  durationMs: number;
  /** Display line for the collapsed activity row, e.g. "src/App.tsx" */
  summary?: string;
  /**
   * UI-only enrichment: for a file mutation, the diff this step
   * produced. It is deliberately NOT part of `data` — `data` is what
   * the model is sent, and a full patch per write would cost context
   * for information the model already has (it wrote the text).
   */
  uiChange?: StepChange;
}

export type ChatMessageRole = "user" | "assistant";

/**
 * Assistant message with one or more tool invocations. Content holds
 * any text the model emitted alongside the calls (often empty); the
 * invocations render as collapsible activity rows in the transcript.
 */
export interface AssistantToolCallsMessage {
  kind: "tool_calls";
  calls: ToolCallRequest[];
}

/**
 * User-role wire message carrying one tool result back to the model.
 * Paired with its request via callId; the UI renders it inline under
 * the tool-calls message, not as a transcript bubble.
 */
export interface ToolResultMessage {
  kind: "tool_result";
  callId: string;
  name: ToolName;
  ok: boolean;
  /** JSON-serialized tool output sent to the model */
  content: string;
  durationMs: number;
  summary?: string;
  /**
   * What this step changed, captured when it ran (see ToolCallResult.
   * uiChange). Present only on file mutations; the transcript uses it
   * to open the step into its own diff.
   */
  change?: StepChange;
}

/** Runtime union marker on stored messages (absent = plain chat message) */
export type ToolMessageKind = "tool_calls" | "tool_result";

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  error?: boolean;
  /** Files/images attached by the user (user messages only) */
  attachments?: ChatAttachment[];
  /** Model that generated this message (assistant messages) */
  model?: string;
  /** End-to-end latency in ms (assistant messages) */
  latencyMs?: number;
  /** Usage accounting (assistant messages) */
  usage?: UsageInfo;
  /** Chain-of-thought text captured from reasoning models (assistant) */
  reasoning?: string;
  /** Time spent emitting reasoning tokens, when reported (assistant) */
  reasoningMs?: number;
  /** Number of earlier messages hidden by compaction (marker message) */
  compactedFrom?: number;
  /**
   * Reasoning-effort rung the turn was sent with (assistant messages).
   * Stored so the transcript stays reconstructable: the same prompt
   * with a different state is a genuinely different request.
   */
  effort?: ReasoningEffort;
  /** Agent mode the turn ran under (assistant messages) */
  mode?: ChatMode;
  /** Present on agent-activity messages: tool calls the model requested */
  toolCalls?: AssistantToolCallsMessage;
  /** Present on agent-activity messages: one tool result (role is "user") */
  toolResult?: ToolResultMessage;
  /**
   * Soft-deleted (append-only session log): hidden from the UI and
   * from request payloads but retained in storage so what the model
   * has seen stays reconstructable. Set by regenerate instead of
   * destructively dropping the reply.
   */
  hidden?: boolean;
  /**
   * Committed by the pagehide partial flush: the page tore down
   * mid-stream and this message is the truncated reply. Drives the
   * resume planner (complete the answer rather than duplicate it).
   */
  resumedPartial?: boolean;
  /**
   * The thread-on-repository this row was produced under (see
   * identity/identity.ts).
   *
   * Stamped at commit, because a transcript outlives its repository: after a
   * switch, the tool rows above are the PREVIOUS checkout's file bodies,
   * search hits and write arguments, and the request would replay all of them
   * under a system prompt that names the new repository. Context/binding-scope
   * reads this to withhold the rows that belong somewhere else.
   *
   * Absent means "unknown" (a row written before this shipped), which is NOT
   * the same as "the current binding": unknown rows are kept, because for a
   * chat that never left its repository they are that repository's facts.
   */
  bindingId?: string;
}

/**
 * The model-visible (and user-visible) transcript: messages that
 * were not soft-deleted. The session-log invariant — "model-visible
 * means logged" — guarantees every wire payload derives from this
 * list, so regenerate and friends hide instead of delete.
 */
export function visibleMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => !m.hidden);
}

/**
 * True when this message starts a new transcript turn — a user message
 * that is not an agent protocol row.
 *
 * The distinction matters wherever history is CUT (compaction, request
 * truncation). Tool results are stored as `role: "user"` rows carrying a
 * `toolResult` payload (the wire protocol is applied at request time), so
 * a role check alone reports a tool result as a turn boundary — cutting
 * there folds the assistant's `tool_calls` row away and leaves its result
 * orphaned in the kept tail. Every module that asks "is this a user
 * turn?" has to ask it the same way; this is that one place.
 */
export function isTranscriptBoundary(message: ChatMessage | undefined): boolean {
  return message?.role === "user" && message.toolResult === undefined;
}

export function isToolMessage(message: ChatMessage): boolean {
  return message.toolCalls !== undefined || message.toolResult !== undefined;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** Model override for this conversation; falls back to settings default */
  model?: string;
  /** Model-state override; falls back to the settings default */
  reasoningEffort?: ReasoningEffort;
  /** Agent mode override; falls back to the settings default ("build") */
  mode?: ChatMode;
  systemPrompt?: string;
  pinned?: boolean;
  /** Rolling LLM summary of the oldest folded messages (compact mode) */
  summary?: ConversationSummary;
  /** GitHub repo attached to this conversation (enables agent tools) */
  repoContext?: RepoContext;
  /**
   * The last time this thread's REPOSITORY CHANGED — when the current era
   * began, and what was attached before it.
   *
   * Written by `setConversationRepo` on the same `moved` check that clears the
   * plan, so it cannot drift from what actually counts as a move. It exists
   * because the per-row binding stamp cannot date the rows that were written
   * before it shipped: those rows carry no provenance, and "unknown" was
   * treated as "current", which left a chat that had already switched before
   * the upgrade replaying the old repository's file bodies to the model —
   * precisely the reported symptom, on a chat the fix could not otherwise
   * reach (context/binding-scope.ts).
   *
   * `at` is the era boundary; `from` is the attachment left behind when there
   * was one (`owner/repo@branch`, or null for a chat that had none), which is
   * what the boundary note names.
   */
  bindingMove?: { at: number; from: string | null };
  /**
   * A turn was started but its outcome (reply, error, or abort) is not
   * yet committed to the transcript. Persisted so a page reload can
   * detect the lost in-flight response and resume it.
   */
  /**
   * A turn was started but its outcome (reply, error, or abort) is
   * not yet committed to the transcript. Persisted so a page reload can
   * detect the lost in-flight response and resume it. `outcome` is
   * set when auto-resume was attempted and failed (the explicit
   * Resume affordance takes over).
   */
  pendingTurn?: { startedAt: number; outcome?: "unresumable" };
  /**
   * The agent's living plan for this conversation.
   *
   * It lives on the conversation rather than in the transcript because it
   * is STATE, not a message: the point is that it is visible and current
   * while the turn runs, and that a reload restores it. A plan buried in
   * a chat message is a snapshot of an intention, which is what makes
   * long agent runs feel like a black box.
   */
  plan?: AgentPlan;
  /**
   * The structured question this conversation's turn is parked on, if any
   * (see `ask_user`). Persisted: after a reload the card renders again and
   * the answer resumes the interrupted tool loop.
   */
  pendingQuestion?: AgentQuestion;
  /**
   * Clickable next steps offered by the last turn (`suggest_next`), shown
   * above the composer while the turn is idle. Cleared by the next send.
   */
  suggestions?: AgentSuggestion[];
  /**
   * Messages the user sent mid-turn, waiting for the next round boundary
   * (see QueuedUserMessage). Persisted so a reload does not swallow them.
   */
  queued?: QueuedUserMessage[];
  /**
   * How many files this conversation's workspace has changed, for the
   * conversation list.
   *
   * A SUMMARY of the workspace, kept here because the workspace itself is
   * only in memory for the conversation that is open: without this the chat
   * list cannot say which thread has work in progress, and a list of
   * identical-looking rows is how uncommitted work gets forgotten. Derived at
   * the one choke point that owns workspaces (`setWorkspace`), never edited
   * by hand.
   */
  pendingChanges?: number;
}

/** One step of the agent's plan */
export interface PlanStep {
  id: string;
  text: string;
  status: PlanStatus;
}

export type PlanStatus = "pending" | "active" | "done";

export interface AgentPlan {
  steps: PlanStep[];
  updatedAt: number;
  /** True once every step is done — the UI uses it to collapse, not to hide */
  complete: boolean;
}

/** One selectable answer on an `ask_user` question */
export interface AgentQuestionOption {
  label: string;
  description?: string;
}

/**
 * A structured question the agent is parked on.
 *
 * It lives on the conversation rather than in the transcript because it is
 * STATE, not a message: the turn is still open, the answer resumes it, and a
 * reload has to find the question again exactly where it was. The transcript
 * carries the other half of the pair (the `ask_user` call and, once it
 * exists, its result) so the model sees the exchange as a normal tool round.
 */
export interface AgentQuestion {
  /** Short title for the card, e.g. "Auth strategy" */
  header: string;
  /** One sentence naming the decision and what depends on it */
  question: string;
  options: AgentQuestionOption[];
  /** True when more than one option may be chosen */
  multiSelect?: boolean;
  /** The tool call this question belongs to (pairs it with its result) */
  callId: string;
  askedAt: number;
}

/** What the user chose. Always free text, optionally with options picked. */
export interface AgentQuestionAnswer {
  /** Labels of the options the user picked (empty when they only typed) */
  selected: string[];
  /** The user's own words, when they typed instead of (or as well as) picking */
  note?: string;
  answeredAt: number;
}

/** A clickable next step offered by `suggest_next` */
export interface AgentSuggestion {
  /** Chip text (imperative, a few words) */
  label: string;
  /** The instruction sent when the chip is clicked — self-contained */
  prompt: string;
}

/**
 * A message the user sent while the turn was still running.
 *
 * It is queued rather than dropped (which is what used to happen) or
 * interleaved into the round in flight (which would put a stale instruction
 * in front of a tool result the model has not seen yet). The engine delivers
 * it at the next round boundary, so the model reads it as the next user turn
 * — the same thing it would have been had the user waited.
 */
export interface QueuedUserMessage {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
  queuedAt: number;
}

/** Rolling conversation summary — persisted compaction state */
export interface ConversationSummary {
  /** Prose summary produced by the model (plain text, no markdown headers) */
  text: string;
  /**
   * The thread-on-repository the folded turns were spent on.
   *
   * A summary names files, decisions and failures in plain prose, and it is
   * re-injected into the system prompt on EVERY later turn. Written on
   * repository A and read on B, it tells the model about A's code with the
   * authority of its own memory (context/engine.ts adds the caveat when it
   * differs from the current binding).
   */
  bindingId?: string;
  /** Number of original messages folded into `text` (and prior summaries) */
  coversCount: number;
  /** When this summary was generated */
  createdAt: number;
  /** Model used to generate the summary */
  model?: string;
  /** Estimated tokens the summary replaced */
  freedTokens: number;
}

// ── Agent workspace (virtual working copy) ──────────────────

export type WorkspaceFileStatus = "unchanged" | "modified" | "added" | "deleted";

export interface WorkspaceFile {
  path: string;
  /** Current working content ("" for deleted files) */
  content: string;
  /** Content at the workspace base ("" for added files) */
  baseContent: string;
  /** Blob sha at the base commit (null for added files) */
  baseSha: string | null;
  status: WorkspaceFileStatus;
  updatedAt: number;
}

export interface WorkspaceTreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

/**
 * Per-conversation virtual working copy of the attached repo. The
 * agent edits here freely; GitHub is only written via the gated
 * push_changes flow.
 */
export interface WorkspaceState {
  conversationId: string;
  owner: string;
  repo: string;
  /** Base branch pinned from the attached repo context */
  branch: string;
  /** Head commit sha the workspace was created from */
  baseCommitSha: string;
  /** Remote working branch created for pushes (null until created) */
  workingBranch: string | null;
  /** Repo structure snapshot (paths only; contents load lazily) */
  tree: WorkspaceTreeEntry[];
  /** File contents held locally (read or edited) */
  files: Record<string, WorkspaceFile>;
  /**
   * Agent-mutation effect log (LIFO, capped) — each agent write/
   * delete records its inverse so individual steps can be undone.
   * Present on workspaces created after this shipped; treat as []
   * when absent (older persisted workspaces).
   */
  mutations?: import("./workspace/undo").WorkspaceMutation[];
  /**
   * The REVISION of the working copy: it moves when the code moves.
   *
   * Load-bearing, because the verification ledger reads it as "which
   * version was proven" (lib/verification-ledger.ts). So it may only be
   * stamped by something that changes what the repository would contain —
   * a write, a delete, a revert, an undo — and never by bookkeeping.
   *
   * Reading a file to fix it used to bump this, which made the failing
   * test the agent was about to repair read as "stale, recorded against
   * old code" the moment it looked at the file. That is the exact answer
   * the ledger exists to give correctly: a run against bytes that have
   * not changed is still a run against the current bytes.
   */
  updatedAt: number;
}

export interface WorkspaceChange {
  path: string;
  status: WorkspaceFileStatus;
  additions: number;
  deletions: number;
  /** Unified diff preview (may be truncated) */
  patch: string;
}

/**
 * One agent step's own diff, stored on the step's tool result.
 *
 * The workspace only ever holds the CURRENT file state, so deriving an
 * earlier step's diff from it would show later edits — a step's row
 * must show what that step did, and nothing after it. The patch is
 * truncated because these live in the persisted transcript.
 */
export interface StepChange {
  path: string;
  status: WorkspaceFileStatus;
  additions: number;
  deletions: number;
  /** Unified diff of this step, truncated to TRANSCRIPT_PATCH_MAX_LINES */
  patch: string;
  /** True when the diff was cut short for storage */
  truncated: boolean;
}

/** A push awaiting user approval — shown in the PushApprovalModal */
export interface PendingPush {
  conversationId: string;
  createdAt: number;
  branchName: string;
  baseBranch: string;
  commitMessage: string;
  prTitle: string;
  prBody?: string;
  changes: WorkspaceChange[];
  stats: { files: number; additions: number; deletions: number };
  /**
   * Preflight findings shown as warnings in the approval UI: the base
   * branch moved, a touched file changed upstream, or the token looks
   * read-only. Advisory only — the user still decides.
   */
  warnings?: PushWarning[];
  /**
   * What was actually executed against this workspace revision — the
   * in-browser type check and any real command runs — with their age and
   * whether they still describe this code. Kept separate from the
   * warnings because passing evidence is not a warning.
   */
  verification?: string[];
}

export interface PushWarning {
  kind:
    | "base-moved"
    | "upstream-changed"
    /** Automated push policy: protected paths, oversized change set */
    | "policy"
    /** The agent's summary claims something the turn's evidence does not support */
    | "evidence"
    /** Checks this repository declares that nothing in this workspace can run */
    | "checks";
  message: string;
}

/** The user's decision at the push gate */
export interface PushDecision {
  approved: boolean;
  note?: string;
  /** Whether to open a pull request after the push (default true) */
  openPr?: boolean;
  /**
   * Paths the user unchecked in the approval list. They are removed from
   * this commit only — the workspace keeps the change and its diff, so
   * "not yet" never means "lost". Unknown paths are ignored rather than
   * trusted: a stale modal must not be able to decide what ships.
   */
  excludePaths?: string[];
}

/**
 * An HTTP request that changes something on an external service, awaiting
 * the user's approval — shown in the HttpApprovalModal.
 *
 * This gate exists because the difference between the agent reading an API
 * and the agent writing to one is the difference between research and an
 * irreversible action taken on the user's behalf. The dialog shows the
 * method, the URL, the headers (credential-shaped values masked) and the
 * body, plus the model's own one-line `why`, so the decision is made on a
 * description of the request rather than on the model's confidence about it.
 */
export interface PendingHttpRequest {
  conversationId: string;
  createdAt: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** The model's one line on what this request is meant to accomplish */
  why?: string;
}

/** The user's decision at the HTTP write gate */
export interface HttpApprovalDecision {
  approved: boolean;
  note?: string;
}

/** Result of the approved GitHub push chain */
export interface PushOutcome {
  ok: boolean;
  branchName?: string;
  commitSha?: string;
  prUrl?: string;
  prNumber?: number;
  error?: string;
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
  /**
   * Lowercase keywords indicating the skill applies to a task. Triggers
   * are ADVERTISED in the standing skill index (name + description +
   * triggers) so the model can load the body itself via `read_skill`.
   * They deliberately do NOT change the system prompt per turn: the
   * prompt prefix must stay byte-stable or provider-side prompt caching
   * misses on every turn, which costs real money on long conversations.
   */
  triggers?: string[];
  /** Repo path globs the skill applies to (advertised like triggers) */
  globs?: string[];
}

/** How the user connected GitHub */
/**
 * One configured MCP server. The shape lives here (not in lib/mcp.ts)
 * because it is PERSISTED settings, alongside the GitHub and skill
 * settings it sits next to in the same store.
 */
export interface McpServerConfig {
  id: string;
  name: string;
  /** HTTPS endpoint speaking streamable-HTTP MCP */
  url: string;
  /** Optional bearer token sent as Authorization */
  apiKey?: string;
  enabled?: boolean;
}

export type GitHubAuthMode = "oauth" | "pat";

export interface GitHubSettings {
  /** OAuth access token or fine-grained PAT (encrypted at rest) */
  token: string;
  /** Which flow produced the token */
  mode: GitHubAuthMode | null;
  /** GitHub login of the connected account */
  login: string | null;
  /** Avatar url (shown next to the connected account) */
  avatarUrl: string | null;
  /** When the connection was established */
  connectedAt: number | null;
}

/** Connection status for the settings UI */
export type GitHubConnectionState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; login: string; avatarUrl: string | null; mode: GitHubAuthMode }
  | { status: "error"; message: string };

export interface ChatSettings {
  defaultModel: string;
  /** Model state applied to new chats (each chat remembers its own) */
  defaultReasoningEffort: ReasoningEffort;
  /** Agent mode applied to new chats ("build" unless changed) */
  defaultMode: ChatMode;
  apiKey: string;
  temperature: number;
  systemPrompt: string;
  /** Skill modules — enabled ones are injected into every system prompt */
  skills: ChatSkill[];
  /**
   * Include attached images in Cloud Sync snapshots. Off keeps image
   * payloads local-only (stubbed in snapshots) to stay under quota;
   * text content always syncs.
   */
  syncImageAttachments: boolean;
  /**
   * Connected MCP servers (browser-native streamable HTTP — no local
   * daemon). Their tools are reachable through list_mcp_tools /
   * call_mcp_tool. See lib/mcp.ts.
   */
  mcpServers?: McpServerConfig[];
  /** GitHub OAuth/PAT credentials for agent mode (encrypted at rest) */
  github: GitHubSettings;
  /**
   * When a turn stalls — the model repeats the same FAILING tool call, or
   * the provider refuses the request — continue it on a capably stronger
   * model instead of giving up. Default on; every switch is announced in
   * the transcript and attributed on the reply. See lib/escalation.ts.
   *
   * The one escalation knob that stays a preference, because a switch can
   * spend money on a pricier model: this is consent, not tuning. WHICH
   * model it switches to is the harness's call (the cheapest model the
   * catalog knows to be stronger, within the automatic budget) — asking a
   * user to type a model id to describe their own failure mode was never a
   * choice they were equipped to make.
   */
  autoEscalate?: boolean;
}

/** Reasoning capability metadata advertised by the OpenRouter catalog */
export interface ModelReasoningMetadata {
  /** True when the model always reasons (effort only tunes depth) */
  mandatory?: boolean;
  /** True when reasoning is on by default */
  defaultEnabled?: boolean;
  /** Effort levels the model accepts (e.g. ["max", "high", "low"]) */
  supportedEfforts?: string[];
  /** Effort applied when the request doesn't specify one */
  defaultEffort?: string;
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
  /** Input modalities advertised by the catalog (e.g. ["text","image"]) */
  inputModalities?: string[];
  /** Request parameters the model accepts (e.g. "reasoning_effort") */
  supportedParameters?: string[];
  /** Reasoning capability metadata (supported efforts, defaults) */
  reasoning?: ModelReasoningMetadata;
}

/** OpenAI-compatible content part for multimodal requests */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Wire content: plain text, or parts for multimodal messages */
export type WireContent = string | ContentPart[];

/**
 * OpenAI-style tool definition sent with a request. Parameters use
 * JSON Schema; only function tools are supported.
 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ContextHealth = "optimal" | "moderate" | "near-limit" | "exceeded";

/** What a slice of the window is spent on */
export type ContextPartKey = "system" | "tools" | "memory" | "messages" | "free";

/**
 * One attributed slice of the context window. `free` is the only part
 * that is not spend — it closes the bar out to the usable window.
 */
export interface ContextPart {
  key: ContextPartKey;
  /** Short label for the breakdown list */
  label: string;
  tokens: number;
  /** What this slice actually contains (tooltip / breakdown detail) */
  detail: string;
}

export interface ContextBreakdown {
  /** Tokens of the full stored conversation (estimates + exacts where known) */
  totalTokens: number;
  /** Tokens of what will actually be sent next request */
  sentTokens: number;
  /** Tokens hidden by compaction in the last request */
  compactedTokens: number;
  /** The model's full context window */
  maxTokens: number;
  /**
   * Denominator of `percentageUsed`: the window actually spendable on
   * input (window − output reserve). 100% means compaction is due, not
   * that the window is literally full.
   */
  usableTokens: number;
  /** Tokens held back for the model's own output */
  outputReserve: number;
  percentageUsed: number;
  health: ContextHealth;
  /**
   * Ordered attribution of the window: system → tools → memory →
   * messages → free. Always sums to the full window.
   */
  parts: ContextPart[];
  /**
   * Provider-reported prompt tokens of the most recent reply (exact,
   * null before the first completed turn) — the ground truth the
   * estimates are checked against.
   */
  lastPromptTokens: number | null;
  /** Provider-reported cached prompt tokens of that same request */
  lastCachedTokens: number | null;
  /** Total spend in OpenRouter credits across the conversation */
  totalCost: number;
  /** Completion tokens the conversation has generated so far */
  completionTokens: number;
  /**
   * Spend attributed to the model that ACTUALLY answered, per model (see
   * lib/cost-meter.ts). A harness that routes work to cheaper models —
   * delegation, vision checks, escalation — has to show its work, or the
   * savings are indistinguishable from a billing mistake.
   */
  spend: SpendSummary;
  /**
   * True when the estimator has a learned correction for this model
   * (see context/tokenizer-calibration.ts) — i.e. the numbers shown
   * have already been corrected against real provider counts.
   */
  calibrated: boolean;
}
