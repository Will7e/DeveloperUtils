// ============================================================
// Chat Runner — Streaming Orchestration
// ============================================================
// Wires the store to the OpenRouter client: prepares budget-safe
// requests via the context engine, streams tokens into transient
// store state, records exact usage from the stream tail, and
// handles abort/error/regenerate flows.

import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { listModels, streamChat } from "../lib/openrouter-client";
import { prepareRequest } from "../context/engine";
import { CURATED_FALLBACK_MODELS, DEFAULT_CHAT_SETTINGS } from "../constants";
import { buildEffectiveSystemPrompt } from "../lib/skills";
import type { ModelInfo, UsageInfo } from "../types";

/** Resolves model metadata (context length etc.) for a model id */
export function resolveModelInfo(modelId?: string): ModelInfo | undefined {
  if (!modelId) return undefined;
  const curated = CURATED_FALLBACK_MODELS.find((m) => m.id === modelId);
  if (curated?.contextLength) return curated;

  // Check the fetched catalog cache synchronously if already loaded
  const cached = (modelCatalogCache.models ?? []).find((m) => m.id === modelId);
  return cached ?? curated;
}

// Populated when the catalog is fetched; consulted synchronously
// by resolveModelInfo without making the function async.
const modelCatalogCache: { models: ModelInfo[] | null } = { models: null };

/** Fetches and memoizes the live model catalog (best-effort) */
export async function ensureModelCatalog(apiKey: string): Promise<ModelInfo[]> {
  try {
    const models = await listModels(apiKey);
    modelCatalogCache.models = models;
    return models;
  } catch {
    return CURATED_FALLBACK_MODELS;
  }
}

