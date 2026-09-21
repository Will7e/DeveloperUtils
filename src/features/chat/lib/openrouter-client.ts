// ============================================================
// OpenRouter Client — Streaming Chat, Models & Key Validation
// ============================================================
// Direct browser fetch with transparent /api/proxy fallback when
// CORS blocks the direct call. OpenRouter quirks handled:
//  - Usage chunk before [DONE] repeats choices[0].delta (safe here)
//  - Mid-stream errors arrive as data events inside 200 responses
//  - Comment lines keep-alive pings are skipped by the SSE parser

import {
  OPENROUTER_BASE_URL,
  STREAM_FIRST_BYTE_TIMEOUT_MS,
  STREAM_STALL_TIMEOUT_MS,
} from "../constants";
import type { ChatMessage, ModelInfo, ToolCallRequest, ToolDefinition, UsageInfo, WireContent } from "../types";
import { readSseStream } from "./sse";

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    /** Rate-limit headers from 429 responses (reset window learning) */
    public readonly rateLimitHeaders?: Record<string, string>
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/** Map common HTTP status codes to friendly, actionable messages */
function friendlyHttpMessage(status: number, detail?: string): string {
  switch (status) {
    case 401:
      return "Your OpenRouter API key is invalid or expired. Check it in Chat Settings.";
    case 402:
      return "Your OpenRouter account is out of credits. Top up at openrouter.ai/credits.";
    case 403:
      return "This model requires additional permissions on your OpenRouter account.";
    case 404:
      return "Model not found. It may have been deprecated — pick another model.";
    case 429:
      return "Rate limited by OpenRouter. Wait a moment and try again.";
    case 502:
    case 503:
      return "Upstream model provider is temporarily unavailable. Try again shortly.";
    default:
      return detail || `OpenRouter request failed (HTTP ${status}).`;
  }
}

interface RequestOptions {
  apiKey: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Internal: skip the direct attempt and use the proxy immediately */
  forceProxy?: boolean;
}

const PROXY_PREFIX = "/api/proxy?url=";

function buildUrl(path: string, useProxy: boolean): string {
  const url = `${OPENROUTER_BASE_URL}${path}`;
  return useProxy
    ? `${PROXY_PREFIX}${encodeURIComponent(url)}`
    : url;
}

/**
 * Executes a JSON request against OpenRouter, transparently falling
 * back to the app proxy when the direct call fails with a network
 * error (typically CORS in restrictive environments).
 */
async function openRouterFetch(
  path: string,
  { apiKey, body, signal, forceProxy }: RequestOptions
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const init: RequestInit = {
    method: body !== undefined ? "POST" : "GET",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  };

  if (forceProxy) {
    return fetch(buildUrl(path, true), init);
  }

  try {
    return await fetch(buildUrl(path, false), init);
  } catch (err) {
    // Network error (likely CORS) → retry through the app proxy
    if (err instanceof TypeError) {
      return fetch(buildUrl(path, true), init);
    }
    throw err;
  }
}

async function parseErrorResponse(res: Response): Promise<OpenRouterError> {
  let detail: string | undefined;
  try {
    const json = (await res.json()) as {
      error?: { message?: string; code?: number | string };
      message?: string;
    };
    detail = json.error?.message || json.message;
  } catch {
    /* non-JSON error body */
  }
  // Capture rate-limit headers so the router can learn real reset
  // windows instead of guessing fixed cooldowns.
  const rateLimitHeaders: Record<string, string> | undefined =
    res.status === 429
      ? (() => {
          const h: Record<string, string> = {};
          for (const name of [
            "retry-after",
            "x-ratelimit-reset",
            "x-ratelimit-limit-reqs-reset",
            "x-ratelimit-limit-tokens-reset",
          ]) {
            const v = res.headers.get(name);
            if (v) h[name] = v;
          }
          return Object.keys(h).length > 0 ? h : undefined;
        })()
      : undefined;
  return new OpenRouterError(
    friendlyHttpMessage(res.status, detail),
    res.status,
    undefined,
    rateLimitHeaders
  );
}

// ── Stream Chat ─────────────────────────────────────────────

/**
 * Wire content: plain text, or OpenAI-compatible parts for
 * multimodal (text + image) messages. Re-exported from shared types.
 */
export type { WireContent } from "../types";

