// ============================================================
// Chat Page — OpenRouter-Powered AI Chat
// ============================================================
// Layout mirrors ApiTester: conversation sidebar + main pane.
// The context engine keeps requests within the model's window and
// the meter reflects live usage.

import React, { useEffect, useMemo, useState } from "react";
import { TopLoadingBar } from "@/components/ui/top-loading-bar";
import { useChatStore, selectActiveConversation } from "@/stores/chat.store";
import {
  regenerateLastResponse,
  resolveModelInfo,
  sendUserMessage,
  stopChatStream,
  downloadConversation,
  ensureModelCatalog,
} from "./services/chat-runner";
import { getConversationContext } from "./context/engine";
import { buildEffectiveSystemPrompt } from "./lib/skills";
import { ChatSidebar } from "./components/ChatSidebar";
import { ChatHeader } from "./components/ChatHeader";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { ChatSettingsModal } from "./components/ChatSettingsModal";
import type { ModelInfo } from "./types";
import "./chat.css";

export function ChatPage() {
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const settings = useChatStore((s) => s.settings);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const settingsOpen = useChatStore((s) => s.settingsOpen);
  const settingsTab = useChatStore((s) => s.settingsTab);

  const activeConversation = useChatStore(selectActiveConversation);

  const [draft, setDraft] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Fetch the live model catalog when a key becomes available.
  // All setState calls happen in async callbacks (never the effect
  // body) to avoid cascading renders.
  useEffect(() => {
    const apiKey = useChatStore.getState().settings.apiKey;
    if (!apiKey) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
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
  }, []);

  // Guarantee an active conversation exists on first mount
  useEffect(() => {
    if (!activeConversationId && conversations.length === 0 && !isStreaming) {
      useChatStore.getState().createConversation(settings.defaultModel);
    } else if (!activeConversationId && conversations.length > 0) {
      useChatStore.getState().selectConversation(
        conversations[0]!.id
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const modelId = activeConversation?.model ?? settings.defaultModel;
  const modelInfo = useMemo(() => resolveModelInfo(modelId), [modelId]);

  // Compose the same effective prompt the runner will send so the
  // context meter reflects skills overhead.
  const effectiveSystemPrompt = useMemo(() => {
    const base =
      activeConversation?.systemPrompt?.trim() || settings.systemPrompt.trim() || "";
    return buildEffectiveSystemPrompt(base, settings.skills ?? []);
  }, [activeConversation?.systemPrompt, settings.systemPrompt, settings.skills]);

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
    if (!activeConversationId || !draft.trim()) return;
    const text = draft;
    setDraft("");
    sendUserMessage(activeConversationId, text);
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
  };

  const handleDeleteConversation = (id: string) => {
    useChatStore.getState().deleteConversation(id);
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

  return (
    <div className="chat-page">
      <TopLoadingBar />

      <ChatSidebar
        conversations={conversations}
        activeId={activeConversationId}
        onSelect={(id) => useChatStore.getState().selectConversation(id)}
        onNew={handleNewChat}
        onRename={(id, title) => useChatStore.getState().renameConversation(id, title)}
        onDelete={handleDeleteConversation}
        onTogglePin={(id) => useChatStore.getState().togglePinConversation(id)}
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
          hasConversationPrompt={Boolean(activeConversation?.systemPrompt)}
          activeSkillCount={(settings.skills ?? []).filter((s) => s.enabled).length}
          onOpenSkills={() => useChatStore.getState().setSettingsOpen(true, "skills")}        />

        <MessageList
          key={activeConversationId ?? "empty"}
          messages={activeConversation?.messages ?? []}
          streamingContent={streamingContent}
          isStreaming={isStreaming}
          defaultModel={modelId}
          onSuggestion={handleSuggestion}
          onRegenerate={() =>
            activeConversationId && regenerateLastResponse(activeConversationId)
          }
        />

        <Composer
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          placeholder={`Message ${modelId}…`}
        />
      </main>

      <ChatSettingsModal
        open={settingsOpen}
        settings={settings}
        conversationCount={conversations.length}
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
