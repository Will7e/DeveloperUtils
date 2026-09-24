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
import type {
  ChatMessage,
  ModelEndpointInfo,
  ModelInfo,
  ModelPriceOverride,
  ToolCallRequest,
  ToolDefinition,
  UsageInfo,
  WireContent,
} from "../types";
import {
  parseBenchmarkRows,
  type BenchmarkRow,
  type BenchmarksPayload,
} from "./model-benchmarks";
import {
  parseEndpointRecords,
  type EndpointsPayload,
} from "./model-endpoints";
import { providerRouting } from "./provider-routing";
import { classifyOpenRouterError,
  retryDelayMs,
  type OpenRouterFailure,
} from "./openrouter-error-taxonomy";
import { readSseStream } from "./sse";

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    /** Rate-limit headers from 429 responses (reset window learning) */
    public readonly rateLimitHeaders?: Record<string, string>,
    /**
     * The classified cause behind this failure, when there was one.
     *
     * Callers branch on `failure.kind` rather than on `status`, because a
     * status alone is ambiguous: 402 is both "out of credits" and "in-flight
     * budget full", and 403 is both "no permission" and "a guardrail blocked
     * your words". The message is derived from this, so reading it is reading
     * the reason the sentence says what it says.
     */
    public readonly failure?: OpenRouterFailure
  ) {
    super(message);
    this.name = "OpenRouterError";
  }

  /** Seconds to wait before retrying, when the response asked for a wait */
  get retryAfterSeconds(): number | undefined {
    return this.failure?.retryAfterSeconds;
  }
}

interface RequestOptions {
  apiKey: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Internal: skip the direct attempt and use the proxy immediately */
  forceProxy?: boolean;
  /**
   * Extra request headers, merged over the defaults.
   *
   * Needed because OpenRouter's browser CORS policy is not uniform across its
   * own headers: `X-Session-Id` is an allowed request header and can be sent
   * directly, while `X-OpenRouter-Metadata` and the response-cache header are
   * not — those must ride `/api/proxy`. So the caller decides, per header,
   * whether the request goes direct or through the proxy.
   */
  extraHeaders?: Record<string, string>;
}

// ── Response metadata ───────────────────────────────────────

/** What the RESPONSE headers say about who served the request. */
export interface ResponseMeta {
  /** Which upstream provider answered (`X-Provider-Name`) */
  providerName?: string;
  /** OpenRouter response-cache verdict, when the header was readable */
  cacheStatus?: string;
}

/**
 * Reads the response headers the app used to throw away.
 *
 * Until now every call site consumed only `res.status` and `res.json()`, so
 * `X-Provider-Name` — the one header that answers "which provider actually
 * served this?" — never reached the UI. That is the difference between
 * debugging a bad answer and guessing at it, so it is captured for every
 * response instead of on demand.
 *
 * Only `X-Provider-Name` is reachable on a direct call (the browser exposes
 * it); the cache headers are proxy-only, hence the tolerant lookup here.
 */
export function readResponseMeta(res: Response): ResponseMeta {
  const providerName = res.headers.get("x-provider-name")?.trim();
  let cacheStatus: string | undefined;
  for (const name of [
    "x-openrouter-cache-status",
    "x-openrouter-cache",
    "x-cache-status",
  ]) {
    const v = res.headers.get(name)?.trim();
    if (v) {
      cacheStatus = v;
      break;
    }
  }
  return {
    ...(providerName ? { providerName } : {}),
    ...(cacheStatus ? { cacheStatus } : {}),
  };
}

const PROXY_PREFIX = "/api/proxy?url=";

function buildUrl(path: string, useProxy: boolean): string {
  const url = `${OPENROUTER_BASE_URL}${path}`;
  return useProxy
    ? `${PROXY_PREFIX}${encodeURIComponent(url)}`
    : url;
}

