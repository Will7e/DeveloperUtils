// ============================================================
// Chat Header — Model Picker, Context Meter, Chat Actions
// ============================================================

import React from "react";
import { Download, Settings, SlidersHorizontal, Sparkles } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ModelPicker } from "./ModelPicker";
import { ContextMeter } from "./ContextMeter";
import type { ContextBreakdown, ModelInfo } from "../types";

interface ChatHeaderProps {
  model: string;
  models: ModelInfo[];
  modelsLoading: boolean;
  onModelChange: (modelId: string) => void;
  context: ContextBreakdown;
  onOpenSettings: () => void;
  onExport: () => void;
  /** Per-conversation system prompt indicator */
  hasConversationPrompt: boolean;
  /** Number of enabled skills (0 hides the chip) */
  activeSkillCount: number;
  onOpenSkills: () => void;
}

export function ChatHeader({
  model,
  models,
  modelsLoading,
  onModelChange,
  context,
  onOpenSettings,
  onExport,
  hasConversationPrompt,
  activeSkillCount,
  onOpenSkills,
}: ChatHeaderProps) {
  return (
    <div className="chat-header">
      <div className="chat-header-left">
        <ModelPicker
          value={model}
          models={models}
          isLoading={modelsLoading}
          onChange={onModelChange}
        />
        <ContextMeter context={context} />
      </div>

      <div className="chat-header-right">
        {hasConversationPrompt && (
          <SimpleTooltip content="This chat has its own system prompt" side="bottom">
            <span className="chat-header-prompt-badge">
              <SlidersHorizontal className="h-3 w-3" />
              Custom prompt
            </span>
          </SimpleTooltip>
        )}
        {activeSkillCount > 0 && (
          <SimpleTooltip
            content={
              activeSkillCount === 1
                ? "1 skill active — click to manage"
                : `${activeSkillCount} skills active — click to manage`
            }
            side="bottom"
          >
            <button
              type="button"
              className="chat-header-prompt-badge chat-header-skills-btn"
              onClick={onOpenSkills}
            >
              <Sparkles className="h-3 w-3 chat-header-skills-icon" />
              {activeSkillCount}
            </button>
          </SimpleTooltip>
        )}
        <SimpleTooltip content="Export chat as Markdown" side="bottom">
          <button
            type="button"
            className="chat-header-btn"
            onClick={onExport}
            aria-label="Export chat"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </SimpleTooltip>
        <SimpleTooltip content="Chat settings" side="bottom">
          <button
            type="button"
            className="chat-header-btn"
            onClick={onOpenSettings}
            aria-label="Chat settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </SimpleTooltip>
      </div>
    </div>
  );
}
