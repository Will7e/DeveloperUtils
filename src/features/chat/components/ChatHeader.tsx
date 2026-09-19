// ============================================================
// ChatHeader — Top status bar with model switcher & context token meter
// ============================================================

import { useMemo } from "react";
import {
  Trash2,
  ChevronDown,
  Check,
  AppWindow,
  MessageSquare,
  Terminal,
  HardDrive,
  Sparkles,
  AlertTriangle,
  Info,
  Download,
} from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CURATED_MODELS, PROVIDER_LABELS, type AIProvider } from "../types";
import {
  calculateConversationTokens,
  formatTokenCount,
} from "../utils/token-counter";
import { ProviderIcon } from "./ProviderIcon";
import { exportConversationAsMarkdown } from "../utils/export-utils";

interface ChatHeaderProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

/**
 * Clean percentage formatter that avoids misleading 0.0% for small non-zero token counts
 */
function formatPercent(tokens: number, max: number): string {
  if (!tokens || !max) return "0%";
  const pct = (tokens / max) * 100;
  if (pct < 0.01) return "<0.01%";
  if (pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

export function ChatHeader({ sidebarOpen: _sidebarOpen, onToggleSidebar: _onToggleSidebar }: ChatHeaderProps) {
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const conversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === activeConversationId)
  );
  const settings = useChatStore((s) => s.settings);
  const updateSettings = useChatStore((s) => s.updateSettings);
  const clearActiveConversation = useChatStore((s) => s.clearActiveConversation);

  const hasMessages = Boolean(conversation && conversation.messages.length > 0);
  const currentModel = CURATED_MODELS.find((m) => m.id === settings.activeModel);
  const currentProvider = settings.activeProvider;
  const currentProviderLabel = PROVIDER_LABELS[currentProvider] || currentProvider;

  const handleSelectModel = (provider: AIProvider, modelId: string) => {
    updateSettings({
      activeProvider: provider,
      activeModel: modelId,
      defaultProvider: provider,
      defaultModel: modelId,
    });
  };

  // Calculate real-time context token usage
  const tokenBreakdown = useMemo(() => {
    return calculateConversationTokens({
      messages: conversation?.messages,
      systemPrompt: conversation?.systemPrompt || settings.systemPrompt,
      skills: settings.skills,
      modelId: settings.activeModel,
    });
  }, [
    conversation?.messages,
    conversation?.systemPrompt,
    settings.systemPrompt,
    settings.skills,
    settings.activeModel,
  ]);

  const maxTokens = tokenBreakdown.maxTokens || 1;
  const systemPromptPercent = maxTokens > 0 ? (tokenBreakdown.systemPromptTokens / maxTokens) * 100 : 0;
  const skillsPercent = maxTokens > 0 ? (tokenBreakdown.skillsTokens / maxTokens) * 100 : 0;
  const messagesPercent = maxTokens > 0 ? (tokenBreakdown.messagesTokens / maxTokens) * 100 : 0;

  const activeSkillsCount = useMemo(
    () => (settings.skills || []).filter((s) => s.enabled).length,
    [settings.skills]
  );
  const messageCount = conversation?.messages?.length || 0;

  // Context token meter health styling
  const healthColor =
    tokenBreakdown.percentageUsed > 80
      ? "var(--red, #ef4444)"
      : tokenBreakdown.percentageUsed > 50
      ? "var(--yellow, #eab308)"
      : "var(--accent, #38bdf8)";

  const healthBadgeLabel =
    tokenBreakdown.health === "optimal"
      ? "Optimal"
      : tokenBreakdown.health === "moderate"
      ? "Moderate"
      : tokenBreakdown.health === "near-limit"
      ? "Near Limit"
      : "Exceeded";

  const isLargeContextModel = Boolean(currentModel?.contextWindow?.includes("M"));

  return (
    <header className="chat-header">
      {/* Left Area: Enhanced Model Selector Dropdown (No duplicate toggle button) */}
      <div className="flex items-center gap-3">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="chat-header-model-dropdown group"
              title="Click to switch AI Model"
            >
              <div className="flex items-center gap-2 min-w-0">
                <ProviderIcon provider={currentProvider} className="h-4 w-4 shrink-0" />
                <span className="chat-model-name truncate">
                  {currentModel?.name || settings.activeModel}
                </span>
                <span className={`chat-model-context-pill ${isLargeContextModel ? "large" : ""}`}>
                  {(currentModel?.contextWindow || "128k").replace(" context", "")}
                </span>
              </div>
              <ChevronDown className="h-3 w-3 text-text-3 group-hover:text-text-1 transition-transform group-data-[state=open]:rotate-180 shrink-0 opacity-70 ml-1" />
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="start"
            sideOffset={6}
            className="chat-header-dropdown-menu"
          >
            <div className="chat-dropdown-header">
              <span className="chat-dropdown-header-title">Select AI Model</span>
              <span className="chat-dropdown-header-count">{CURATED_MODELS.length} Models</span>
            </div>

            <div className="chat-dropdown-scroll-body">
              {(["gemini", "openai", "anthropic"] as const).map((prov) => {
                const providerModels = CURATED_MODELS.filter((m) => m.provider === prov);

                return (
                  <div key={prov} className="chat-dropdown-provider-group">
                    <div className="chat-dropdown-provider-label">
                      <div className="flex items-center gap-1.5">
                        <ProviderIcon provider={prov} className="h-3.5 w-3.5" />
                        <span>{PROVIDER_LABELS[prov]}</span>
                      </div>
                      <span className="chat-dropdown-group-count">{providerModels.length}</span>
                    </div>

                    {providerModels.map((m) => {
                      const isSelected = m.id === settings.activeModel;
                      const isModelLargeContext = Boolean(m.contextWindow?.includes("M"));

                      return (
                        <DropdownMenuItem
                          key={m.id}
                          onClick={() => handleSelectModel(m.provider, m.id)}
                          className={`chat-dropdown-model-item ${
                            isSelected ? "chat-dropdown-model-item-selected" : ""
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1 pr-2">
                            <ProviderIcon
                              provider={m.provider}
                              modelId={m.id}
                              className="h-3.5 w-3.5 shrink-0 opacity-85"
                            />
                            <div className="flex flex-col min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-text-1 text-xs truncate">
                                  {m.name}
                                </span>
                                {m.isDefault && (
                                  <span className="chat-model-tag default">Default</span>
                                )}
                                <span className={`chat-model-tag context ml-auto ${isModelLargeContext ? "large" : ""}`}>
                                  {(m.contextWindow || "").replace(" context", "")}
                                </span>
                              </div>
                              <span className="text-[10px] text-text-3 truncate mt-0.5">
                                {m.description}
                              </span>
                            </div>
                          </div>

                          {isSelected && (
                            <Check className="h-3.5 w-3.5 text-accent shrink-0 ml-1.5" />
                          )}
                        </DropdownMenuItem>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Right Area: Context Token Meter & Clear Action */}
      <div className="flex items-center gap-2">
        {/* Context Window Calculation Widget */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="chat-header-token-pill group"
              aria-label={`Context Tokens: ${formatTokenCount(tokenBreakdown.totalTokens)} of ${formatTokenCount(tokenBreakdown.maxTokens)}`}
              title="Context Window — Click to view memory and capacity breakdown"
            >
              <div className="chat-token-pill-badge">
                <AppWindow className="h-3.5 w-3.5 text-accent" />
              </div>

              <div className="chat-token-pill-text">
                <span className="chat-token-pill-used font-mono">
                  {formatTokenCount(tokenBreakdown.totalTokens)}
                </span>
                <span className="chat-token-pill-sep">/</span>
                <span className="chat-token-pill-max font-mono">
                  {formatTokenCount(tokenBreakdown.maxTokens)}
                </span>
              </div>

              {/* Mini visual usage track */}
              <div className="chat-header-token-mini-track">
                <div
                  className="chat-header-token-mini-fill"
                  style={{
                    width: `${Math.max(4, Math.min(100, tokenBreakdown.percentageUsed))}%`,
                    backgroundColor: healthColor,
                  }}
                />
              </div>

              <ChevronDown className="h-3 w-3 text-text-3 group-hover:text-text-1 transition-transform group-data-[state=open]:rotate-180 opacity-70 ml-0.5" />
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="end"
            sideOffset={6}
            className="chat-token-popover-menu"
          >
            {/* Header: Title & Health status badge (Model badge removed as requested) */}
            <div className="chat-token-popover-header">
              <div className="flex items-center gap-2 min-w-0">
                <div className="chat-token-icon-frame">
                  <AppWindow className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0">
                  <span className="chat-token-popover-title">Context Window</span>
                  <p className="chat-token-popover-subtitle">
                    {formatTokenCount(tokenBreakdown.totalTokens)} / {formatTokenCount(tokenBreakdown.maxTokens)} used ({formatPercent(tokenBreakdown.totalTokens, maxTokens)})
                  </p>
                </div>
              </div>

              <div
                className="chat-token-health-badge"
                style={{
                  color: healthColor,
                  borderColor: `${healthColor}40`,
                  background: `${healthColor}15`,
                }}
              >
                <span
                  className="chat-token-health-dot"
                  style={{ backgroundColor: healthColor }}
                />
                <span>{healthBadgeLabel}</span>
              </div>
            </div>

            {/* Visual Multi-Segment Usage Progress Bar */}
            <div className="chat-token-meter-section">
              <div className="chat-token-segmented-bar">
                {/* System Prompt segment */}
                <div
                  className="chat-token-segment system"
                  style={{
                    width: `${Math.min(100, Math.max(0, systemPromptPercent))}%`,
                  }}
                  title={`System Prompt: ~${tokenBreakdown.systemPromptTokens} tokens`}
                />
                {/* Active Skills segment */}
                <div
                  className="chat-token-segment skills"
                  style={{
                    width: `${Math.min(100 - systemPromptPercent, Math.max(0, skillsPercent))}%`,
                  }}
                  title={`Active Skills: ~${tokenBreakdown.skillsTokens} tokens`}
                />
                {/* Conversation Messages segment */}
                <div
                  className="chat-token-segment messages"
                  style={{
                    width: `${Math.min(100 - systemPromptPercent - skillsPercent, Math.max(0, messagesPercent))}%`,
                  }}
                  title={`Conversation Messages: ~${tokenBreakdown.messagesTokens} tokens`}
                />
              </div>
            </div>

            {/* Itemized Context Allocation Breakdown */}
            <div className="chat-token-breakdown-list">
              {/* 1. System Prompt */}
              <div className="chat-token-breakdown-row">
                <div className="flex items-center gap-2 text-text-2 min-w-0">
                  <Terminal className="h-3.5 w-3.5 text-purple shrink-0" />
                  <span className="truncate">System Prompt</span>
                </div>
                <div className="flex items-center gap-2 shrink-0 font-mono text-xs">
                  <span className="text-text-1">~{tokenBreakdown.systemPromptTokens.toLocaleString()}</span>
                  <span className="chat-token-breakdown-pct">
                    {formatPercent(tokenBreakdown.systemPromptTokens, maxTokens)}
                  </span>
                </div>
              </div>

              {/* 2. Active Skills */}
              <div className="chat-token-breakdown-row">
                <div className="flex items-center gap-2 text-text-2 min-w-0">
                  <Sparkles className="h-3.5 w-3.5 text-teal-400 shrink-0" />
                  <span className="truncate">Active Skills</span>
                  <span className="chat-token-breakdown-tag">
                    {activeSkillsCount > 0 ? `${activeSkillsCount} active` : "None"}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0 font-mono text-xs">
                  <span className="text-text-1">~{tokenBreakdown.skillsTokens.toLocaleString()}</span>
                  <span className="chat-token-breakdown-pct">
                    {formatPercent(tokenBreakdown.skillsTokens, maxTokens)}
                  </span>
                </div>
              </div>

              {/* 3. Conversation Messages */}
              <div className="chat-token-breakdown-row">
                <div className="flex items-center gap-2 text-text-2 min-w-0">
                  <MessageSquare className="h-3.5 w-3.5 text-accent shrink-0" />
                  <span className="truncate">Conversation</span>
                  <span className="chat-token-breakdown-tag">
                    {messageCount} msgs
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0 font-mono text-xs">
                  <span className="text-text-1">~{tokenBreakdown.messagesTokens.toLocaleString()}</span>
                  <span className="chat-token-breakdown-pct">
                    {formatPercent(tokenBreakdown.messagesTokens, maxTokens)}
                  </span>
                </div>
              </div>

              {/* 4. Remaining Capacity */}
              <div className="chat-token-breakdown-row highlight">
                <div className="flex items-center gap-2 text-text-1 font-medium min-w-0">
                  <HardDrive className="h-3.5 w-3.5 text-green shrink-0" />
                  <span className="truncate">Remaining Capacity</span>
                </div>
                <div className="flex items-center gap-2 shrink-0 font-mono text-xs">
                  <span className="text-green font-semibold">~{tokenBreakdown.remainingTokens.toLocaleString()}</span>
                  <span className="chat-token-breakdown-pct success">
                    {(100 - tokenBreakdown.percentageUsed).toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>

            {/* Context Management Action / Footer Note */}
            {hasMessages ? (
              <div className="chat-token-popover-action">
                <button
                  type="button"
                  onClick={() => clearActiveConversation()}
                  className="chat-token-clear-btn"
                  title="Clear conversation history to reclaim context window headroom"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Clear messages to free {formatTokenCount(tokenBreakdown.messagesTokens)} tokens</span>
                </button>
              </div>
            ) : tokenBreakdown.percentageUsed >= 80 ? (
              <div className="chat-token-popover-warning">
                <AlertTriangle className="h-3.5 w-3.5 text-yellow shrink-0" />
                <span>Context memory nearing capacity ({tokenBreakdown.percentageUsed.toFixed(0)}%). Consider resetting.</span>
              </div>
            ) : (
              <div className="chat-token-popover-footer">
                <Info className="h-3.5 w-3.5 text-text-3 shrink-0" />
                <span>Full context headroom available • {formatTokenCount(tokenBreakdown.maxTokens)} limit</span>
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Export & Clear Actions (only displayed when there are messages) */}
        {hasMessages && conversation && (
          <div className="flex items-center gap-1">
            <SimpleTooltip content="Export conversation as Markdown" side="bottom">
              <button
                type="button"
                onClick={() => exportConversationAsMarkdown(conversation)}
                className="chat-header-icon-btn hover:text-accent hover:bg-accent/10"
                aria-label="Export conversation as Markdown"
              >
                <Download className="h-4 w-4" />
              </button>
            </SimpleTooltip>

            <SimpleTooltip content="Clear conversation messages" side="bottom">
              <button
                type="button"
                onClick={clearActiveConversation}
                className="chat-header-icon-btn hover:text-red-400 hover:bg-red-500/10"
                aria-label="Clear conversation messages"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </SimpleTooltip>
          </div>
        )}
      </div>
    </header>
  );
}