/**
 * Who is making this request.
 *
 * OpenRouter attributes traffic by these two headers: `X-Title` names the app
 * and `HTTP-Referer` is its origin (`Referer` itself is a forbidden header name
 * in browsers, which is why the `HTTP-` prefixed spelling exists). They are
 * free to send and they are on the browser's allowed request-header list —
 * checked against the live preflight, not assumed — so attribution does NOT
 * cost a proxy hop the way `X-OpenRouter-Metadata` would. Without them the
 * app's traffic is anonymous in OpenRouter's own dashboards, which is the one
 * view that shows how this app's routing behaves in the wild.
 */
const ATTRIBUTION_HEADERS: Record<string, string> = {
  "X-Title": "InTab",
  "HTTP-Referer": "https://github.com/intab/intab",
};

/**
 * Executes a JSON request against OpenRouter, transparently falling
 * back to the app proxy when the direct call fails with a network
 * error (typically CORS in restrictive environments).
 */
async function openRouterFetch(
  path: string,
  { apiKey, body, signal, forceProxy, extraHeaders }: RequestOptions
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...ATTRIBUTION_HEADERS,
    // Caller headers come last so a caller can override either one.
    ...extraHeaders,
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
  // The full parsed body is handed to the classifier rather than a pre-digested
  // message: 402 and 403 each hide three different causes in `metadata`, and
  // flattening to a string first is exactly how those causes got lost.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }

  // Retry-After is sent on 429, on 503, and on the in-flight-budget 402 — the
  // three cases where waiting is the documented remedy. It used to be captured
  // only on 429, so the two cases where the wait matters most were dropped.
  const retryAfterHeader = res.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null;

  const rateLimitHeaders: Record<string, string> | undefined = (() => {
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
  })();

  const failure = classifyOpenRouterError({
    status: res.status,
    body,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
    ...(rateLimitHeaders ? { rateLimitHeaders } : {}),
  });

  return new OpenRouterError(failure.message, res.status, undefined, rateLimitHeaders, failure);
}

/**
 * Retries a request whose failure the taxonomy calls transient.
 *
 * The gateway pushes the retry policy to the client instead of documenting a
 * fixed backoff: `Retry-After` on 429/503, and the same header on the
 * in-flight-budget 402. Retrying without it turns a momentary rate limit into
 * a sustained one, and not retrying at all — the old behaviour — surfaced a
 * recoverable hiccup to the user as a failed turn.
 */
