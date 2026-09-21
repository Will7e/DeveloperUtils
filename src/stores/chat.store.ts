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
  ConversationSummary,
  PendingPush,
  RepoContext,
  ToolCallRequest,
  ToolCallResult,
  UsageInfo,
  WorkspaceState,
} from "@/features/chat/types";
import {
  hydrateTree,
  loadWorkspace,
  flushWorkspaceSave,
  deleteWorkspace as deleteWorkspaceFromIdb,
} from "@/features/chat/workspace/workspace";
import { DEFAULT_CHAT_SETTINGS, BUILTIN_SKILLS, INTAB_MODEL_ID } from "@/features/chat/constants";
import { normalizeSkillsForSync, reconcileBuiltins } from "@/features/chat/lib/skills";
import { PENDING_TURN_MAX_AGE_MS } from "@/features/chat/session/resume-plan";

export interface ChatStoreState {
  conversations: ChatConversation[];
  activeConversationId: string | null;
  settings: ChatSettings;

  // ── Transient (not persisted) ──
  isStreaming: boolean;
  streamingConversationId: string | null;
  /** Content accumulated for the in-flight assistant message */
  streamingContent: string;
  /** Reasoning-token text accumulated for the in-flight message */
  streamingReasoning: string;
  /** True after abort — partial output is kept */
  wasAborted: boolean;
  /** True while a resume attempt is reconnecting (transient banner) */
  reconnecting: boolean;
  settingsOpen: boolean;
  /** Tab to focus when the settings modal opens (transient) */
  settingsTab: "connection" | "chat" | "skills" | "github" | null;

  // ── Agent workspace (transient; hydrated from IndexedDB) ──
  /** conversationId → workspace */
  workspaces: Record<string, WorkspaceState>;
  /** Push awaiting user approval (one at a time, app-wide) */
  pendingPush: PendingPush | null;
  /** Resolve callbacks for the push approval gate */
  pushGate: {
    resolve: (approved: boolean, note?: string) => void;
    conversationId: string;
  } | null;

  // ── Workspace actions ──
  setWorkspace: (conversationId: string, ws: WorkspaceState) => void;
  patchWorkspace: (conversationId: string, ws: WorkspaceState) => void;
  /** Ensures a workspace exists for the repo (creating + hydrating tree) */
  ensureWorkspace: (conversationId: string) => Promise<WorkspaceState | null>;
  removeWorkspace: (conversationId: string) => void;
  /** Opens the approval gate; resolves when the user decides */
  requestPushApproval: (pending: PendingPush) => Promise<{ approved: boolean; note?: string }>;
  resolvePushApproval: (approved: boolean, note?: string) => void;
  clearPendingPush: () => void;

  // ── Conversation actions ──
  createConversation: (model?: string) => string;
  selectConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  duplicateConversation: (id: string) => string | null;
  togglePinConversation: (id: string) => void;
  setConversationModel: (id: string, model: string | undefined) => void;
  setConversationSystemPrompt: (id: string, prompt: string | undefined) => void;
  /** Attaches/detaches the GitHub repo this conversation works against */
  setConversationRepo: (id: string, repo: RepoContext | undefined) => void;
  /** Replaces the oldest `summary.coversCount` messages with the rolling summary */
  applyCompaction: (conversationId: string, summary: ConversationSummary) => void;
  /**
   * Clears what the model sees for a conversation (/clear): every
   * stored message is soft-hidden and the rolling summary dropped.
   * Nothing is destroyed — the session log stays reconstructable.
   */
  clearConversationContext: (conversationId: string) => void;

  // ── Message actions ──
  addMessage: (conversationId: string, message: Omit<ChatMessage, "id" | "timestamp">) => string;
  updateMessage: (
    conversationId: string,
    messageId: string,
    patch: Partial<Pick<ChatMessage, "content" | "error" | "model" | "latencyMs" | "usage">>
  ) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  /** Soft-hides messages from messageId on — for regenerate (session log) */
  truncateFrom: (conversationId: string, messageId: string) => void;
  /** Restores soft-deleted messages from messageId on (inverse of truncateFrom) */
  restoreHiddenFrom: (conversationId: string, messageId: string) => void;