/**
 * Wire-format message: plain content, or OpenAI tool protocol fields.
 *
 * "tool" is a distinct wire role (the OpenAI tool protocol), which is
 * why it is wider than the stored ChatMessage role union. Assistant
 * rows may carry `tool_calls`; every one of those calls MUST be
 * answered by a `tool` row carrying the same `tool_call_id` — strict
 * providers (OpenAI, Groq, Fireworks, vLLM…) reject the request
 * otherwise.
 */
export interface StreamWireMessage {
  role: ChatMessage["role"] | "tool";
  content: WireContent | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * Serializes one assembled wire message for the request body.
 * Keeps the tool-protocol fields: an assistant turn that requested
 * tools and the `tool` rows answering it are meaningless (and
 * rejected) without them.
 */
export function toWireBodyMessage(m: StreamWireMessage): Record<string, unknown> {
  const body: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls && m.tool_calls.length > 0) body.tool_calls = m.tool_calls;
  if (m.tool_call_id) body.tool_call_id = m.tool_call_id;
  return body;
}

export interface StreamChatParams {
  apiKey: string;
  model: string;
  /** Wire-format messages (tool_calls allowed for agent mode) */
  messages: StreamWireMessage[];
  systemPrompt?: string;
  temperature?: number;
  /** Provider output cap (max_tokens) — protects the context budget */
  maxTokens?: number;
  /** OpenAI-style function tools the model may call (agent mode) */
  tools?: ToolDefinition[];
  /**
   * Ask OpenRouter to return exact usage accounting in the stream
   * tail (prompt/completion/cost). Free for streaming requests.
   */
  requestUsage?: boolean;
  /**
   * Per-request model state merged into the JSON body (e.g.
   * reasoning_effort / reasoning.exclude from the InTab tier).
   * Ignored by models that don't support the keys.
   */
  requestState?: Record<string, unknown>;
  /**
   * Called once per stream with fully-assembled tool calls when the
   * model requested any. Arguments arrive fragmented across chunks;
   * they are reassembled here before the callback fires.
   */
  onToolCalls?: (calls: ToolCallRequest[]) => void;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
  /** Called with reasoning-token deltas (reasoning models) when present */
  onReasoning?: (text: string) => void;
  /** Called once at stream end with the usage frame (when present) */
  onUsage?: (usage: UsageInfo) => void;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      role?: string;
      /** Reasoning-token text (reasoning models via OpenRouter) */
      reasoning?: string | null;
      /** Tool-call fragments (agent mode): id/name/arguments split across chunks */
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  } | null;
  error?: { code?: number | string; message?: string };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/** Reassembles index-keyed tool-call fragments into complete calls */
function assembleToolCalls(acc: Map<number, ToolCallAccumulator>): ToolCallRequest[] {
  const calls: ToolCallRequest[] = [];
  for (const [, entry] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!entry.name) continue; // fragment noise without a function name
    calls.push({
      id: entry.id || `call_${calls.length}`,
      name: entry.name as ToolCallRequest["name"],
      arguments: entry.args || "{}",
    });
  }
  return calls;
}

