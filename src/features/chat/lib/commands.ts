// ============================================================
// Chat Commands — Slash Command Registry
// ============================================================
// Every command maps onto an existing store action or service —
// no new backend behavior. One registry serves both entry paths:
//
//   · the composer's menu (CommandMenu.tsx) — grouped, filtered,
//     availability-aware, keyboard driven
//   · typed input (sendUserMessage / the composer's Enter) — routed
//     through lib/slash.ts so the same token means the same thing
//     whichever way it was submitted
//
// A command never sees raw UI state: it gets a small context
// (conversation, argument, streaming flag) and returns an optional
// outcome controlling the composer (e.g. /help reopens the menu).
//
// Import discipline: this module must stay importable from the turn
// runner, so anything that lives in the runner (regenerate) is
// loaded lazily inside the command that needs it.

import {
  ArrowDownToLine,
  Bot,
  Braces,
  CircleStop,
  Eraser,
  Gauge,
  Hammer,
  LifeBuoy,
  ListTree,
  MessageSquarePlus,
  Pencil,
  RotateCcw,
  ScrollText,
  Settings,
  Shapes,
  Signal,
  Undo2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { CURATED_FALLBACK_MODELS } from "../constants";
import { REASONING_EFFORT_META, modelSupportsTools } from "./model-state";
import { resolveToolProfile } from "./tool-profiles";
import { downloadConversation } from "../services/export-conversation";
import { resolveModelInfo } from "./model-catalog";
import { runCompactCommand } from "../services/compaction";
import { undoLastWorkspaceMutation } from "../services/agent-actions";
import { canUndo } from "../workspace/undo";
import { TOOL_REGISTRY } from "./tool-registry";
import { getConversationContext, composeSystemPrompt } from "../context/engine";
import { buildEffectiveSystemPrompt } from "./skills";
import { isTurnRunning, stopTurn } from "../session/turn-engine";
import { getTurnLog, formatTurnLog } from "../session/turn-log";
import { sessionHost } from "../session/session-client";
import { rankCommandSpecs } from "./slash";
import type {
  ChatMode,
  ContextBreakdown,
  ModelInfo,
  ReasoningEffort,
  ToolDefinition,
} from "../types";

function toast(
  message: string,
  type: "success" | "error" | "info" = "info",
  multiline = false
): void {
  useAppStore.getState().addToast({ message, type, duration: 5000, multiline });
}

/**
 * Renders the window breakdown as an aligned report. Colored bars are
 * worth more than a paragraph in the meter card, but a command's job
 * is to be copyable — this is the same accounting as text.
 */
function contextReport(info: ContextBreakdown, modelId: string): string {
  const free = info.parts.find((p) => p.key === "free");
  const rows: Array<[string, number]> = [
    ...info.parts.filter((p) => p.key !== "free").map((p) => [p.label, p.tokens] as [string, number]),
    ...(free ? [[free.label, free.tokens] as [string, number]] : []),
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, tokens]) => {
    const share = (tokens / Math.max(1, info.usableTokens)) * 100;
    return `${label.padEnd(width)}  ${formatTokenCount(tokens).padStart(7)}  ${share.toFixed(1).padStart(5)}%`;
  });

  const foot = [
    `Window ${info.maxTokens.toLocaleString()} · ${info.outputReserve.toLocaleString()} reserved for the reply · ${info.usableTokens.toLocaleString()} usable`,
    !info.calibrated
      ? "Estimates only — no measured token ratio for this model yet"
      : null,
    info.lastPromptTokens != null
      ? `Last request: ${info.lastPromptTokens.toLocaleString()} prompt tokens (exact)` +
        (info.lastCachedTokens
          ? ` · ${info.lastCachedTokens.toLocaleString()} from cache`
          : "")
      : "No completed request yet — estimates only",
    info.compactedTokens > 0
      ? `${formatTokenCount(info.compactedTokens)} tokens folded into compacted memory`
      : null,
    info.totalCost > 0
      ? `Spend $${info.totalCost.toFixed(4)} · ${formatTokenCount(info.completionTokens)} generated`
      : null,
    info.percentageUsed >= 70 ? "Older messages get summarized before the next send." : null,
  ].filter(Boolean);

  return [
    `Context · ${modelId}`,
    `${formatTokenCount(info.totalTokens)} of ${formatTokenCount(info.usableTokens)} usable tokens · ${info.percentageUsed}% · ${info.health}`,
    "",
    ...lines,
    "",
    ...foot,
  ].join("\n");
}

