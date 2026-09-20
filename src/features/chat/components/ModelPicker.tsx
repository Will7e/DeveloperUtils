// ============================================================
// Model Picker — Searchable OpenRouter Model Dropdown
// ============================================================
// Lists the live catalog (fetched once per session) with context
// window and pricing. Falls back to curated models while loading
// or offline. Renders in a portal-aligned fixed dropdown following
// the ApiTester env-dropdown pattern.

import React from "react";
import { Check, ChevronDown, Search, Sparkles } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useClickOutside } from "@/features/api-tester/hooks/useClickOutside";
import { CURATED_FALLBACK_MODELS, PINNED_MODEL_IDS } from "../constants";
import type { ModelInfo } from "../types";

function formatPrice(price?: number): string {
  if (price === undefined) return "";
  if (price === 0) return "Free";
  if (price < 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(2)}`;
}

function formatContext(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  return `${Math.round(n / 1000)}k ctx`;
}

interface ModelPickerProps {
  value: string;
  models: ModelInfo[];
  isLoading: boolean;
  onChange: (modelId: string) => void;
}

export function ModelPicker({ value, models, isLoading, onChange }: ModelPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [pos, setPos] = React.useState({ top: 0, left: 0, width: 0 });

  // The returned ref wraps both the trigger and the dropdown so
  // clicks inside either never count as "outside".
  const containerRef = useClickOutside<HTMLDivElement>(
    () => setOpen(false),
    open
  );

  const handleOpen = React.useCallback(() => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 4,
        left: rect.left,
        width: Math.max(340, rect.width),
      });
    }
    setOpen(!open);
  }, [open]);

  React.useEffect(() => {
    if (open) {
      // Focus search after mount
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const catalog = models.length > 0 ? models : CURATED_FALLBACK_MODELS;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
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
  }, [catalog, query]);

  const selected = catalog.find((m) => m.id === value);

  return (
    <div ref={containerRef} className="chat-model-picker">
      <SimpleTooltip content="Switch model" side="bottom">
        <button
          ref={btnRef}
          type="button"
          className="chat-model-btn"
          onClick={handleOpen}
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
          >
            <div className="chat-model-search">
              <Search className="h-3.5 w-3.5 chat-model-search-icon" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={isLoading ? "Loading models…" : "Search models…"}
                className="chat-model-search-input"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
              />
            </div>

            <div className="chat-model-list">
              {filtered.length === 0 && (
                <div className="chat-model-empty">
                  No models match “{query}”.
                </div>
              )}
              {filtered.map((m) => {
                const isSelected = m.id === value;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`chat-model-item ${isSelected ? "chat-model-item-selected" : ""}`}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                    }}
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
