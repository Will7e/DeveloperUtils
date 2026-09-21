// ============================================================
// Chat Runner — Streaming Orchestration
// ============================================================
// Wires the store to the OpenRouter client: prepares budget-safe
// requests via the context engine, streams tokens into transient
// store state, records exact usage from the stream tail, and
// handles abort/error/regenerate flows.

import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { streamChat, OpenRouterError } from "../lib/openrouter-client";
import { prepareRequest, composeSystemPrompt, getConversationContext, needsCompaction } from "../context/engine";
import { AGENT_MAX_ITERATIONS, DEFAULT_CHAT_SETTINGS, INTAB_MODEL_ID, OUTPUT_RESERVE_TOKENS } from "../constants";
import { buildEffectiveSystemPrompt } from "../lib/skills";
import {
  displayNameFor,
  isIntabModel,
  pickInTabModel,
  recordModelFailure,
  recordModelSuccess,
} from "../lib/intab-llm";
import { AGENT_TOOLS, executeToolCall, serializeToolResult } from "../lib/tools";
import { ensureCompaction, runCompactCommand } from "./compaction";
import type { ChatMessage, RepoContext, ToolCallRequest, UsageInfo } from "../types";

/**
 * Repo-context block appended to the system prompt in agent mode.
 * Tells the model which tools exist and when to reach for each.
 */
function composeRepoPrompt(repo: RepoContext): string {
  return [
    `# Repository Context`,
    ``,
    `The user attached the GitHub repository **${repo.owner}/${repo.repo}** (branch: \`${repo.branch}\`) to this conversation.`,
    `You have read-only tools to explore it:`,
    `- get_repo_overview: start here for unfamiliar repos — root structure + README excerpt`,
    `- list_repo_files: list the file tree (optionally narrowed to a subtree)`,
    `- read_file: read one file's full content`,
    `- search_code: full-text search across the repo`,
    ``,
    `Guidelines:`,
    `- Prefer tools over guessing. Ground every claim about the codebase in files you actually read.`,
    `- Use list_repo_files/search_code to locate relevant files, then read_file only what you need.`,
    `- Cite file paths when referencing code.`,
    `- Answer from the repository, not from assumptions about similar projects.`,
  ].join("\n");
}

// Model metadata resolution lives in a leaf module so the compaction
// service can use it without an import cycle. Re-exported here for
// existing UI imports.
import { resolveModelInfo, ensureModelCatalog } from "../lib/model-catalog";
export { resolveModelInfo, ensureModelCatalog };

/** UI-facing model display name (masks InTab-routed models) */
export { displayNameFor };

