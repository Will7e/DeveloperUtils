// ============================================================
// Chat Runner Service — Orchestrates streaming completions,
// latency measurement, regeneration, and message re-execution
// ============================================================

import { useChatStore } from "@/stores/chat.store";
import { useAppStore } from "@/stores/app.store";
import { streamChatCompletion, abortCurrentRequest } from "./ai-client.service";
import {
  PROVIDER_LABELS,
  buildEffectiveSystemPrompt,
  CURATED_MODELS,
  type AIProvider,
} from "../types";

export async function executeChatStream(
  conversationId: string,
  modelOverride?: string
): Promise<void> {
  const store = useChatStore.getState();
  const settings = store.settings;
  const conversation = store.conversations.find((c) => c.id === conversationId);

  if (!conversation) return;

  // Determine provider & model
  let targetModel = modelOverride || conversation.model || settings.activeModel || "gpt-4o";
  let targetProvider: AIProvider = conversation.provider || settings.activeProvider || "openai";

  if (modelOverride) {
    const foundModel = CURATED_MODELS.find((m) => m.id === modelOverride);
    if (foundModel) {
      targetProvider = foundModel.provider;
      targetModel = foundModel.id;
    }
  }

  const apiKey = settings.apiKeys?.[targetProvider]?.trim();
  if (!apiKey) {
    useAppStore.getState().addToast({
      message: `API Key required for ${PROVIDER_LABELS[targetProvider] || targetProvider}. Configure it in Chat Settings.`,
      type: "error",
      duration: 4000,
    });
    return;
  }

  store.setStreaming(true);
  store.setStreamingContent("");

  let accumulated = "";
  const startTime = Date.now();

  try {
    const messagesHistory = [...conversation.messages];

    await streamChatCompletion({
      provider: targetProvider,
      model: targetModel,
      apiKey,
      messages: messagesHistory,
      systemPrompt: buildEffectiveSystemPrompt(
        settings.skills,
        conversation.systemPrompt || settings.systemPrompt
      ),
      temperature: settings.temperature,
      customBaseUrl: settings.baseUrls?.[targetProvider],
      useProxy: settings.useProxy,
      onChunk: (chunk) => {
        accumulated += chunk;
        store.appendStreamingContent(chunk);
      },
    });

    const latencyMs = Date.now() - startTime;

    if (accumulated.trim()) {
      store.addMessage(conversationId, {
        role: "assistant",
        content: accumulated,
        model: targetModel,
        latencyMs,
      });
    }
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An unexpected error occurred.";

    if (
      errorMessage !== "The user aborted a request." &&
      !errorMessage.includes("aborted")
    ) {
      store.addMessage(conversationId, {
        role: "assistant",
        content: `Error: ${errorMessage}`,
        error: true,
        model: targetModel,
      });
    } else if (accumulated.trim()) {
      const latencyMs = Date.now() - startTime;
      store.addMessage(conversationId, {
        role: "assistant",
        content: accumulated,
        model: targetModel,
        latencyMs,
      });
    }
  } finally {
    store.setStreaming(false);
    store.setStreamingContent("");
  }
}

export function stopChatStream() {
  abortCurrentRequest();
}
