// ============================================================
// AI Client Service — Multi-Provider Streaming & Test Engine
// ============================================================

import type { AIProvider, ChatMessage } from "../types";
function extractBase64Data(dataUrl: string): {
  mimeType: string;
  base64: string;
} {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return {
      mimeType: match[1] || "image/jpeg",
      base64: match[2] || "",
    };
  }
  return {
    mimeType: "image/jpeg",
    base64: dataUrl,
  };
}

let currentAbortController: AbortController | null = null;

export function abortCurrentRequest() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

export interface StreamParams {
  provider: AIProvider;
  model: string;
  apiKey: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  temperature?: number;
  customBaseUrl?: string;
  useProxy?: boolean;
  onChunk: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Dispatch chat streaming request across supported providers
 */
export async function streamChatCompletion({
  provider,
  model,
  apiKey,
  messages,
  systemPrompt,
  temperature = 0.7,
  customBaseUrl,
  useProxy = false,
  onChunk,
  signal,
}: StreamParams): Promise<void> {
  if (!apiKey?.trim()) {
    throw new Error(
      `API key for ${provider.toUpperCase()} is required. Please set it in Chat Settings.`
    );
  }

  if (!signal) {
    currentAbortController = new AbortController();
    signal = currentAbortController.signal;
  }

  try {
    switch (provider) {
      case "openai":
        await streamOpenAI({
          model,
          apiKey,
          messages,
          systemPrompt,
          temperature,
          customBaseUrl,
          useProxy,
          onChunk,
          signal,
        });
        break;

      case "anthropic":
        await streamAnthropic({
          model,
          apiKey,
          messages,
          systemPrompt,
          temperature,
          customBaseUrl,
          useProxy,
          onChunk,
          signal,
        });
        break;

      case "gemini":
        await streamGemini({
          model,
          apiKey,
          messages,
          systemPrompt,
          temperature,
          customBaseUrl,
          useProxy,
          onChunk,
          signal,
        });
        break;

      default:
        throw new Error(`Unsupported AI provider: ${provider}`);
    }
  } finally {
    if (currentAbortController?.signal === signal) {
      currentAbortController = null;
    }
  }
}

// ── OpenAI Stream ───────────────────────────────────────────

async function streamOpenAI({
  model,
  apiKey,
  messages,
  systemPrompt,
  temperature,
  customBaseUrl,
  useProxy,
  onChunk,
  signal,
}: Omit<StreamParams, "provider">) {
  const baseUrl = customBaseUrl?.trim() || "https://api.openai.com/v1";
  let url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  if (useProxy && typeof window !== "undefined") {
    url = `/api/proxy?url=${encodeURIComponent(url)}`;
  }

  const formattedMessages: Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
  }> = [];
  if (systemPrompt?.trim()) {
    formattedMessages.push({ role: "system", content: systemPrompt.trim() });
  }

  for (const msg of messages) {
    if (msg.images && msg.images.length > 0 && msg.role === "user") {
      const parts: Array<Record<string, unknown>> = [];
      if (msg.content.trim()) {
        parts.push({ type: "text", text: msg.content.trim() });
      }
      for (const img of msg.images) {
        parts.push({
          type: "image_url",
          image_url: { url: img.url },
        });
      }
      formattedMessages.push({
        role: "user",
        content: parts,
      });
    } else {
      formattedMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model,
      messages: formattedMessages,
      temperature,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message =
      errorData?.error?.message ||
      `OpenAI API responded with status ${response.status}: ${response.statusText}`;
    throw new Error(message);
  }

  await parseSseStream(response, (dataStr) => {
    if (dataStr === "[DONE]") return;
    try {
      const parsed = JSON.parse(dataStr);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) {
        onChunk(delta);
      }
    } catch {
      // Ignore JSON parse error in individual chunk
    }
  });
}

// ── Anthropic Claude Stream ─────────────────────────────────

async function streamAnthropic({
  model,
  apiKey,
  messages,
  systemPrompt,
  temperature,
  customBaseUrl,
  useProxy,
  onChunk,
  signal,
}: Omit<StreamParams, "provider">) {
  const baseUrl = customBaseUrl?.trim() || "https://api.anthropic.com/v1";
  const directUrl = `${baseUrl.replace(/\/+$/, "")}/messages`;

  const formattedMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const role = m.role === "assistant" ? "assistant" : "user";
      if (m.images && m.images.length > 0 && m.role === "user") {
        const content: Array<Record<string, unknown>> = [];
        for (const img of m.images) {
          const { mimeType, base64 } = extractBase64Data(img.url);
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,
              data: base64,
            },
          });
        }
        if (m.content.trim()) {
          content.push({
            type: "text",
            text: m.content.trim(),
          });
        }
        return { role, content };
      }
      return {
        role,
        content: m.content,
      };
    });

  const payload = {
    model,
    max_tokens: 4096,
    system: systemPrompt?.trim() || undefined,
    messages: formattedMessages,
    temperature,
    stream: true,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey.trim(),
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };

  let response: Response;
  const shouldProxy = useProxy || (typeof window !== "undefined" && window.location.hostname !== "localhost");

  try {
    if (shouldProxy) {
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(directUrl)}`;
      response = await fetch(proxyUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } else {
      response = await fetch(directUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    }
  } catch (err: unknown) {
    if (err instanceof TypeError && !directUrl.includes("/api/proxy")) {
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(directUrl)}`;
      response = await fetch(proxyUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } else {
      throw err;
    }
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message =
      errorData?.error?.message ||
      `Anthropic API responded with status ${response.status}: ${response.statusText}`;
    throw new Error(message);
  }

  await parseSseStream(response, (dataStr) => {
    try {
      const parsed = JSON.parse(dataStr);
      if (parsed.type === "content_block_delta" && parsed.delta?.text) {
        onChunk(parsed.delta.text);
      }
    } catch {
      // Ignore JSON parse error in chunk
    }
  });
}

