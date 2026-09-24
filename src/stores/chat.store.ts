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
  AgentPlan,
  AgentQuestion,
  AgentSuggestion,
  ChatAttachment,
  ChatConversation,
  ChatMessage,
  ChatMode,
  ChatSettings,
  ChatSkill,
  ConversationSummary,
  HttpApprovalDecision,
  PendingHttpRequest,
  PendingPush,
  PushDecision,
  QueuedUserMessage,
  ReasoningEffort,
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
  pendingChangeCount,
  workspaceMatchesRepo,
  deleteWorkspace as deleteWorkspaceFromIdb,
} from "@/features/chat/workspace/workspace";
import {
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_CHAT_MODEL,
  BUILTIN_SKILLS,
  isLegacyIntabModelId,
} from "@/features/chat/constants";
import { normalizeSkillsForSync, reconcileBuiltins } from "@/features/chat/lib/skills";
import { PENDING_TURN_MAX_AGE_MS } from "@/features/chat/session/resume-plan";
import {
  bindingIdOf,
  clearAttachment,
  forgetThread,
  setAttachment,
} from "@/features/chat/identity/bindings";
import { attachmentIdOf, bindingKey, isAttached } from "@/features/chat/identity/identity";

/**
 * What a new chat starts from.
 *
 * Omitted → inherit the active chat's repository and mode. `repo: null` asks
 * for a chat with no repository; `repo: {...}` names a different one.
 */
export interface ConversationSeed {
  repo?: RepoContext | null;
  mode?: ChatMode;
}

/**
 * What one thread's composer holds: text typed but not sent, and the files
 * attached to it.
 *
 * A draft belongs to the chat it was typed in, which is why this is keyed by
 * conversation and lives here rather than in the page's own state: a single
 * shared draft carried the text (and the images) into the wrong thread on a
 * switch, where Enter would send it.
 */
export interface ComposerDraft {
  draft: string;
  images: ChatAttachment[];
}

/** A new draft string, or a function of the previous one */
export type ComposerDraftUpdate = string | ((previous: string) => string);

const EMPTY_COMPOSER_DRAFT: ComposerDraft = { draft: "", images: [] };

/**
 * One conversation's in-flight assistant output.
 *
 * Held together as one value because the three fields share a lifetime: the
 * buffer exists exactly while the stream does, and `startedAt` is what lets a
 * UI order several live streams by who started first.
 */
export interface ConversationStream {
  /** Content accumulated for the in-flight assistant message */
  content: string;
  /** Reasoning-token text accumulated for the in-flight message */
  reasoning: string;
  /** When this stream started (ms since epoch) */
  startedAt: number;
}

/** Part of an approval that is the same whoever is asking */
interface ApprovalBase {
  /** Stable id, so a dialog answers the request it was opened for */
  id: string;
  /** The thread whose agent is waiting */
  conversationId: string;
  createdAt: number;
}

/**
 * An action parked on the user's decision.
 *
 * The resolver travels WITH the request rather than in a parallel slot, so a
 * second agent asking for something cannot displace the first one's answer.
 */
export type PendingApproval =
  | (ApprovalBase & {
      kind: "push";
      request: PendingPush;
      resolve: (decision: PushDecision) => void;
    })
  | (ApprovalBase & {
      kind: "http";
      request: PendingHttpRequest;
      resolve: (decision: HttpApprovalDecision) => void;
    });

/** The decision an approval of either kind carries */
export type ApprovalDecision = PushDecision | HttpApprovalDecision;

export interface ChatStoreState {
  conversations: ChatConversation[];
  activeConversationId: string | null;
  settings: ChatSettings;

  // ── Transient (not persisted) ──
  /**
   * In-flight assistant text, ONE ENTRY PER STREAMING CONVERSATION.
   *
   * Keyed by conversation rather than held in a single slot because several
   * agents can be working at once. With one app-wide buffer, two live streams
   * appended into the same string — a delta belonging to one thread landed in
   * another thread's message — and the commit took whichever conversation the
   * slot happened to name. The key is what makes that unrepresentable: every
   * append says which conversation it belongs to, and an append for a stream
   * that is over is dropped rather than folded into a neighbour.
   */
  streams: Record<string, ConversationStream>;
  /**
   * Conversations whose last stream was stopped by the user.
   *
   * Per conversation for the same reason the buffers are: "you stopped this
   * one" is a fact about a thread, and an app-wide flag would have one Stop
   * mark every other agent's finished reply as aborted too.
   */
  abortedStreams: Record<string, true>;
  /**
   * Conversations whose resume attempt is reconnecting right now.
   *
   * Keyed by conversation like every other transient here: a resume belongs to
   * ONE thread, and an app-wide flag would put "reconnecting…" on a chat that is
   * answering normally because a different one lost its stream.
   */
  reconnecting: Record<string, true>;
  settingsOpen: boolean;
  /** Tab to focus when the settings modal opens (transient) */
  settingsTab: "connection" | "chat" | "skills" | "github" | "companion" | null;
  /**
   * A user-initiated verification run, while it is in flight.
   *
   * In the store rather than in the Changes pane's own state because the pane is
   * not the only surface that has to know: a type check over a large workspace
   * takes tens of seconds, and the activity rail above the composer claiming the
   * agent is idle during it is exactly the "is it hung?" question the rail exists
   * to answer. Keyed by conversation so a run cannot make another thread look busy.
   */
  checkRuns: Record<string, number>;

