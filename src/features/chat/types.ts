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

/** Name of a tool the agent can call (see lib/tools.ts) */
export type ToolName = "list_repo_files" | "read_file" | "search_code" | "get_repo_overview";

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
   * Message produced through the InTab LLM virtual router — the UI
   * displays "InTab LLM" instead of the underlying free model in
   * `model` (which keeps the real id for exports and debugging).
   */
  viaInTab?: boolean;
  /** Present on agent-activity messages: tool calls the model requested */
  toolCalls?: AssistantToolCallsMessage;
  /** Present on agent-activity messages: one tool result (role is "user") */
  toolResult?: ToolResultMessage;
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
  systemPrompt?: string;
  pinned?: boolean;
  /** Rolling LLM summary of the oldest folded messages (compact mode) */
  summary?: ConversationSummary;
  /** GitHub repo attached to this conversation (enables agent tools) */
  repoContext?: RepoContext;
}

/** Rolling conversation summary — persisted compaction state */
export interface ConversationSummary {
  /** Prose summary produced by the model (plain text, no markdown headers) */
  text: string;
  /** Number of original messages folded into `text` (and prior summaries) */
  coversCount: number;
  /** When this summary was generated */
  createdAt: number;
  /** Model used to generate the summary */
  model?: string;
  /** Estimated tokens the summary replaced */
  freedTokens: number;
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

/** How the user connected GitHub */
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
  /** GitHub OAuth/PAT credentials for agent mode (encrypted at rest) */
  github: GitHubSettings;
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
