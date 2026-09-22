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
//
// One button, not a two-option group: the header shows the mode you
// are IN and switching is one click. Plan mode announces itself
// loudly elsewhere (the composer badge), so the header control stays
// quiet like the rest of the strip.

import React from "react";
import { Hammer, Route } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { ChatMode } from "../types";

const MODE_META: Record<
  ChatMode,
  { label: string; Icon: typeof Hammer; tooltip: string }
> = {
  build: {
    label: "Build",
    Icon: Hammer,
    tooltip: "Build mode — edits the workspace and ships via the push gate",
  },
  plan: {
    label: "Plan",
    Icon: Route,
    tooltip: "Plan mode — read-only: investigates and proposes, changes nothing",
  },
};

interface ModeToggleProps {
  value: ChatMode;
  onChange: (mode: ChatMode) => void;
  /** Plan mode is only meaningful with a repo attached */
  disabled?: boolean;
}

export function ModeToggle({ value, onChange, disabled = false }: ModeToggleProps) {
  const next: ChatMode = value === "build" ? "plan" : "build";
  const current = MODE_META[value];

  return (
    <SimpleTooltip
      content={
        disabled
          ? "Agent mode — attach a repository to use Plan mode"
          : `${current.tooltip} · click for ${MODE_META[next].label}`
      }
      side="bottom"
    >
      <button
        type="button"
        className={`chat-mode-btn ${
          value === "plan" ? "chat-mode-btn-plan" : "chat-mode-btn-build"
        }`}
        onClick={() => onChange(next)}
        disabled={disabled}
        aria-label={`Agent mode: ${current.label}. Switch to ${MODE_META[next].label}.`}
        aria-pressed={value === "plan"}
      >
        <current.Icon className="h-3 w-3 chat-mode-btn-icon" />
        <span className="chat-mode-btn-label">{current.label}</span>
      </button>
    </SimpleTooltip>
  );
}