export async function streamChat({
  apiKey,
  model,
  messages,
  systemPrompt,
  temperature = 0.7,
  maxTokens,
  tools,
  requestUsage,
  requestState,
  onToolCalls,
  signal,
  onChunk,
  onReasoning,
  onUsage,
}: StreamChatParams): Promise<void> {
  if (!apiKey.trim()) {
    throw new OpenRouterError(
      "An OpenRouter API key is required. Add yours in Chat Settings.",
      401
    );
  }

  const payload: Record<string, unknown> = {
    model,
    stream: true,
    temperature,
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    // Exact usage in the stream tail — feeds token calibration
    ...(requestUsage ? { usage: { include: true } } : {}),
    // Per-request state (InTab tier: reasoning effort/exclusion) —
    // merged last so it can carry nested objects like `reasoning`.
    ...requestState,
    messages: [
      ...(systemPrompt?.trim()
        ? [{ role: "system", content: systemPrompt.trim() }]
        : []),
      ...messages.map(toWireBodyMessage),
    ],
  };

  // Watchdogs: the user signal plus internal timers that abort when
  // the response never starts or the stream stalls between chunks.
  const watchdog = new AbortController();
  let firstByteTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const clearTimers = () => {
    if (firstByteTimer !== null) clearTimeout(firstByteTimer);
    if (stallTimer !== null) clearTimeout(stallTimer);
    firstByteTimer = null;
    stallTimer = null;
  };

  const armFirstByte = () => {
    firstByteTimer = setTimeout(() => {
      timedOut = true;
      watchdog.abort();
    }, STREAM_FIRST_BYTE_TIMEOUT_MS);
  };

  const armStall = () => {
    clearTimers();
    stallTimer = setTimeout(() => {
      timedOut = true;
      watchdog.abort();
    }, STREAM_STALL_TIMEOUT_MS);
  };

  // Combine the user signal with the watchdog controller
  const onUserAbort = () => watchdog.abort();
  signal?.addEventListener("abort", onUserAbort);

  armFirstByte();

  let response: Response;
  try {
    response = await openRouterFetch("/chat/completions", {
      apiKey,
      body: payload,
      signal: watchdog.signal,
    });
    // Headers arrived — switch from first-byte to stall timing until
    // the body reader starts delivering chunks.
    armStall();
  } catch (err) {
    clearTimers();
    signal?.removeEventListener("abort", onUserAbort);
    if (timedOut) {
      throw new OpenRouterError(
        "The model took too long to respond. Please try again.",
        0
      );
    }
    if (err instanceof DOMException && err.name === "AbortError" && signal?.aborted) {
      throw err; // user abort propagates unchanged
    }
    throw new OpenRouterError(
      "Could not reach OpenRouter. Check your connection and try again.",
      0
    );
  }

  if (!response.ok) {
    clearTimers();
    signal?.removeEventListener("abort", onUserAbort);
    throw await parseErrorResponse(response);
  }

  let sawError = false;
  let gotUsage = false;
  let anyContent = false;

  // Agent mode: accumulate index-keyed tool-call fragments until the
  // stream ends, then fire onToolCalls once with complete requests.
  const toolAcc = new Map<number, ToolCallAccumulator>();

  try {
    await readSseStream(response, {
    onRawChunk: () => {
      // Any bytes reset the stall timer (keep-alives count)
      armStall();
    },
    onEvent: (data) => {
      if (data === "[DONE]") return;
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(data) as ChatCompletionChunk;
      } catch {
        return; // Ignore malformed frames
      }

      if (chunk.error) {
        sawError = true;
        throw new OpenRouterError(
          chunk.error.message || "The model stream failed mid-generation.",
          200,
          String(chunk.error.code ?? "")
        );
      }

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        anyContent = true;
        onChunk(delta.content);
      }
      if (delta?.reasoning) {
        onReasoning?.(delta.reasoning);
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let entry = toolAcc.get(idx);
          if (!entry) {
            entry = { id: tc.id ?? `call_${idx}`, name: "", args: "" };
            toolAcc.set(idx, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
        }
      }

      if (chunk.usage) {
        gotUsage = true;
        onUsage?.({
          promptTokens: chunk.usage.prompt_tokens ?? null,
          completionTokens: chunk.usage.completion_tokens ?? null,
          cost: typeof chunk.usage.cost === "number" ? chunk.usage.cost : null,
        });
      }
    },
    });
  } catch (err) {
    // Watchdog fired mid-stream: the provider stopped sending bytes.
    if (timedOut) {
      throw new OpenRouterError(
        "The model stream stalled and was interrupted. Partial output was kept.",
        0
      );
    }
    throw err;
  } finally {
    clearTimers();
    signal?.removeEventListener("abort", onUserAbort);
  }

  // Fire once with fully-assembled tool calls (agent mode)
  const assembledCalls = assembleToolCalls(toolAcc);
  if (assembledCalls.length > 0) onToolCalls?.(assembledCalls);

  // A 200 stream that errors before producing any content is a failure
  // (tool calls alone count as a productive stream)
  if (sawError || (!anyContent && !gotUsage && assembledCalls.length === 0 && !signal?.aborted)) {
    if (!signal?.aborted) {
      throw new OpenRouterError(
        "The model returned an empty response. Try again or switch models.",
        200
      );
    }
  }
}

// ── Non-Streaming Completion (summaries, titles, utilities) ─