export class ChatError extends Error {
  constructor(
    message: string,
    public readonly kind: "key" | "credits" | "rate" | "network" | "model" | "aborted" | "unknown"
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/**
 * Streams a completion for a conversation. The assistant message is
 * committed when the stream finishes (kept partial on abort).
 */
export async function executeChatStream(conversationId: string): Promise<void> {
  const store = useChatStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  if (!conversation) return;

  const settings = store.settings;
  const apiKey = settings.apiKey?.trim();
  if (!apiKey) {
    useAppStore.getState().addToast({
      message: "Add your OpenRouter API key in Chat Settings to start chatting.",
      type: "error",
      duration: 4500,
    });
    store.setSettingsOpen(true);
    return;
  }

  const modelId = conversation.model ?? settings.defaultModel;
  const modelInfo = resolveModelInfo(modelId);

  // Compose the base prompt + enabled skills into one system prompt
  const basePrompt = conversation.systemPrompt?.trim() || settings.systemPrompt.trim() || "";
  const composedPrompt = buildEffectiveSystemPrompt(basePrompt, settings.skills ?? []);
  const effectiveSystemPrompt = composedPrompt.trim() || undefined;

  const prepared = prepareRequest({
    conversation,
    model: modelInfo,
    effectiveSystemPrompt,
  });

  // Warm the live catalog in the background so context lengths and
  // the model picker improve after the first send.
  void ensureModelCatalog(apiKey);

  store.beginStreaming(conversationId);

  const startedAt = Date.now();
  let usage: UsageInfo | null = null;

  try {
    await streamChat({
      apiKey,
      model: modelId,
      messages: prepared.messages,
      systemPrompt: effectiveSystemPrompt,
      temperature: settings.temperature,
      onChunk: (chunk) => useChatStore.getState().appendStreamingContent(chunk),
      onUsage: (u) => {
        usage = u;
      },
    });

    const latencyMs = Date.now() - startedAt;
    const committedId = useChatStore
      .getState()
      .commitStreamingMessage({
        model: modelId,
        latencyMs,
        usage: usage ?? undefined,
      });

    if (!committedId) {
      // Empty response with no error — surface it as a message so the
      // user is never left staring at a silent no-op.
      useChatStore.getState().addMessage(conversationId, {
        role: "assistant",
        content:
          "The model returned an empty response. Try again, or switch to a different model.",
        error: true,
        model: modelId,
      });
    }
  } catch (err) {
    const aborted =
      err instanceof DOMException
        ? err.name === "AbortError"
        : err instanceof Error && err.name === "AbortError";

    if (aborted) {
      // Keep partial output on user abort
      useChatStore.getState().commitStreamingMessage({
        model: modelId,
        latencyMs: Date.now() - startedAt,
      });
    } else {
      useChatStore.getState().discardStreaming();
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      useChatStore.getState().addMessage(conversationId, {
        role: "assistant",
        content: message,
        error: true,
        model: modelId,
      });
    }
  } finally {
    const wasAborted = useChatStore.getState().wasAborted;
    useChatStore.getState().endStreaming(wasAborted);
  }
}

/** Aborts the in-flight stream (partial output is preserved) */
export function stopChatStream(): void {
  const state = useChatStore.getState();
  if (state.isStreaming && abortRef.controller) {
    abortRef.controller.abort();
  }
}

// Module-level abort controller registry (one in-flight stream max,
// consistent with the single active conversation model)
const abortRef: { controller: AbortController | null } = { controller: null };

/** Starts a user turn: appends the message and kicks off the stream */
export function sendUserMessage(conversationId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const store = useChatStore.getState();
  if (store.isStreaming) return;

  store.addMessage(conversationId, { role: "user", content: trimmed });

  // Auto-title new conversations from the first user message
  const conv = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  if (conv && conv.title === "New Chat") {
    const title = trimmed.slice(0, 48) + (trimmed.length > 48 ? "…" : "");
    useChatStore.getState().renameConversation(conversationId, title);
  }

  abortRef.controller = new AbortController();
  const controller = abortRef.controller;
  void runWithSignal(conversationId, controller);
}

async function runWithSignal(
  conversationId: string,
  controller: AbortController
): Promise<void> {
  // Re-prepare the request with the abort signal by delegating to
  // executeChatStream, which reads fresh state; the signal is wired
  // through the module-level controller consumed by stopChatStream.
  try {
    await executeChatStream(conversationId);
  } finally {
    if (abortRef.controller === controller) {
      abortRef.controller = null;
    }
  }
}

/**
 * Regenerates the last assistant reply: removes it and re-streams.
 */
export async function regenerateLastResponse(conversationId: string): Promise<void> {
  const store = useChatStore.getState();
  const conv = store.conversations.find((c) => c.id === conversationId);
  if (!conv || store.isStreaming) return;

  const last = conv.messages[conv.messages.length - 1];
  if (!last || last.role !== "assistant") return;

  store.truncateFrom(conversationId, last.id);
  abortRef.controller = new AbortController();
  const controller = abortRef.controller;
  try {
    await executeChatStream(conversationId);
  } finally {
    if (abortRef.controller === controller) {
      abortRef.controller = null;
    }
  }
}

/** Exports a conversation to a Markdown string */
export function exportConversationToMarkdown(conversationId: string): string | null {
  const conv = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  if (!conv) return null;

  const lines: string[] = [
    `# ${conv.title}`,
    "",
    `_Model: ${conv.model ?? DEFAULT_CHAT_SETTINGS.defaultModel} · Exported ${new Date().toLocaleString()}_`,
    "",
  ];

  for (const m of conv.messages) {
    if (m.compactedFrom !== undefined) {
      lines.push(`> _…${m.compactedFrom} earlier messages hidden by context compaction…_`, "");
      continue;
    }
    const who = m.role === "user" ? "## You" : "## Assistant";
    lines.push(who, "", m.content, "");
  }

  return lines.join("\n");
}

/** Triggers a Markdown file download for the conversation */
export function downloadConversation(conversationId: string): void {
  const conv = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  const md = exportConversationToMarkdown(conversationId);
  if (!conv || !md) return;

  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${conv.title.replace(/[^\w\d-]+/g, "-").toLowerCase() || "chat"}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
