// ============================================================
// Chat Page — OpenRouter-Powered AI Chat
// ============================================================
// Layout mirrors ApiTester: conversation sidebar + main pane.
// The context engine keeps requests within the model's window and
// the meter reflects live usage.

import React, { useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { FileDiff } from "lucide-react";
import {
  useChatStore,
  selectActiveConversation,
  selectAnyStreaming,
  selectStreamingIds,
  selectWorkspace,
} from "@/stores/chat.store";
import type { ConversationSeed } from "@/stores/chat.store";
import { useWorkspaceStoreSlice } from "@/hooks/useWorkspace";
import { flushWorkspaceSave } from "./workspace/workspace";
import {
  modelDisplayName,
  regenerateLastResponse,
  resolveModelInfo,
  sendUserMessage,
  stopChatStream,
  ensureCompetenceIndex,
  ensureModelCatalog,
  resumeInterruptedTurn,
  commitPartialReply,
} from "./services/chat-runner";
import { activeBindingIdOf, getConversationContext, composeSystemPrompt } from "./context/engine";
import { buildEffectiveSystemPrompt } from "./lib/skills";
import { CHAT_COMMANDS, CHAT_COMMAND_BY_ID, runCommandById } from "./lib/commands";
import { conversationStatus, type ConversationStatus } from "./lib/conversation-status";
import { resolveSlashInput } from "./lib/slash";
import { useAppStore } from "@/stores/app.store";
import { ChatSidebar } from "./components/ChatSidebar";
import { ChatHeader } from "./components/ChatHeader";
import { downloadConversation } from "./services/export-conversation";
import type { RepoSelection } from "./components/RepoPicker";
import { planRepoPick, type RepoPickIntent } from "./lib/repo-routing";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ChatSettingsModal } from "./components/ChatSettingsModal";
import { PushApprovalModal } from "./components/PushApprovalModal";
import { HttpApprovalModal } from "./components/HttpApprovalModal";
import { useSkillActivity } from "./lib/skill-activity";
import {
  claimReloadEndedPreview,
  previewRecordsRestored,
  repoKeyOf,
  setPreviewView,
} from "./container/preview-bridge";
import { resolveMentionContext } from "./services/mention-context";
import { watchGitHubSession } from "./services/github-session";
import { PlanStrip } from "./components/PlanStrip";
import { ActivityRail } from "./components/ActivityRail";
import { WorkspaceStrip } from "./components/WorkspaceStrip";
import { ChangesSheet } from "./components/ChangesSheet";
import { useNarrowLayout } from "./components/useNarrowLayout";
import type { WorkspacePanelTab } from "./components/ChangesPane";
import { ChangesPane } from "./components/ChangesPane";

import { collectChangeSet } from "./lib/change-set";
import { modelSupportsImages } from "./services/chat-runner";
import { startPreviewForConversation } from "./services/container-workspace";
import { sessionHost } from "./session/session-client";
import { logTurnEvent } from "./session/turn-log";
import { installDebugForward } from "./session/debug-forward";
import { isTurnUnrecoverable } from "./session/turn-engine";
import { workspaceSupport } from "./lib/availability";
import { availableEfforts, modelSupportsTools } from "./lib/model-state";
import { resolveToolSurface } from "./lib/tool-profiles";
import { DEFAULT_CHAT_MODE, DEFAULT_REASONING_EFFORT } from "./constants";
import type {
  ChatAttachment,
  ChatMode,
  ModelInfo,
  ReasoningEffort,
  RepoContext,
} from "./types";
import type { ChatCommand } from "./lib/commands";
import "./chat.css";

