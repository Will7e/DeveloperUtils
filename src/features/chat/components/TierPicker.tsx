// ============================================================
// Tier Picker — InTab Flash State Selector (Light / High / Max)
// ============================================================
// Sits beside the ModelPicker and is ONLY visible while InTab Flash
// is the selected model — the state is a property OF InTab Flash,
// not a standalone model. The model picker always reads "InTab
// Flash 5.5"; the state chosen here is applied invisibly in the
// background on every send.
//
// Each tier maps to per-request OpenRouter state (see
// INTAB_TIER_REQUEST_STATE in constants.ts): Light = low reasoning
// effort with thinking excluded (fastest), High = medium effort
// (balanced), Max = high effort with the reasoning panel visible
// (deep thinking).
//
// Selecting a tier swaps the conversation's model id to that tier's
// synthetic id — the runner reads the id at send time and merges
// the tier's request state into every OpenRouter body for the turn.

import React from "react";
import { Brain, Check, ChevronDown, Gauge, Leaf } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { InTabLogo } from "@/components/ui/intab-logo";
import { useClickOutside } from "@/features/api-tester/hooks/useClickOutside";
import { INTAB_MODEL_TIERS, intabTierById } from "../constants";

const DROPDOWN_WIDTH = 300;
const VIEWPORT_MARGIN = 8;

/** Tier glyphs chosen to read as the state they set */
const TIER_TRIGGER: Record<string, { label: string; Icon: typeof Leaf }> = {
  "intab/intab-llm-light": { label: "Light", Icon: Leaf },
  "intab/intab-llm": { label: "High", Icon: Gauge },
  "intab/intab-llm-max": { label: "Max", Icon: Brain },
};

interface TierPickerProps {
  /** Active conversation model id (synthetic InTab id when InTab) */
  model: string;
  /** Swaps the conversation model — same handler as the ModelPicker */
  onChange: (tierModelId: string) => void;
}

export function TierPicker({ model, onChange }: TierPickerProps) {
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState({ top: 0, left: 0, width: DROPDOWN_WIDTH });

  const containerRef = useClickOutside<HTMLDivElement>(
    () => setOpen(false),
    open
  );

  const activeTier = intabTierById(model) ?? intabTierById("intab/intab-llm");
  const activeMeta = activeTier ? TIER_TRIGGER[activeTier.id] : undefined;
  const trigger = activeMeta ?? { label: "High", Icon: Gauge };

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

  const pick = (tierModelId: string) => {
    onChange(tierModelId);
    setOpen(false);
    btnRef.current?.focus();
  };

  const TriggerIcon = trigger.Icon;

  return (
    <div ref={containerRef} className="chat-tier-picker">
      <SimpleTooltip
        content={`InTab Flash state — ${activeTier?.tagline ?? "balanced quality"}`}
        side="bottom"
      >
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
          aria-label="InTab Flash state"
        >
          <TriggerIcon className="h-3 w-3 chat-tier-btn-icon" />
          <span className="chat-tier-btn-label">{trigger.label}</span>
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
            aria-label="InTab Flash state"
          >
            <div className="chat-tier-dropdown-head">
              <InTabLogo size={14} variant="glyph" className="chat-tier-head-logo" />
              <span className="chat-tier-head-title">InTab Flash state</span>
            </div>
            <div ref={listRef} tabIndex={-1} className="chat-model-list chat-tier-list">
              {INTAB_MODEL_TIERS.map((tier) => {
                const meta = TIER_TRIGGER[tier.id];
                const Icon = meta?.Icon ?? Gauge;
                const isSelected = activeTier?.id === tier.id;
                return (
                  <button
                    key={tier.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`chat-model-item ${isSelected ? "chat-model-item-selected" : ""}`}
                    onClick={() => pick(tier.id)}
                    title={tier.id}
                  >
                    <div className="chat-model-item-main">
                      <div className="chat-model-item-head">
                        <Icon className="h-3.5 w-3.5 chat-tier-item-icon" />
                        <span className="chat-model-item-name">{meta?.label ?? tier.name}</span>
                      </div>
                      <span className="chat-model-item-id">{tier.tagline}</span>
                    </div>
                    <div className="chat-model-item-meta">
                      {isSelected && <Check className="h-3.5 w-3.5 chat-model-check" />}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="chat-model-footer chat-tier-footer">
              Applied automatically on every send — each state sets how
              much the model thinks and which free models it routes to.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
