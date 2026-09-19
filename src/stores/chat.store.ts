// ============================================================
// AI Chat Store — Zustand with transparent AES-256-GCM Vault
// ============================================================

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createEncryptedStorage } from "@/services/encrypted-storage.service";
import { generateId } from "@/lib/utils";
import type {
  AIProvider,
  ChatConversation,
  ChatMessage,
  ChatSettings,
  ChatSkill,
} from "@/features/chat/types";
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SKILLS,
} from "@/features/chat/types";

export interface ChatStoreState {
  conversations: ChatConversation[];
  activeConversationId: string | null;
  settings: ChatSettings;

  // Transient state
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingContent: string;
  settingsModalOpen: boolean;
  systemPromptModalOpen: boolean;

  // Actions
  createConversation: (provider?: AIProvider, model?: string) => string;
  selectConversation: (id: string) => void;
  renameConversation: (id: string, newTitle: string) => void;
  deleteConversation: (id: string) => void;
  clearActiveConversation: () => void;
  addMessage: (
    conversationId: string,
    message: Omit<ChatMessage, "id" | "timestamp">
  ) => string;
  updateMessageContent: (
    conversationId: string,
    messageId: string,
    content: string
  ) => void;
  updateMessageError: (
    conversationId: string,
    messageId: string,
    error: boolean
  ) => void;

  setStreaming: (isStreaming: boolean, messageId?: string | null) => void;
  setStreamingContent: (content: string) => void;
  appendStreamingContent: (chunk: string) => void;

  updateSettings: (partial: Partial<ChatSettings>) => void;
  setApiKey: (provider: AIProvider, key: string) => void;
  setBaseUrl: (provider: AIProvider, url: string) => void;
  setConversationSystemPrompt: (conversationId: string, prompt: string) => void;
  setSettingsModalOpen: (open: boolean) => void;
  togglePinConversation: (id: string) => void;
  duplicateConversation: (id: string) => string;
  deleteMessage: (conversationId: string, messageId: string) => void;
  truncateMessagesFrom: (conversationId: string, messageId: string) => void;
  updateMessageMetadata: (
    conversationId: string,
    messageId: string,
    meta: { model?: string; latencyMs?: number }
  ) => void;

  toggleSkill: (id: string) => void;
  addSkill: (skill: Omit<ChatSkill, "id">) => void;
  updateSkill: (id: string, partial: Partial<ChatSkill>) => void;
  deleteSkill: (id: string) => void;
}

const isSupportedGeminiModel = (m?: string) =>
  m === "gemini-3.8-flash" || m === "gemini-3.6-flash";

const DEFAULT_SETTINGS: ChatSettings = {
  activeProvider: "openai",
  activeModel: "gpt-4o",
  defaultProvider: "openai",
  defaultModel: "gpt-4o",
  apiKeys: {
    openai: "",
    anthropic: "",
    gemini: "",
  },
  baseUrls: {
    openai: "",
    anthropic: "",
    gemini: "",
  },
  skills: DEFAULT_SKILLS,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.7,
  useProxy: false,
};

