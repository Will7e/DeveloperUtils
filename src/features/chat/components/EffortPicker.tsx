// ============================================================
// Effort Picker — Model State Selector (Low / Medium / High / Max)
// ============================================================
// The per-conversation "model state". Beside the ModelPicker, it
// chooses how much the selected model may think before answering.
//
// The rungs are snapped to what the model actually declares in the
// OpenRouter catalog (`reasoning.supported_efforts`): a model that
// only accepts ["xhigh","medium"] offers fewer options, and a model
// with no reasoning support hides the control entirely (the caller
// passes an empty `efforts` list).
//
// The choice rides every request as `reasoning.effort` /
// `reasoning_effort` (see lib/model-state.ts) — applied invisibly on
// every send, exactly like the old tier selector, but now naming a
// real setting on a real model instead of a fake model id.

import React from "react";
import { Brain, Check, ChevronDown, Gauge, Leaf, Sparkles } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useClickOutside } from "@/features/api-tester/hooks/useClickOutside";
import { REASONING_EFFORT_META } from "../lib/model-state";
import type { ReasoningEffort } from "../types";

const DROPDOWN_WIDTH = 300;
const VIEWPORT_MARGIN = 8;

/** Rung glyphs chosen to read as the effort they set */
const EFFORT_ICON: Record<ReasoningEffort, typeof Leaf> = {
  low: Leaf,
  medium: Gauge,
  high: Brain,
  max: Sparkles,
};

interface EffortPickerProps {
  /** Active rung for the conversation */
  value: ReasoningEffort;
  /** Rungs the current model can express (empty → render nothing) */
  efforts: ReasoningEffort[];
  onChange: (effort: ReasoningEffort) => void;
}

export function EffortPicker({ value, efforts, onChange }: EffortPickerProps) {
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState({ top: 0, left: 0, width: DROPDOWN_WIDTH });

  const containerRef = useClickOutside<HTMLDivElement>(() => setOpen(false), open);

  const positionDropdown = React.useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const dropdownHeight = 300;

    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    let top: number;
    if (spaceBelow < dropdownHeight && rect.top > spaceBelow) {
      top = Math.max(VIEWPORT_MARGIN, rect.top - dropdownHeight - 4);
    } else {
      top = rect.bottom + 4;
    }

    // Align to the right edge of the trigger, clamped to the viewport
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.right - DROPDOWN_WIDTH, window.innerWidth - DROPDOWN_WIDTH - VIEWPORT_MARGIN)
    );
    setPos({ top, left, width: DROPDOWN_WIDTH });
  }, []);

  const handleOpen = React.useCallback(() => {
    setOpen((prev) => {
      if (!prev) positionDropdown();
      return !prev;
    });
  }, [positionDropdown]);

  React.useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", positionDropdown);
    window.addEventListener("scroll", positionDropdown, true);
    return () => {
      window.removeEventListener("resize", positionDropdown);
      window.removeEventListener("scroll", positionDropdown, true);
    };
  }, [open, positionDropdown]);

  React.useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => listRef.current?.focus());
  }, [open]);

  // The control only exists when the model can express at least one
  // rung — otherwise it would promise a setting that never reaches
  // the wire.
  if (efforts.length === 0) return null;

  const active = efforts.includes(value) ? value : efforts[efforts.length - 1]!;
  const activeMeta = REASONING_EFFORT_META[active];
  const TriggerIcon = EFFORT_ICON[active];

  const pick = (effort: ReasoningEffort) => {
    onChange(effort);
    setOpen(false);
    btnRef.current?.focus();
  };

  return (
    <div ref={containerRef} className="chat-tier-picker">
      <SimpleTooltip content={`Reasoning effort — ${activeMeta.tagline}`} side="bottom">
        <button
          ref={btnRef}
          type="button"
          className="chat-tier-btn chat-tier-btn-active"
          onClick={handleOpen}
          onKeyDown={(e) => {
            if ((e.key === "ArrowDown" || e.key === "Enter") && !open) {
              e.preventDefault();
              handleOpen();
            }
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Reasoning effort"
        >
          <TriggerIcon className="h-3 w-3 chat-tier-btn-icon" />
          <span className="chat-tier-btn-label">{activeMeta.label}</span>
          <ChevronDown className="h-3 w-3 chat-tier-btn-chevron" />
        </button>
      </SimpleTooltip>

      {open && (
        <>
          <div className="chat-model-backdrop" onClick={() => setOpen(false)} />
          <div
            className="chat-model-dropdown chat-tier-dropdown"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
            role="listbox"
            aria-label="Reasoning effort"
          >
            <div className="chat-tier-dropdown-head">
              <Brain className="h-3.5 w-3.5 chat-tier-head-logo" />
              <span className="chat-tier-head-title">Reasoning effort</span>
            </div>
            <div ref={listRef} tabIndex={-1} className="chat-model-list chat-tier-list">
              {efforts.map((effort) => {
                const meta = REASONING_EFFORT_META[effort];
                const Icon = EFFORT_ICON[effort];
                const isSelected = active === effort;
                return (
                  <button
                    key={effort}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`chat-model-item ${isSelected ? "chat-model-item-selected" : ""}`}
                    onClick={() => pick(effort)}
                    title={meta.tagline}
                  >
                    <div className="chat-model-item-main">
                      <div className="chat-model-item-head">
                        <Icon className="h-3.5 w-3.5 chat-tier-item-icon" />
                        <span className="chat-model-item-name">{meta.label}</span>
                      </div>
                      <span className="chat-model-item-id">{meta.tagline}</span>
                    </div>
                    <div className="chat-model-item-meta">
                      {isSelected && <Check className="h-3.5 w-3.5 chat-model-check" />}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="chat-model-footer chat-tier-footer">
              Sent as the request's reasoning effort, snapped to the
              levels this model declares. Unsupported models always use
              their provider default.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
