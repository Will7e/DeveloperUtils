// ============================================================
// ChatEmptyState — Minimalist greeting and ready state
// ============================================================

import { useChatStore } from "@/stores/chat.store";
import { PROVIDER_LABELS } from "../types";
import { ProviderIcon } from "./ProviderIcon";

export function ChatEmptyState() {
  const activeProvider = useChatStore((s) => s.settings.activeProvider);
  const activeModel = useChatStore((s) => s.settings.activeModel);

  return (
    <div className="chat-empty-state">
      <div className="chat-empty-logo">
        <ProviderIcon provider={activeProvider} modelId={activeModel} className="w-12 h-12" />
      </div>
      <h2 className="chat-empty-title">InTab AI Assistant</h2>
      <p className="chat-empty-subtitle">
        Powered by {PROVIDER_LABELS[activeProvider]} ({activeModel}).
        Ready to assist with code architecture, debugging, analysis, and developer workflows.
      </p>
    </div>
  );
}