  // ── Streaming ──
  beginStreaming: (conversationId: string) => void;
  /** Marks a turn started-but-uncommitted (persisted, drives reload resume) */
  markPendingTurn: (conversationId: string) => void;
  /** Clears the pending-turn marker (turn outcome committed) */
  clearPendingTurn: (conversationId: string) => void;
  appendStreamingContent: (chunk: string) => void;
  /** Appends reasoning-token text (reasoning models via OpenRouter) */
  appendStreamingReasoning: (chunk: string) => void;
  /** Commits the streaming content as a real message; returns its id */
  commitStreamingMessage: (meta?: {
    model?: string;
    latencyMs?: number;
    usage?: UsageInfo;
    reasoning?: string;
    reasoningMs?: number;
    /** Message routed through the InTab LLM virtual model (UI mask) */
    viaInTab?: boolean;
    /** Task kind the router classified this turn as (InTab messages) */
    turnKind?: "quick" | "code" | "analysis" | "vision" | "agent";
  }) => string | null;
  /** Commits an in-flight assistant tool-calls message (agent mode) */
  commitToolCallsMessage: (
    conversationId: string,
    calls: ToolCallRequest[],
    meta?: { content?: string; reasoning?: string; model?: string }
  ) => string;
  /** Commits one tool result (paired to its request via callId) */
  commitToolResult: (
    conversationId: string,
    result: ToolCallResult,
    content: string
  ) => void;
  /**
   * Host-mode rendering: commits the in-flight assistant message
   * directly (streaming text bypasses streamingContent). Returns
   * the new message id, or null when the conversation is gone.
   */
  commitDirectAssistantMessage: (
    conversationId: string,
    message: Pick<ChatMessage, "content"> & Partial<ChatMessage>
  ) => string | null;
  /** Discards in-flight content (used when stream produced nothing) */
  discardStreaming: () => void;
  endStreaming: (aborted: boolean) => void;

  // ── Settings ──
  updateSettings: (patch: Partial<ChatSettings>) => void;
  setSettingsOpen: (open: boolean, tab?: "connection" | "chat" | "skills" | "github") => void;
  setSettingsTab: (tab: "connection" | "chat" | "skills" | "github") => void;
  setSettingsModalState: (state: {
    settingsOpen: boolean;
    settingsTab: "connection" | "chat" | "skills" | "github" | null;
  }) => void;  /** Hydration-time cleanup of stale pending-turn markers */
  cleanupStalePendingTurns: () => void;
  /** Toggles the reconnecting banner (resume retries) */
  setReconnecting: (value: boolean) => void;

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
      streamingReasoning: "",
      wasAborted: false,
      reconnecting: false,
      settingsOpen: false,
      settingsTab: null,

      workspaces: {},
      pendingPush: null,
      pushGate: null,

      // ── Workspace ──
      setWorkspace: (conversationId, ws) =>
        set((s) => ({ workspaces: { ...s.workspaces, [conversationId]: ws } })),

      patchWorkspace: (conversationId, ws) =>
        set((s) => ({ workspaces: { ...s.workspaces, [conversationId]: ws } })),

      ensureWorkspace: async (conversationId) => {
        const state = get();
        const existing = state.workspaces[conversationId];
        if (existing) return existing;
        const conv = state.conversations.find((c) => c.id === conversationId);
        const repo = conv?.repoContext;
        const token = state.settings.github.token;
        if (!repo || !token) return null;

        // Rehydrate from IDB or create fresh; pin the base commit.
        // Branch must match too: re-attaching the repo on a different
        // branch invalidates the persisted tree, base commit, and
        // pending diffs, so those start fresh rather than pushing
        // from a stale base.
        const persisted = await loadWorkspace(conversationId);
        if (
          persisted &&
          persisted.owner === repo.owner &&
          persisted.repo === repo.repo &&
          persisted.branch === repo.branch
        ) {
          set((s) => ({ workspaces: { ...s.workspaces, [conversationId]: persisted } }));
          return persisted;
        }

        const [{ getBranchHead }, { createWorkspace }] = await Promise.all([
          import("@/features/chat/lib/github-write"),
          import("@/features/chat/workspace/workspace"),
        ]);
        let baseSha: string;
        try {
          baseSha = (await getBranchHead(token, repo.owner, repo.repo, repo.branch)).commitSha;
        } catch {
          return null; // no write-capable base — agent stays read-only
        }
        const fresh = createWorkspace(conversationId, repo.owner, repo.repo, repo.branch, baseSha);
        try {
          const hydrated = await hydrateTree(fresh, token);
          set((s) => ({ workspaces: { ...s.workspaces, [conversationId]: hydrated } }));
          void flushWorkspaceSave(conversationId, hydrated);
          return hydrated;
        } catch {
          // Tree fetch failed — workspace still usable for writes w/o tree
          set((s) => ({ workspaces: { ...s.workspaces, [conversationId]: fresh } }));
          return fresh;
        }
      },