  /**
   * When each thread was last on screen, for the list's "finished while you were
   * away" dot.
   *
   * Session-only, and absent from `partialize` on purpose: it is a fact about
   * THIS visit rather than about the work, and a timestamp persisted three weeks
   * ago deciding whether a dot shows today is a lie either way it lands. It also
   * cannot be derived from the conversation, because "you were looking at a
   * different chat when this finished" is not written down anywhere in it.
   */
  lastSeenAt: Record<string, number>;
  /** Records that a thread is on screen right now (see lastSeenAt) */
  markConversationSeen: (id: string) => void;
  /**
   * Stamps every thread that has not been on screen yet as seen as of now.
   *
   * Called once when the list mounts. Activity AFTER you arrived is news;
   * history that predates the session is not, and a cold start over thirty old
   * chats must not look like thirty alerts.
   */
  seedConversationSeen: () => void;

  // ── Composer (transient, per thread) ──
  /** conversationId → what is typed and attached, not yet sent */
  composerDrafts: Record<string, ComposerDraft>;
  setComposerDraft: (conversationId: string, update: ComposerDraftUpdate) => void;
  setComposerImages: (conversationId: string, images: ChatAttachment[]) => void;

  // ── Agent workspace (transient; hydrated from IndexedDB) ──
  /** conversationId → workspace */
  workspaces: Record<string, WorkspaceState>;
  /**
   * Agent actions parked on the user's decision, OLDEST FIRST.
   *
   * A queue rather than the single slot these used to be. "One at a time,
   * app-wide" stopped being a queuing rule the moment two agents could run at
   * once: a second request REPLACED the first, so the first agent's promise
   * was never resolved and its turn hung behind a dialog nobody could see.
   * Each entry carries its own resolver and the conversation it belongs to,
   * and the UI shows the head of the queue — so the other one waits, visibly,
   * instead of vanishing.
   *
   * Push and HTTP stay separate KINDS in one queue rather than two queues:
   * they answer different questions ("may I ship this diff?" vs "may I send
   * this request?"), and sharing one dialog at a time is only safe when the
   * kind is what tells them apart.
   */
  approvals: PendingApproval[];

  // ── Workspace actions ──
  setWorkspace: (conversationId: string, ws: WorkspaceState) => void;
  patchWorkspace: (conversationId: string, ws: WorkspaceState) => void;
  /** Ensures a workspace exists for the repo (creating + hydrating tree) */
  ensureWorkspace: (conversationId: string) => Promise<WorkspaceState | null>;
  removeWorkspace: (conversationId: string) => void;
  /** Opens the push gate; resolves when the user decides */
  requestPushApproval: (pending: PendingPush) => Promise<PushDecision>;
  /** Opens the HTTP write gate; resolves when the user decides */
  requestHttpApproval: (pending: PendingHttpRequest) => Promise<HttpApprovalDecision>;
  /** Answers ONE waiting approval by id; a no-op when it is already gone */
  resolveApproval: (id: string, decision: ApprovalDecision) => void;
  /** Refuses and drops one waiting approval (a dismissed dialog) */
  dismissApproval: (id: string, note?: string) => void;
  /**
   * Refuses and drops every approval belonging to one conversation.
   *
   * This is what Stop does: an approval gate is a WAIT, and a wait that
   * outlives its turn leaves that agent parked forever behind a dialog for
   * work the user already ended.
   */
  dismissApprovalsFor: (conversationId: string, note?: string) => void;