async function fetchWithRetry(
  attempt: () => Promise<Response>,
  {
    signal,
    maxRetries = 1,
    beforeAttempt,
    onRetry,
  }: {
    signal?: AbortSignal;
    maxRetries?: number;
    /** Re-arms the caller's watchdog, so a retry is not mistaken for a stall */
    beforeAttempt?: () => void;
    onRetry?: (failure: OpenRouterFailure, attemptNumber: number, delayMs: number) => void;
  }
): Promise<{ response?: Response; error?: OpenRouterError }> {
  let lastError: OpenRouterError | undefined;

  for (let tries = 0; tries <= maxRetries; tries++) {
    if (signal?.aborted) break;
    if (tries > 0) beforeAttempt?.();

    try {
      const res = await attempt();
      if (res.ok) return { response: res };
      const error = await parseErrorResponse(res);
      lastError = error;
      if (!error.failure?.retryable) return { error };
    } catch (err) {
      // A transport failure (CORS, DNS, offline) is retryable by definition —
      // there is no status to classify, and the proxy fallback already ran.
      if (err instanceof OpenRouterError) return { error: err };
      lastError = new OpenRouterError(
        "Could not reach OpenRouter. Check your connection and try again.",
        0,
        undefined,
        undefined,
        classifyOpenRouterError({ status: 0 })
      );
    }

    if (tries === maxRetries) break;
    const failure = lastError?.failure;
    if (!failure || !failure.retryable) break;
    const delayMs = retryDelayMs(failure);
    onRetry?.(failure, tries + 1, delayMs);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return { error: lastError };
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
  /**
   * Reasoning blocks from this assistant turn, replayed verbatim.
   *
   * Must be sent back whole and in original order, on the assistant message
   * that produced them. Providers that interleave thinking with tool calls
   * (Anthropic especially) use these to continue the chain of thought across
   * rounds; without them each tool round starts reasoning from scratch, and
   * some providers reject the request outright.
   */
  reasoning_details?: unknown[];
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
  // Omitted when absent rather than sent as []: an empty array still tells a
  // strict provider "this turn had structured reasoning", which is a different
  // claim from "no structured reasoning".
  if (m.reasoning_details && m.reasoning_details.length > 0) {
    body.reasoning_details = m.reasoning_details;
  }
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
  /**
   * Cached-conversation session id (`X-Session-Id`).
   *
   * One value per conversation, stable for its lifetime. It buys two things:
   * sticky provider routing (the same provider answers, so its prompt cache is
   * warm) and OpenRouter's own cache affinity. Sending a NEW id per request is
   * worse than sending none — it fragments the cache instead of sharing it.
   */
  sessionId?: string;
  /**
   * Stops discarding the response headers. `X-Provider-Name` arrives here.
   */
  onResponseMeta?: (meta: ResponseMeta) => void;
  /**
   * The model that ACTUALLY answered, as named by the stream.
   *
   * With `failoverModels` the gateway may serve a different model than the one
   * asked for, so the caller can no longer assume its requested id is the one
   * that wrote the reply. Fired at most once, on the first frame that names one.
   */
  onServedModel?: (modelId: string) => void;
  /**
   * In-request failover: if the chosen provider rejects the request, OpenRouter
   * tries these models in order *within the same request*. Unlike a client-side
   * retry, a failover does not create a second billed round for the part that
   * already succeeded, and it does not lose the turn.
   */
  failoverModels?: string[];
  /**
   * Extra request headers. `X-OpenRouter-Metadata` (attribution) belongs here,
   * and sending it forces the request through the proxy on its own, since the
   * browser's CORS policy does not allow that header on a direct call.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Reports a transient failure that is about to be retried, with the delay the
   * gateway asked for. Lets the UI say "provider busy — retrying in 8s" instead
   * of looking hung for the length of the backoff.
   */
  onRetry?: (failure: OpenRouterFailure, attemptNumber: number, delayMs: number) => void;
  /**
   * Reassembled reasoning blocks, for echo-back on the next request.
   *
   * Reasoning models that interleave thinking with tool calls require the
   * previous turn's `reasoning_details` back, whole and in order; dropping them
   * ends the chain of thought across tool rounds. Captured here, stored on the
   * assistant message, replayed by `toWireBodyMessage`.
   */
  onReasoningDetails?: (details: unknown[]) => void;
}

/**
 * Merges streamed `reasoning_details` fragments.
 *
 * A block arrives as whole objects on some providers and as index-keyed
 * fragments on others, so text-bearing fields are concatenated when the same
 * index and type repeat rather than replacing the block. NOTE: unlike the
 * error envelopes, this shape is not covered by a captured fixture — it needs
 * a paid reasoning round to observe — so the merge is deliberately additive and
 * loses nothing when a provider sends whole blocks.
 */
function mergeReasoningDetails(existing: unknown[], incoming: unknown[]): unknown[] {
  const out = [...existing];
  for (const block of incoming) {
    if (!block || typeof block !== "object") {
      out.push(block);
      continue;
    }
    const b = block as Record<string, unknown>;
    const idx = typeof b.index === "number" ? b.index : undefined;
    const priorIdx =
      idx === undefined
        ? -1
        : out.findIndex(
            (o) =>
              o &&
              typeof o === "object" &&
              (o as Record<string, unknown>).index === idx &&
              (o as Record<string, unknown>).type === b.type
          );
    if (priorIdx === -1) {
      out.push(block);
      continue;
    }
    const prior = { ...(out[priorIdx] as Record<string, unknown>) };
    for (const [key, value] of Object.entries(b)) {
      const prev = prior[key];
      prior[key] =
        typeof prev === "string" && typeof value === "string" ? prev + value : value;
    }
    out[priorIdx] = prior;
  }
  return out;
}

interface ChatCompletionChunk {
  /** The model that actually served this stream (may differ under failover) */
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      role?: string;
      /** Reasoning-token text (reasoning models via OpenRouter) */
      reasoning?: string | null;
      /** Structured reasoning blocks, for echo-back (see mergeReasoningDetails) */
      reasoning_details?: unknown[] | null;
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
    /** Cache accounting: how many prompt tokens were served from cache */
    prompt_tokens_details?: { cached_tokens?: number } | null;
    /**
     * Reasoning tokens billed as output. Compared against completion_tokens to
     * detect starvation: a model that spends its whole output budget thinking
     * returns an empty answer and a 200 status, with nothing in the response
     * explaining why.
     */
    completion_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
  /** Provider attribution, when the response is a router failure frame */
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
  sessionId,
  onResponseMeta,
  onServedModel,
  failoverModels,
  extraHeaders,
  onRetry,
  onReasoningDetails,
}: StreamChatParams): Promise<void> {
  if (!apiKey.trim()) {
    throw new OpenRouterError(
      "An OpenRouter API key is required. Add yours in Chat Settings.",
      401,
      undefined,
      undefined,
      classifyOpenRouterError({ status: 401 })
    );
  }

  const carriesTools = Boolean(tools && tools.length > 0);
  const routing = providerRouting({ carriesTools });
  const payload: Record<string, unknown> = {
    model,
    stream: true,
    temperature,
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    // In-request failover: a list, not a retry. OpenRouter walks it inside the
    // same request, so the provider rejecting the *body* (a tool-schema
    // mismatch, a max_tokens above the provider's ceiling) is handled without
    // spending a second round or dropping the user's turn.
    ...(failoverModels && failoverModels.length > 0
      ? { models: [model, ...failoverModels.filter((m) => m !== model)] }
      : {}),
    ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    // What the request REQUIRES of the routing. Without this a provider that
    // cannot honour the tool schemas answers anyway, in prose, and the turn
    // looks like a model choosing not to act. See lib/provider-routing.ts.
    ...(routing ? { provider: routing } : {}),
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

  // `X-Session-Id` goes direct: the probe found it on the browser's allowed
  // request-header list, so conversation affinity costs no proxy hop.
  const requestHeaders: Record<string, string> = {
    ...(sessionId ? { "X-Session-Id": sessionId } : {}),
    ...extraHeaders,
  };

  let responseMeta: ResponseMeta = {};
  const attempt = await fetchWithRetry(
    () =>
      openRouterFetch("/chat/completions", {
        apiKey,
        body: payload,
        signal: watchdog.signal,
        ...(Object.keys(requestHeaders).length > 0 ? { extraHeaders: requestHeaders } : {}),
      }),
    {
      signal: watchdog.signal,
      maxRetries: 1,
      // A retry restarts the clock: the first-byte budget is for waiting on a
      // provider, not for the backoff the gateway asked us to observe.
      beforeAttempt: () => {
        if (firstByteTimer !== null) clearTimeout(firstByteTimer);
        armFirstByte();
      },
      ...(onRetry ? { onRetry } : {}),
    }
  );

  if (attempt.error || !attempt.response) {
    clearTimers();
    signal?.removeEventListener("abort", onUserAbort);
    if (timedOut) {
      throw new OpenRouterError(
        "The model took too long to respond. Please try again.",
        0,
        undefined,
        undefined,
        classifyOpenRouterError({ status: 408 })
      );
    }
    if (signal?.aborted) {
      throw new DOMException("The user aborted the request", "AbortError");
    }
    throw attempt.error ?? new OpenRouterError("Could not reach OpenRouter.", 0);
  }

  // Assigned once, after the failure guard: the retry helper returns the
  // response rather than assigning into a variable declared out here, which is
  // what made the old shape need a `let` (and a definite-assignment dance).
  const response = attempt.response;
  // Headers arrived — switch from first-byte to stall timing until
  // the body reader starts delivering chunks, and hand the caller the
  // attribution the response used to discard.
  armStall();
  responseMeta = readResponseMeta(response);
  if (Object.keys(responseMeta).length > 0) onResponseMeta?.(responseMeta);

  let sawError = false;
  let gotUsage = false;
  let anyContent = false;
  let servedModel: string | null = null;
  /** Reasoning tokens billed on the final frame, for starvation detection */
  let reasoningTokens: number | null = null;
  let completionTokens: number | null = null;
  /** Structured reasoning blocks, echoed back on the next request */
  let reasoningDetails: unknown[] = [];

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
        // A mid-stream failure frame carries the same structured metadata a
        // non-200 body does (`error_type`, `provider_code`), so it gets the
        // same classifier instead of becoming a bare string with status 200.
        const failure = classifyOpenRouterError({
          status: typeof chunk.error.code === "number" ? chunk.error.code : 503,
          body: { error: chunk.error },
        });
        throw new OpenRouterError(
          chunk.error.message || failure.message,
          200,
          String(chunk.error.code ?? ""),
          undefined,
          { ...failure, message: chunk.error.message || failure.message }
        );
      }

      // Attribution before anything else: the FIRST frame that names a model is
      // the one that answered, and it must be recorded before an error frame can
      // end the stream.
      if (chunk.model && servedModel === null) {
        servedModel = chunk.model;
        onServedModel?.(chunk.model);
      }

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        anyContent = true;
        onChunk(delta.content);
      }
      if (delta?.reasoning) {
        onReasoning?.(delta.reasoning);
      }
      if (delta?.reasoning_details && Array.isArray(delta.reasoning_details)) {
        reasoningDetails = mergeReasoningDetails(reasoningDetails, delta.reasoning_details);
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
        completionTokens = chunk.usage.completion_tokens ?? null;
        reasoningTokens =
          chunk.usage.completion_tokens_details?.reasoning_tokens ?? null;
        onUsage?.({
          promptTokens: chunk.usage.prompt_tokens ?? null,
          completionTokens,
          cost: typeof chunk.usage.cost === "number" ? chunk.usage.cost : null,
          cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? null,
          reasoningTokens,
          ...(responseMeta.providerName ? { providerName: responseMeta.providerName } : {}),
          ...(responseMeta.cacheStatus ? { cacheStatus: responseMeta.cacheStatus } : {}),
        });
      }
    },
    });
  } catch (err) {
    // Watchdog fired mid-stream: the provider stopped sending bytes.
    if (timedOut) {
      throw new OpenRouterError(
        "The model stream stalled and was interrupted. Partial output was kept.",
        0,
        undefined,
        undefined,
        { kind: "provider-down", message: "Stream stalled", status: 0, retryable: true }
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

  if (reasoningDetails.length > 0) onReasoningDetails?.(reasoningDetails);

  // A 200 stream that errors before producing any content is a failure
  // (tool calls alone count as a productive stream)
  if (sawError || (!anyContent && !gotUsage && assembledCalls.length === 0 && !signal?.aborted)) {
    if (!signal?.aborted) {
      throw new OpenRouterError(
        "The model returned an empty response. Try again or switch models.",
        200
      );
    }
    return;
  }

  // ── Reasoning starvation ──
  // A 200 with no content and no tool calls, where the output budget went to
  // reasoning tokens, is not an "empty response" from the model — it is the
  // model thinking until it ran out of room. The two need different fixes (raise
  // the cap vs. change the model), and without this check they were the same
  // unhelpful sentence. Detected from usage rather than guessed from the clock.
  if (
    !anyContent &&
    assembledCalls.length === 0 &&
    !signal?.aborted &&
    reasoningTokens !== null &&
    reasoningTokens > 0 &&
    (completionTokens === null || reasoningTokens >= completionTokens * 0.95)
  ) {
    throw new OpenRouterError(
      `The model spent its entire output budget thinking (${reasoningTokens} reasoning tokens, nothing left to answer with). Raise the max-token limit, lower the reasoning effort, or switch to a model that thinks less.`,
      200,
      "reasoning_starvation"
    );
  }
}

// ── Non-Streaming Completion (summaries, titles, utilities) ─

export interface CompleteChatParams {
  apiKey: string;
  model: string;
  /**
   * `content` is a string for text-only turns, or content parts when the
   * request carries an image (visual verification). Only the user role
   * may send parts — the OpenAI protocol has no image in a tool row,
   * which is exactly why a picture is described by a vision model whose
   * TEXT answer becomes the tool result.
   */
  messages: Array<{ role: "system" | "user" | "assistant"; content: string | CompletionContentPart[] }>
  temperature?: number;
  maxTokens?: number;
  /** Per-request model state merged into the JSON body (tier state) */
  requestState?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** One piece of a multimodal message (text or an inline/remote image) */
export type CompletionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

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
      prompt_tokens_details?: { cached_tokens?: number } | null;
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
          cachedTokens: u.prompt_tokens_details?.cached_tokens ?? null,
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
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
      prompt_tokens_details?: { cached_tokens?: number } | null;
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
          cachedTokens: u.prompt_tokens_details?.cached_tokens ?? null,
        }
      : null,
  };
}