      removeWorkspace: (conversationId) =>
        set((s) => {
          const next = { ...s.workspaces };
          delete next[conversationId];
          void deleteWorkspaceFromIdb(conversationId);
          return { workspaces: next };
        }),

      requestPushApproval: (pending) =>
        new Promise((resolve) => {
          set({
            pendingPush: pending,
            pushGate: {
              conversationId: pending.conversationId,
              resolve: (approved, note) => resolve({ approved, note }),
            },
          });
        }),

      resolvePushApproval: (approved, note) =>
        set((s) => {
          const gate = s.pushGate;
          if (gate) gate.resolve(approved, note);
          return { pushGate: null, pendingPush: approved ? null : s.pendingPush };
        }),

      clearPendingPush: () =>
        set((s) => {
          // Defensive: if the gate is still open (e.g. the modal was
          // unmounted without deciding, or a caller cleared before
          // resolving), reject it so the awaiting tool executor never
          // hangs on an unresolved promise.
          if (s.pushGate) s.pushGate.resolve(false);
          return { pendingPush: null, pushGate: null };
        }),
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
          // A pending marker belongs to the original's turn, not the copy
          pendingTurn: undefined,
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

      setConversationRepo: (id, repo) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, id, (c) =>
            // Stamp attachedAt here (impure Date.now stays out of render)
            touchConversation({
              ...c,
              repoContext: repo ? { ...repo, attachedAt: Date.now() } : undefined,
            })
          ),
        })),

      applyCompaction: (conversationId, summary) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              // Drop the folded messages — the summary carries their
              // memory. coversCount was snapped to a user boundary,
              // so the kept tail still starts with a user turn.
              messages: c.messages.slice(summary.coversCount),
              summary,
            })
          ),
        })),

      clearConversationContext: (conversationId) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              messages: c.messages.map((m) => (m.hidden ? m : { ...m, hidden: true })),
              // The summary describes the history being cleared — it
              // would otherwise keep feeding the model the very
              // context the user just asked to drop.
              summary: undefined,
            })
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

      // Soft delete (append-only session log): regenerate hides the
      // discarded reply instead of destroying it, so every request
      // payload stays reconstructable from stored history.
      truncateFrom: (conversationId, messageId) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) => {
            const idx = c.messages.findIndex((m) => m.id === messageId);
            if (idx === -1) return c;
            return touchConversation({
              ...c,
              messages: c.messages.map((m, i) => (i >= idx ? { ...m, hidden: true } : m)),
            });
          }),
        })),

      restoreHiddenFrom: (conversationId, messageId) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) => {
            const idx = c.messages.findIndex((m) => m.id === messageId);
            if (idx === -1) return c;
            return touchConversation({
              ...c,
              messages: c.messages.map((m, i) => (i >= idx ? { ...m, hidden: false } : m)),
            });
          }),
        })),

      // ── Streaming ──
      beginStreaming: (conversationId) =>
        set({
          isStreaming: true,
          streamingConversationId: conversationId,
          streamingContent: "",
          streamingReasoning: "",
          wasAborted: false,
        }),

      markPendingTurn: (conversationId) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({ ...c, pendingTurn: { startedAt: Date.now() } })
          ),
        })),

      clearPendingTurn: (conversationId) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            // touchConversation would stamp updatedAt on every stream
            // iteration; the marker is bookkeeping, not activity
            c.pendingTurn
              ? { ...c, pendingTurn: undefined }
              : c
          ),
        })),

      // Zombie-renderer guard: a stale renderer (adoption racing the
      // fresh turn, or a torn-down round that missed its unsubscribe)
      // must never append into a NEW turn's streaming buffer — that
      // is exactly the doubled/garbled-output symptom.
      appendStreamingContent: (chunk) =>
        set((s) =>
          s.isStreaming && s.streamingConversationId
            ? { streamingContent: s.streamingContent + chunk }
            : s
        ),

      appendStreamingReasoning: (chunk) =>
        set((s) => ({ streamingReasoning: s.streamingReasoning + chunk })),

      commitStreamingMessage: (meta) => {
        const { streamingConversationId, streamingContent, streamingReasoning } = get();
        if (!streamingConversationId || !streamingContent.trim()) return null;
        const id = generateId();
        const reasoning = meta?.reasoning ?? streamingReasoning;
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
                  reasoning: reasoning || undefined,
                  ...meta,
                },
              ],
            })
          ),
        }));
        return id;
      },

      discardStreaming: () => set({ streamingContent: "", streamingReasoning: "" }),

      commitToolCallsMessage: (conversationId, calls, meta) => {
        const id = generateId();
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              messages: [
                ...c.messages,
                {
                  id,
                  role: "assistant",
                  content: meta?.content ?? "",
                  timestamp: Date.now(),
                  reasoning: meta?.reasoning || undefined,
                  model: meta?.model,
                  toolCalls: { kind: "tool_calls", calls },
                },
              ],
            })
          ),
        }));
        return id;
      },

      commitToolResult: (conversationId, result, content) => {
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              messages: [
                ...c.messages,
                {
                  id: generateId(),
                  role: "user",
                  content: "",
                  timestamp: Date.now(),
                  toolResult: {
                    kind: "tool_result",
                    callId: result.callId,
                    name: result.name,
                    ok: result.ok,
                    content,
                    durationMs: result.durationMs,
                    summary: result.summary,
                  },
                },
              ],
            })
          ),
        }));
      },

      endStreaming: (aborted) =>
        set({
          isStreaming: false,
          streamingConversationId: null,
          streamingContent: "",
          streamingReasoning: "",
          wasAborted: aborted,
        }),

      commitDirectAssistantMessage: (conversationId, message) => {
        const id = generateId();
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              messages: [
                ...c.messages,
                {
                  id,
                  role: "assistant",
                  timestamp: Date.now(),
                  ...message,
                },
              ],
            })
          ),
        }));
        return id;
      },

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

      setReconnecting: (value) => set({ reconnecting: value }),

      /** Clears pendingTurn markers that outlived their turn (>24h) */
      cleanupStalePendingTurns: () =>
        set((s) => {
          const now = Date.now();
          let changed = false;
          const conversations = s.conversations.map((c) => {
            if (
              c.pendingTurn &&
              now - c.pendingTurn.startedAt > PENDING_TURN_MAX_AGE_MS
            ) {
              changed = true;
              return { ...c, pendingTurn: undefined };
            }
            return c;
          });
          return changed ? { conversations } : s;
        }),
    }),
    {
      name: CHAT_STORAGE_NAME,
      storage: createJSONStorage(() => createEncryptedStorage()),
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        settings: state.settings,
      }),
      // NOTE: pendingTurn rides inside conversations, so it persists
      // automatically — that's what makes reload-resume detectable.
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
            // Versioned default: existing installs move to InTab LLM
            // when it shipped. Conversations with an explicit model
            // choice are untouched; legacy unset chats resolve to it
            // via the `?? settings.defaultModel` fallback at send time.
            defaultModel:
              settings?.defaultModel === "openai/gpt-4o-mini"
                ? INTAB_MODEL_ID
                : (settings?.defaultModel ?? DEFAULT_CHAT_SETTINGS.defaultModel),
            github: {
              ...DEFAULT_CHAT_SETTINGS.github,
              ...settings?.github,
            },
            skills: reconciled ?? skills,
          },
          isStreaming: false,
          streamingConversationId: null,
          streamingContent: "",
          wasAborted: false,
          reconnecting: false,
          settingsOpen: false,
          settingsTab: null,
          workspaces: {},
          pendingPush: null,
          pushGate: null,
        };
      },
    }
  )
);

/** Selector: the active conversation object (or undefined) */
export function selectActiveConversation(state: ChatStoreState): ChatConversation | undefined {
  return state.conversations.find((c) => c.id === state.activeConversationId);
}