  // ── Conversation actions ──
  /**
   * Starts a new chat. Inherits the active chat's repository and mode unless
   * `seed` says otherwise — see the implementation for why that is the
   * default rather than an empty chat.
   */
  createConversation: (model?: string, seed?: ConversationSeed) => string;
  selectConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  duplicateConversation: (id: string) => string | null;
  togglePinConversation: (id: string) => void;
  setConversationModel: (id: string, model: string | undefined) => void;
  /** Sets this conversation's reasoning-effort rung */
  setConversationEffort: (id: string, effort: ReasoningEffort | undefined) => void;
  /** Sets this conversation's agent mode (build/plan) */
  setConversationMode: (id: string, mode: ChatMode | undefined) => void;
  setConversationSystemPrompt: (id: string, prompt: string | undefined) => void;
  /** Attaches/detaches the GitHub repo this conversation works against */
  setConversationRepo: (id: string, repo: RepoContext | undefined) => void;
  /** Replaces the agent's living plan for this conversation */
  setConversationPlan: (id: string, plan: AgentPlan | undefined) => void;
  /**
   * Sets (or clears, with `undefined`) the question this conversation's turn
   * is parked on. Persisted, because a reload has to render the same card
   * and the answer has to resume the loop (see services/ask-user.ts).
   */
  setPendingQuestion: (conversationId: string, question: AgentQuestion | undefined) => void;
  /** Replaces the clickable next steps offered by the last turn */
  setSuggestions: (conversationId: string, suggestions: AgentSuggestion[] | undefined) => void;
  /**
   * Queues a message the user sent while the turn was running. It is
   * delivered at the next round boundary (never dropped, never interleaved
   * into a tool result the model has not read yet).
   */
  enqueueUserMessage: (
    conversationId: string,
    message: { text: string; attachments?: ChatAttachment[] }
  ) => string;
  removeQueuedMessage: (conversationId: string, id: string) => void;
  /** Takes the oldest queued message, removing it (undefined when empty) */
  shiftQueuedMessage: (conversationId: string) => QueuedUserMessage | undefined;
  /**
   * Commits a compaction: the folded messages are removed and the rolling
   * summary replaces their memory. Removal is BY ID, not by count —
   * hidden rows (cleared history, soft-deleted regenerations) can sit
   * anywhere in the array and must survive: "/clear" promises nothing is
   * destroyed, and `summary.coversCount` is cumulative, so slicing by it
   * would cut the wrong messages.
   */
  applyCompaction: (
    conversationId: string,
    summary: ConversationSummary,
    removedMessageIds: readonly string[]
  ) => void;
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
  appendStreamingContent: (conversationId: string, chunk: string) => void;
  /** Appends reasoning-token text (reasoning models via OpenRouter) */
  appendStreamingReasoning: (conversationId: string, chunk: string) => void;
  /** Commits the streaming content as a real message; returns its id */
  commitStreamingMessage: (conversationId: string, meta?: {
    model?: string;
    latencyMs?: number;
    usage?: UsageInfo;
    reasoning?: string;
    reasoningMs?: number;
    /** Reasoning rung the turn was sent with */
    effort?: ReasoningEffort;
    /** Agent mode the turn ran under */
    mode?: ChatMode;
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
  /** Discards in-flight content for one conversation (stream produced nothing) */
  discardStreaming: (conversationId: string) => void;
  /** Ends one conversation's stream, dropping its buffer */
  endStreaming: (conversationId: string, aborted: boolean) => void;
  /** Drops every in-flight stream (teardown paths that replace the app state) */
  clearStreams: () => void;

  // ── Settings ──
  updateSettings: (patch: Partial<ChatSettings>) => void;
  setSettingsOpen: (
    open: boolean,
    tab?: "connection" | "chat" | "skills" | "github" | "companion"
  ) => void;
  setSettingsTab: (tab: "connection" | "chat" | "skills" | "github" | "companion") => void;
  setSettingsModalState: (state: {
    settingsOpen: boolean;
    settingsTab: "connection" | "chat" | "skills" | "github" | "companion" | null;
  }) => void;  /** Hydration-time cleanup of stale pending-turn markers */
  cleanupStalePendingTurns: () => void;
  /** Toggles one conversation's reconnecting banner (resume retries) */
  setReconnecting: (conversationId: string, value: boolean) => void;
  /** Marks a user-run verification as started/finished for one conversation */
  setCheckRun: (conversationId: string, running: boolean) => void;

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

/** A copy of `record` without `key` — and the same object when it had none */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next: Record<string, T> = {};
  for (const [k, value] of Object.entries(record)) {
    if (k !== key) next[k] = value;
  }
  return next;
}

let approvalSeq = 0;

/** Id for one waiting approval, so a dialog answers the request it opened for */
function createApprovalId(): string {
  approvalSeq += 1;
  return `approval_${Date.now().toString(36)}_${approvalSeq.toString(36)}`;
}

/**
 * Answers a waiting approval as a refusal.
 *
 * Switched on the kind rather than called through the union, because the two
 * resolvers take different decision shapes and a silent mismatch here is a
 * dialog that closes with nobody's promise resolved.
 */
function refuseApproval(approval: PendingApproval, note?: string): void {
  if (approval.kind === "push") {
    approval.resolve({ approved: false, ...(note ? { note } : {}) });
  } else {
    approval.resolve({ approved: false, ...(note ? { note } : {}) });
  }
}

/**
 * Every message is stamped with the binding it was produced under.
 *
 * One choke point, deliberately: the transcript outlives the repository it
 * describes, and a request built from it is replayed under a system prompt
 * that names whatever is attached NOW. Without the stamp there is no way to
 * tell the rows apart afterwards (see context/binding-scope.ts), so this is
 * written where a row BECOMES a row rather than at the four call sites that
 * build them.
 *
 * The stamp is written LAST and wins over anything the caller passed, because
 * a message that could nominate its own repository is exactly the artifact the
 * binding discipline exists to prevent.
 */
function stampBinding(
  conversationId: string,
  message: Omit<ChatMessage, "id" | "timestamp">,
  id: string
): ChatMessage {
  return {
    ...message,
    id,
    timestamp: Date.now(),
    bindingId: bindingIdOf(conversationId),
  };
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

      streams: {},
      abortedStreams: {},
      reconnecting: {},
      settingsOpen: false,
      settingsTab: null,
      checkRuns: {},
      lastSeenAt: {},

      composerDrafts: {},
      workspaces: {},
      approvals: [],

      // ── Composer ──
      // Write-through, in the same store as the threads themselves: reading
      // a draft is then a lookup by conversation with no reconciliation step,
      // and there is no window where the box shows one chat's text while
      // another chat is active. Functional updates are supported because the
      // composer appends imported files to whatever is already typed.
      setComposerDraft: (conversationId, update) =>
        set((s) => {
          if (!conversationId) return s;
          const previous = s.composerDrafts[conversationId] ?? EMPTY_COMPOSER_DRAFT;
          const draft = typeof update === "function" ? update(previous.draft) : update;
          return {
            composerDrafts: { ...s.composerDrafts, [conversationId]: { ...previous, draft } },
          };
        }),

      setComposerImages: (conversationId, images) =>
        set((s) => {
          if (!conversationId) return s;
          const previous = s.composerDrafts[conversationId] ?? EMPTY_COMPOSER_DRAFT;
          return {
            composerDrafts: { ...s.composerDrafts, [conversationId]: { ...previous, images } },
          };
        }),

      // ── Workspace ──
      // The two workspace setters are the choke point where a workspace
      // change becomes visible outside the open conversation: the list row
      // needs to say which thread has work in progress, and the workspace
      // itself is only in memory for the chat that is open. The count is
      // derived here and never written anywhere else.
      setWorkspace: (conversationId, ws) =>
        set((s) => ({
          workspaces: { ...s.workspaces, [conversationId]: ws },
          conversations: mapConversation(s.conversations, conversationId, (c) => ({
            ...c,
            pendingChanges: pendingChangeCount(ws),
          })),
        })),

      patchWorkspace: (conversationId, ws) =>
        set((s) => ({
          workspaces: { ...s.workspaces, [conversationId]: ws },
          conversations: mapConversation(s.conversations, conversationId, (c) => ({
            ...c,
            pendingChanges: pendingChangeCount(ws),
          })),
        })),

      ensureWorkspace: async (conversationId) => {
        const state = get();
        const conv = state.conversations.find((c) => c.id === conversationId);
        const repo = conv?.repoContext;
        const token = state.settings.github.token;
        if (!repo || !token) return null;

        // The in-memory workspace counts only when it is a working copy of
        // THIS repository. Returning it unconditionally is how a chat that
        // changed repos kept editing the old one's files, in memory, while
        // every record on disk said otherwise.
        const existing = state.workspaces[conversationId];
        if (workspaceMatchesRepo(existing, repo)) return existing!;

        // Rehydrate from IDB or create fresh; pin the base commit.
        //
        // The lookup is by (conversation, repo, branch), which is the whole
        // point: a chat that moved from one repository to another, and back,
        // finds the work it left in the first one instead of the record
        // having been overwritten. A different branch is a different base
        // commit and therefore a different working copy, so it starts fresh
        // rather than pushing from a stale base.
        const persisted = await loadWorkspace(conversationId, {
          owner: repo.owner,
          repo: repo.repo,
          branch: repo.branch,
        });
        if (persisted) {
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

      requestPushApproval: (pending) => {
        // "Run tools without asking" (settings.autoApproveTools): the user has
        // pre-approved the agent's gated actions, so the gate resolves at once
        // and no dialog is mounted. Defaults match the dialog's own — a
        // pull request is opened, every changed file ships — and the decision
        // is marked `auto` so the tool result can say nobody was asked.
        if (get().settings.autoApproveTools === true) {
          return Promise.resolve({ approved: true, openPr: true, auto: true });
        }
        return new Promise((resolve) => {
          set((s) => ({
            approvals: [
              ...s.approvals,
              {
                id: createApprovalId(),
                kind: "push",
                conversationId: pending.conversationId,
                createdAt: pending.createdAt,
                request: pending,
                resolve,
              },
            ],
          }));
        });
      },

      requestHttpApproval: (pending) => {
        // Same pre-approval as the push gate: no dialog, decision marked
        // `auto`, and the request still validated by the executor before it
        // is sent (auto-approve skips the QUESTION, never the checks).
        if (get().settings.autoApproveTools === true) {
          return Promise.resolve({ approved: true, auto: true });
        }
        return new Promise((resolve) => {
          set((s) => ({
            approvals: [
              ...s.approvals,
              {
                id: createApprovalId(),
                kind: "http",
                conversationId: pending.conversationId,
                createdAt: pending.createdAt,
                request: pending,
                resolve,
              },
            ],
          }));
        });
      },

      resolveApproval: (id, decision) =>
        set((s) => {
          const waiting = s.approvals.find((a) => a.id === id);
          // Vanished already (a Stop dismissed it, or a second answer for the
          // same dialog arrived): a no-op, never a resolve of somebody else's
          // promise.
          if (!waiting) return s;
          if (waiting.kind === "push") waiting.resolve(decision as PushDecision);
          else waiting.resolve(decision as HttpApprovalDecision);
          return { approvals: s.approvals.filter((a) => a.id !== id) };
        }),

      dismissApproval: (id, note) =>
        set((s) => {
          const waiting = s.approvals.find((a) => a.id === id);
          if (!waiting) return s;
          // An unmounted dialog must not leave its tool executor awaiting a
          // promise nothing will ever resolve.
          refuseApproval(waiting, note);
          return { approvals: s.approvals.filter((a) => a.id !== id) };
        }),

      dismissApprovalsFor: (conversationId, note) =>
        set((s) => {
          const mine = s.approvals.filter((a) => a.conversationId === conversationId);
          if (mine.length === 0) return s;
          for (const waiting of mine) refuseApproval(waiting, note);
          return { approvals: s.approvals.filter((a) => a.conversationId !== conversationId) };
        }),
      createConversation: (model, seed) => {
        const id = generateId();
        const state = get();
        const active = state.conversations.find((c) => c.id === state.activeConversationId);

        // A new chat INHERITS the active chat's workspace context: the same
        // repository, and the same agent mode.
        //
        // The repository is the expensive part — a tree and the files the
        // agent reads — and it used to be re-attached by hand for every new
        // chat, which made "new chat" a project reset instead of a new
        // conversation about the same project. Nothing else is inherited:
        // the new thread starts from the repository's base commit, not from
        // the other thread's uncommitted edits (that is a deliberate choice a
        // caller can make with an explicit seed).
        //
        // `seed.repo = null` asks for a chat with no repository at all.
        const repo = seed && "repo" in seed ? (seed.repo ?? undefined) : active?.repoContext;
        const mode = seed?.mode ?? active?.mode;
        const conv: ChatConversation = {
          id,
          title: "New Chat",
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          model,
          ...(repo ? { repoContext: repo } : {}),
          ...(mode ? { mode } : {}),
        };
        set((s) => ({
          conversations: [conv, ...s.conversations],
          activeConversationId: id,
        }));
        return id;
      },

      // Selecting a thread is also the moment it stops being news: the dot in
      // the list means "there is something here you have not looked at", so the
      // lookup and the clearing are the same action.
      selectConversation: (id) =>
        set((s) => ({
          activeConversationId: id,
          lastSeenAt: { ...s.lastSeenAt, [id]: Date.now() },
        })),

      markConversationSeen: (id) =>
        set((s) => {
          const conversation = s.conversations.find((c) => c.id === id);
          // Nothing has landed since the last stamp, so rewriting it would only
          // move a clock nobody reads. The guard is what lets the page stamp on
          // every settle (and every render that recomputes a status) without
          // the stamp becoming a render loop.
          if (!conversation || (s.lastSeenAt[id] ?? 0) >= conversation.updatedAt) return {};
          return { lastSeenAt: { ...s.lastSeenAt, [id]: Date.now() } };
        }),

      seedConversationSeen: () =>
        set((s) => {
          const now = Date.now();
          const seen = { ...s.lastSeenAt };
          let changed = false;
          for (const conversation of s.conversations) {
            if (seen[conversation.id] === undefined) {
              seen[conversation.id] = now;
              changed = true;
            }
          }
          // A no-op write would re-render every subscriber for nothing.
          return changed ? { lastSeenAt: seen } : {};
        }),

      renameConversation: (id, title) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, id, (c) =>
            touchConversation({ ...c, title: title.trim() || c.title })
          ),
        })),

