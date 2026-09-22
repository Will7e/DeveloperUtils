// ============================================================
// Chat Page — OpenRouter-Powered AI Chat
// ============================================================
// Layout mirrors ApiTester: conversation sidebar + main pane.
// The context engine keeps requests within the model's window and
// the meter reflects live usage.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { MonitorPlay } from "lucide-react";
import { useChatStore, selectActiveConversation } from "@/stores/chat.store";
import { useWorkspaceStoreSlice } from "@/hooks/useWorkspace";
import { flushWorkspaceSave } from "./workspace/workspace";
import {
  modelDisplayName,
  regenerateLastResponse,
  resolveModelInfo,
  sendUserMessage,
  stopChatStream,
  ensureModelCatalog,
  resumeInterruptedTurn,
  resumeUserTurn,
  commitPartialReply,
} from "./services/chat-runner";
import { getConversationContext, composeSystemPrompt } from "./context/engine";
import { buildEffectiveSystemPrompt } from "./lib/skills";
import { CHAT_COMMANDS, CHAT_COMMAND_BY_ID } from "./lib/commands";
import { resolveSlashInput } from "./lib/slash";
import { useAppStore } from "@/stores/app.store";
import { ChatSidebar } from "./components/ChatSidebar";
import { ChatHeader } from "./components/ChatHeader";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ChatSettingsModal } from "./components/ChatSettingsModal";
import { PushApprovalModal } from "./components/PushApprovalModal";
import { PreviewPane } from "./preview/PreviewPane";
import { usePreviewBridge } from "./preview/preview-bridge";
import { modelSupportsImages } from "./services/chat-runner";
import { sessionHost } from "./session/session-client";
import { logTurnEvent } from "./session/turn-log";
import { isTurnUnrecoverable } from "./session/turn-engine";
import { availableEfforts, modelSupportsTools } from "./lib/model-state";
import { resolveToolProfile } from "./lib/tool-profiles";
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
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingConversationId = useChatStore((s) => s.streamingConversationId);
  const settingsOpen = useChatStore((s) => s.settingsOpen);
  const settingsTab = useChatStore((s) => s.settingsTab);

  const activeConversation = useChatStore(selectActiveConversation);

  // Streaming is scoped to one conversation: other chats stay fully
  // usable while a stream runs elsewhere. (Declared before the
  // command helpers, which read it during render.)
  const isStreamingHere = isStreaming && streamingConversationId === activeConversationId;

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // ── Per-conversation composer state ──
  // A draft belongs to the chat it was typed in. Keeping one shared
  // draft meant switching chats carried the text (and the attached
  // images) into the wrong thread — where Enter would send it. Drafts
  // are stashed per conversation and restored when you come back.
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<ChatAttachment[]>([]);
  const composerByConversation = useRef(
    new Map<string, { draft: string; images: ChatAttachment[] }>()
  );
  const draftOwnerRef = useRef<string | null>(activeConversationId);

  // Render-time reconciliation: when the active conversation changes,
  // stash what was typed and restore the new chat's own draft. (No
  // effect: this must land in the same commit as the switch, or a
  // keystroke could be attributed to the previous chat.)
  if (draftOwnerRef.current !== activeConversationId) {
    const previous = draftOwnerRef.current;
    if (previous) {
      composerByConversation.current.set(previous, { draft, images: pendingImages });
    }
    const restored = activeConversationId
      ? composerByConversation.current.get(activeConversationId)
      : undefined;
    draftOwnerRef.current = activeConversationId;
    setDraft(restored?.draft ?? "");
    setPendingImages(restored?.images ?? []);
  }

  // Agent workspace: ensures the workspace exists on repo attach and
  // exposes the attachment state for the preview toggle.
  const { repoAttached } = useWorkspaceStoreSlice();
  usePreviewBridge();

  // Auto-open the preview on attach: derive from the repo context so
  // no effect-based setState is needed. Once closed manually it stays
  // closed for this attachment (tracked by attachedAt).
  const attachedAt = activeConversation?.repoContext?.attachedAt ?? 0;
  const [closedForAttachment, setClosedForAttachment] = useState<number | null>(null);
  const shouldShowPreview = repoAttached && closedForAttachment !== attachedAt;
  const previewVisible = previewOpen && shouldShowPreview;

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
      if (state.activeConversationId || state.isStreaming) return;
      if (state.conversations.length > 0) {
        state.selectConversation(state.conversations[0]!.id);
      } else {
        state.createConversation(state.settings.defaultModel);
      }
    };

    if (useChatStore.persist.hasHydrated()) ensureConversation();
    return useChatStore.persist.onFinishHydration(ensureConversation);
  }, []);

  // Resume a turn that was streaming when the page reloaded. The
  // persisted pendingTurn marker + trailing user message identify the
  // lost response; resumeInterruptedTurn validates and re-streams
  // (or adopts the host's live stream) through the normal turn loop.
  useEffect(() => {
    const resume = () => {
      const state = useChatStore.getState();
      state.cleanupStalePendingTurns();
      if (state.isStreaming) return;
      // Most recently interrupted first; markers flagged unresumable
      // wait for the explicit Resume affordance instead of retrying
      // the failed auto path on every load.
      const candidates = state.conversations
        .filter((c) => c.pendingTurn && c.pendingTurn.outcome !== "unresumable")
        .sort((a, b) => (b.pendingTurn!.startedAt ?? 0) - (a.pendingTurn!.startedAt ?? 0));
      for (const conv of candidates) {
        void resumeInterruptedTurn(conv.id);
        break; // one stream at a time
      }
    };

    if (useChatStore.persist.hasHydrated()) resume();
    return useChatStore.persist.onFinishHydration(resume);
  }, []);

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
      const id = state.streamingConversationId ?? state.activeConversationId;
      if (id) commitPartialReply(id);
      // Workspaces save on a debounce — flush the active one so an
      // instant close can't lose the last agent edit.
      const ws = state.workspaces[id ?? ""];
      if (ws) void flushWorkspaceSave(id!, ws);
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

  // Global shortcut: ⌘⇧N (or Ctrl+Shift+N) starts a new chat,
  // matching the sidebar button's tooltip.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        useChatStore.getState().createConversation(settings.defaultModel);
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
  const modelInfo = useMemo(() => resolveModelInfo(modelId), [modelId]);
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
    return composeSystemPrompt(withSkills, activeConversation?.summary);
  }, [activeConversation?.systemPrompt, activeConversation?.summary, settings.systemPrompt, settings.skills]);

  // The tool schemas this conversation would actually send next turn —
  // the meter must charge for them, exactly as the runner does, or it
  // reports a window several thousand tokens emptier than the truth.
  const contextTools = useMemo(() => {
    if (!activeConversation?.repoContext || !settings.github.token) return undefined;
    if (!modelSupportsTools(modelInfo)) return undefined;
    return resolveToolProfile(mode, modelInfo).tools;
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
      const outcome = command.run({
        conversationId: activeConversationId,
        arg,
        models,
        isStreaming: isStreamingHere,
      });
      // Commands may hand the composer a draft (/help reopens the
      // menu); otherwise the input is cleared.
      void Promise.resolve(outcome).then((result) => {
        setDraft(result && typeof result === "object" ? result.draft ?? "" : "");
      });
    },
    [activeConversationId, models, isStreamingHere]
  );

  const handleSend = () => {
    if (!activeConversationId) return;
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
    sendUserMessage(
      activeConversationId,
      text,
      images.length > 0 ? images : undefined
    );
  };

  const handleSuggestion = (text: string) => {
    if (!activeConversationId) return;
    setDraft("");
    sendUserMessage(activeConversationId, text);
  };

  const handleStop = () => {
    stopChatStream();
  };

  const handleNewChat = () => {
    useChatStore.getState().createConversation(settings.defaultModel);
    setSidebarOpen(false);
  };

  const handleDeleteConversation = (id: string) => {
    useChatStore.getState().deleteConversation(id);
    // Deleting the last conversation leaves the store empty — spin
    // up a fresh chat so the composer is always usable (mirrors the
    // Clear-All behavior in settings).
    const state = useChatStore.getState();
    if (state.conversations.length === 0) {
      state.createConversation(state.settings.defaultModel);
    }
  };

  const handleClearAllConversations = () => {
    useChatStore.setState({ conversations: [], activeConversationId: null });
    useChatStore.getState().createConversation(settings.defaultModel);
  };

  const handleModelChange = (modelId: string) => {
    if (activeConversationId) {
      useChatStore.getState().setConversationModel(activeConversationId, modelId);
    }
    // First model switch also becomes the default for future chats
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
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelect={(id) => useChatStore.getState().selectConversation(id)}
        onNew={handleNewChat}
        onRename={(id, title) => useChatStore.getState().renameConversation(id, title)}
        onDelete={handleDeleteConversation}
        onDuplicate={(id) => useChatStore.getState().duplicateConversation(id)}
        onTogglePin={(id) => useChatStore.getState().togglePinConversation(id)}
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
          activeSkillCount={(settings.skills ?? []).filter((s) => s.enabled).length}
          onOpenSkills={() => useChatStore.getState().setSettingsOpen(true, "skills")}
          repoContext={activeConversation?.repoContext}
          githubToken={settings.github?.token ?? ""}
          onRepoChange={(repo) => {
            if (!activeConversationId) return;
            // Store action accepts the selection and stamps attachedAt
            useChatStore.getState().setConversationRepo(
              activeConversationId,
              repo as RepoContext | undefined
            );
          }}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          isSidebarOpen={sidebarOpen}
        />

        {previewVisible ? (
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
                  <Composer
                    value={draft}
                    onChange={setDraft}
                    onSend={handleSend}
                    onStop={handleStop}
                    isStreaming={isStreamingHere}
                    disabled={isStreaming && !isStreamingHere}
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
                  />
                </div>
              </Panel>
              <Separator className="chat-agent-resize-handle" />
              <Panel defaultSize={45} minSize={25}>
                <PreviewPane
                  onClose={() => {
                    setPreviewOpen(false);
                    if (attachedAt) setClosedForAttachment(attachedAt);
                  }}
                />
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

            <Composer
              value={draft}
              onChange={setDraft}
              onSend={handleSend}
              onStop={handleStop}
              isStreaming={isStreamingHere}
              disabled={isStreaming && !isStreamingHere}
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
            />
            {repoAttached && !previewVisible && (
              <button
                type="button"
                className="chat-preview-open-fab"
                onClick={() => setPreviewOpen(true)}
                title="Show live preview"
              >
                <MonitorPlay className="h-4 w-4" />
                Preview
              </button>
            )}
          </>
        )}
      </main>

      <PushApprovalModal />

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
