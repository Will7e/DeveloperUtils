// ============================================================
// AI Chat Store — Zustand + AES-256-GCM Encrypted Persistence
// ============================================================
// Holds conversations, settings (incl. the OpenRouter API key —
// encrypted at rest via createEncryptedStorage), and transient
// streaming state. Actions are pure state mutations; streaming
// orchestration lives in services/chat-runner.ts.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createEncryptedStorage } from "@/services/encrypted-storage.service";
import { generateId } from "@/lib/utils";
import type {
  ChatConversation,
  ChatMessage,
  ChatSettings,
  ChatSkill,
  UsageInfo,
} from "@/features/chat/types";
import { DEFAULT_CHAT_SETTINGS, BUILTIN_SKILLS } from "@/features/chat/constants";
import { normalizeSkillsForSync, reconcileBuiltins } from "@/features/chat/lib/skills";

export interface ChatStoreState {
  conversations: ChatConversation[];
  activeConversationId: string | null;
  settings: ChatSettings;

  // ── Transient (not persisted) ──
  isStreaming: boolean;
  streamingConversationId: string | null;
  /** Content accumulated for the in-flight assistant message */
  streamingContent: string;
  /** True after abort — partial output is kept */
  wasAborted: boolean;
  settingsOpen: boolean;
  /** Tab to focus when the settings modal opens (transient) */
  settingsTab: "connection" | "chat" | "skills" | null;

  // ── Conversation actions ──
  createConversation: (model?: string) => string;
  selectConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  duplicateConversation: (id: string) => string | null;
  togglePinConversation: (id: string) => void;
  setConversationModel: (id: string, model: string | undefined) => void;
  setConversationSystemPrompt: (id: string, prompt: string | undefined) => void;

  // ── Message actions ──
  addMessage: (conversationId: string, message: Omit<ChatMessage, "id" | "timestamp">) => string;
  updateMessage: (
    conversationId: string,
    messageId: string,
    patch: Partial<Pick<ChatMessage, "content" | "error" | "model" | "latencyMs" | "usage">>
  ) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  /** Removes messages after (and including) messageId — for regenerate */
  truncateFrom: (conversationId: string, messageId: string) => void;

  // ── Streaming ──
  beginStreaming: (conversationId: string) => void;
  appendStreamingContent: (chunk: string) => void;
  /** Commits the streaming content as a real message; returns its id */
  commitStreamingMessage: (meta?: { model?: string; latencyMs?: number; usage?: UsageInfo }) => string | null;
  /** Discards in-flight content (used when stream produced nothing) */
  discardStreaming: () => void;
  endStreaming: (aborted: boolean) => void;

  // ── Settings ──
  updateSettings: (patch: Partial<ChatSettings>) => void;
  setSettingsOpen: (open: boolean, tab?: "connection" | "chat" | "skills") => void;
  setSettingsTab: (tab: "connection" | "chat" | "skills") => void;
  setSettingsModalState: (state: { settingsOpen: boolean; settingsTab: "connection" | "chat" | "skills" | null }) => void;

  // ── Skills ──
  addSkill: (skill: ChatSkill) => void;
  updateSkill: (id: string, patch: Partial<Omit<ChatSkill, "id" | "builtin">>) => void;
  deleteSkill: (id: string) => void;
  /** Restores all builtins to their pristine shipped state */
  resetBuiltinSkills: () => void;
}

function touchConversation(conv: ChatConversation): ChatConversation {
  return { ...conv, updatedAt: Date.now() };
}

function mapConversation(
  conversations: ChatConversation[],
  id: string,
  fn: (conv: ChatConversation) => ChatConversation
): ChatConversation[] {
  return conversations.map((c) => (c.id === id ? fn(c) : c));
}

const CHAT_STORAGE_NAME = "intab_chat_state";

/** Pristine builtin skill set (fresh objects each call) */
function pristineBuiltinSkills(): ChatSkill[] {
  return BUILTIN_SKILLS.map((s) => ({ ...s }));
}