export class ChatError extends Error {
  constructor(
    message: string,
    public readonly kind: "key" | "credits" | "rate" | "network" | "model" | "aborted" | "unknown"
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/** Tool calls requested by the most recent stream (reset per iteration) */
const toolCallsRef: { current: ToolCallRequest[] } = { current: [] };

/** Distinct InTab pool models a single user turn may try before giving up */
const INTAB_MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when this conversation would route through the InTab virtual model */
function isIntabTurn(conversationId: string): boolean {
  const state = useChatStore.getState();
  const conv = state.conversations.find((c) => c.id === conversationId);
  return isIntabModel(conv?.model ?? state.settings.defaultModel);
}

/**
 * True when a failed InTab attempt is worth retrying on another pool
 * model: provider errors (HTTP statuses and mid-stream error frames),
 * network/watchdog timeouts, and empty responses. Key/credit problems
 * (401/402/403) and user aborts surface normally instead.
 */
function isRetryableModelError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // network-level failure
  if (!(err instanceof Error) || err.name === "AbortError") return false;
  if (err instanceof OpenRouterError) {
    return (
      err.status === 0 ||
      err.status === 200 ||
      err.status === 404 ||
      err.status === 408 ||
      err.status === 429 ||
      err.status >= 500
    );
  }
  return false;
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof OpenRouterError && err.status === 429;
}

/**
 * Streams a completion for a conversation, running the agent tool
 * loop when a repo is attached: stream → (tool calls?) → execute →
 * re-stream, until the model answers without tools or the iteration
 * cap is hit. Each iteration re-reads live store state, so
 * compaction and aborts stay respected mid-loop.
 */
export async function executeChatStream(conversationId: string): Promise<void> {
  // InTab failover memory for this user turn: every pool model that
  // failed is excluded from later attempts (agent tool loop included).
  const attempted = new Set<string>();
  let lastOutcome: "done" | "continue" | "aborted" = "done";
  for (let iteration = 0; iteration < AGENT_MAX_ITERATIONS; iteration++) {
    // A user Stop between iterations must not start another stream
    if (abortRef.controller?.signal.aborted) {
      lastOutcome = "aborted";
      break;
    }
    let outcome = await streamOnce(conversationId, { exclude: attempted });

    // InTab turn: silently retry on the next free pool model after a
    // retryable failure — the conversation keeps its full context.
    // streamOnce records each failed model into `attempted`.
    if (isIntabTurn(conversationId)) {
      while (outcome === "retryable" && attempted.size < INTAB_MAX_ATTEMPTS) {
        if (abortRef.controller?.signal.aborted) {
          outcome = "aborted";
          break;
        }
        // Brief backoff — clears short rate-limit windows
        await sleep(600 + 400 * attempted.size);
        const next = await streamOnce(conversationId, { exclude: attempted });
        if (next === "exhausted") {
          // No pool candidate left outside `attempted`
          outcome = "retryable";
          break;
        }
        outcome = next;
      }
      if (outcome === "retryable" || outcome === "exhausted") {
        // Whole pool exhausted this turn — one honest capacity note.
        useChatStore.getState().addMessage(conversationId, {
          role: "assistant",
          content:
            "InTab LLM is at capacity right now — try again in a few minutes.",
          error: true,
          model: INTAB_MODEL_ID,
        });
        outcome = "done";
      }
    }

    lastOutcome =
      outcome === "retryable" || outcome === "exhausted" ? "done" : outcome;
    if (lastOutcome !== "continue") break;
  }
  if (lastOutcome === "continue") {
    // Iteration cap reached while the model still wanted tools
    useChatStore.getState().addMessage(conversationId, {
      role: "assistant",
      content:
        "Reached the tool-use limit for this turn. Ask me to continue and I'll pick up where I left off.",
    });
  }
}

/** One model turn: stream, commit, and (in agent mode) run tools */
async function streamOnce(
  conversationId: string,
  options: { exclude?: Set<string> } = {}
): Promise<"done" | "continue" | "aborted" | "retryable" | "exhausted"> {
  const store = useChatStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  if (!conversation) return "done";

  const settings = store.settings;
  const apiKey = settings.apiKey?.trim();
  if (!apiKey) {
    useAppStore.getState().addToast({
      message: "Add your OpenRouter API key in Chat Settings to start chatting.",
      type: "error",
      duration: 4500,
    });
    store.setSettingsOpen(true);
    return "done";
  }

  // ── Resolve the wire model. InTab turns route through the virtual
  // free-model pool with sticky per-conversation selection; explicit
  // model choices pass through untouched.
  const requestedModel = conversation.model ?? settings.defaultModel;
  const intab = isIntabModel(requestedModel);
  let modelId = requestedModel;
  if (intab) {
    const needsVision = conversation.messages.some(
      (m) => m.role === "user" && (m.attachments ?? []).some((a) => a.dataUrl)
    );
    const pick = pickInTabModel({
      conversationId,
      needsVision,
      exclude: options.exclude,
    });
    if (!pick) return "exhausted"; // every pool model already failed this turn
    modelId = pick.modelId;
  }
  const modelInfo = resolveModelInfo(modelId);

  // Compose the base prompt + enabled skills into one system prompt
  const basePrompt = conversation.systemPrompt?.trim() || settings.systemPrompt.trim() || "";
  const composedPrompt = buildEffectiveSystemPrompt(basePrompt, settings.skills ?? []);

  // ── Compact mode: fold old history into a rolling summary before
  // the request busts the budget. Truncation fallback inside
  // ensureCompaction guarantees the send proceeds either way.
  const contextNow = getConversationContext({
    conversation,
    model: modelInfo,
    effectiveSystemPrompt: composedPrompt,
  });
  if (needsCompaction(contextNow)) {
    await ensureCompaction(conversationId);
  }

  // Re-read post-compaction state (messages may have been folded)
  const live = useChatStore.getState().conversations.find((c) => c.id === conversationId);
  if (!live) return "done";

  // Agent mode: an attached repo extends the system prompt and arms
  // the GitHub tools (only when a token is actually available).
  const repoContext = live.repoContext;
  const agentActive = Boolean(repoContext && settings.github.token);
  const tools = agentActive ? AGENT_TOOLS : undefined;

  // The rolling summary rides in the system block (deterministic
  // placement keeps provider-side prompt caches hitting). The repo
  // block sits after it so both stay stable across turns.
  const effectiveSystemPrompt = agentActive && repoContext
    ? [
        composeSystemPrompt(composedPrompt, live.summary),
        composeRepoPrompt(repoContext),
      ]
        .filter(Boolean)
        .join("\n\n")
    : composeSystemPrompt(composedPrompt, live.summary);

  const prepared = prepareRequest({
    conversation: live,
    model: modelInfo,
    effectiveSystemPrompt,
  });

  // Warm the live catalog in the background so context lengths and
  // the model picker improve after the first send (and the InTab
  // pool upgrades from static fallbacks to live free models).
  void ensureModelCatalog(apiKey);

  toolCallsRef.current = [];

  store.beginStreaming(conversationId);

  const startedAt = Date.now();
  let usage: UsageInfo | null = null;

  // Tokens are coalesced into one store update per animation frame.
  // Without this, each SSE chunk is its own zustand set() + React
  // render, which breaks down on fast models and long replies. The
  // rAF callback is skipped entirely in non-DOM environments.
  const rafAvailable = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";
  let pendingContent = "";
  let pendingReasoning = "";
  let rafId: number | null = null;

  const flushPending = () => {
    rafId = null;
    const api = useChatStore.getState();
    if (pendingReasoning) {
      api.appendStreamingReasoning(pendingReasoning);
      pendingReasoning = "";
    }
    if (pendingContent) {
      api.appendStreamingContent(pendingContent);
      pendingContent = "";
    }
  };

  const queueContent = (chunk: string) => {
    pendingContent += chunk;
    if (rafAvailable && rafId === null) {
      rafId = window.requestAnimationFrame(flushPending);
    }
  };

  const queueReasoning = (chunk: string) => {
    pendingReasoning += chunk;
    if (rafAvailable && rafId === null) {
      rafId = window.requestAnimationFrame(flushPending);
    }
  };

  const stopBatching = () => {
    if (rafId !== null && rafAvailable) window.cancelAnimationFrame(rafId);
    rafId = null;
    flushPending();
  };

  /** Reasoning text accumulated before a flush point (for abort commits) */
  const pendingReasoningCommitted = () => {
    const streamed = useChatStore.getState().streamingReasoning;
    return streamed + pendingReasoning;
  };

  try {
    await streamChat({
      apiKey,
      model: modelId,
      messages: prepared.messages,
      systemPrompt: effectiveSystemPrompt,
      temperature: settings.temperature,
      maxTokens: modelInfo?.contextLength
        ? Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(modelInfo.contextLength * 0.1))
        : OUTPUT_RESERVE_TOKENS,
      tools,
      signal: abortRef.controller?.signal,
      onToolCalls: (calls) => {
        toolCallsRef.current = calls;
      },
      onChunk: queueContent,
      onReasoning: queueReasoning,
      onUsage: (u) => {
        usage = u;
      },
    });

    stopBatching();

    // ── Agent mode: the model requested tools → execute, then loop.
    // Calls run sequentially so the transcript order is deterministic;
    // each result is committed as it lands (visible live in the UI).
    if (toolCallsRef.current.length > 0) {
      const calls = toolCallsRef.current;
      toolCallsRef.current = [];
      const api = useChatStore.getState();
      api.commitToolCallsMessage(conversationId, calls, {
        content: api.streamingContent,
        reasoning: api.streamingReasoning,
        model: intab ? INTAB_MODEL_ID : modelId,
      });

      for (const call of calls) {
        if (abortRef.controller?.signal.aborted) break;
        const result = await executeToolCall(call, {
          token: settings.github.token,
          repo: repoContext!,
          signal: abortRef.controller?.signal,
        });
        useChatStore
          .getState()
          .commitToolResult(conversationId, result, serializeToolResult(result));
      }
      // Stop mid-tool-run (user pressed Stop) must not re-stream —
      // executeChatStream checks the signal before the next turn.
      if (abortRef.controller?.signal.aborted) return "aborted";
      return "continue";
    }

    const latencyMs = Date.now() - startedAt;
    if (intab) recordModelSuccess(modelId);
    const committedId = useChatStore
      .getState()
      .commitStreamingMessage({
        model: intab ? INTAB_MODEL_ID : modelId,
        viaInTab: intab || undefined,
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
        model: intab ? INTAB_MODEL_ID : modelId,
        viaInTab: intab || undefined,
      });
    }
    return "done";
  } catch (err) {
    stopBatching();
    const aborted =
      err instanceof DOMException
        ? err.name === "AbortError"
        : err instanceof Error && err.name === "AbortError";

    if (aborted) {
      // Keep partial output on user abort
      useChatStore.getState().commitStreamingMessage({
        model: intab ? INTAB_MODEL_ID : modelId,
        viaInTab: intab || undefined,
        latencyMs: Date.now() - startedAt,
        reasoning: pendingReasoningCommitted(),
      });
      return "aborted";
    } else {
      // InTab turn: a retryable provider failure silently moves to
      // the next free pool model (the caller owns the retry loop).
      if (intab && isRetryableModelError(err)) {
        useChatStore.getState().discardStreaming();
        if (isRateLimitError(err)) {
          recordModelFailure(modelId, "rate");
        } else {
          recordModelFailure(modelId, "hard");
        }
        options.exclude?.add(modelId);
        return "retryable";
      }
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      const streamed = useChatStore.getState().streamingContent;

      if (streamed.trim()) {
        // Mid-stream failure (watchdog stall, provider error): keep
        // what already arrived instead of discarding it, with a
        // note explaining the cut-off.
        useChatStore.getState().commitStreamingMessage({
          model: modelId,
          latencyMs: Date.now() - startedAt,
          reasoning: pendingReasoningCommitted(),
        });
        const convAfter = useChatStore
          .getState()
          .conversations.find((c) => c.id === conversationId);
        const last =
          convAfter && convAfter.messages.length > 0
            ? convAfter.messages[convAfter.messages.length - 1]
            : undefined;
        if (last && last.role === "assistant") {
          useChatStore.getState().updateMessage(conversationId, last.id, {
            content: `${streamed}\n\n— _response interrupted: ${message}_`,
          });
        }
      } else {
        // Nothing streamed — surface the error as its own message.
        useChatStore.getState().discardStreaming();
        useChatStore.getState().addMessage(conversationId, {
          role: "assistant",
          content: message,
          error: true,
          model: intab ? INTAB_MODEL_ID : modelId,
          viaInTab: intab || undefined,
        });
      }
    }
    return "done";
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

/**
 * True when the resolved model advertises image input. Unknown when
 * the catalog hasn't loaded — treated as capable (providers enforce).
 */
export function modelSupportsImages(modelId?: string): boolean | null {
  const info = resolveModelInfo(modelId);
  if (!info?.inputModalities) return null;
  return info.inputModalities.includes("image");
}

/** Starts a user turn: appends the message and kicks off the stream */
export function sendUserMessage(
  conversationId: string,
  text: string,
  attachments?: ChatMessage["attachments"]
): void {
  const trimmed = text.trim();
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!trimmed && !hasAttachments) return;

  const store = useChatStore.getState();
  if (store.isStreaming) return;

  // ── /compact command: force a compaction cycle from the composer.
  // Handled before any message is appended — nothing is sent to the
  // model for this turn. Toast/reporting logic is shared with the
  // composer's slash command menu (lib/commands.ts).
  if (/^\/compact\s*$/i.test(trimmed)) {
    void runCompactCommand(conversationId);
    return;
  }

  // Warn (don't block) when images ride a text-only model — the
  // provider error surfaces in the thread if it truly can't handle it.
  const conv = store.conversations.find((c) => c.id === conversationId);
  const modelId = conv?.model ?? store.settings.defaultModel;
  const supportsImages = modelSupportsImages(modelId);
  if (
    supportsImages === false &&
    (attachments ?? []).some((a) => a.dataUrl)
  ) {
    useAppStore.getState().addToast({
      message: "This model may not accept images — pick a vision model for best results.",
      type: "info",
      duration: 4000,
    });
  }

  const titleSource = trimmed || attachments?.[0]?.name || "New Chat";

  store.addMessage(conversationId, {
    role: "user",
    content: trimmed,
    ...(hasAttachments ? { attachments } : {}),
  });

  // Auto-title new conversations from the first user message
  const conv2 = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  if (conv2 && conv2.title === "New Chat") {
    const title = titleSource.slice(0, 48) + (titleSource.length > 48 ? "…" : "");
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
 * Also removes an orphan trailing user message — the attachments
 * flow's early-return can leave one behind, and re-streaming with an
 * unanswered user turn would duplicate it in the request.
 */
export async function regenerateLastResponse(conversationId: string): Promise<void> {
  const store = useChatStore.getState();
  const conv = store.conversations.find((c) => c.id === conversationId);
  if (!conv || store.isStreaming) return;

  const last = conv.messages[conv.messages.length - 1];
  if (!last || last.role !== "assistant") return;

  // Removes the reply; the user prompt becomes the request's final
  // turn, which is exactly what the model should re-answer.
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
    `_Model: ${displayNameFor(
      conv.model ?? DEFAULT_CHAT_SETTINGS.defaultModel,
      []
    )} · Exported ${new Date().toLocaleString()}_`,
    "",
  ];

  for (const m of conv.messages) {
    if (m.compactedFrom !== undefined) {
      lines.push(`> _…${m.compactedFrom} earlier messages hidden by context compaction…_`, "");
      continue;
    }
    // Agent-activity messages export as compact activity lines
    if (m.toolCalls) {
      const names = m.toolCalls.calls.map((c) => c.name).join(", ");
      lines.push(`> _🛠 Assistant used tools: ${names}_`, "");
      continue;
    }
    if (m.toolResult) {
      lines.push(
        `> _↳ ${m.toolResult.name}${m.toolResult.ok ? "" : " (error)"} · ${m.toolResult.summary ?? ""} · ${m.toolResult.durationMs}ms_`,
        ""
      );
      continue;
    }
    const who = m.role === "user" ? "## You" : "## Assistant";
    lines.push(who, "", m.content, "");
    const imageNames = (m.attachments ?? [])
      .filter((a) => a.dataUrl)
      .map((a) => a.name);
    if (imageNames.length > 0) {
      lines.push("", `> _Attached image${imageNames.length === 1 ? "" : "s"}: ${imageNames.join(", ")}_`);
    }
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