// ── Models Catalog ──────────────────────────────────────────

interface OpenRouterModel {
  id: string;
  name?: string;
  /** Publisher's id, usually with the date suffix `id` omits */
  canonical_slug?: string;
  context_length?: number;
  /** ISO date the model is retired */
  expiration_date?: string | null;
  architecture?: {
    input_modalities?: string[];
  } | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    /** Per-token prices for cache reads/writes */
    input_cache_read?: string;
    input_cache_write?: string;
    /** Tiered rates that replace the base ones above a threshold */
    overrides?: Array<{
      min_prompt_tokens?: number;
      prompt?: string;
      completion?: string;
      input_cache_read?: string;
      input_cache_write?: string;
    }>;
  };
  /** Request parameters the model accepts ("reasoning_effort", …) */
  supported_parameters?: string[];
  /** Reasoning capability metadata (efforts, defaults) */
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[];
    default_effort?: string;
    /**
     * When true, offer a max-tokens reasoning budget instead of an effort
     * ladder. Live on only 11 of 459 models, so it stays opt-in rather than
     * driving the control's shape.
     */
    supports_max_tokens?: boolean;
  } | null;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  } | null;
}

/** Per-token string price → USD per 1M tokens, or undefined when unusable */
function perMillion(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = parseFloat(value) * 1_000_000;
  return Number.isFinite(n) ? n : undefined;
}

