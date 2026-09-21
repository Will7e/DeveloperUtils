// ============================================================
// Mode Toggle — Agent Mode (Build / Plan)
// ============================================================
// Build is the coding agent: full tool set, edits the workspace,
// ships through the push gate. Plan is read-only: the mutating tools
// (write_file, edit_file, delete_file, create_working_branch,
// push_changes) are withheld from the request AND refused by the
// executor, and a planning directive is appended to the system
// prompt (see services/turn-prep.ts).
//
// OpenRouter has no concept of a "mode" — this is an application-level
// contract about which tools exist and what the model is asked to do,
// so it is enforced in two places we control: the tool list and the
// executor.

import React from "react";
import { Hammer, Route } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { ChatMode } from "../types";

const MODES: Array<{
  id: ChatMode;
  label: string;
  Icon: typeof Hammer;
  tooltip: string;
}> = [
  {
    id: "build",
    label: "Build",
    Icon: Hammer,
    tooltip: "Build — edit the workspace, verify in the preview, ship via the push gate",
  },
  {
    id: "plan",
    label: "Plan",
    Icon: Route,
    tooltip: "Plan — read-only: investigate and propose a plan, no file changes",
  },
];

interface ModeToggleProps {
  value: ChatMode;
  onChange: (mode: ChatMode) => void;
  /** Plan mode is only meaningful with a repo attached */
  disabled?: boolean;
}

export function ModeToggle({ value, onChange, disabled = false }: ModeToggleProps) {
  return (
    <div className="chat-mode-toggle" role="radiogroup" aria-label="Agent mode">
      {MODES.map((mode) => {
        const isActive = value === mode.id;
        const Icon = mode.Icon;
        return (
          <SimpleTooltip key={mode.id} content={mode.tooltip} side="bottom">
            <button
              type="button"
              role="radio"
              aria-checked={isActive}
              disabled={disabled}
              className={`chat-mode-btn ${isActive ? "chat-mode-btn-active" : ""}`}
              onClick={() => onChange(mode.id)}
            >
              <Icon className="h-3 w-3 chat-mode-btn-icon" />
              <span className="chat-mode-btn-label">{mode.label}</span>
            </button>
          </SimpleTooltip>
        );
      })}
    </div>
  );
}
