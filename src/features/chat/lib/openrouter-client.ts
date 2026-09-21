// ============================================================
// OpenRouter Client — Streaming Chat, Models & Key Validation
// ============================================================
// Direct browser fetch with transparent /api/proxy fallback when
// CORS blocks the direct call. OpenRouter quirks handled:
//  - Usage chunk before [DONE] repeats choices[0].delta (safe here)
//  - Mid-stream errors arrive as data events inside 200 responses
//  - Comment lines keep-alive pings are skipped by the SSE parser

import { OPENROUTER_BASE_URL } from "../constants";
import type { ChatMessage, ModelInfo, UsageInfo } from "../types";
import { readSseStream } from "./sse";

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
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
  return new OpenRouterError(friendlyHttpMessage(res.status, detail), res.status);
}

// ── Stream Chat ─────────────────────────────────────────────

export interface StreamChatParams {
  apiKey: string;
  model: string;
  /** Wire-format messages: role + content only */
  messages: Array<Pick<ChatMessage, "role" | "content">>;
  systemPrompt?: string;
  temperature?: number;
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

export async function streamChat({
  apiKey,
  model,
  messages,
  systemPrompt,
  temperature = 0.7,
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
    messages: [
      ...(systemPrompt?.trim()
        ? [{ role: "system", content: systemPrompt.trim() }]
        : []),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
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

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  let sawError = false;
  let gotUsage = false;
  let anyContent = false;

  await readSseStream(response, {
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

  // A 200 stream that errors before producing any content is a failure
  if (sawError || (!anyContent && !gotUsage && !signal?.aborted)) {
    if (!signal?.aborted) {
      throw new OpenRouterError(
        "The model returned an empty response. Try again or switch models.",
        200
      );
    }
  }
}

// ── Models Catalog ──────────────────────────────────────────

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

function toModelInfo(m: OpenRouterModel): ModelInfo {
  const promptPrice = m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1_000_000 : undefined;
  const completionPrice = m.pricing?.completion
    ? parseFloat(m.pricing.completion) * 1_000_000
    : undefined;
  const isFree =
    (promptPrice !== undefined && promptPrice === 0) ||
    m.id.endsWith(":free");

  return {
    id: m.id,
    name: m.name || m.id,
    contextLength: m.context_length,
    promptPrice: Number.isFinite(promptPrice) ? promptPrice : undefined,
    completionPrice: Number.isFinite(completionPrice) ? completionPrice : undefined,
    isFree,
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