export const useChatStore = create<ChatStoreState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      settings: DEFAULT_SETTINGS,

      isStreaming: false,
      streamingMessageId: null,
      streamingContent: "",
      settingsModalOpen: false,
      systemPromptModalOpen: false,

      createConversation: (provider, model) => {
        const currentSettings = get().settings;
        const chosenProvider =
          provider ||
          currentSettings.activeProvider ||
          currentSettings.defaultProvider ||
          "openai";
        let chosenModel =
          model ||
          currentSettings.activeModel ||
          currentSettings.defaultModel ||
          "gpt-4o";

        if (chosenProvider === "gemini" && !isSupportedGeminiModel(chosenModel)) {
          chosenModel = "gemini-3.8-flash";
        }

        const newId = generateId();
        const newConversation: ChatConversation = {
          id: newId,
          title: "New Chat",
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          provider: chosenProvider,
          model: chosenModel,
          systemPrompt: currentSettings.systemPrompt,
        };

        set((state) => ({
          conversations: [newConversation, ...state.conversations],
          activeConversationId: newId,
          streamingContent: "",
          isStreaming: false,
          streamingMessageId: null,
        }));

        return newId;
      },

      selectConversation: (id) => {
        const found = get().conversations.find((c) => c.id === id);
        if (!found) return;

        let modelToUse = found.model;
        if (found.provider === "gemini" && !isSupportedGeminiModel(modelToUse)) {
          modelToUse = "gemini-3.8-flash";
        }

        set((state) => ({
          activeConversationId: id,
          streamingContent: "",
          isStreaming: false,
          streamingMessageId: null,
          settings: {
            ...state.settings,
            activeProvider: found.provider || state.settings.activeProvider,
            activeModel: modelToUse || state.settings.activeModel,
          },
        }));
      },

      renameConversation: (id, newTitle) => {
        const trimmed = newTitle.trim() || "Untitled Chat";
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title: trimmed, updatedAt: Date.now() } : c
          ),
        }));
      },

      deleteConversation: (id) => {
        set((state) => {
          const updated = state.conversations.filter((c) => c.id !== id);
          let nextActiveId = state.activeConversationId;

          if (state.activeConversationId === id) {
            nextActiveId = updated.length > 0 && updated[0] ? updated[0].id : null;
          }

          return {
            conversations: updated,
            activeConversationId: nextActiveId,
            streamingContent: "",
            isStreaming: false,
            streamingMessageId: null,
          };
        });
      },

      clearActiveConversation: () => {
        const { activeConversationId } = get();
        if (!activeConversationId) return;

        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === activeConversationId
              ? { ...c, messages: [], updatedAt: Date.now() }
              : c
          ),
          streamingContent: "",
          isStreaming: false,
          streamingMessageId: null,
        }));
      },

      addMessage: (conversationId, messageData) => {
        const msgId = generateId();
        const newMessage: ChatMessage = {
          ...messageData,
          id: msgId,
          timestamp: Date.now(),
        };

        set((state) => {
          return {
            conversations: state.conversations.map((c) => {
              if (c.id !== conversationId) return c;
              let title = c.title;
              if (
                title === "New Chat" &&
                messageData.role === "user" &&
                c.messages.length === 0
              ) {
                const titleText =
                  messageData.content.trim() ||
                  (messageData.images?.[0]?.name
                    ? `Image: ${messageData.images[0].name}`
                    : "Image");
                title =
                  titleText.slice(0, 36).replace(/\n/g, " ").trim() +
                  (titleText.length > 36 ? "..." : "");
              }
              return {
                ...c,
                title,
                messages: [...c.messages, newMessage],
                updatedAt: Date.now(),
              };
            }),
          };
        });

        return msgId;
      },

      updateMessageContent: (conversationId, messageId, content) => {
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, content } : m
              ),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      updateMessageError: (conversationId, messageId, error) => {
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, error } : m
              ),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      setStreaming: (isStreaming, messageId = null) => {
        set({ isStreaming, streamingMessageId: messageId });
      },

      setStreamingContent: (content) => {
        set({ streamingContent: content });
      },

      appendStreamingContent: (chunk) => {
        set((state) => ({
          streamingContent: state.streamingContent + chunk,
        }));
      },

      updateSettings: (partial) => {
        set((state) => {
          const nextSettings = { ...state.settings, ...partial };
          if (partial.activeProvider && !partial.defaultProvider) {
            nextSettings.defaultProvider = partial.activeProvider;
          }
          if (partial.activeModel && !partial.defaultModel) {
            nextSettings.defaultModel = partial.activeModel;
          }
          if (partial.defaultProvider && !partial.activeProvider) {
            nextSettings.activeProvider = partial.defaultProvider;
          }
          if (partial.defaultModel && !partial.activeModel) {
            nextSettings.activeModel = partial.defaultModel;
          }

          const activeId = state.activeConversationId;
          const updatedConversations = state.conversations.map((c) => {
            if (c.id === activeId) {
              return {
                ...c,
                provider: nextSettings.activeProvider || nextSettings.defaultProvider,
                model: nextSettings.activeModel || nextSettings.defaultModel,
              };
            }
            return c;
          });

          return {
            settings: nextSettings,
            conversations: updatedConversations,
          };
        });
      },

      setApiKey: (provider, key) => {
        set((state) => ({
          settings: {
            ...state.settings,
            apiKeys: {
              ...state.settings.apiKeys,
              [provider]: key.trim(),
            },
          },
        }));
      },

      setBaseUrl: (provider, url) => {
        set((state) => ({
          settings: {
            ...state.settings,
            baseUrls: {
              ...state.settings.baseUrls,
              [provider]: url.trim(),
            },
          },
        }));
      },

      setConversationSystemPrompt: (conversationId, prompt) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, systemPrompt: prompt } : c
          ),
        }));
      },

      setSettingsModalOpen: (open) => {
        set({ settingsModalOpen: open });
      },

      togglePinConversation: (id) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, pinned: !c.pinned, updatedAt: Date.now() } : c
          ),
        }));
      },

      duplicateConversation: (id) => {
        const target = get().conversations.find((c) => c.id === id);
        if (!target) return "";
        const newId = generateId();
        const cloned: ChatConversation = {
          ...target,
          id: newId,
          title: `${target.title} (Copy)`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          pinned: false,
          messages: target.messages.map((m) => ({
            ...m,
            id: generateId(),
            timestamp: Date.now(),
          })),
        };
        set((state) => ({
          conversations: [cloned, ...state.conversations],
          activeConversationId: newId,
        }));
        return newId;
      },

      deleteMessage: (conversationId, messageId) => {
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.filter((m) => m.id !== messageId),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      truncateMessagesFrom: (conversationId, messageId) => {
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const targetIdx = c.messages.findIndex((m) => m.id === messageId);
            if (targetIdx === -1) return c;
            return {
              ...c,
              messages: c.messages.slice(0, targetIdx),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      updateMessageMetadata: (conversationId, messageId, meta) => {
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, ...meta } : m
              ),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      toggleSkill: (id) => {
        set((state) => {
          const currentSkills = state.settings.skills || DEFAULT_SKILLS;
          return {
            settings: {
              ...state.settings,
              skills: currentSkills.map((s) =>
                s.id === id ? { ...s, enabled: !s.enabled } : s
              ),
            },
          };
        });
      },

      addSkill: (skill) => {
        set((state) => {
          const currentSkills = state.settings.skills || DEFAULT_SKILLS;
          const newSkill: ChatSkill = {
            ...skill,
            id: generateId(),
          };
          return {
            settings: {
              ...state.settings,
              skills: [...currentSkills, newSkill],
            },
          };
        });
      },

      updateSkill: (id, partial) => {
        set((state) => {
          const currentSkills = state.settings.skills || DEFAULT_SKILLS;
          return {
            settings: {
              ...state.settings,
              skills: currentSkills.map((s) =>
                s.id === id ? { ...s, ...partial } : s
              ),
            },
          };
        });
      },

      deleteSkill: (id) => {
        set((state) => {
          const currentSkills = state.settings.skills || DEFAULT_SKILLS;
          return {
            settings: {
              ...state.settings,
              skills: currentSkills.filter((s) => s.id !== id),
            },
          };
        });
      },
    }),
    {
      name: "intab_chat_store",
      storage: createJSONStorage(() => createEncryptedStorage()),
      merge: (persistedState: unknown, currentState: ChatStoreState) => {
        const persisted = persistedState as Partial<ChatStoreState> | undefined;
        const persistedSettings = persisted?.settings;

        let activeModel = persistedSettings?.activeModel || DEFAULT_SETTINGS.activeModel;
        let defaultModel = persistedSettings?.defaultModel || DEFAULT_SETTINGS.defaultModel;
        const activeProvider = persistedSettings?.activeProvider || DEFAULT_SETTINGS.activeProvider;

        if (activeProvider === "gemini" && !isSupportedGeminiModel(activeModel)) {
          activeModel = "gemini-3.8-flash";
        }
        if (defaultModel.startsWith("gemini") && !isSupportedGeminiModel(defaultModel)) {
          defaultModel = "gemini-3.8-flash";
        }

        const mergedSettings: ChatSettings = {
          activeProvider,
          activeModel,
          defaultProvider: persistedSettings?.defaultProvider || DEFAULT_SETTINGS.defaultProvider,
          defaultModel,
          apiKeys: {
            openai: persistedSettings?.apiKeys?.openai || "",
            anthropic: persistedSettings?.apiKeys?.anthropic || "",
            gemini: persistedSettings?.apiKeys?.gemini || "",
          },
          baseUrls: {
            openai: persistedSettings?.baseUrls?.openai || "",
            anthropic: persistedSettings?.baseUrls?.anthropic || "",
            gemini: persistedSettings?.baseUrls?.gemini || "",
          },
          skills: Array.isArray(persistedSettings?.skills) && persistedSettings.skills.length > 0
            ? persistedSettings.skills
            : DEFAULT_SKILLS,
          systemPrompt: persistedSettings?.systemPrompt || DEFAULT_SETTINGS.systemPrompt,
          temperature: typeof persistedSettings?.temperature === "number"
            ? persistedSettings.temperature
            : DEFAULT_SETTINGS.temperature,
          useProxy: Boolean(persistedSettings?.useProxy),
        };

        const sanitizedConversations = (Array.isArray(persisted?.conversations)
          ? persisted.conversations
          : currentState.conversations
        ).map((conv) => {
          if (conv.provider === "gemini" && !isSupportedGeminiModel(conv.model)) {
            return { ...conv, model: "gemini-3.8-flash" };
          }
          return conv;
        });

        return {
          ...currentState,
          ...persisted,
          settings: mergedSettings,
          conversations: sanitizedConversations,
          activeConversationId: persisted?.activeConversationId ?? currentState.activeConversationId,
        };
      },
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        settings: state.settings,
      }),
    }
  )
);
