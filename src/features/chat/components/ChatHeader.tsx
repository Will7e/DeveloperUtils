// ============================================================
// Chat Header — Model Picker, Context Meter, Chat Actions
// ============================================================

import React from "react";
import {
  Blocks,
  Download,
  Menu,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ModelPicker } from "./ModelPicker";
import { EffortPicker } from "./EffortPicker";
import { ModeToggle } from "./ModeToggle";
import { ContextMeter } from "./ContextMeter";
import { useModelEndpoints } from "./useModelEndpoints";
import { VerificationChip } from "./VerificationChip";
import { RepoPicker, type RepoSelection } from "./RepoPicker";
import type { RepoPickIntent } from "../lib/repo-routing";
import type {
  ChatMode,
  ContextBreakdown,
  ModelInfo,
  ReasoningEffort,
  RepoContext,
} from "../types";
import type { SkillActivity } from "../lib/skill-activity";

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
  /**
   * Skills sent with every message (the ones switched "Always on").
   *
   * A count alone was the misleading part: it described only this mode, so a
   * turn that loaded three skills from triggers still showed "2". The chip is
   * fed the whole picture now, and the hover card names each state.
   */
  alwaysOnSkills: string[];
  /** Skills that activate themselves on their triggers (not always-on) */
  availableSkillCount: number;
  /** What the last prepared turn auto-activated (lib/skill-activity) */
  skillActivity: SkillActivity | null;
  onOpenSkills: () => void;
  /** Attached GitHub repo (agent mode); undefined = none */
  repoContext?: RepoContext;
  /** GitHub token — enables the repo picker */
  githubToken: string;
  /** A repository was picked — routing is the page's business (lib/repo-routing) */
  onRepoSelect: (repo: RepoSelection, intent: RepoPickIntent) => void;
  /** The repository was removed from this chat */
  onRepoDetach: () => void;
  /** Toggle the off-canvas sidebar drawer (narrow widths) */
  onToggleSidebar: () => void;
  isSidebarOpen: boolean;
  /**
   * The facts the verification chip's tier plan needs. Absent when the chat has
   * no repository, in which case there is nothing to verify and no chip.
   *
   * The evidence itself is NOT passed down: the chip reads the ledger through
   * the shared hook, so the revision comparison happens in one place instead of
   * at every caller between here and the header.
   */
  verification?: {
    conversationId: string;
    repoAttached: boolean;
    hasChanges: boolean;
    pushed: boolean;
  };
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
  alwaysOnSkills,
  availableSkillCount,
  skillActivity,
  onOpenSkills,
  repoContext,
  githubToken,
  onRepoSelect,
  onRepoDetach,
  onToggleSidebar,
  isSidebarOpen,
  verification,
  hasMessages,
  onExport,
}: ChatHeaderProps) {
  const canExport = Boolean(hasMessages && onExport);
  // Who serves the selected model. Fetched here rather than in the card so the
  // facts are already there when the card opens — see useModelEndpoints.
  const endpoints = useModelEndpoints(model);
  // "In play" = always sent PLUS whatever the last turn loaded from triggers
  // PLUS what the agent pulled mid-turn with read_skill. The count used to be
  // the always-on half only, which under-reported every turn where a skill
  // activated itself — and then under-reported again the moment the agent
  // fetched a deferred skill it had been told about.
  const autoActive = skillActivity?.auto ?? [];
  const deferredSkills = skillActivity?.deferred ?? [];
  const loadedSkills = skillActivity?.loaded ?? [];
  const inEffect = alwaysOnSkills.length + autoActive.length + loadedSkills.length;
  const hasSkills = alwaysOnSkills.length + availableSkillCount > 0;

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
        <ContextMeter context={context} session={{ model, effort, mode }} endpoints={endpoints} />
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
        {hasSkills && (
          <SimpleTooltip
            side="bottom"
            className="chat-skills-card"
            content={
              <SkillsCard
                alwaysOn={alwaysOnSkills}
                auto={autoActive}
                deferred={deferredSkills}
                loaded={loadedSkills}
                availableSkillCount={availableSkillCount}
              />
            }
          >
            <button
              type="button"
              className="chat-header-prompt-badge chat-header-skills-btn"
              onClick={onOpenSkills}
              aria-label={
                inEffect > 0
                  ? `${inEffect} skill${inEffect === 1 ? "" : "s"} in play — hover to see which, click to manage`
                  : "No skills in play for the latest turn — hover for details, click to manage"
              }
            >
              <Blocks className="h-3 w-3 chat-header-skills-icon" />
              {inEffect > 0 && inEffect}
            </button>
          </SimpleTooltip>
        )}
        {verification && <VerificationChip {...verification} />}
        {/* Export was reachable only as `/export` while these props sat unused
            here: the affordance existed, the wiring did not. It lives in the
            header rather than the sidebar because it exports the chat you are
            looking at, and the header already describes which chat that is. */}
        {canExport && (
          <SimpleTooltip content="Export this chat as Markdown" side="bottom">
            <button
              type="button"
              className="chat-header-btn chat-header-export-btn"
              onClick={onExport}
              aria-label="Export this chat as Markdown"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          </SimpleTooltip>
        )}
        <RepoPicker
          repoContext={repoContext}
          token={githubToken}
          onSelect={onRepoSelect}
          onDetach={onRepoDetach}
        />
      </div>
    </div>
  );
}