export const useChatStore = create<ChatStoreState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      settings: DEFAULT_CHAT_SETTINGS,

      isStreaming: false,
      streamingConversationId: null,
      streamingContent: "",
      wasAborted: false,
      settingsOpen: false,
      settingsTab: null,

      // ── Conversations ──
      createConversation: (model) => {
        const id = generateId();
        const conv: ChatConversation = {
          id,
          title: "New Chat",
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          model,
        };
        set((s) => ({
          conversations: [conv, ...s.conversations],
          activeConversationId: id,
        }));
        return id;
      },

      selectConversation: (id) => set({ activeConversationId: id }),

      renameConversation: (id, title) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, id, (c) =>
            touchConversation({ ...c, title: title.trim() || c.title })
          ),
        })),

      deleteConversation: (id) =>
        set((s) => {
          const remaining = s.conversations.filter((c) => c.id !== id);
          const active =
            s.activeConversationId === id
              ? remaining[0]?.id ?? null
              : s.activeConversationId;
          return { conversations: remaining, activeConversationId: active };
        }),

      duplicateConversation: (id) => {
        const source = get().conversations.find((c) => c.id === id);
        if (!source) return null;
        const newId = generateId();
        const copy: ChatConversation = {
          ...source,
          id: newId,
          title: `${source.title} (copy)`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: source.messages.map((m) => ({ ...m, id: generateId() })),
        };
        set((s) => ({
          conversations: [copy, ...s.conversations],
          activeConversationId: newId,
        }));
        return newId;
      },

      togglePinConversation: (id) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, id, (c) => ({
            ...c,
            pinned: !c.pinned,
          })),
        })),

      setConversationModel: (id, model) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, id, (c) =>
            touchConversation({ ...c, model })
          ),
        })),

      setConversationSystemPrompt: (id, prompt) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, id, (c) =>
            touchConversation({ ...c, systemPrompt: prompt })
          ),
        })),

      // ── Messages ──
      addMessage: (conversationId, message) => {
        const id = generateId();
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              messages: [...c.messages, { ...message, id, timestamp: Date.now() }],
            })
          ),
        }));
        return id;
      },

      updateMessage: (conversationId, messageId, patch) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, ...patch } : m
              ),
            })
          ),
        })),

      deleteMessage: (conversationId, messageId) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              messages: c.messages.filter((m) => m.id !== messageId),
            })
          ),
        })),

      truncateFrom: (conversationId, messageId) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) => {
            const idx = c.messages.findIndex((m) => m.id === messageId);
            if (idx === -1) return c;
            return touchConversation({
              ...c,
              messages: c.messages.slice(0, idx),
            });
          }),
        })),

      // ── Streaming ──
      beginStreaming: (conversationId) =>
        set({
          isStreaming: true,
          streamingConversationId: conversationId,
          streamingContent: "",
          wasAborted: false,
        }),

      appendStreamingContent: (chunk) =>
        set((s) => ({ streamingContent: s.streamingContent + chunk })),

      commitStreamingMessage: (meta) => {
        const { streamingConversationId, streamingContent } = get();
        if (!streamingConversationId || !streamingContent.trim()) return null;
        const id = generateId();
        set((s) => ({
          conversations: mapConversation(s.conversations, streamingConversationId, (c) =>
            touchConversation({
              ...c,
              messages: [
                ...c.messages,
                {
                  id,
                  role: "assistant",
                  content: s.streamingContent,
                  timestamp: Date.now(),
                  ...meta,
                },
              ],
            })
          ),
        }));
        return id;
      },

      discardStreaming: () => set({ streamingContent: "" }),

      endStreaming: (aborted) =>
        set({ isStreaming: false, streamingConversationId: null, streamingContent: "", wasAborted: aborted }),

      // ── Skills ──
      addSkill: (skill) =>
        set((s) => ({
          settings: {
            ...s.settings,
            skills: [...s.settings.skills, skill],
          },
        })),

      updateSkill: (id, patch) =>
        set((s) => ({
          settings: {
            ...s.settings,
            skills: s.settings.skills.map((skill) =>
              skill.id === id
                ? {
                    ...skill,
                    ...patch,
                    updated: skill.builtin ? true : skill.updated,
                  }
                : skill
            ),
          },
        })),

      deleteSkill: (id) =>
        set((s) => ({
          settings: {
            ...s.settings,
            skills: s.settings.skills.filter((skill) => skill.id !== id),
          },
        })),

      resetBuiltinSkills: () =>
        set((s) => {
          // Restores all builtins to their pristine shipped state,
          // dropping any user edits (updated builtins included).
          const userSkills = s.settings.skills.filter((skill) => !skill.builtin);
          return {
            settings: {
              ...s.settings,
              skills: [...pristineBuiltinSkills(), ...userSkills],
            },
          };
        }),

      // ── Settings ──
      updateSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),

      setSettingsOpen: (open, tab) =>
        set({ settingsOpen: open, settingsTab: open ? tab ?? null : null }),

      setSettingsTab: (tab) => set({ settingsTab: tab }),

      setSettingsModalState: ({ settingsOpen, settingsTab }) =>
        set({ settingsOpen, settingsTab }),
    }),
    {
      name: CHAT_STORAGE_NAME,
      storage: createJSONStorage(() => createEncryptedStorage()),
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        settings: state.settings,
      }),
      // Never hydrate transient streaming flags from disk; reconcile
      // shipped builtins and sanitize skills arriving via cloud sync.
      merge: (persisted, current) => {
        const p = persisted as Partial<ChatStoreState>;
        const settings = p.settings as ChatSettings | undefined;
        const skills = normalizeSkillsForSync(settings?.skills);
        const reconciled = reconcileBuiltins(skills);
        return {
          ...current,
          ...p,
          settings: {
            ...DEFAULT_CHAT_SETTINGS,
            ...settings,
            skills: reconciled ?? skills,
          },
          isStreaming: false,
          streamingConversationId: null,
          streamingContent: "",
          wasAborted: false,
          settingsOpen: false,
          settingsTab: null,
        };
      },
    }
  )
);

/** Selector: the active conversation object (or undefined) */
export function selectActiveConversation(state: ChatStoreState): ChatConversation | undefined {
  return state.conversations.find((c) => c.id === state.activeConversationId);
}