/** Compact token count for text reports (matches the meter's units) */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Menu sections — the order here is the order rendered */
export const COMMAND_GROUPS = ["Turn", "Context", "Agent", "Model", "Session"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/** What a command may hand back to the composer */
export interface CommandOutcome {
  /**
   * Draft to leave in the composer. Default "" (cleared). "/help"
   * returns "/" so the menu reopens on the full list.
   */
  draft?: string;
}

/** Context handed to a command when it runs */
export interface ChatCommandContext {
  /** Conversation the composer belongs to */
  conversationId: string;
  /** Everything after the command token (trimmed; "" when absent) */
  arg: string;
  /** Live model catalog (empty before the key-backed fetch succeeds) */
  models: ModelInfo[];
  /** True while THIS conversation is producing a reply */
  isStreaming: boolean;
}

export interface ChatCommand {
  /** Command token without the slash */
  id: string;
  /** One-line description shown in the menu */
  description: string;
  icon: LucideIcon;
  /** Menu section */
  group: CommandGroup;
  /** Extra match terms the user might type ("ctx" for /context) */
  keywords?: readonly string[];
  /** Placeholder shown when the command expects an argument */
  argsHint?: string;
  /**
   * True when the menu should stay open and hand the query over to
   * a custom arg source (e.g. /model lists the catalog).
   */
  hasSubmenu?: boolean;
  /**
   * Offered only when this returns true. Availability is a *menu*
   * concern: typing /stop outside a turn still reaches the command,
   * which then explains itself instead of silently doing nothing.
   */
  available?: (ctx: { isStreaming: boolean }) => boolean;
  run: (ctx: ChatCommandContext) => void | Promise<void> | CommandOutcome;
}

/** Resolves "/model <query>" against the catalog: exact id, then substring */
export function matchModelArg(
  arg: string,
  models: ModelInfo[],
  fallback: ModelInfo[]
): ModelInfo | undefined {
  const q = arg.trim().toLowerCase();
  if (!q) return undefined;
  const catalog = models.length > 0 ? models : fallback;
  return (
    catalog.find((m) => m.id.toLowerCase() === q) ??
    catalog.find((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  );
}

/** Effective system prompt a turn would send (skills + rolling summary) */
function effectiveSystemPrompt(conversationId: string): string {
  const store = useChatStore.getState();
  const conv = store.conversations.find((c) => c.id === conversationId);
  if (!conv) return "";
  const base = conv.systemPrompt?.trim() || store.settings.systemPrompt.trim() || "";
  const composed = buildEffectiveSystemPrompt(base, store.settings.skills ?? []);
  return composeSystemPrompt(composed, conv.summary) ?? "";
}

function activeConversation(conversationId: string) {
  return useChatStore.getState().conversations.find((c) => c.id === conversationId);
}

/**
 * Tool definitions the next turn of this conversation would carry —
 * the same condition the runner checks, so /context and /status charge
 * for exactly the schemas that will ride the request.
 */
function contextToolsFor(conversationId: string): ToolDefinition[] | undefined {
  const store = useChatStore.getState();
  const conv = activeConversation(conversationId);
  if (!conv?.repoContext || !store.settings.github.token) return undefined;
  const { model, mode } = currentModelState();
  const info = resolveModelInfo(model);
  if (!modelSupportsTools(info)) return undefined;
  return resolveToolProfile(mode, info).tools;
}

/** Reasoning-effort aliases users actually type */
const EFFORT_ALIASES: Record<string, ReasoningEffort> = {
  low: "low",
  light: "low",
  fast: "low",
  quick: "low",
  medium: "medium",
  med: "medium",
  balanced: "medium",
  default: "medium",
  high: "high",
  deep: "high",
  smart: "high",
  max: "max",
  xhigh: "max",
};

/** Agent-mode aliases */
const MODE_ALIASES: Record<string, ChatMode> = {
  build: "build",
  edit: "build",
  agent: "build",
  plan: "plan",
  read: "plan",
  readonly: "plan",
};

/** Effective model state for the active conversation */
function currentModelState(): { model: string; effort: ReasoningEffort; mode: ChatMode } {
  const store = useChatStore.getState();
  const conv = activeConversation(store.activeConversationId ?? "");
  return {
    model: conv?.model ?? store.settings.defaultModel,
    effort: conv?.reasoningEffort ?? store.settings.defaultReasoningEffort,
    mode: conv?.mode ?? store.settings.defaultMode,
  };
}

// ── Registry ────────────────────────────────────────────────

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  // ── Turn ──
  {
    id: "stop",
    description: "Stop the reply that is streaming now",
    icon: CircleStop,
    group: "Turn",
    keywords: ["cancel", "halt", "abort"],
    available: ({ isStreaming }) => isStreaming,
    run: ({ isStreaming }) => {
      if (!isStreaming) {
        toast("Nothing is streaming right now.", "info");
        return;
      }
      stopTurn();
      toast("Stopped — the partial reply is kept.", "info");
    },
  },
  {
    id: "retry",
    description: "Regenerate the last reply",
    icon: RotateCcw,
    group: "Turn",
    keywords: ["regenerate", "again", "redo"],
    available: ({ isStreaming }) => !isStreaming,
    run: async ({ conversationId, isStreaming }) => {
      if (isStreaming) return;
      const conv = activeConversation(conversationId);
      const hasReply = Boolean(conv?.messages.some((m) => m.role === "assistant" && !m.hidden));
      if (!hasReply) {
        toast("No reply to regenerate yet.", "info");
        return;
      }
      // Lazy: regenerate orchestration lives in the turn facade, and
      // importing it here would make the registry depend on it.
      const { regenerateLastResponse } = await import("../services/chat-runner");
      await regenerateLastResponse(conversationId);
    },
  },

  // ── Context ──
  {
    id: "compact",
    description: "Summarize older history to free context window",
    icon: Zap,
    group: "Context",
    keywords: ["summarize", "shrink", "fold"],
    run: ({ conversationId }) => void runCompactCommand(conversationId),
  },
  {
    id: "context",
    description: "Show what is in the context window",
    icon: Gauge,
    group: "Context",
    keywords: ["ctx", "usage", "tokens", "budget"],
    run: ({ conversationId }) => {
      const conv = activeConversation(conversationId);
      if (!conv) return;
      const modelId = conv.model ?? useChatStore.getState().settings.defaultModel;
      const info = getConversationContext({
        conversation: conv,
        effectiveSystemPrompt: effectiveSystemPrompt(conversationId),
        modelId,
        tools: contextToolsFor(conversationId),
      });
      toast(
        contextReport(info, modelId),
        info.percentageUsed >= 85 ? "error" : "info",
        true
      );
    },
  },
  {
    id: "clear",
    description: "Start this chat over — clear context, keep the history on disk",
    icon: Eraser,
    group: "Context",
    keywords: ["reset", "forget", "wipe"],

    available: ({ isStreaming }) => !isStreaming,
    run: ({ conversationId, isStreaming }) => {
      if (isStreaming) {
        toast("Stop the current reply before clearing context.", "error");
        return;
      }
      const conv = activeConversation(conversationId);
      if (!conv || conv.messages.every((m) => m.hidden)) {
        toast("Context is already empty.", "info");
        return;
      }
      useChatStore.getState().clearConversationContext(conversationId);
      toast("Context cleared — history stays stored but is no longer sent.", "success");
    },
  },

  // ── Agent ──
  {
    id: "undo",
    description: "Undo the last file the agent changed here",
    icon: Undo2,
    group: "Agent",
    keywords: ["revert", "rollback"],
    run: async ({ conversationId }) => {
      const ws = useChatStore.getState().workspaces[conversationId];
      if (!ws) {
        toast("No agent workspace yet — attach a repo and let the agent edit.", "info");
        return;
      }
      if (!canUndo(ws)) {
        toast("Nothing to undo — the agent hasn't changed a file yet.", "info");
        return;
      }
      const last = ws.mutations?.[ws.mutations.length - 1];
      await undoLastWorkspaceMutation(conversationId);
      toast(`Reverted ${last?.path ?? "the last change"}.`, "success");
    },
  },
  {
    id: "tools",
    description: "List the tools the agent can use",
    icon: Braces,
    group: "Agent",
    keywords: ["capabilities", "functions"],
    run: () => {
      const names = TOOL_REGISTRY.map((t) => t.name).join(", ");
      toast(`Agent tools (${TOOL_REGISTRY.length}): ${names}`, "info");
    },
  },
  {
    id: "status",
    description: "Report this session: model, transport, context, turn state",
    icon: Signal,
    group: "Agent",
    keywords: ["health", "state", "session"],
    run: ({ conversationId }) => {
      const store = useChatStore.getState();
      const conv = activeConversation(conversationId);
      const { model: modelId, effort, mode } = currentModelState();
      const info = getConversationContext({
        conversation: conv ?? {
          id: conversationId,
          title: "",
          messages: [],
          createdAt: 0,
          updatedAt: 0,
        },
        effectiveSystemPrompt: effectiveSystemPrompt(conversationId),
        modelId,
        tools: contextToolsFor(conversationId),
      });
      const parts = [
        modelId,
        `effort: ${REASONING_EFFORT_META[effort].label.toLowerCase()}`,
        `mode: ${mode}`,
        `transport: ${sessionHost.available ? "session host" : "page-local"}`,
        `streaming: ${store.isStreaming ? "yes" : "no"}${isTurnRunning() ? " (turn running)" : ""}`,
        `context: ${info.percentageUsed}% of ${formatTokenCount(info.usableTokens)}`,
        `tools: ${info.parts.find((p) => p.key === "tools")?.tokens.toLocaleString() ?? 0} tok`,
        info.lastPromptTokens != null
          ? `last request: ${info.lastPromptTokens.toLocaleString()} tok exact`
          : "last request: none",
        conv?.summary ? `summary covers ${conv.summary.coversCount}` : null,
        `messages: ${conv?.messages.filter((m) => !m.hidden).length ?? 0}`,
        conv?.pendingTurn ? "pending turn marker SET" : null,
        conv?.repoContext ? `repo: ${conv.repoContext.owner}/${conv.repoContext.repo}` : null,
      ].filter(Boolean);
      toast(parts.join(" · "), "info");
    },
  },
  {
    id: "log",
    description: "Print the turn log to the console (debug)",
    icon: ScrollText,
    group: "Agent",
    keywords: ["debug", "trace", "diagnostics", "console"],
    run: () => {
      const entries = getTurnLog();
      // eslint-disable-next-line no-console
      console.log(formatTurnLog() || "(turn log is empty)");
      toast(
        `${entries.length} turn-log entries printed to the console (window.__intabTurnLog).`,
        "info"
      );
    },
  },

  // ── Model ──
  {
    id: "model",
    description: "Switch the model for this conversation",
    icon: Bot,
    group: "Model",
    keywords: ["models", "switch"],
    argsHint: "model name…",
    hasSubmenu: true,
    run: ({ conversationId, arg, models }) => {
      const model = matchModelArg(arg, models, CURATED_FALLBACK_MODELS);
      if (!model) {
        toast(`No model matches “${arg.trim()}”.`, "error");
        return { draft: `/model ${arg.trim()}` };
      }
      const store = useChatStore.getState();
      store.setConversationModel(conversationId, model.id);
      // First model switch also becomes the default for future chats,
      // mirroring the header ModelPicker behavior.
      store.updateSettings({ defaultModel: model.id });
      toast(`Model switched to ${model.name}.`, "success");
    },
  },
  {
    id: "effort",
    description: "Set how hard the model thinks (low · medium · high · max)",
    icon: ListTree,
    group: "Model",
    keywords: ["reasoning", "thinking", "level", "tier"],
    argsHint: "low · medium · high · max",
    run: ({ conversationId, arg }) => {
      const store = useChatStore.getState();
      const requested = arg.trim().toLowerCase();
      if (!requested) {
        const { effort } = currentModelState();
        toast(
          `Reasoning effort: ${REASONING_EFFORT_META[effort].label} — use /effort low, /effort medium, /effort high or /effort max.`,
          "info"
        );
        return;
      }
      const next = EFFORT_ALIASES[requested];
      if (!next) {
        toast(`Unknown effort “${requested}” — try low, medium, high or max.`, "error");
        return { draft: "/effort " };
      }
      store.setConversationEffort(conversationId, next);
      toast(
        `Reasoning effort: ${REASONING_EFFORT_META[next].label} — ${REASONING_EFFORT_META[next].tagline}.`,
        "success"
      );
    },
  },
  {
    id: "mode",
    description: "Switch agent mode (build edits code · plan is read-only)",
    icon: Hammer,
    group: "Agent",
    keywords: ["plan", "build", "readonly", "agent"],
    argsHint: "build · plan",
    run: ({ conversationId, arg }) => {
      const store = useChatStore.getState();
      const requested = arg.trim().toLowerCase();
      if (!requested) {
        const { mode } = currentModelState();
        toast(`Agent mode: ${mode} — use /mode build or /mode plan.`, "info");
        return;
      }
      const next = MODE_ALIASES[requested];
      if (!next) {
        toast(`Unknown mode “${requested}” — try build or plan.`, "error");
        return { draft: "/mode " };
      }
      store.setConversationMode(conversationId, next);
      toast(
        next === "plan"
          ? "Plan mode — the agent investigates read-only and proposes changes; edit tools are disabled."
          : "Build mode — the agent can edit the workspace and ship through the push gate.",
        "success"
      );
    },
  },

  // ── Session ──
  {
    id: "new",
    description: "Start a new conversation",
    icon: MessageSquarePlus,
    group: "Session",
    keywords: ["chat"],
    run: () => {
      const model = useChatStore.getState().settings.defaultModel;
      useChatStore.getState().createConversation(model);
    },
  },
  {
    id: "rename",
    description: "Rename this conversation",
    icon: Pencil,
    group: "Session",
    keywords: ["title", "name"],
    argsHint: "new title",
    run: ({ conversationId, arg }) => {
      if (!arg.trim()) {
        toast("Usage: /rename <new title>", "info");
        return { draft: "/rename " };
      }
      useChatStore.getState().renameConversation(conversationId, arg.trim());
      toast(`Renamed to “${arg.trim()}”.`, "success");
    },
  },
  {
    id: "system",
    description: "Set (or show) this chat's system prompt",
    icon: Settings,
    group: "Session",
    keywords: ["prompt", "instructions", "persona"],
    argsHint: "instructions (or 'clear')",
    run: ({ conversationId, arg }) => {
      const conv = activeConversation(conversationId);
      const trimmed = arg.trim();
      if (!trimmed) {
        const current = conv?.systemPrompt?.trim();
        toast(
          current
            ? `System prompt: ${current.slice(0, 180)}${current.length > 180 ? "…" : ""}`
            : "No chat-specific system prompt. Use /system <instructions> to add one, or /system clear.",
          "info"
        );
        return;
      }
      if (trimmed.toLowerCase() === "clear") {
        useChatStore.getState().setConversationSystemPrompt(conversationId, undefined);
        toast("Chat system prompt cleared.", "success");
        return;
      }
      useChatStore.getState().setConversationSystemPrompt(conversationId, trimmed);
      toast("System prompt set for this chat.", "success");
    },
  },
  {
    id: "export",
    description: "Download this conversation as Markdown",
    icon: ArrowDownToLine,
    group: "Session",
    keywords: ["download", "save", "markdown"],
    run: ({ conversationId }) => {
      const conv = activeConversation(conversationId);
      if (!conv || conv.messages.length === 0) {
        toast("Nothing to export yet — send a message first.", "info");
        return;
      }
      downloadConversation(conversationId);
    },
  },
  {
    id: "skills",
    description: "Manage skills and prompt modules",
    icon: Shapes,
    group: "Session",
    keywords: ["modules", "library"],
    run: () => useChatStore.getState().setSettingsOpen(true, "skills"),
  },
  {
    id: "settings",
    description: "Open chat settings",
    icon: Settings,
    group: "Session",
    keywords: ["key", "api", "preferences"],
    run: () => useChatStore.getState().setSettingsOpen(true),
  },
  {
    id: "help",
    description: "Show all commands",
    icon: LifeBuoy,
    group: "Session",
    keywords: ["commands", "?"],
    run: () => ({ draft: "/" }),
  },
];

/** Registry by command token ("compact" → the /compact command) */
export const CHAT_COMMAND_BY_ID: ReadonlyMap<string, ChatCommand> = new Map(
  CHAT_COMMANDS.map((c) => [c.id, c])
);

/**
 * Commands offered in the menu right now: availability-filtered,
 * then ranked against the typed token. `isStreaming` gates the
 * streaming-only commands (/stop) and hides the ones that need a
 * settled transcript (/retry, /clear).
 */
export function commandsFor(query: string, ctx: { isStreaming: boolean }): ChatCommand[] {
  const offered = CHAT_COMMANDS.filter((c) => !c.available || c.available(ctx));
  const ranked = rankCommandSpecs(offered, query);
  // A token typed in full is always offered, even when the command is
  // not applicable right now — selecting it explains itself ("nothing
  // is streaming") instead of leaving the keystroke silently dead.
  const typed = query.trim().toLowerCase();
  if (typed) {
    const exact = CHAT_COMMANDS.find((c) => c.id === typed);
    if (exact && !ranked.includes(exact)) ranked.unshift(exact);
  }
  return ranked;
}

/** Runs a command by id with the given argument (typed-input path) */
export async function runCommandById(
  id: string,
  ctx: ChatCommandContext
): Promise<CommandOutcome | void> {
  const command = CHAT_COMMAND_BY_ID.get(id);
  if (!command) return;
  return command.run(ctx);
}