      deleteConversation: (id) => {
        set((s) => {
          const remaining = s.conversations.filter((c) => c.id !== id);
          const active =
            s.activeConversationId === id
              ? remaining[0]?.id ?? null
              : s.activeConversationId;
          // The chat's working copies go with it: one record per repo it was
          // attached to, plus the in-memory copy. Leaving them behind would
          // keep the user's un-pushed code on disk for a chat they deleted.
          const workspaces = { ...s.workspaces };
          delete workspaces[id];
          void deleteWorkspaceFromIdb(id);
          // Its composer goes too. This one holds base64 attachments, so
          // leaving it behind is memory held for a chat that is gone.
          const composerDrafts = { ...s.composerDrafts };
          delete composerDrafts[id];
          return {
            conversations: remaining,
            activeConversationId: active,
            workspaces,
            composerDrafts,
          };
        });
        // The deleted thread's binding is announced so every cache scoped to it
        // releases its share: file reads, published URLs, recorded evidence.
        // Before, each of those was forgotten (or not) separately, and the ones
        // that were not kept a readable copy of a deleted repository's code
        // alive for the life of the tab.
        void forgetThread(id);
      },

      duplicateConversation: (id) => {
        const source = get().conversations.find((c) => c.id === id);
        if (!source) return null;
        const newId = generateId();
        const copy: ChatConversation = {
          ...source,
          id: newId,
          title: `${source.title} (copy)`,
          // The copy is a fork of the TRANSCRIPT, never of the unfinished turn.
          //
          // The spread above carries every field of the source, and several of
          // them describe work that is happening in the source right now rather
          // than anything the copy has. On the copy they are not merely stale,
          // they are false, and each one is user-visible:
          //
          //   pendingTurn     a reload of the copy would offer to resume the
          //                   source's turn against the copy's (empty) log
          //   pendingQuestion answering the card would resume a tool loop in a
          //                   conversation that never asked the question
          //   queued          messages waiting for a round boundary in the
          //                   source's turn, which the copy will never reach
          //   plan            a live plan with steps the copy is not running
          //
          // Dropping them is the same rule the pending marker already followed,
          // applied to the rest of the set instead of just the one field. The
          // configuration (model, effort, mode, system prompt), the repository
          // binding and the summary are properties of the chat, not of a turn,
          // so they stay.
          pendingTurn: undefined,
          pendingQuestion: undefined,
          queued: undefined,
          plan: undefined,
          // `pendingChanges` is a SUMMARY derived at the one choke point that
          // owns workspaces (`setWorkspace`). The copy owns no workspace yet —
          // its id keys nothing in `workspaces` and nothing in IndexedDB — so
          // inheriting the source's count put a "3 changed" badge on a chat
          // with no changes at all, and clicking it opened an empty pane. Zero
          // is the honest answer, and the first `setWorkspace` will correct it.
          pendingChanges: undefined,
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

      setConversationEffort: (id, effort) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, id, (c) =>
            touchConversation({ ...c, reasoningEffort: effort })
          ),
        })),

      setConversationMode: (id, mode) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, id, (c) =>
            touchConversation({ ...c, mode })
          ),
        })),

      setConversationSystemPrompt: (id, prompt) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, id, (c) =>
            touchConversation({ ...c, systemPrompt: prompt })
          ),
        })),

      setConversationRepo: (id, repo) => {
        set((s) => ({
          conversations: mapConversation(s.conversations, id, (c) => {
            // A DIFFERENT repository is a different job. The plan is a promise
            // about files in the repository being left, the suggested next
            // steps describe work on it, and the completion gate reads the
            // plan — so leaving them in place is how a thread spends its next
            // turn chasing the previous repository's steps (and reporting them
            // as unfinished work). Re-attaching the SAME repository keeps
            // everything: nothing changed.
            const moved = attachmentIdOf(c.repoContext) !== attachmentIdOf(repo);
            return touchConversation({
              ...c,
              // Stamp attachedAt here (impure Date.now stays out of render)
              repoContext: repo ? { ...repo, attachedAt: Date.now() } : undefined,
              ...(moved
                ? {
                    plan: undefined,
                    suggestions: undefined,
                    // The era boundary the request reads to date the rows that
                    // carry no binding stamp of their own. Recorded HERE, on the
                    // same `moved` check that clears the plan, so the two can
                    // never disagree about what counted as a move.
                    bindingMove: { at: Date.now(), from: attachmentIdOf(c.repoContext) },
                  }
                : {}),
            });
          })
        }));
        // `repoContext` is the PERSISTED PROJECTION of the thread's binding, so
        // the binding is declared in the same call that writes it. Leaving that
        // to a component effect is a hop that can be missed, and missing it is
        // exactly how a thread came to be on repository B while its workspace
        // and its recorded evidence still belonged to A.
        if (repo) void setAttachment(id, repo);
        else void clearAttachment(id);
      },

      setConversationPlan: (id, plan) =>
        set((s) => ({
          // Deliberately NOT touchConversation: progress on a plan is not a
          // content change, and reordering the sidebar on every step tick
          // would make the list jump while the user is reading it.
          conversations: mapConversation(s.conversations, id, (c) => ({ ...c, plan })),
        })),

      setPendingQuestion: (conversationId, question) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            // Bookkeeping, not activity: a question must not reorder the
            // chat list or move updatedAt under the user's cursor.
            c.pendingQuestion === question ? c : { ...c, pendingQuestion: question }
          ),
        })),

      setSuggestions: (conversationId, suggestions) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) => ({
            ...c,
            suggestions: suggestions && suggestions.length > 0 ? suggestions : undefined,
          })),
        })),

      enqueueUserMessage: (conversationId, message) => {
        const id = generateId();
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) => ({
            ...c,
            queued: [...(c.queued ?? []), { id, ...message, queuedAt: Date.now() }],
          })),
        }));
        return id;
      },

      removeQueuedMessage: (conversationId, id) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            c.queued?.some((q) => q.id === id)
              ? { ...c, queued: c.queued.filter((q) => q.id !== id) }
              : c
          ),
        })),

      // Read-and-remove in one step, so two callers can never deliver the
      // same queued message twice (the engine's round boundary and its
      // post-turn restart both call this).
      shiftQueuedMessage: (conversationId) => {
        const conv = get().conversations.find((c) => c.id === conversationId);
        const next = conv?.queued?.[0];
        if (!conv || !next) return undefined;
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) => ({
            ...c,
            queued: (c.queued ?? []).slice(1),
          })),
        }));
        return next;
      },

      applyCompaction: (conversationId, summary, removedMessageIds) =>
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) => {
            // The folded messages leave the stored transcript — the
            // summary carries their memory — while hidden rows stay put
            // (the fold never covered them, and /clear must remain
            // non-destructive).
            const removed = new Set(removedMessageIds);
            const messages =
              removed.size > 0 ? c.messages.filter((m) => !removed.has(m.id)) : c.messages;
            // The notes describe what was read and written HERE, so they are
            // stamped with the repository they are about: composeSystemPrompt
            // adds the caveat when that is not the one the thread is on now.
            return touchConversation({
              ...c,
              messages,
              summary: { ...summary, bindingId: bindingIdOf(conversationId) },
            });
          })
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
              messages: [...c.messages, stampBinding(conversationId, message, id)],
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
      //
      // Every action here names its conversation, and that is the whole
      // multi-tenancy change: two agents can stream at once, and neither can
      // write into the other's buffer or commit the other's text. The insert
      // is what opens a gate; the appends close it again when the stream is
      // over, which is how a late delta from a torn-down round is dropped
      // instead of landing in whatever stream is running now.
      beginStreaming: (conversationId) =>
        set((s) => ({
          streams: {
            ...s.streams,
            [conversationId]: { content: "", reasoning: "", startedAt: Date.now() },
          },
          // A new stream for a thread clears that thread's stopped mark — the
          // "aborted" note is about the reply that ended, not about the chat.
          abortedStreams: withoutKey(s.abortedStreams, conversationId),
        })),

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
      appendStreamingContent: (conversationId, chunk) =>
        set((s) => {
          const stream = s.streams[conversationId];
          // No buffer means the stream is over (or was never opened). Dropping
          // the delta is the honest answer: appending it anywhere else is how
          // one thread's words ended up in another thread's answer.
          if (!stream) return s;
          return {
            streams: {
              ...s.streams,
              [conversationId]: { ...stream, content: stream.content + chunk },
            },
          };
        }),

      appendStreamingReasoning: (conversationId, chunk) =>
        set((s) => {
          const stream = s.streams[conversationId];
          if (!stream) return s;
          return {
            streams: {
              ...s.streams,
              [conversationId]: { ...stream, reasoning: stream.reasoning + chunk },
            },
          };
        }),

      commitStreamingMessage: (conversationId, meta) => {
        const stream = get().streams[conversationId];
        if (!stream || !stream.content.trim()) return null;
        const id = generateId();
        const reasoning = meta?.reasoning ?? stream.reasoning;
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              messages: [
                ...c.messages,
                stampBinding(
                  conversationId,
                  {
                    role: "assistant",
                    content: stream.content,
                    reasoning: reasoning || undefined,
                    ...meta,
                  },
                  id
                ),
              ],
            })
          ),
        }));
        return id;
      },

      discardStreaming: (conversationId) =>
        set((s) => {
          const stream = s.streams[conversationId];
          if (!stream) return s;
          return {
            streams: {
              ...s.streams,
              [conversationId]: { ...stream, content: "", reasoning: "" },
            },
          };
        }),

      commitToolCallsMessage: (conversationId, calls, meta) => {
        const id = generateId();
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              messages: [
                ...c.messages,
                stampBinding(conversationId, {
                  role: "assistant",
                  content: meta?.content ?? "",
                  reasoning: meta?.reasoning || undefined,
                  model: meta?.model,
                  toolCalls: { kind: "tool_calls", calls },
                }, id),
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
                stampBinding(conversationId, {
                  role: "user",
                  content: "",
                  toolResult: {
                    kind: "tool_result",
                    callId: result.callId,
                    name: result.name,
                    ok: result.ok,
                    content,
                    durationMs: result.durationMs,
                    summary: result.summary,
                    // UI-only: lets the transcript open a mutation step
                    // into the diff that step produced.
                    change: result.uiChange,
                  },
                }, generateId()),
              ],
            })
          ),
        }));
      },

      endStreaming: (conversationId, aborted) =>
        set((s) => ({
          streams: withoutKey(s.streams, conversationId),
          abortedStreams: aborted
            ? { ...s.abortedStreams, [conversationId]: true }
            : s.abortedStreams,
        })),

      clearStreams: () => set({ streams: {}, abortedStreams: {} }),

      commitDirectAssistantMessage: (conversationId, message) => {
        const id = generateId();
        set((s) => ({
          conversations: mapConversation(s.conversations, conversationId, (c) =>
            touchConversation({
              ...c,
              messages: [
                ...c.messages,
                stampBinding(conversationId, { role: "assistant", ...message }, id),
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

      setCheckRun: (conversationId, running) =>
        set((s) => {
          // Only this conversation's run may clear its own flag: a stale
          // finally() from an abandoned run must not blank a newer one's
          // indicator, and two threads verifying at once each keep their own.
          const checkRuns = { ...s.checkRuns };
          if (running) {
            checkRuns[conversationId] = Date.now();
          } else if (conversationId in checkRuns) {
            delete checkRuns[conversationId];
          } else {
            return s;
          }
          return { checkRuns };
        }),

      setSettingsOpen: (open, tab) =>
        set({ settingsOpen: open, settingsTab: open ? tab ?? null : null }),

      setSettingsTab: (tab) => set({ settingsTab: tab }),

      setSettingsModalState: ({ settingsOpen, settingsTab }) =>
        set({ settingsOpen, settingsTab }),

      setReconnecting: (conversationId, value) =>
        set((s) => ({
          reconnecting: value
            ? { ...s.reconnecting, [conversationId]: true }
            : withoutKey(s.reconnecting, conversationId),
        })),

      /** Clears pendingTurn markers that outlived their turn (>24h) */
      cleanupStalePendingTurns: () =>
        set((s) => {
          const now = Date.now();
          let changed = false;
          const conversations = s.conversations.map((c) => {
            const staleTurn =
              c.pendingTurn && now - c.pendingTurn.startedAt > PENDING_TURN_MAX_AGE_MS;
            // A question that outlived its turn is stale too: nobody is
            // parked on it, and leaving it on screen advertises an answer
            // that would restart a turn from a day-old context.
            const staleQuestion =
              c.pendingQuestion && now - c.pendingQuestion.askedAt > PENDING_TURN_MAX_AGE_MS;
            if (!staleTurn && !staleQuestion) return c;
            changed = true;
            return {
              ...c,
              pendingTurn: staleTurn ? undefined : c.pendingTurn,
              pendingQuestion: staleQuestion ? undefined : c.pendingQuestion,
            };
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
            // Retired InTab virtual-model ids migrate onto a real model;
            // every other choice is left exactly as the user set it.
            defaultModel: isLegacyIntabModelId(settings?.defaultModel)
              ? DEFAULT_CHAT_MODEL
              : (settings?.defaultModel ?? DEFAULT_CHAT_SETTINGS.defaultModel),
            github: {
              ...DEFAULT_CHAT_SETTINGS.github,
              ...settings?.github,
            },
            // Same treatment as GitHub: a stored pairing missing a field
            // added later must fill from the default rather than arrive as
            // undefined, or the probe reads `origin: undefined` and reports
            // "no companion configured" for a user who paired one.
            companion: {
              ...DEFAULT_CHAT_SETTINGS.companion,
              ...settings?.companion,
            },
            skills: reconciled ?? skills,
          },
          // Same migration for per-conversation overrides: a stored
          // "intab/intab-llm*" id would otherwise 404 on the next send.
          conversations: (p.conversations ?? current.conversations).map((c) =>
            isLegacyIntabModelId(c.model) ? { ...c, model: DEFAULT_CHAT_MODEL } : c
          ),
          streams: {},
          abortedStreams: {},
          reconnecting: {},
          settingsOpen: false,
          settingsTab: null,
          checkRuns: {},
          workspaces: {},
          approvals: [],
        };
      },
    }
  )
);

/** Selector: the active conversation object (or undefined) */
export function selectActiveConversation(state: ChatStoreState): ChatConversation | undefined {
  return state.conversations.find((c) => c.id === state.activeConversationId);
}

/**
 * A thread's working copy — but ONLY when it is a copy of what the thread is
 * currently attached to.
 *
 * `workspaces[threadId]` answers a different question than the one every caller
 * means to ask. It says "what did this thread last have in memory", and the
 * honest answer right after a repository switch is the PREVIOUS repository's
 * working copy, because the new one is still being fetched. Reading it directly
 * is how a write tool edited files in a repository the thread had already left,
 * how a diff showed another repository's changes, and how a push shipped a
 * change set that was no longer on screen.
 *
 * Fail-closed on purpose: null is the answer that makes a caller wait or
 * re-derive (`ensureWorkspace`), and the wrong workspace is never an acceptable
 * answer. The check is the binding itself rather than a comparison of owner and
 * repo fields, so it cannot drift from what the change set, the ledger and the
 * persisted record are keyed by.
 */
export function selectWorkspace(
  state: ChatStoreState,
  threadId: string | null
): WorkspaceState | null {
  if (!threadId) return null;
  const binding = bindingIdOf(threadId);
  // A thread with nothing attached has nothing to work on, whatever happens to
  // be left in memory from before it detached.
  if (!isAttached(binding)) return null;
  const workspace = state.workspaces[threadId];
  if (!workspace) return null;
  return bindingKey(threadId, attachmentIdOf(workspace)) === binding
    ? workspace
    : null;
}

/** `selectWorkspace` for callers that are not rendering */
export function currentWorkspace(threadId: string | null): WorkspaceState | null {
  return selectWorkspace(useChatStore.getState(), threadId);
}

// ── Selectors: per-thread transient state ────────────────────
//
// These are what callers read instead of the app-wide flags they used to read.
// Every one of those questions — is this thread streaming, is a verification
// running for it, is it waiting on the user — is a question about ONE thread,
// and a single boolean could not answer it once two agents could be busy at
// once. Returning the STORED value (never a fresh object) keeps them safe to
// use directly as `useSyncExternalStore` selectors.

/** The stream in flight for one conversation, or null when it is idle */
export function selectStream(
  state: ChatStoreState,
  conversationId: string | null
): ConversationStream | null {
  if (!conversationId) return null;
  return state.streams[conversationId] ?? null;
}

/** True when ANY conversation is streaming */
export function selectAnyStreaming(state: ChatStoreState): boolean {
  return Object.keys(state.streams).length > 0;
}

/** Ids of every conversation with a stream in flight */
export function selectStreamingIds(state: ChatStoreState): string[] {
  return Object.keys(state.streams);
}

/** True when the last stream this conversation had was stopped by the user */
export function selectStreamAborted(
  state: ChatStoreState,
  conversationId: string | null
): boolean {
  return Boolean(conversationId && state.abortedStreams[conversationId]);
}

/** True while this conversation's resume attempt is reconnecting */
export function selectReconnecting(
  state: ChatStoreState,
  conversationId: string | null
): boolean {
  return Boolean(conversationId && state.reconnecting[conversationId]);
}

/** When this conversation's user-run verification started, or null */
export function selectCheckStartedAt(
  state: ChatStoreState,
  conversationId: string | null
): number | null {
  if (!conversationId) return null;
  return state.checkRuns[conversationId] ?? null;
}

/**
 * The approval the UI should show: the OLDEST waiting one.
 *
 * FIFO and one dialog at a time, because a decision deserves undivided
 * attention — and because showing the newest would let a second agent's
 * request hide a first one's, which is the failure the queue exists to fix.
 */
export function selectPendingApproval(state: ChatStoreState): PendingApproval | null {
  return state.approvals[0] ?? null;
}

/** How many approvals are waiting (the "N more waiting" affordance) */
export function selectApprovalCount(state: ChatStoreState): number {
  return state.approvals.length;
}

/** True when at least one approval of this kind is waiting */
export function selectHasApprovalOfKind(
  state: ChatStoreState,
  kind: PendingApproval["kind"]
): boolean {
  return state.approvals.some((a) => a.kind === kind);
}