/**
 * The hover card: which skills are in play, and WHY each one is.
 *
 * Informational, like the context card it sits beside — the chip itself is the
 * click target that opens Skills, because a button inside tooltip content is
 * not reachable by the time the pointer gets there. Each row names the reason
 * (always sent / matched this request / matched but not loaded) rather than
 * repeating the word "active", which is the ambiguity this card exists to end.
 */
function SkillsCard({
  alwaysOn,
  auto,
  deferred,
  loaded,
  availableSkillCount,
}: {
  alwaysOn: string[];
  auto: string[];
  deferred: string[];
  loaded: string[];
  availableSkillCount: number;
}) {
  const inEffect = alwaysOn.length + auto.length + loaded.length;
  const rows: Array<{ title: string; note: string; names: string[]; tone: string }> = [
    {
      title: "Always on",
      note: "sent with every message",
      names: alwaysOn,
      tone: "always",
    },
    {
      title: "Auto-activated",
      note: "matched your last message",
      names: auto,
      tone: "auto",
    },
    {
      title: "Loaded mid-turn",
      note: "the agent pulled these with read_skill",
      names: loaded,
      tone: "loaded",
    },
    {
      title: "Matched, not loaded",
      note: "named for the agent; it has not fetched them yet",
      names: deferred.filter((name) => !loaded.includes(name)),
      tone: "deferred",
    },
  ];

  return (
    <div className="chat-skills-card-inner">
      <div className="chat-skills-card-head">
        <span className="chat-skills-card-title">Skills</span>
        <span className="chat-skills-card-sub">
          {inEffect} in play
        </span>
      </div>

      {inEffect === 0 && deferred.length === 0 && loaded.length === 0 && (
        <div className="chat-skills-card-empty">
          Nothing is active for the latest turn. Skills load themselves when your
          request matches their triggers.
        </div>
      )}

      {rows.map((row) =>
        row.names.length === 0 ? null : (
          <div key={row.title} className="chat-skills-card-row">
            <div className="chat-skills-card-row-head">
              <span className={`chat-skills-card-dot chat-skills-card-dot-${row.tone}`} />
              <span className="chat-skills-card-row-title">{row.title}</span>
              <span className="chat-skills-card-row-count">{row.names.length}</span>
            </div>
            <div className="chat-skills-card-row-note">{row.note}</div>
            <div className="chat-skills-card-names">
              {row.names.map((name) => (
                <span key={name} className="chat-skills-card-name">
                  {name}
                </span>
              ))}
            </div>
          </div>
        )
      )}

      <div className="chat-skills-card-foot">
        {availableSkillCount > 0
          ? `${availableSkillCount} more activate on their own triggers · click to manage`
          : "Click to manage skills"}
      </div>
    </div>
  );
}
