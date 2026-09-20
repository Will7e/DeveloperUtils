// ============================================================
// Model Picker — Searchable OpenRouter Model Dropdown
// ============================================================
// Lists the live catalog (fetched once per session) with context
// window and pricing. Falls back to curated models while loading
// or offline. Renders in a portal-aligned fixed dropdown following
// the ApiTester env-dropdown pattern. Fully keyboard navigable:
// arrows move the highlight, Enter selects, Escape closes.

import React from "react";
import { Check, ChevronDown, Search, Sparkles } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useClickOutside } from "@/features/api-tester/hooks/useClickOutside";
import { CURATED_FALLBACK_MODELS, PINNED_MODEL_IDS } from "../constants";
import type { ModelInfo } from "../types";

function formatPrice(price?: number): string {
  if (price === undefined) return "";
  if (price === 0) return "Free";
  return `$${price.toFixed(2)}`;
}

function formatContext(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  return `${Math.round(n / 1000)}k ctx`;
}

const DROPDOWN_WIDTH = 340;
const VIEWPORT_MARGIN = 8;

interface ModelPickerProps {
  value: string;
  models: ModelInfo[];
  isLoading: boolean;
  onChange: (modelId: string) => void;
}

export function ModelPicker({ value, models, isLoading, onChange }: ModelPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [highlightedIdx, setHighlightedIdx] = React.useState(0);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState({ top: 0, left: 0, width: DROPDOWN_WIDTH });

  // The returned ref wraps both the trigger and the dropdown so
  // clicks inside either never count as "outside".
  const containerRef = useClickOutside<HTMLDivElement>(
    () => setOpen(false),
    open
  );

  // Position the dropdown below the trigger, clamped to the
  // viewport so it can never overflow either edge.
  const positionDropdown = React.useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const width = Math.max(DROPDOWN_WIDTH, rect.width);
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const minTop = Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight - 420 - VIEWPORT_MARGIN
    );
    setPos({
      top: Math.max(minTop, Math.min(rect.bottom + 4, minTop)),
      left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft)),
      width,
    });
  }, []);

  const handleOpen = React.useCallback(() => {
    setOpen((prev) => {
      if (!prev) positionDropdown();
      return !prev;
    });
  }, [positionDropdown]);

  // Keep the dropdown anchored on resize/scroll while open
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
    if (open) {
      // Focus search after mount
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const catalog = models.length > 0 ? models : CURATED_FALLBACK_MODELS;
  const effectiveQuery = open ? query : "";

  const filtered = React.useMemo(() => {
    const q = effectiveQuery.trim().toLowerCase();
    const matches = q
      ? catalog.filter(
          (m) =>
            m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
        )
      : catalog;

    // Pinned models first, then the rest alphabetically
    const pinned = matches.filter((m) => PINNED_MODEL_IDS.includes(m.id));
    const rest = matches
      .filter((m) => !PINNED_MODEL_IDS.includes(m.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...pinned, ...rest].slice(0, 120);
  }, [catalog, effectiveQuery]);

  const selected = catalog.find((m) => m.id === value);

  // Reset highlight to the top when the query changes (render-time
  // adjustment — state converges before commit; see
  // react.dev/learn/you-might-not-need-an-effect).
  if (highlightedIdx !== 0 && !effectiveQuery && open) {
    setHighlightedIdx(0);
  } else if (highlightedIdx >= filtered.length && filtered.length > 0) {
    setHighlightedIdx(filtered.length - 1);
  }

  // Scroll the highlighted option into view (keyboard navigation)
  React.useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;
    const el = listEl.querySelector<HTMLElement>(
      `[data-option-index="${highlightedIdx}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightedIdx]);

  const selectAt = (index: number) => {
    const model = filtered[index];
    if (!model) return;
    onChange(model.id);
    setOpen(false);
    btnRef.current?.focus();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIdx((i) => Math.min(filtered.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIdx((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setHighlightedIdx(0);
        break;
      case "End":
        e.preventDefault();
        setHighlightedIdx(Math.max(0, filtered.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        selectAt(highlightedIdx);
        break;
      case "Escape":
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
        break;
    }
  };

  return (
    <div ref={containerRef} className="chat-model-picker">
      <SimpleTooltip content="Switch model" side="bottom">
        <button
          ref={btnRef}
          type="button"
          className="chat-model-btn"
          onClick={handleOpen}
          onKeyDown={(e) => {
            if ((e.key === "ArrowDown" || e.key === "Enter") && !open) {
              e.preventDefault();
              handleOpen();
            }
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <Sparkles className="h-3.5 w-3.5 chat-model-btn-icon" />
          <span className="chat-model-btn-label">{selected?.name ?? value}</span>
          <ChevronDown className="h-3 w-3 chat-model-btn-chevron" />
        </button>
      </SimpleTooltip>

      {open && (
        <>
          <div className="dropdown-backdrop" onClick={() => setOpen(false)} />
          <div
            className="chat-model-dropdown"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
            role="listbox"
            aria-label="Models"
          >
            <div className="chat-model-search">
              <Search className="h-3.5 w-3.5 chat-model-search-icon" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={isLoading ? "Loading models…" : "Search models…"}
                className="chat-model-search-input"
                role="combobox"
                aria-expanded
                aria-controls="chat-model-listbox"
                aria-activedescendant={
                  filtered[highlightedIdx] ? `chat-model-opt-${highlightedIdx}` : undefined
                }
                aria-label="Search models"
              />
            </div>

            <div ref={listRef} id="chat-model-listbox" className="chat-model-list">
              {filtered.length === 0 && (
                <div className="chat-model-empty">
                  No models match “{query}”.
                </div>
              )}
              {filtered.map((m, index) => {
                const isSelected = m.id === value;
                const isHighlighted = index === highlightedIdx;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    id={`chat-model-opt-${index}`}
                    data-option-index={index}
                    aria-selected={isSelected}
                    className={`chat-model-item ${isSelected ? "chat-model-item-selected" : ""} ${isHighlighted ? "chat-model-item-highlighted" : ""}`}
                    onClick={() => selectAt(index)}
                    onMouseMove={() => setHighlightedIdx(index)}
                    title={m.id}
                  >
                    <div className="chat-model-item-main">
                      <span className="chat-model-item-name">{m.name}</span>
                      <span className="chat-model-item-id">{m.id}</span>
                    </div>
                    <div className="chat-model-item-meta">
                      {m.isFree && (
                        <span className="chat-model-badge chat-model-badge-free">FREE</span>
                      )}
                      {m.contextLength !== undefined && (
                        <span className="chat-model-badge">
                          {formatContext(m.contextLength)}
                        </span>
                      )}
                      {m.promptPrice !== undefined && (
                        <span className="chat-model-badge">
                          {formatPrice(m.promptPrice)}/M in
                        </span>
                      )}
                      {isSelected && <Check className="h-3.5 w-3.5 chat-model-check" />}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="chat-model-footer">
              {models.length > 0
                ? `${models.length} models via OpenRouter`
                : "Curated defaults — full catalog loads with a valid key"}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