export interface CompleteChatParams {
  apiKey: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
  temperature?: number;
  maxTokens?: number;
  /** Per-request model state merged into the JSON body (tier state) */
  requestState?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CompleteChatResult {
  content: string;
  usage: UsageInfo | null;
}

/**
 * One-shot (non-streaming) chat completion. Same auth/proxy plumbing
 * as streamChat but reads a plain JSON body — used for background
 * work like history summarization where streaming adds nothing.
 */
export async function completeChat({
  apiKey,
  model,
  messages,
  temperature = 0,
  maxTokens,
  requestState,
  signal,
}: CompleteChatParams): Promise<CompleteChatResult> {
  if (!apiKey.trim()) {
    throw new OpenRouterError(
      "An OpenRouter API key is required. Add yours in Chat Settings.",
      401
    );
  }

  const payload: Record<string, unknown> = {
    model,
    stream: false,
    temperature,
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(requestState ?? {}),
    messages,
  };

  let response: Response;
  try {
    response = await openRouterFetch("/chat/completions", {
      apiKey,
      body: payload,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new OpenRouterError(
      "Could not reach OpenRouter. Check your connection and try again.",
      0
    );
  }

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  let json: {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
    };
    error?: { message?: string; code?: number | string };
  };
  try {
    json = (await response.json()) as typeof json;
  } catch {
    throw new OpenRouterError("OpenRouter returned an unreadable response.", 200);
  }

  if (json.error) {
    throw new OpenRouterError(
      json.error.message || "The completion request failed.",
      200,
      String(json.error.code ?? "")
    );
  }

  const content = json.choices?.[0]?.message?.content ?? "";
  const u = json.usage;
  return {
    content,
    usage: u
      ? {
          promptTokens: u.prompt_tokens ?? null,
          completionTokens: u.completion_tokens ?? null,
          cost: typeof u.cost === "number" ? u.cost : null,
        }
      : null,
  };
}

// ── Non-Streaming Completion WITH Tools (delegation) ────────

/**
 * Wire message accepted by the tool-calling completion below: the same
 * OpenAI tool protocol as the streaming path (assistant rows may carry
 * `tool_calls`, `tool` rows answer them by id).
 */
export type ToolWireMessage = StreamWireMessage;

export interface CompleteChatWithToolsParams {
  apiKey: string;
  model: string;
  messages: ToolWireMessage[];
  /** Model-facing instructions for this nested agent */
  systemPrompt?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Per-request state merged into the body (reasoning effort, etc.) */
  requestState?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CompleteChatWithToolsResult {
  content: string;
  /** Fully-assembled tool calls, empty when the model answered directly */
  toolCalls: ToolCallRequest[];
  usage: UsageInfo | null;
}

/**
 * One non-streaming completion that may return tool calls.
 *
 * Delegation needs this shape and streaming cannot provide it: a nested
 * helper agent's output is a report for the parent, not something a
 * human watches arrive token by token. Non-streaming also means one
 * request per round instead of a stream teardown per round, which is
 * what makes a nested loop cheap enough to be worth having.
 */
export async function completeChatWithTools({
  apiKey,
  model,
  messages,
  systemPrompt,
  tools,
  temperature = 0.2,
  maxTokens,
  requestState,
  signal,
}: CompleteChatWithToolsParams): Promise<CompleteChatWithToolsResult> {
  if (!apiKey.trim()) {
    throw new OpenRouterError(
      "An OpenRouter API key is required. Add yours in Chat Settings.",
      401
    );
  }

  const payload: Record<string, unknown> = {
    model,
    stream: false,
    temperature,
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    ...(requestState ?? {}),
    messages: [
      ...(systemPrompt?.trim()
        ? [{ role: "system", content: systemPrompt.trim() }]
        : []),
      ...messages.map(toWireBodyMessage),
    ],
  };

  let response: Response;
  try {
    response = await openRouterFetch("/chat/completions", {
      apiKey,
      body: payload,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new OpenRouterError(
      "Could not reach OpenRouter. Check your connection and try again.",
      0
    );
  }

  if (!response.ok) throw await parseErrorResponse(response);

  let json: {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string; code?: number | string };
  };
  try {
    json = (await response.json()) as typeof json;
  } catch {
    throw new OpenRouterError("OpenRouter returned an unreadable response.", 200);
  }

  if (json.error) {
    throw new OpenRouterError(
      json.error.message || "The completion request failed.",
      200,
      String(json.error.code ?? "")
    );
  }

  const message = json.choices?.[0]?.message;
  const toolCalls: ToolCallRequest[] = (message?.tool_calls ?? [])
    .filter((tc) => typeof tc.function?.name === "string" && tc.function.name)
    .map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.function!.name as ToolCallRequest["name"],
      arguments: tc.function!.arguments || "{}",
    }));

  const u = json.usage;
  return {
    content: message?.content ?? "",
    toolCalls,
    usage: u
      ? {
          promptTokens: u.prompt_tokens ?? null,
          completionTokens: u.completion_tokens ?? null,
          cost: typeof u.cost === "number" ? u.cost : null,
        }
      : null,
  };
}

// ── Models Catalog ──────────────────────────────────────────

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
  } | null;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  /** Request parameters the model accepts ("reasoning_effort", …) */
  supported_parameters?: string[];
  /** Reasoning capability metadata (efforts, defaults) */
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[];
    default_effort?: string;
  } | null;
}

