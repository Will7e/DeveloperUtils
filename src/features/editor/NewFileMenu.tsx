// ============================================================
// New File Menu — shared language-picker popover
// ============================================================
// Used by both the sidebar "new file" button and the tab bar "+"
// button so every entry point renders the identical popover, styled
// after the chat ModelPicker dropdown (Geist design system).
// Supports search filtering and full keyboard navigation.

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Zap } from "lucide-react";
import { LANGUAGE_CONFIGS } from "@/config";
import type { Language } from "@/types";
import { cn } from "@/lib/utils";
import { LanguageIcon } from "./language-icon";

/** Runtime notes shown per language (kept in sync with compiler.service.ts) */
const RUNTIME_NOTES: Partial<Record<Language, string>> = {
  javascript: "Worker sandbox",
  typescript: "TS compiler · sandboxed",
  python: "Pyodide WASM",
  sql: "SQLite WASM",
  lua: "Lua 5.4 WASM",
  html: "Live preview",
};

/** Languages where the runtime downloads on first run */
const DOWNLOAD_LANGUAGES: Partial<Record<Language, string>> = {
  python: "~10 MB",
  sql: "~1.5 MB",
  lua: "~0.5 MB",
};

interface NewFileMenuProps {
  open: boolean;
  /** Fixed-position anchor (top-left corner where the menu should appear) */
  anchor: { top: number; left: number } | null;
  onClose: () => void;
  onCreate: (language: Language) => void;
}

const MENU_WIDTH = 264;
const MENU_MAX_HEIGHT = 400;

export function NewFileMenu({ open, anchor, onClose, onCreate }: NewFileMenuProps) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [wasOpen, setWasOpen] = useState(false);

  // Reset search + highlight on the open-transition (render-phase state
  // adjustment per React docs — avoids setState-in-effect cascades).
  if (open && !wasOpen) {
    setWasOpen(true);
    if (query !== "") setQuery("");
    if (highlighted !== 0) setHighlighted(0);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const languages = useMemo(() => Object.keys(LANGUAGE_CONFIGS) as Language[], []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return languages;
    return languages.filter(
      (lang) =>
        LANGUAGE_CONFIGS[lang].label.toLowerCase().includes(q) ||
        LANGUAGE_CONFIGS[lang].extension.toLowerCase().includes(q) ||
        lang.includes(q)
    );
  }, [languages, query]);

  // Focus after the popover mounts (external side effect only)
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Clamp position to the viewport so the menu never overflows
  const pos = useMemo(() => {
    if (!anchor) return null;
    const top = Math.min(
      anchor.top,
      window.innerHeight - MENU_MAX_HEIGHT - 12
    );
    const left = Math.min(
      anchor.left,
      window.innerWidth - MENU_WIDTH - 12
    );
    return { top: Math.max(8, top), left: Math.max(8, left) };
  }, [anchor]);

  if (!open || !pos) return null;

  const handleCreate = (lang: Language) => {
    onCreate(lang);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const lang = filtered[highlighted];
      if (lang) handleCreate(lang);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <>
      <div
        className="newfile-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={menuRef}
        className="newfile-popover"
        style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
        onKeyDown={handleKeyDown}
        role="menu"
        aria-label="Create new file"
      >
        {/* Header */}
        <div className="newfile-header">
          <span className="newfile-title">Create file</span>
          <button
            type="button"
            className="newfile-close"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Search */}
        <div className="newfile-search">
          <Search className="h-3.5 w-3.5 newfile-search-icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlighted(0);
            }}
            placeholder="Search languages…"
            className="newfile-search-input"
            spellCheck={false}
          />
        </div>

        {/* Language list */}
        <div className="newfile-list">
          {filtered.length === 0 && (
            <div className="newfile-empty">
              No languages match <strong>“{query}”</strong>
            </div>
          )}
          {filtered.map((lang, index) => {
            const config = LANGUAGE_CONFIGS[lang];
            const download = DOWNLOAD_LANGUAGES[lang];
            return (
              <button
                key={lang}
                type="button"
                role="menuitem"
                className={cn(
                  "newfile-item",
                  index === highlighted && "newfile-item-highlighted"
                )}
                onClick={() => handleCreate(lang)}
                onMouseEnter={() => setHighlighted(index)}
              >
                <LanguageIcon language={lang} size="md" />
                <span className="newfile-item-main">
                  <span className="newfile-item-name">{config.label}</span>
                  <span className="newfile-item-note">
                    {RUNTIME_NOTES[lang] ?? "Sandboxed"}
                    {download && (
                      <span className="newfile-item-download">
                        <Zap className="h-2.5 w-2.5" />
                        {download} on first run
                      </span>
                    )}
                  </span>
                </span>
                <span className="newfile-item-ext">{config.extension}</span>
              </button>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="newfile-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> create</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </>
  );
}
