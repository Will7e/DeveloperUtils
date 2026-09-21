// ============================================================
// Chat Commands — Slash Command Registry
// ============================================================
// Every command maps onto an existing store action or service —
// no new backend behavior. The registry is consumed by the
// composer's command menu (CommandMenu.tsx) and the plain-text
// fallback in sendUserMessage keeps accepting typed commands.
//
// /compact's toast logic lives in services/compaction.ts
// (runCompactCommand) so the menu and the typed fallback share one
// implementation without a runner ↔ commands import cycle.

import {
  ArrowDownToLine,
  Bot,
  MessageSquarePlus,
  Settings,
  Shapes,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { downloadConversation } from "../services/chat-runner";
import { runCompactCommand } from "../services/compaction";
import { CURATED_FALLBACK_MODELS } from "../constants";
import type { ModelInfo } from "../types";

function toast(message: string, type: "success" | "error" | "info"): void {
  useAppStore.getState().addToast({ message, type, duration: 5000 });
}

/**
 * Resolves a "/model <query>" argument against the available models:
 * exact id, then case-insensitive substring on id or display name.
 */
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
    catalog.find(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    )
  );
}

/** Context handed to a command when it runs */
export interface ChatCommandContext {
  /** Conversation the composer belongs to */
  conversationId: string;
  /** Everything after the command token (trimmed; "" when absent) */
  arg: string;
  /** Live model catalog (empty before the key-backed fetch succeeds) */
  models: ModelInfo[];
}

export interface ChatCommand {
  /** Command token without the slash */
  id: string;
  /** One-line description shown in the menu */
  description: string;
  icon: LucideIcon;
  /** Placeholder shown when the command expects an argument */
  argsHint?: string;
  /**
   * True when the menu should stay open and hand the query over to
   * a custom arg source (e.g. /model lists the catalog).
   */
  hasSubmenu?: boolean;
  run: (ctx: ChatCommandContext) => void;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    id: "compact",
    description: "Summarize older history to free context window",
    icon: Zap,
    run: ({ conversationId }) => void runCompactCommand(conversationId),
  },
  {
    id: "new",
    description: "Start a new conversation",
    icon: MessageSquarePlus,
    run: () => {
      const model = useChatStore.getState().settings.defaultModel;
      useChatStore.getState().createConversation(model);
    },
  },
  {
    id: "model",
    description: "Switch the model for this conversation",
    icon: Bot,
    argsHint: "model name…",
    hasSubmenu: true,
    run: ({ conversationId, arg, models }) => {
      const model = matchModelArg(arg, models, CURATED_FALLBACK_MODELS);
      if (!model) {
        toast(`No model matches “${arg.trim()}”.`, "error");
        return;
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
    id: "export",
    description: "Download this conversation as Markdown",
    icon: ArrowDownToLine,
    run: ({ conversationId }) => {
      const conv = useChatStore
        .getState()
        .conversations.find((c) => c.id === conversationId);
      if (!conv || conv.messages.length === 0) {
        toast("Nothing to export yet — send a message first.", "info");
        return;
      }
      downloadConversation(conversationId);
    },
  },
  {
    id: "settings",
    description: "Open chat settings",
    icon: Settings,
    run: () => useChatStore.getState().setSettingsOpen(true),
  },
  {
    id: "skills",
    description: "Manage skills and prompt modules",
    icon: Shapes,
    run: () => useChatStore.getState().setSettingsOpen(true, "skills"),
  },
];

/** Registry by command token ("compact" → the /compact command) */
export const CHAT_COMMAND_BY_ID: ReadonlyMap<string, ChatCommand> = new Map(
  CHAT_COMMANDS.map((c) => [c.id, c])
);

/**
 * Filters the registry for the menu: prefix matches on the command
 * name first, then substring matches on name or description.
 */
export function filterCommands(query: string): ChatCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return CHAT_COMMANDS;
  const prefix = CHAT_COMMANDS.filter((c) => c.id.startsWith(q));
  const rest = CHAT_COMMANDS.filter(
    (c) =>
      !c.id.startsWith(q) &&
      (c.id.includes(q) || c.description.toLowerCase().includes(q))
  );
  return [...prefix, ...rest];
}