export function ChatPage() {
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const settings = useChatStore((s) => s.settings);
  const settingsOpen = useChatStore((s) => s.settingsOpen);
  const settingsTab = useChatStore((s) => s.settingsTab);
  // Per-thread transients, read as the maps themselves rather than as "the one
  // that is running": several agents can be in flight at once, and every
  // question asked of them below is asked about a SPECIFIC thread. The
  // seen-stamps decide what counts as unread.
  const streams = useChatStore((s) => s.streams);
  const reconnectingThreads = useChatStore((s) => s.reconnecting);
  const checkRuns = useChatStore((s) => s.checkRuns);
  const lastSeenAt = useChatStore((s) => s.lastSeenAt);

  const activeConversation = useChatStore(selectActiveConversation);

  // Streaming is scoped to one conversation: other chats stay fully usable
  // while a stream runs elsewhere, and the composer's send/stop belong to the
  // chat they sit in. (Declared before the command helpers, which read it
  // during render.)
  const isStreamingHere = Boolean(activeConversationId && streams[activeConversationId]);

  /**
   * What every thread in the list is doing, keyed by id (lib/conversation-status).
   *
   * The sidebar draws one glyph per row and rolls a repository's threads up into
   * its header, so the inputs are all store state — never local component state,
   * or two panes would disagree about the same thread. `statuses` is required by
   * ChatSidebarProps; computing it here is what makes that prop real rather than
   * a type error.
   */
  const conversationStatuses = useMemo(() => {
    const out: Record<string, ConversationStatus> = {};
    for (const conversation of conversations) {
      out[conversation.id] = conversationStatus({
        conversation,
        streaming: Boolean(streams[conversation.id]),
        reconnecting: Boolean(reconnectingThreads[conversation.id]),
        runningChecks: Boolean(checkRuns[conversation.id]),
        isActive: conversation.id === activeConversationId,
        lastSeenAt: lastSeenAt[conversation.id],
      });
    }
    return out;
  }, [
    conversations,
    streams,
    reconnectingThreads,
    checkRuns,
    activeConversationId,
    lastSeenAt,
  ]);

  // A thread you are looking at is a thread you have read.
  //
  // `conversationStatus` never calls the ACTIVE row unread, but the stamp still
  // has to move, or switching away from a chat you just watched finish would
  // accuse you of missing it. Stamped only once the thread is at rest — a stamp
  // mid-turn would keep moving the finish line the dot is measured from — and
  // only through the store's guarded write, which makes a repeat call free.
  const activeStatus = activeConversationId
    ? conversationStatuses[activeConversationId]
    : undefined;
  useEffect(() => {
    if (!activeConversationId || activeStatus?.kind === "running" || activeStatus?.kind === "waiting") {
      return;
    }
    useChatStore.getState().markConversationSeen(activeConversationId);
  }, [activeConversationId, activeStatus]);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Below the drawer breakpoint there is no room for two readable panes, so the
  // change set becomes a sheet. See components/useNarrowLayout.ts for why this
  // cannot be a stylesheet rule.
  const narrow = useNarrowLayout();

  // ── Per-conversation composer state ──
  // A draft belongs to the chat it was typed in, so it is keyed by
  // conversation IN THE STORE rather than stashed and reconciled here. One
  // shared draft carried the text (and the attached images) into the wrong
  // thread on a switch — where Enter would send it — and reconciliation in
  // the page needed a ref read during render to beat the switch. Write-through
  // has no window to lose a keystroke in, and the box is always showing the
  // active thread's own draft by construction.
  const composerDrafts = useChatStore((s) => s.composerDrafts);
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  const setComposerImages = useChatStore((s) => s.setComposerImages);
  const composerId = activeConversationId ?? "";
  // What the last prepared turn loaded from skill triggers, for the header's
  // skills card (lib/skill-activity records it in services/turn-prep).
  const skillActivity = useSkillActivity(activeConversationId);
  const alwaysOnSkillNames = (settings.skills ?? [])
    .filter((s) => s.enabled)
    .map((s) => s.name);
  const autoSkillCount = (settings.skills ?? []).filter(
    (s) => !s.enabled && s.content.trim()
  ).length;
  const draft = composerDrafts[composerId]?.draft ?? "";
  const pendingImages = composerDrafts[composerId]?.images ?? [];
  // The composer's own call sites keep React's setter shape (a value, or a
  // function of the previous text for appended file imports).
  const setDraft = React.useCallback(
    (update: React.SetStateAction<string>) => setComposerDraft(composerId, update),
    [composerId, setComposerDraft]
  );
  const setPendingImages = React.useCallback(
    (images: ChatAttachment[]) => setComposerImages(composerId, images),
    [composerId, setComposerImages]
  );

  // Agent workspace: ensures the workspace exists on repo attach and
  // exposes the attachment state for the agent panel.
  const { repoAttached } = useWorkspaceStoreSlice();

  // Auto-open the agent panel on attach: derive from the repo context so
  // no effect-based setState is needed. Once closed manually it stays
  // closed for this attachment (tracked by attachedAt) and the floating
  // button brings it back.
  const attachedAt = activeConversation?.repoContext?.attachedAt ?? 0;
  const [closedForAttachment, setClosedForAttachment] = useState<number | null>(null);
  // The preview lives INSIDE the workspace panel (Changes | Preview tabs), so
  // "showing the preview" means the panel is open on the preview tab — one
  // surface, tabbed, instead of a panel and a floating popup. Owned by the
  // page: the workspace strip below the composer moves it between tabs, and
  // the sheet layout (≤860px) hosts the same tabs.
  const [panelTab, setPanelTab] = useState<WorkspacePanelTab>("changes");
  // The preview's RECORD is per-repo (lib/preview-bridge sessions), so the view
  // follows the active conversation's repository: switching chats in the sidebar
  // switches the preview state the strip and panel describe. Starting a preview
  // re-points the view too, but a switch with nothing starting must show THIS
  // repo's own session — not the last repo's server that happened to be live.
  const activeRepoKey = repoKeyOf(
    activeConversation?.repoContext?.owner,
    activeConversation?.repoContext?.repo
  );
  useEffect(() => {
    setPreviewView(activeRepoKey);
  }, [activeRepoKey]);

  // ── Auto-restart the preview a reload ended ──
  // The dev server cannot survive a reload (it lives in this page's browser
  // workspace), but its RECORD does — see preview-bridge's persistence. When
  // that record says the page went down with a live server, this page finishes
  // the job: the same thread's repository gets a fresh server AND the panel is
  // put back on the preview tab, so the preview the user was watching comes
  // back on its own — not as a dead record they must click open.
  //
  // Gated three ways, each one a real answer to "should this run here?":
  //   • the restored records have landed (otherwise the pending set is empty
  //     no matter what happened before the reload);
  //   • this page can host a workspace at all (the boot verdict, not a probe);
  //   • the ACTIVE conversation's repo is the one whose session ended — the
  //     restart serves the thread the user is looking at, never a background
  //     one. Switching chats consumes the pending restart, because a preview
  //     the user navigated away from during the reload window is not one they
  //     asked to come back.
  useEffect(() => {
    if (!activeRepoKey) return;
    let cancelled = false;
    void previewRecordsRestored().then(() => {
      // Identity is read at RESOLUTION time, not captured at effect time: the
      // chat store hydrates asynchronously, so `activeConversationId` here is
      // often still null when this effect first ran. Capturing it was the bug
      // that made every auto-restart a silent no-op — the claim was burned on
      // an empty conversation id and the user had to press the button after
      // all. The claim is only spent when there is a real thread to start.
      if (cancelled) return;
      const conversationId = useChatStore.getState().activeConversationId;
      if (!conversationId) return;
      if (workspaceSupport().state === "down") return;
      if (!claimReloadEndedPreview(activeRepoKey)) return;
      // The record was live → the panel WAS showing the preview when the page
      // went down. Reopen that tab; the strip shows progress from the shared
      // preview state ("starting" → "running"), so no local state is needed.
      setPanelTab("preview");
      setClosedForAttachment(null);
      void startPreviewForConversation(conversationId).catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the repo key, NOT on the conversation object:
    // the restart belongs to whichever conversation is on screen when the
    // restored records land, and re-running it on unrelated conversation
    // updates would re-claim (and re-fail) forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepoKey]);
  const panelVisible = Boolean(repoAttached) && closedForAttachment !== attachedAt;
  // Fail closed: the change set in this panel must be the change set of the
  // repository the panel is about. After a switch, the in-memory entry is the
  // one the thread just left.
  const activeWorkspace = useChatStore(
    (s) => selectWorkspace(s, activeConversationId) ?? undefined
  );
  const changeSet = useMemo(() => collectChangeSet(activeWorkspace), [activeWorkspace]);

  // Fetch the live model catalog whenever an API key becomes
  // available. Keying on the hydrated key value (not just mount)
  // means a saved key loads the catalog after async storage
  // hydration, so the picker never stays on curated fallbacks.
  useEffect(() => {
    const apiKey = settings.apiKey;
    if (!apiKey) return;
    let cancelled = false;
    // Defer setState into the async chain so the effect body itself
    // never triggers cascading renders.
    void Promise.resolve()
      .then(() => {
        setModelsLoading(true);
        return ensureModelCatalog(apiKey);
      })
      .then((list) => {
        if (!cancelled && list.length > 0) setModels(list);
        // Published competence, fetched after the catalog because the join needs
        // it: the index aliases each model's `canonical_slug`, which only exists
        // once the catalog is in memory. Fired here rather than in the turn path
        // so the escalation picker has measurements from the first turn instead
        // of falling back to the price heuristic for the session's first swap.
        void ensureCompetenceIndex(apiKey);
      })
      .catch(() => {
        /* curated fallbacks remain in place */
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settings.apiKey]);

  // Guarantee an active conversation exists, but only AFTER the
  // encrypted chat store has rehydrated — otherwise a stray "New
  // Chat" gets created before persisted conversations arrive.
  // Reads fresh state via getState() so it never needs deps.
  useEffect(() => {
    const ensureConversation = () => {
      const state = useChatStore.getState();
      // Any running stream counts: a chat created while an agent is mid-reply
      // would steal the selection from the turn the user is watching.
      if (state.activeConversationId || selectAnyStreaming(state)) return;
      if (state.conversations.length > 0) {
        state.selectConversation(state.conversations[0]!.id);
      } else {
        state.createConversation(state.settings.defaultModel);
      }
    };

    if (useChatStore.persist.hasHydrated()) ensureConversation();
    return useChatStore.persist.onFinishHydration(ensureConversation);
  }, []);

  // A stored token is not a live session. The chat header and the settings tab
  // both derive "connected" from the presence of that string, so a token
  // GitHub has already stopped accepting kept them saying "Connected" for as
  // long as the app stayed open. Validated once per load (after hydration, or
  // there would be no token to read yet), then watched for the 401s that any
  // later call can produce.
  useEffect(() => {
    const start = () => watchGitHubSession();
    if (useChatStore.persist.hasHydrated()) start();
    return useChatStore.persist.onFinishHydration(start);
  }, []);

  // Resume a turn that was streaming when the page reloaded. The
  // persisted pendingTurn marker + trailing user message identify the
  // lost response; resumeInterruptedTurn validates and re-streams
  // (or adopts the host's live stream) through the normal turn loop.
  useEffect(() => {
    const resume = () => {
      const state = useChatStore.getState();
      state.cleanupStalePendingTurns();
      // No app-wide "is anything streaming" guard: an interrupted thread is
      // resumed even while a DIFFERENT agent works, because its own marker says
      // its reply was lost. `resumeInterruptedTurn` refuses a chat that is
      // already running, and a plain turn adopts the live host stream rather
      // than re-streaming it.
      //
      // Most recently interrupted first; markers flagged unresumable wait for
      // the explicit Resume affordance instead of retrying the failed auto path
      // on every load.
      const candidates = state.conversations
        .filter((c) => c.pendingTurn && c.pendingTurn.outcome !== "unresumable")
        .sort((a, b) => (b.pendingTurn!.startedAt ?? 0) - (a.pendingTurn!.startedAt ?? 0));
      for (const conv of candidates) {
        void resumeInterruptedTurn(conv.id);
        break; // one resume per load
      }
    };

    if (useChatStore.persist.hasHydrated()) resume();
    return useChatStore.persist.onFinishHydration(resume);
  }, []);

  // A cold start over thirty old chats must not read as thirty alerts. The
  // per-thread glyphs call "unread" only for activity AFTER you arrived, so
  // every thread with no stamp yet is stamped now, once, when the list mounts
  // (store.seedConversationSeen). Without this call the unread branch could
  // never fire for a thread you had not already selected this session.
  useEffect(() => {
    const seed = () => useChatStore.getState().seedConversationSeen();
    if (useChatStore.persist.hasHydrated()) seed();
    return useChatStore.persist.onFinishHydration(seed);
  }, []);

  // The turn log and the scorecard used to be two commands (/log,
  // /scorecard) that printed only when someone thought to ask. They print
  // themselves now, on the failures they describe (session/debug-forward),
  // so the report is on screen-adjacent the moment the turn loses work.
  useEffect(() => installDebugForward(), []);

  // Session hardening, once per mount:
  //  - pre-connect the session host so the first send skips the
  //    handshake (and reloads re-attach a beat sooner),
  //  - retire the old keep-alive service worker if a previous build
  //    installed one (it could never keep a SharedWorker alive),
  //  - flush streamed-but-uncommitted content on page hide so a
  //    page-local (non-surviving) reply is preserved for resume.
  useEffect(() => {
    void sessionHost.connect();
    // Fold the host's log into this page's log so one console handle
    // (window.__intabTurnLog) tells the whole story of a turn.
    const unsubscribeHostLog = sessionHost.subscribe((event) => {
      if (event.type === "LOG") logTurnEvent(event.entry);
    });
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          for (const registration of registrations) {
            const url = registration.active?.scriptURL ?? "";
            if (url.endsWith("/sw.js")) void registration.unregister();
          }
        })
        .catch(() => {
          /* SW API unavailable — nothing to retire */
        });
    }

    const flushPartial = () => {
      const state = useChatStore.getState();
      // EVERY in-flight stream is flushed, not just one: a page-local stream
      // dies with the page, and with several agents working there are several
      // partial replies to rescue before the document goes away.
      const inFlight = selectStreamingIds(state);
      const ids = inFlight.length > 0
        ? inFlight
        : state.activeConversationId
          ? [state.activeConversationId]
          : [];
      for (const id of ids) {
        commitPartialReply(id);
        // Workspaces save on a debounce — flush them too, so an instant close
        // cannot lose the last agent edit.
        const ws = state.workspaces[id];
        if (ws) void flushWorkspaceSave(id, ws);
      }
    };
    window.addEventListener("pagehide", flushPartial);
    const onVisChange = () => {
      if (document.visibilityState === "hidden") flushPartial();
    };
    document.addEventListener("visibilitychange", onVisChange);

    // Last-chance guard ONLY for work a reload would actually lose: a
    // page-local stream (the worker isn't holding it) or an in-flight
    // tool phase. A host-owned stream is reload-surviving by design,
    // so blocking that reload would fight the feature it provides.
    const guardUnload = (e: BeforeUnloadEvent) => {
      if (isTurnUnrecoverable()) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", guardUnload);
    return () => {
      unsubscribeHostLog();
      window.removeEventListener("pagehide", flushPartial);
      document.removeEventListener("visibilitychange", onVisChange);
      window.removeEventListener("beforeunload", guardUnload);
    };
  }, []);

  // Global shortcut: ⌘⇧N (or Ctrl+Shift+N) starts a new chat, matching the
  // sidebar's "New chat" row — including the part that row is FOR: a chat with
  // no repository. Inheriting the active thread's repo here would make the
  // keyboard and the click two different actions with one name.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        useChatStore.getState().createConversation(settings.defaultModel, { repo: null });
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [settings.defaultModel]);

  // Close the mobile drawer when leaving the narrow breakpoint
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 860px)");
    const onChange = () => {
      if (!mql.matches) setSidebarOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const modelId = activeConversation?.model ?? settings.defaultModel;
  // The fetched list first, then the synchronous cache. `resolveModelInfo`
  // alone was memoized on `[modelId]`, so the catalog arriving mid-session
  // never invalidated it: the header kept the cold-start answer ("this model
  // declares nothing") until you switched models, which is why the reasoning
  // control appeared sometimes and not others. Same lookup the settings modal
  // already does.
  const modelInfo = useMemo(
    () => models.find((m) => m.id === modelId) ?? resolveModelInfo(modelId),
    [modelId, models]
  );
  const modelName = useMemo(
    () => modelDisplayName(modelId, models),
    [modelId, models]
  );

  // Model state: conversation override → settings default.
  const effort = activeConversation?.reasoningEffort ?? settings.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const mode = activeConversation?.mode ?? settings.defaultMode ?? DEFAULT_CHAT_MODE;
  // Rungs this model can actually express (empty → the picker hides).
  const efforts = useMemo(() => availableEfforts(modelInfo), [modelInfo]);

  // Compose the same effective prompt the runner will send — skills
  // plus the rolling summary — so the context meter reflects exactly
  // what the next request costs.
  const effectiveSystemPrompt = useMemo(() => {
    const base =
      activeConversation?.systemPrompt?.trim() || settings.systemPrompt.trim() || "";
    const withSkills = buildEffectiveSystemPrompt(base, settings.skills ?? []);
    return composeSystemPrompt(
      withSkills,
      activeConversation?.summary,
      activeConversation ? activeBindingIdOf(activeConversation) : undefined
    );
  }, [activeConversation?.systemPrompt, activeConversation?.summary, settings.systemPrompt, settings.skills]);

  // The tool schemas this conversation would actually send next turn —
  // the meter must charge for them, exactly as the runner does, or it
  // reports a window several thousand tokens emptier than the truth. That
  // means the SAME surface rule as turn-prep: app tools in every
  // tool-capable chat, repo tools only with a repository + token.
  const contextTools = useMemo(() => {
    if (!modelSupportsTools(modelInfo)) return undefined;
    const repoAttached = Boolean(activeConversation?.repoContext && settings.github.token);
    const tools = resolveToolSurface(mode, modelInfo, { repoAttached }).tools;
    return tools.length > 0 ? tools : undefined;
  }, [activeConversation?.repoContext, settings.github.token, modelInfo, mode]);

  const context = useMemo(
    () =>
      getConversationContext({
        conversation: activeConversation ?? { id: "", title: "", messages: [], createdAt: 0, updatedAt: 0 },
        model: modelInfo,
        effectiveSystemPrompt,
        tools: contextTools,
      }),
    [activeConversation, modelInfo, effectiveSystemPrompt, contextTools]
  );

  /** Runs a registry command against this conversation */
  const runCommand = React.useCallback(
    (command: ChatCommand, arg: string) => {
      if (!activeConversationId) return;
      // Through the registry's single executor: sendUserMessage runs the
      // same function, so the two paths cannot drift in how a command
      // behaves (they did — one applied a returned draft, one dropped it).
      const outcome = runCommandById(command.id, {
        conversationId: activeConversationId,
        arg,
        models,
        isStreaming: isStreamingHere,
      });
      // A command that cannot act on its argument hands the prefix back
      // (/rename with no title); otherwise the input is cleared.
      void Promise.resolve(outcome).then((result) => {
        setDraft(result && typeof result === "object" ? result.draft ?? "" : "");
      });
    },
    [activeConversationId, models, isStreamingHere, setDraft]
  );

  /**
   * The conversation a send belongs to, creating one if the page has none.
   *
   * The composer is live while the page has no active conversation — typing
   * works and Send looks ready — so returning early here made the primary
   * action a silent no-op: the click did nothing and nothing explained it.
   * The page is supposed to guarantee a conversation (see the hydration
   * effect above), but that guarantee is one tick of timing away from being
   * wrong, so the send path does not depend on it.
   */
  const resolveTargetConversation = (): string => {
    const state = useChatStore.getState();
    if (state.activeConversationId) return state.activeConversationId;
    return state.createConversation(state.settings.defaultModel);
  };

  // Repository paths for the "@" picker. Memoised on the tree reference so
  // typing in the composer never re-walks it.
  const mentionPaths = useMemo(
    () => (activeWorkspace?.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path),
    [activeWorkspace?.tree]
  );

  const handleSend = () => {
    if (!draft.trim() && pendingImages.length === 0) return;
    const text = draft;
    const images = pendingImages;

    // A slash draft is a command, never a prompt. Unmatched command
    // tokens stay in the composer with an explanation instead of
    // being sent to the model.
    const resolution = resolveSlashInput(text, CHAT_COMMANDS);
    if (resolution.kind === "unknown") {
      useAppStore.getState().addToast({
        message: `Unknown command “/${resolution.token}” — press / to browse commands.`,
        type: "error",
        duration: 4000,
      });
      return;
    }
    if (resolution.kind === "command") {
      const command = CHAT_COMMAND_BY_ID.get(resolution.id);
      setDraft("");
      if (command) runCommand(command, resolution.arg);
      return;
    }

    setDraft("");
    setPendingImages([]);
    const target = resolveTargetConversation();
    // "@file" in the draft becomes FILE CONTENTS on the message. The read is
    // async, so the send waits for it — sending first and attaching later
    // would let the model answer before the context it was told it had.
    if (text.includes("@")) {
      void resolveMentionContext(target, text).then((resolved) => {
        for (const failure of resolved.failures) {
          useAppStore.getState().addToast({
            message: `Could not attach @${failure.path} — ${failure.reason}`,
            type: "error",
            duration: 4500,
          });
        }
        sendUserMessage(target, resolved.text, images.length > 0 ? images : undefined);
      });
      return;
    }
    sendUserMessage(target, text, images.length > 0 ? images : undefined);
  };

  const handleSuggestion = (text: string) => {
    setDraft("");
    sendUserMessage(resolveTargetConversation(), text);
  };

  //
  // Scoped to the chat the composer belongs to: with several agents working,
  // Stop must end the reply the user is looking at and leave the others alone.
  // The app-wide form (the palette's) is what stops everything.
  const handleStop = () => {
    stopChatStream(activeConversationId ?? undefined);
  };

  /**
   * Starts a chat, optionally seeded.
   *
   * A seed = a chat that begins somewhere specific: the sidebar's per-repo
   * "new chat here" hands it a repository, so creating a second thread on a
   * project is one click instead of create-then-reattach. The store stamps
   * `attachedAt` on the repo context when it commits, exactly as attaching by
   * hand does.
   */
  const handleNewChat = (seed?: ConversationSeed) => {
    useChatStore.getState().createConversation(settings.defaultModel, seed);
    setSidebarOpen(false);
  };

  /**
   * A repository was picked in the header.
   *
   * WHERE it lands is decided by `planRepoPick`, and the reason it is decided
   * anywhere but here is that this used to have exactly one outcome — repoint
   * the chat you are in — which meant reaching for a new project cost you the
   * conversation you were having, and a project no chat had ever used was
   * unreachable except that way. Each outcome says out loud what it did, because
   * the interesting part of a routed pick is the chat you are NOT in any more.
   */
  const handleRepoPick = (repo: RepoSelection, intent: RepoPickIntent) => {
    const state = useChatStore.getState();
    const current = state.conversations.find((c) => c.id === state.activeConversationId) ?? null;
    const routing = planRepoPick({
      pick: repo,
      intent,
      current: current
        ? {
            id: current.id,
            title: current.title,
            repoContext: current.repoContext,
            updatedAt: current.updatedAt,
          }
        : null,
      conversations: state.conversations.map((c) => ({
        id: c.id,
        title: c.title,
        repoContext: c.repoContext,
        updatedAt: c.updatedAt,
      })),
    });

    const withRepo: RepoContext = { ...repo, attachedAt: Date.now() };
    const name = `${repo.owner}/${repo.repo}`;

    switch (routing.action) {
      case "none":
        return;

      case "attach":
      case "switch": {
        // No chat on screen (the store can be empty): one gets made here, with
        // the repository already on it, rather than attaching to nothing.
        if (!current || !state.activeConversationId) {
          handleNewChat({ repo: withRepo });
          return;
        }
        const leaving = current.repoContext;
        const kept = current.pendingChanges ?? 0;
        state.setConversationRepo(current.id, withRepo);
        // Silence here reads as loss, and the old behaviour really did lose it —
        // the workspace is kept per (chat, repo), so say where it went.
        if (leaving && kept > 0) {
          useAppStore.getState().addToast({
            message:
              `${kept} changed file${kept === 1 ? "" : "s"} kept for ` +
              `${leaving.owner}/${leaving.repo} — they come back when you re-attach it to this chat.`,
            type: "info",
            duration: 6000,
          });
        }
        return;
      }

      case "open-chat":
        state.selectConversation(routing.conversationId);
        setSidebarOpen(false);
        useAppStore.getState().addToast({
          message: `"${routing.title}" already works on ${name} — opened it instead of starting another.`,
          type: "info",
          duration: 5000,
        });
        return;

      case "new-chat":
        handleNewChat({ repo: withRepo });
        useAppStore.getState().addToast({
          message: `Started a new chat on ${name}. Your previous chat is still open in the sidebar.`,
          type: "info",
          duration: 5000,
        });
        return;
    }
  };

  const handleRepoDetach = () => {
    const state = useChatStore.getState();
    if (!state.activeConversationId) return;
    state.setConversationRepo(state.activeConversationId, undefined);
  };

  // Deleting the last conversation spawns NO replacement any more: the
  // repository's pinned sidebar row is what survives (deleteConversation
  // re-pins it), and a working chat is created lazily — by the row's "new
  // chat here" button, the send path (resolveTargetConversation), or the
  // hydration effect. An automatic replacement used to come up detached
  // whenever the store was empty, because inheritance had nothing to
  // inherit; the pin covers the repo, so the spawn is simply gone.
  const handleDeleteConversation = (id: string) => {
    useChatStore.getState().deleteConversation(id);
  };

  /**
   * Detach a REPOSITORY from the sidebar — the button on the repo row.
   *
   * This is the ONLY gesture that removes a repo row; deleting chats never
   * does. It unpins the row and, when a chat is currently attached to that
   * repo, detaches the chat too — that is what the button says, and leaving
   * the chat attached would put the row straight back on the next sync. Chats
   * themselves are kept: their transcripts outlive the repo's place in the
   * sidebar (the same rule the header's Detach follows for one chat).
   */
  const handleDetachRepo = (owner: string, repo: string) => {
    const state = useChatStore.getState();
    state.unpinRepoFromSidebar(owner, repo);
    const key = `${owner}/${repo}`.toLowerCase();
    for (const conv of state.conversations) {
      if (
        conv.repoContext &&
        `${conv.repoContext.owner}/${conv.repoContext.repo}`.toLowerCase() === key
      ) {
        state.setConversationRepo(conv.id, undefined);
      }
    }
  };

  const handleClearAllConversations = () => {
    useChatStore.setState({ conversations: [], activeConversationId: null });
    useChatStore.getState().createConversation(settings.defaultModel);
  };

  // The three pickers follow ONE rule: a change made in a chat belongs to that
  // chat, and a change made with no chat open becomes the default for the next
  // one (which is the empty state's whole purpose — it is where you set the
  // model/mode you are about to start working with).
  //
  // The model picker used to break that rule: it wrote `defaultModel` on every
  // switch, so the explicit "Default model" control in Chat settings was silently
  // overwritten by any casual model change, and the two controls disagreed about
  // which one decides. Effort and mode already behaved this way; the model picker
  // was the outlier, and the settings control now means what its label says.
  const handleModelChange = (modelId: string) => {
    if (activeConversationId) {
      useChatStore.getState().setConversationModel(activeConversationId, modelId);
      return;
    }
    useChatStore.getState().updateSettings({ defaultModel: modelId });
  };

  const handleEffortChange = (next: ReasoningEffort) => {
    if (activeConversationId) {
      useChatStore.getState().setConversationEffort(activeConversationId, next);
      return;
    }
    useChatStore.getState().updateSettings({ defaultReasoningEffort: next });
  };

  const handleModeChange = (next: ChatMode) => {
    if (activeConversationId) {
      useChatStore.getState().setConversationMode(activeConversationId, next);
      return;
    }
    useChatStore.getState().updateSettings({ defaultMode: next });
  };

  // Slash command entry point from the composer's command menu.
  // Clears the composer when the page (not the command) owns the
  // draft; submenu commands keep it open for their argument.
  const handleRunCommand = (command: ChatCommand, arg: string) => {
    if (!activeConversationId) return;
    if (command.hasSubmenu && !arg.trim()) {
      // /model without an arg enters the submenu in the composer —
      // the draft is still showing "/model", so leave it alone.
      return;
    }
    runCommand(command, arg);
  };

  return (
    <div className="chat-page">
      <ChatSidebar
        conversations={conversations}
        activeId={activeConversationId}
        statuses={conversationStatuses}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelect={(id) => useChatStore.getState().selectConversation(id)}
        onNew={() => handleNewChat({ repo: null })}
        onNewInRepo={(repo) => handleNewChat({ repo: { ...repo, attachedAt: Date.now() } })}
        onRename={(id, title) => useChatStore.getState().renameConversation(id, title)}
        onDelete={handleDeleteConversation}
        onDuplicate={(id) => useChatStore.getState().duplicateConversation(id)}
        onTogglePin={(id) => useChatStore.getState().togglePinConversation(id)}
        onDetachRepo={handleDetachRepo}
        onOpenSettings={() => useChatStore.getState().setSettingsOpen(true)}
      />

      <main className="chat-main">
        <ChatHeader
          model={modelId}
          models={models}
          modelsLoading={modelsLoading}
          onModelChange={handleModelChange}
          effort={effort}
          efforts={efforts}
          onEffortChange={handleEffortChange}
          mode={mode}
          onModeChange={handleModeChange}
          context={context}
          hasConversationPrompt={Boolean(activeConversation?.systemPrompt)}
          alwaysOnSkills={alwaysOnSkillNames}
          availableSkillCount={autoSkillCount}
          skillActivity={skillActivity}
          onOpenSkills={() => useChatStore.getState().setSettingsOpen(true, "skills")}
          repoContext={activeConversation?.repoContext}
          githubToken={settings.github?.token ?? ""}
          onRepoSelect={handleRepoPick}
          onRepoDetach={handleRepoDetach}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          isSidebarOpen={sidebarOpen}
          hasMessages={Boolean(activeConversation?.messages.length)}
          onExport={() => {
            if (activeConversationId) downloadConversation(activeConversationId);
          }}
        />

        {panelVisible && !narrow ? (
          <div className="chat-agent-layout">
            <Group orientation="horizontal">
              <Panel defaultSize={55} minSize={30}>
                <div className="chat-agent-chat-column">
                  <MessageList
                    key={activeConversationId ?? "empty"}
                    messages={activeConversation?.messages ?? []}
                    defaultModel={modelName}
                    hasApiKey={Boolean(settings.apiKey)}
                    summary={activeConversation?.summary}
                    onSuggestion={handleSuggestion}
                    onRegenerate={() =>
                      activeConversationId && regenerateLastResponse(activeConversationId)
                    }
                    onOpenSettings={() => useChatStore.getState().setSettingsOpen(true)}
                  />

                  {/* The plan is the agent's contract with the user and the
                      completion gate reads it — opening the Changes panel is
                      no reason to hide it. */}
                  <PlanStrip conversationId={activeConversationId} />

                  {/* Live activity: what the agent is doing right now, one line
                      above the composer, where the eye already is while
                      waiting. Derived from state this page holds — see
                      lib/activity.ts. */}
                  <ActivityRail
                    conversationId={activeConversationId}
                    filesChanged={changeSet.fileCount}
                    onOpenChanges={() => setClosedForAttachment(null)}
                  />

                  {/* What this page can execute, and whether the app is running
                      in it. Above the composer for the same reason the activity
                      rail is: it answers a question the user has while waiting,
                      and it says which workspace a "verified" chip came from —
                      this tab, or a daemon they paired. */}
                  <WorkspaceStrip
                    conversationId={activeConversationId}
                    repoAttached={repoAttached}
                    previewShown={panelVisible && panelTab === "preview"}
                    onShowPreview={() => {
                      setClosedForAttachment(null);
                      setPanelTab("preview");
                    }}
                  />

                  <Composer
                    value={draft}
                    onChange={setDraft}
                    onSend={handleSend}
                    onStop={handleStop}
                    isStreaming={isStreamingHere}
                    placeholder={
                      activeConversation?.repoContext
                        ? `Ask about ${activeConversation.repoContext.owner}/${activeConversation.repoContext.repo}…`
                        : `Message ${modelName}…`
                    }
                    attachments={pendingImages}
                    onAttachmentsChange={setPendingImages}
                    onTextFilesImported={(md) => setDraft((d) => d + md)}
                    modelSupportsImages={modelSupportsImages(modelId)}
                    models={models}
                    modelsLoading={modelsLoading}
                    activeModelId={modelId}
                    onRunCommand={handleRunCommand}
                    onModelChange={handleModelChange}
                    mentionPaths={mentionPaths}
                    suggestions={activeConversation?.suggestions}
                    onSuggestion={handleSuggestion}
                    queued={activeConversation?.queued}
                    onRemoveQueued={(id) =>
                      activeConversationId &&
                      useChatStore.getState().removeQueuedMessage(activeConversationId, id)
                    }
                  />
                </div>
              </Panel>
              <Separator className="chat-agent-resize-handle" />
              <Panel defaultSize={45} minSize={25}>
                <div className="chat-agent-panel">
                  {/* Not `standalone`: the chat header is on screen above this
                      pane, and it already states the verification status — one
                      surface says it, this one acts on it. */}
                  <ChangesPane
                    conversationId={activeConversationId}
                    tab={panelTab}
                    onTabChange={setPanelTab}
                    onClose={() => {
                      if (attachedAt) setClosedForAttachment(attachedAt);
                    }}
                  />
                </div>
              </Panel>
            </Group>
          </div>
        ) : (
          <>
            <MessageList
              key={activeConversationId ?? "empty"}
              messages={activeConversation?.messages ?? []}
              defaultModel={modelName}
              hasApiKey={Boolean(settings.apiKey)}
              summary={activeConversation?.summary}
              onSuggestion={handleSuggestion}
              onRegenerate={() =>
                activeConversationId && regenerateLastResponse(activeConversationId)
              }
              onOpenSettings={() => useChatStore.getState().setSettingsOpen(true)}
            />

            <PlanStrip conversationId={activeConversationId} />

            <ActivityRail
              conversationId={activeConversationId}
              filesChanged={changeSet.fileCount}
              onOpenChanges={() => {
                // With no repository attached there is no Changes pane to open;
                // the rail's line is about files, so it only offers the button
                // when a workspace exists to show.
                if (repoAttached) setClosedForAttachment(null);
              }}
            />

            <WorkspaceStrip
              conversationId={activeConversationId}
              repoAttached={repoAttached}
              previewShown={narrow && panelVisible && panelTab === "preview"}
              onShowPreview={() => {
                if (repoAttached) setClosedForAttachment(null);
                setPanelTab("preview");
              }}
            />

            <Composer
              value={draft}
              onChange={setDraft}
              onSend={handleSend}
              onStop={handleStop}
              isStreaming={isStreamingHere}
              placeholder={
                activeConversation?.repoContext
                  ? `Ask about ${activeConversation.repoContext.owner}/${activeConversation.repoContext.repo}…`
                  : `Message ${modelName}…`
              }
              attachments={pendingImages}
              onAttachmentsChange={setPendingImages}
              onTextFilesImported={(md) => setDraft((d) => d + md)}
              modelSupportsImages={modelSupportsImages(modelId)}
              models={models}
              modelsLoading={modelsLoading}
              activeModelId={modelId}
              onRunCommand={handleRunCommand}
              onModelChange={handleModelChange}
              mentionPaths={mentionPaths}
              suggestions={activeConversation?.suggestions}
              onSuggestion={handleSuggestion}
              queued={activeConversation?.queued}
              onRemoveQueued={(id) =>
                activeConversationId &&
                useChatStore.getState().removeQueuedMessage(activeConversationId, id)
              }
            />
            {narrow && panelVisible && (
              <ChangesSheet
                conversationId={activeConversationId}
                tab={panelTab}
                onTabChange={setPanelTab}
                onClose={() => {
                  if (attachedAt) setClosedForAttachment(attachedAt);
                }}
              />
            )}
            {repoAttached && !panelVisible && (
              <button
                type="button"
                className="chat-changes-open-fab"
                onClick={() => setClosedForAttachment(null)}
                title={
                  changeSet.empty
                    ? "Show agent changes"
                    : `Show ${changeSet.fileCount} changed file${changeSet.fileCount === 1 ? "" : "s"}`
                }
              >
                <FileDiff className="h-4 w-4" />
                Changes
                {!changeSet.empty && <span className="chat-changes-open-count">{changeSet.fileCount}</span>}
              </button>
            )}
          </>
        )}
      </main>

      <PushApprovalModal />

      {/* The gate for the agent's external writes. A dialog rather than a
          tool argument, because "may I POST this?" is answered by looking at
          the request, not by trusting the model's summary of it. */}
      <HttpApprovalModal />

      <ChatSettingsModal
        open={settingsOpen}
        settings={settings}
        conversationCount={conversations.length}
        models={models}
        initialTab={settingsTab}
        onClose={() => useChatStore.getState().setSettingsOpen(false)}
        onUpdate={(patch) => useChatStore.getState().updateSettings(patch)}
        onClearAllConversations={handleClearAllConversations}
        onAddSkill={(skill) => useChatStore.getState().addSkill(skill)}
        onUpdateSkill={(id, patch) => useChatStore.getState().updateSkill(id, patch)}
        onDeleteSkill={(id) => useChatStore.getState().deleteSkill(id)}
        onResetBuiltinSkills={() => useChatStore.getState().resetBuiltinSkills()}
      />
    </div>
  );
}
