// ============================================================
// Chat Header — Model Picker, Context Meter, Chat Actions
// ============================================================

import React from "react";
import {
  Blocks,
  Menu,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ModelPicker } from "./ModelPicker";
import { EffortPicker } from "./EffortPicker";
import { ModeToggle } from "./ModeToggle";
import { ContextMeter } from "./ContextMeter";
import { RepoPicker, type RepoSelection } from "./RepoPicker";
import type {
  ChatMode,
  ContextBreakdown,
  ModelInfo,
  ReasoningEffort,
  RepoContext,
} from "../types";

interface ChatHeaderProps {
  model: string;
  models: ModelInfo[];
  modelsLoading: boolean;
  onModelChange: (modelId: string) => void;
  /** Model state: the reasoning rung the conversation is set to */
  effort: ReasoningEffort;
  /** Rungs the current model can express (empty hides the control) */
  efforts: ReasoningEffort[];
  onEffortChange: (effort: ReasoningEffort) => void;
  /** Agent mode for this conversation */
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  context: ContextBreakdown;
  onOpenSettings?: () => void;
  onExport?: () => void;
  /** Whether the active conversation has anything to export */
  hasMessages?: boolean;
  /** Per-conversation system prompt indicator */
  hasConversationPrompt: boolean;
  /** Number of enabled skills (0 hides the chip) */
  activeSkillCount: number;
  onOpenSkills: () => void;
  /** Attached GitHub repo (agent mode); undefined = none */
  repoContext?: RepoContext;
  /** GitHub token — enables the repo picker */
  githubToken: string;
  onRepoChange: (repo: RepoSelection | undefined) => void;
  /** Toggle the off-canvas sidebar drawer (narrow widths) */
  onToggleSidebar: () => void;
  isSidebarOpen: boolean;
}

export function ChatHeader({
  model,
  models,
  modelsLoading,
  onModelChange,
  effort,
  efforts,
  onEffortChange,
  mode,
  onModeChange,
  context,
  hasConversationPrompt,
  activeSkillCount,
  onOpenSkills,
  repoContext,
  githubToken,
  onRepoChange,
  onToggleSidebar,
  isSidebarOpen,
}: ChatHeaderProps) {
  return (
    <div className="chat-header">
      <div className="chat-header-left">
        {/* Shown only when the sidebar is off-canvas (≤860px) */}
        <SimpleTooltip
          content={isSidebarOpen ? "Close menu" : "Open menu"}
          side="bottom"
        >
          <button
            type="button"
            className="chat-header-btn chat-header-menu-btn"
            onClick={onToggleSidebar}
            aria-label={isSidebarOpen ? "Close menu" : "Open menu"}
            aria-expanded={isSidebarOpen}
          >
            {isSidebarOpen ? (
              <X className="h-3.5 w-3.5" />
            ) : (
              <Menu className="h-3.5 w-3.5" />
            )}
          </button>
        </SimpleTooltip>

        {/* One control strip, not three loose buttons: model · effort ·
            mode are one decision (what answers, how hard it thinks,
            what it may do), so they read as a single control with
            hairline dividers. */}
        <div className="chat-header-controls">
          <ModelPicker
            value={model}
            models={models}
            isLoading={modelsLoading}
            onChange={onModelChange}
          />
          {/* Model state (reasoning effort) — applied to every send and
              snapped to what this model declares it accepts. Hidden for
              models with no reasoning support. */}
          <EffortPicker value={effort} efforts={efforts} onChange={onEffortChange} />
          {/* Build/Plan — enforced by the tool list and the executor */}
          <ModeToggle
            value={mode}
            onChange={onModeChange}
            disabled={!repoContext}
          />
        </div>
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
              <Blocks className="h-3 w-3 chat-header-skills-icon" />
              {activeSkillCount}
            </button>
          </SimpleTooltip>
        )}
        <RepoPicker
          repoContext={repoContext}
          token={githubToken}
          onChange={onRepoChange}
        />
      </div>
    </div>
  );
}