function toModelInfo(m: OpenRouterModel): ModelInfo {
  const promptPrice = perMillion(m.pricing?.prompt);
  const completionPrice = perMillion(m.pricing?.completion);
  const cacheReadPrice = perMillion(m.pricing?.input_cache_read);
  const cacheWritePrice = perMillion(m.pricing?.input_cache_write);

  // Tiered pricing: without this the estimate for a long-context turn uses the
  // base rate and can be understated by 2×. Rows without a usable threshold are
  // dropped, since a tier that applies to everything is just the base rate.
  const priceOverrides: ModelPriceOverride[] = (m.pricing?.overrides ?? [])
    .filter((o) => typeof o?.min_prompt_tokens === "number" && o.min_prompt_tokens > 0)
    .map((o) => ({
      minPromptTokens: o.min_prompt_tokens as number,
      ...(perMillion(o.prompt) !== undefined ? { promptPrice: perMillion(o.prompt) } : {}),
      ...(perMillion(o.completion) !== undefined
        ? { completionPrice: perMillion(o.completion) }
        : {}),
      ...(perMillion(o.input_cache_read) !== undefined
        ? { cacheReadPrice: perMillion(o.input_cache_read) }
        : {}),
      ...(perMillion(o.input_cache_write) !== undefined
        ? { cacheWritePrice: perMillion(o.input_cache_write) }
        : {}),
    }))
    .sort((a, b) => a.minPromptTokens - b.minPromptTokens);
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
    promptPrice,
    completionPrice,
    isFree,
    inputModalities: modalities && modalities.length > 0 ? modalities : undefined,
    supportedParameters,
    reasoning: reasoningMeta,
    ...(m.canonical_slug ? { canonicalSlug: m.canonical_slug } : {}),
    ...(cacheReadPrice !== undefined ? { cacheReadPrice } : {}),
    ...(cacheWritePrice !== undefined ? { cacheWritePrice } : {}),
    ...(priceOverrides.length > 0 ? { priceOverrides } : {}),
    ...(typeof m.top_provider?.max_completion_tokens === "number"
      ? { maxCompletionTokens: m.top_provider.max_completion_tokens }
      : {}),
    ...(m.top_provider?.is_moderated === true ? { isModerated: true } : {}),
    ...(m.expiration_date ? { expirationDate: m.expiration_date } : {}),
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

// ── Model endpoints ─────────────────────────────────────────

/**
 * Fetches who actually serves a model: one record per provider (and per service
 * tier a provider offers).
 *
 * A PATH route, not a query parameter — `/models/{author}/{slug}/endpoints`, so
 * the slash IS the structure. `encodeURIComponent` would turn
 * `openai/gpt-6-luna-pro` into `openai%2Fgpt-6-luna-pro` and the route stops
 * matching, which returns an empty endpoint list rather than an error. The probe
 * hit exactly that and the encoding is spelled out here so it cannot come back.
 *
 * No cache on purpose: this is the raw call, and the figures in it (uptime,
 * p50 latency, throughput) are rolling. `model-catalog.ts` owns the memoization,
 * with a TTL measured in minutes rather than the catalog's hours.
 */
export async function listModelEndpoints(
  apiKey: string,
  modelId: string
): Promise<ModelEndpointInfo[]> {
  const res = await openRouterFetch(`/models/${encodeURI(modelId)}/endpoints`, { apiKey });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return parseEndpointRecords((await res.json()) as EndpointsPayload);
}

// ── Benchmarks ──────────────────────────────────────────────

/**
 * Fetches published competence scores.
 *
 * Three slices, because the endpoint filters by task rather than returning
 * everything: the two Artificial Analysis indices the escalation picker ranks by,
 * and OpenRouter's own task suites, which are the only source of a MEASURED
 * cost per completed task. They are merged into one row list here so the index
 * builder sees a single stream.
 *
 * No cache: this is the raw call. `model-catalog.ts` owns the memoization, since
 * a rate limit of 30/min and 500/day means the answer must be reused, not
 * refetched per picker render.
 */
export async function listBenchmarks(apiKey: string): Promise<BenchmarkRow[]> {
  const paths = [
    "/benchmarks?task_type=agentic&max_results=100",
    "/benchmarks?task_type=coding&max_results=100",
    "/benchmarks?source=openrouter&max_results=100",
  ];

  const rows: BenchmarkRow[] = [];
  // Sequential rather than parallel: three requests sit well inside the burst
  // limit either way, and a failure in one must not discard the other two —
  // coding scores alone are still worth more than the price heuristic.
  for (const path of paths) {
    try {
      const res = await openRouterFetch(path, { apiKey });
      if (!res.ok) continue;
      rows.push(...parseBenchmarkRows((await res.json()) as BenchmarksPayload));
    } catch {
      /* one slice is optional; the others are not */
    }
  }
  return rows;
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
