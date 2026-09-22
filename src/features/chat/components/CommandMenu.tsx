// ============================================================
// Command Menu — Composer Slash Command Palette
// ============================================================
// Opens when the draft starts with "/". Renders the filtered
// command registry as an anchored list above the composer input
// (same visual language as the ModelPicker dropdown). Fully
// keyboard navigable via the textarea: arrows move the highlight,
// Enter/Tab runs the command, Escape closes. /model swaps the list
// for the loaded model catalog as an inline submenu.
//
// Rows are grouped by the registry's `group` label. Group headers
// are rendered inline so the flat index the composer navigates with
// stays identical to the flat index used here.
//
// Availability is the registry's concern, not this component's: it
// receives the rows it should render.

import React from "react";
import { Bot, Check, CornerDownLeft } from "lucide-react";
import { formatContext, formatPrice } from "../lib/model-format";
import { CURATED_FALLBACK_MODELS } from "../constants";
import type { ModelInfo } from "../types";
import type { ChatCommand } from "../lib/commands";

export type CommandMenuMode = "commands" | "model";

interface CommandMenuProps {
  /** "/"-query from the draft: text after the slash up to a space */
  query: string;
  /** Argument typed after the command token ("" when none) */
  arg: string;
  /** Live model catalog (empty before the fetch succeeds) */
  models: ModelInfo[];
  /** Model id active for this conversation */
  activeModelId: string;
  /** True while the catalog request is in flight */
  modelsLoading: boolean;
  /** Highlighted row index (owned by the composer for key handling) */
  highlightedIdx: number;
  /** Which list is shown */
  mode: CommandMenuMode;
  /** Commands matching the current query (availability already applied) */
  filteredCommands: ChatCommand[];
  /** Model rows matching the arg in submenu mode */
  filteredModels: ModelInfo[];
  /** Runs the highlighted (or clicked) command */
  onSelectCommand: (command: ChatCommand) => void;
  /** Picks the highlighted (or clicked) model in submenu mode */
  onSelectModel: (modelId: string) => void;
  /** True while this conversation is replying (drives the hints) */
  isStreaming?: boolean;
}

/** Per-model row metadata (badges + free flag for the submenu) */
function toRowMeta(m: ModelInfo): { name: string; id: string; badges: string[]; free: boolean } {
  return {
    name: m.name,
    id: m.id,
    badges: [
      m.contextLength !== undefined ? formatContext(m.contextLength) : "",
      m.promptPrice !== undefined ? `${formatPrice(m.promptPrice)}/M in` : "",
    ].filter(Boolean),
    free: Boolean(m.isFree),
  };
}

export function CommandMenu({
  query,
  arg,
  models,
  activeModelId,
  modelsLoading,
  highlightedIdx,
  mode,
  filteredCommands,
  filteredModels,
  onSelectCommand,
  onSelectModel,
  isStreaming = false,
}: CommandMenuProps) {
  const listRef = React.useRef<HTMLDivElement>(null);

  // Scroll the highlighted row into view on keyboard navigation.
  React.useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;
    const el = listEl.querySelector<HTMLElement>(`[data-option-index="${highlightedIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightedIdx, mode]);

  const isModelMode = mode === "model";
  const modelCatalog = models.length > 0 ? models : CURATED_FALLBACK_MODELS;
  const selectedModel = modelCatalog.find((m) => m.id === activeModelId);

  return (
    <div className="chat-command-menu" role="presentation">
      {!isModelMode && (
        <>
          <div
            ref={listRef}
            id="chat-command-listbox"
            className="chat-command-list"
            role="listbox"
            aria-label="Chat commands"
          >
            {filteredCommands.length === 0 && (
              <div className="chat-command-empty">
                No command matches “{query}” — Enter keeps your text, Esc clears it.
              </div>
            )}
            {filteredCommands.map((command, index) => {
              const Icon = command.icon;
              const isHighlighted = index === highlightedIdx;
              // Group headers ride on the flat (navigable) order, so
              // keyboard indices and rendered rows stay in lockstep.
              const prevGroup = index > 0 ? filteredCommands[index - 1]!.group : null;
              const showGroup = command.group !== prevGroup;
              return (
                <React.Fragment key={command.id}>
                  {showGroup && (
                    <div className="chat-command-group" role="presentation">
                      {command.group}
                    </div>
                  )}
                  <button
                    type="button"
                    id={`chat-command-opt-${index}`}
                    role="option"
                    aria-selected={isHighlighted}
                    data-option-index={index}
                    className={`chat-command-item ${isHighlighted ? "chat-command-item-highlighted" : ""}`}
                    onMouseDown={(e) => {
                      // Prevent textarea blur so the click still lands
                      e.preventDefault();
                    }}
                    onClick={() => onSelectCommand(command)}
                    title={command.description}
                  >
                    <span className="chat-command-item-icon">
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="chat-command-item-main">
                      <span className="chat-command-item-name">/{command.id}</span>
                      <span className="chat-command-item-desc">{command.description}</span>
                    </span>
                    {command.argsHint && (
                      <span className="chat-command-item-hint">
                        {isHighlighted ? <CornerDownLeft className="h-3 w-3" /> : command.argsHint}
                      </span>
                    )}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
          <div className="chat-command-footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> navigate
            </span>
            <span>
              <kbd>↵</kbd> run
            </span>
            <span>
              <kbd>esc</kbd> close
            </span>
            {isStreaming && <span className="chat-command-footer-accent">/stop cancels the reply</span>}
          </div>
        </>
      )}

      {isModelMode && (
        <>
          <div className="chat-command-submenu-header">
            <Bot className="h-3.5 w-3.5 chat-command-submenu-icon" />
            <span className="chat-command-submenu-title">Switch model</span>
            {selectedModel && (
              <span className="chat-command-submenu-current" title={selectedModel.id}>
                {selectedModel.name}
              </span>
            )}
          </div>
          <div ref={listRef} className="chat-command-list" role="listbox" aria-label="Models">
            {filteredModels.length === 0 && (
              <div className="chat-command-empty">
                {modelsLoading ? "Loading models…" : `No models match “${arg}”.`}
              </div>
            )}
            {filteredModels.map((m, index) => {
              const meta = toRowMeta(m);
              const isSelected = m.id === activeModelId;
              const isHighlighted = index === highlightedIdx;
              return (
                <button
                  key={m.id}
                  type="button"
                  id={`chat-command-opt-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  data-option-index={index}
                  className={[
                    "chat-command-item",
                    "chat-command-item-model",
                    isSelected ? "chat-command-item-selected" : "",
                    isHighlighted ? "chat-command-item-highlighted" : "",
                  ].join(" ")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSelectModel(m.id)}
                  title={m.id}
                >
                  <span className="chat-command-item-main">
                    <span className="chat-command-item-name">{meta.name}</span>
                    <span className="chat-command-item-desc">{meta.id}</span>
                  </span>
                  <span className="chat-command-item-meta">
                    {meta.free && (
                      <span className="chat-command-badge chat-command-badge-free">FREE</span>
                    )}
                    {meta.badges.map((b) => (
                      <span key={b} className="chat-command-badge">
                        {b}
                      </span>
                    ))}
                    {isSelected && <Check className="h-3.5 w-3.5 chat-command-check" />}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="chat-command-footer">
            <span>
              {models.length > 0
                ? `${models.length} models via OpenRouter`
                : "Curated defaults — full catalog loads with a valid key"}
            </span>
            <span>
              <kbd>esc</kbd> back
            </span>
          </div>
        </>
      )}
    </div>
  );
}