function toModelInfo(m: OpenRouterModel): ModelInfo {
  const promptPrice = m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1_000_000 : undefined;
  const completionPrice = m.pricing?.completion
    ? parseFloat(m.pricing.completion) * 1_000_000
    : undefined;
  const isFree =
    (promptPrice !== undefined && promptPrice === 0) ||
    m.id.endsWith(":free");
  const modalities = m.architecture?.input_modalities?.filter(Boolean);
  const supportedParameters =
    Array.isArray(m.supported_parameters) && m.supported_parameters.length > 0
      ? m.supported_parameters
      : undefined;
  const reasoningMeta =
    m.reasoning && typeof m.reasoning === "object"
      ? {
          mandatory: m.reasoning.mandatory === true,
          defaultEnabled: m.reasoning.default_enabled === true,
          supportedEfforts:
            Array.isArray(m.reasoning.supported_efforts) && m.reasoning.supported_efforts.length > 0
              ? m.reasoning.supported_efforts
              : undefined,
          defaultEffort:
            typeof m.reasoning.default_effort === "string" ? m.reasoning.default_effort : undefined,
        }
      : undefined;

  return {
    id: m.id,
    name: m.name || m.id,
    contextLength: m.context_length,
    promptPrice: Number.isFinite(promptPrice) ? promptPrice : undefined,
    completionPrice: Number.isFinite(completionPrice) ? completionPrice : undefined,
    isFree,
    inputModalities: modalities && modalities.length > 0 ? modalities : undefined,
    supportedParameters,
    reasoning: reasoningMeta,
  };
}

/** Model list cache (1 hour TTL) — avoids refetching the large catalog */
let modelsCache: { models: ModelInfo[]; at: number } | null = null;
const MODELS_CACHE_TTL = 60 * 60 * 1000;

export async function listModels(apiKey: string): Promise<ModelInfo[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_TTL) {
    return modelsCache.models;
  }

  const res = await openRouterFetch("/models", { apiKey });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  const json = (await res.json()) as { data?: OpenRouterModel[] };
  const models = (json.data ?? []).map(toModelInfo);
  if (models.length > 0) {
    modelsCache = { models, at: Date.now() };
  }
  return models;
}

// ── Key Validation ──────────────────────────────────────────

export interface KeyCheckResult {
  valid: boolean;
  message: string;
  /** Remaining credits in USD (when available) */
  usageRemaining?: number;
  usageLimit?: number | null;
}

export async function checkKey(apiKey: string): Promise<KeyCheckResult> {
  if (!apiKey.trim()) {
    return { valid: false, message: "Enter an API key first." };
  }

  try {
    const res = await openRouterFetch("/key", { apiKey });
    if (res.status === 401) {
      return { valid: false, message: "Key is invalid or was revoked." };
    }
    if (!res.ok) {
      return {
        valid: false,
        message: `Could not validate the key (HTTP ${res.status}).`,
      };
    }

    const json = (await res.json()) as {
      data?: {
        usage?: number;
        limit?: number | null;
        is_free_tier?: boolean;
      };
    };

    const data = json.data;
    const usageRemaining =
      data && typeof data.limit === "number" ? data.limit - (data.usage ?? 0) : undefined;

    return {
      valid: true,
      message: "Key is valid.",
      usageRemaining,
      usageLimit: data?.limit ?? null,
    };
  } catch {
    return {
      valid: false,
      message: "Network error — could not reach OpenRouter.",
    };
  }
}
