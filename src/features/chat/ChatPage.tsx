// ============================================================
// Chat Page — OpenRouter-Powered AI Chat
// ============================================================
// Layout mirrors ApiTester: conversation sidebar + main pane.
// The context engine keeps requests within the model's window and
// the meter reflects live usage.

import React, { useEffect, useMemo, useState } from "react";
import { useChatStore, selectActiveConversation } from "@/stores/chat.store";
import {
  displayNameFor,
  regenerateLastResponse,
  resolveModelInfo,
  sendUserMessage,
  stopChatStream,
  downloadConversation,
  ensureModelCatalog,
} from "./services/chat-runner";
import { getConversationContext, composeSystemPrompt } from "./context/engine";
import { buildEffectiveSystemPrompt } from "./lib/skills";
import { ChatSidebar } from "./components/ChatSidebar";
import { ChatHeader } from "./components/ChatHeader";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ChatSettingsModal } from "./components/ChatSettingsModal";
import { modelSupportsImages } from "./services/chat-runner";
import type { ChatAttachment, ModelInfo, RepoContext } from "./types";
import type { ChatCommand } from "./lib/commands";
import "./chat.css";

/** Display name for a model id (masks InTab routing; falls back to the id) */
function modelDisplayName(modelId: string, models: ModelInfo[]): string {
  return displayNameFor(modelId, models);
}

export function ChatPage() {
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const settings = useChatStore((s) => s.settings);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingConversationId = useChatStore((s) => s.streamingConversationId);
  const settingsOpen = useChatStore((s) => s.settingsOpen);
  const settingsTab = useChatStore((s) => s.settingsTab);

  const activeConversation = useChatStore(selectActiveConversation);

  const [draft, setDraft] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingImages, setPendingImages] = useState<ChatAttachment[]>([]);

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

  // Compose the same effective prompt the runner will send — skills
  // plus the rolling summary — so the context meter reflects exactly
  // what the next request costs.
  const effectiveSystemPrompt = useMemo(() => {
    const base =
      activeConversation?.systemPrompt?.trim() || settings.systemPrompt.trim() || "";
    const withSkills = buildEffectiveSystemPrompt(base, settings.skills ?? []);
    return composeSystemPrompt(withSkills, activeConversation?.summary);
  }, [activeConversation?.systemPrompt, activeConversation?.summary, settings.systemPrompt, settings.skills]);

  const context = useMemo(
    () =>
      getConversationContext({
        conversation: activeConversation ?? { id: "", title: "", messages: [], createdAt: 0, updatedAt: 0 },
        model: modelInfo,
        effectiveSystemPrompt,
      }),
    [activeConversation, modelInfo, effectiveSystemPrompt]
  );

  const handleSend = () => {
    if (!activeConversationId) return;
    if (!draft.trim() && pendingImages.length === 0) return;
    const text = draft;
    const images = pendingImages;
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

  // Slash command entry point from the composer's command menu.
  // Clears the composer when the page (not the command) owns the
  // draft; submenu commands keep it open for their argument.
  const handleRunCommand = (command: ChatCommand, arg: string) => {
    if (!activeConversationId) return;
    if (command.hasSubmenu) {
      // /model without an arg enters the submenu in the composer —
      // the draft is still showing "/model", so leave it alone.
      if (!arg.trim()) return;
      command.run({ conversationId: activeConversationId, arg, models });
      setDraft("");
      return;
    }
    command.run({ conversationId: activeConversationId, arg, models });
    setDraft("");
  };

  // Streaming is scoped to one conversation: other chats stay fully
  // usable while a stream runs elsewhere.
  const isStreamingHere = isStreaming && streamingConversationId === activeConversationId;

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
          context={context}
          onOpenSettings={() => useChatStore.getState().setSettingsOpen(true)}
          onExport={() => activeConversationId && downloadConversation(activeConversationId)}
          hasMessages={Boolean(activeConversation && activeConversation.messages.length > 0)}
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
      </main>

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