// ── Google Gemini Stream ────────────────────────────────────

async function streamGemini({
  model,
  apiKey,
  messages,
  systemPrompt,
  temperature,
  customBaseUrl,
  useProxy,
  onChunk,
  signal,
}: Omit<StreamParams, "provider">) {
  const baseUrl =
    customBaseUrl?.trim() ||
    "https://generativelanguage.googleapis.com/v1beta";
  let url = `${baseUrl.replace(
    /\/+$/,
    ""
  )}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
    apiKey.trim()
  )}`;

  if (useProxy && typeof window !== "undefined") {
    url = `/api/proxy?url=${encodeURIComponent(url)}`;
  }

  const contents = messages.map((m) => {
    const role = m.role === "assistant" ? "model" : "user";
    const parts: Array<Record<string, unknown>> = [];

    if (m.images && m.images.length > 0 && m.role === "user") {
      for (const img of m.images) {
        const { mimeType, base64 } = extractBase64Data(img.url);
        parts.push({
          inlineData: {
            mimeType,
            data: base64,
          },
        });
      }
    }

    if (m.content.trim() || parts.length === 0) {
      parts.push({ text: m.content });
    }

    return { role, parts };
  });

  const payload: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature,
    },
  };

  if (systemPrompt?.trim()) {
    payload.systemInstruction = {
      parts: [{ text: systemPrompt.trim() }],
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message =
      errorData?.error?.message ||
      `Gemini API responded with status ${response.status}: ${response.statusText}`;
    throw new Error(message);
  }

  await parseSseStream(response, (dataStr) => {
    try {
      const parsed = JSON.parse(dataStr);
      const parts = parsed.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part.text) {
            onChunk(part.text);
          }
        }
      }
    } catch {
      // Ignore JSON parse error in chunk
    }
  });
}

// ── SSE Parser ──────────────────────────────────────────────

async function parseSseStream(
  response: Response,
  onData: (data: string) => void
) {
  if (!response.body) {
    throw new Error("Response body is null, cannot stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr) {
          onData(dataStr);
        }
      }
    }
  }

  if (buffer.trim().startsWith("data:")) {
    const dataStr = buffer.trim().slice(5).trim();
    if (dataStr) {
      onData(dataStr);
    }
  }
}

// ── Connection Tester ───────────────────────────────────────

export async function testProviderConnection(
  provider: AIProvider,
  apiKey: string,
  customBaseUrl?: string,
  useProxy?: boolean
): Promise<{ success: boolean; message: string }> {
  if (!apiKey?.trim()) {
    return { success: false, message: "Please enter an API key first." };
  }

  try {
    if (provider === "openai") {
      const baseUrl = customBaseUrl?.trim() || "https://api.openai.com/v1";
      let url = `${baseUrl.replace(/\/+$/, "")}/models`;
      if (useProxy) {
        url = `/api/proxy?url=${encodeURIComponent(url)}`;
      }
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      });
      if (res.ok) {
        return { success: true, message: "Connected to OpenAI successfully!" };
      }
      const err = await res.json().catch(() => ({}));
      return {
        success: false,
        message: err?.error?.message || `OpenAI returned status ${res.status}`,
      };
    }

    if (provider === "anthropic") {
      const baseUrl = customBaseUrl?.trim() || "https://api.anthropic.com/v1";
      const directUrl = `${baseUrl.replace(/\/+$/, "")}/messages`;
      const headers = {
        "Content-Type": "application/json",
        "x-api-key": apiKey.trim(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      };

      const payload = {
        model: "claude-3-5-haiku-20241022",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      };

      let res: Response;
      try {
        if (useProxy) {
          res = await fetch(`/api/proxy?url=${encodeURIComponent(directUrl)}`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
        } else {
          res = await fetch(directUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
        }
      } catch (err: unknown) {
        if (err instanceof TypeError && typeof window !== "undefined") {
          res = await fetch(`/api/proxy?url=${encodeURIComponent(directUrl)}`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
        } else {
          throw err;
        }
      }

      if (res.ok) {
        return { success: true, message: "Connected to Claude successfully!" };
      }
      const err = await res.json().catch(() => ({}));
      return {
        success: false,
        message: err?.error?.message || `Claude returned status ${res.status}`,
      };
    }

    if (provider === "gemini") {
      const baseUrl =
        customBaseUrl?.trim() ||
        "https://generativelanguage.googleapis.com/v1beta";
      let url = `${baseUrl.replace(/\/+$/, "")}/models?key=${encodeURIComponent(
        apiKey.trim()
      )}`;
      if (useProxy) {
        url = `/api/proxy?url=${encodeURIComponent(url)}`;
      }
      const res = await fetch(url);
      if (res.ok) {
        return { success: true, message: "Connected to Gemini successfully!" };
      }
      const err = await res.json().catch(() => ({}));
      return {
        success: false,
        message: err?.error?.message || `Gemini returned status ${res.status}`,
      };
    }

    return { success: false, message: "Unknown provider" };
  } catch (error: unknown) {
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Failed to connect to provider",
    };
  }
}
