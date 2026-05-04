// ============================================================
// Command Palette — ⌘K fuzzy search for actions
// ============================================================

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play,
  Terminal,
  Settings,
  FilePlus,
  Trash2,
  Copy,
  Download,
  Sun,
  Moon,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { LANGUAGE_CONFIGS } from "@/config";
import type { Language } from "@/types";

interface PaletteAction {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  icon: React.ReactNode;
  action: () => void;
}

export function CommandPalette() {
  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const createFile = useAppStore((s) => s.createFile);
  const clearOutput = useAppStore((s) => s.clearOutput);
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const editorSettings = useAppStore((s) => s.editorSettings);
  const updateEditorSettings = useAppStore((s) => s.updateEditorSettings);
  const addToast = useAppStore((s) => s.addToast);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const activeFile = files.find((f) => f.id === activeFileId);

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [
      {
        id: "toggle-console",
        label: "Toggle Console",
        shortcut: "⌘J",
        category: "View",
        icon: <Terminal style={{ width: 14, height: 14 }} />,
        action: () => toggleOutputPanel(),
      },
      {
        id: "open-settings",
        label: "Open Settings",
        shortcut: "⌘,",
        category: "View",
        icon: <Settings style={{ width: 14, height: 14 }} />,
        action: () => toggleSettings(),
      },
      {
        id: "clear-console",
        label: "Clear Console",
        category: "Actions",
        icon: <Trash2 style={{ width: 14, height: 14 }} />,
        action: () => {
          clearOutput();
          addToast({ message: "Console cleared", type: "info", duration: 1500 });
        },
      },
      {
        id: "copy-code",
        label: "Copy Code to Clipboard",
        category: "Actions",
        icon: <Copy style={{ width: 14, height: 14 }} />,
        action: () => {
          if (activeFile) {
            navigator.clipboard.writeText(activeFile.content);
            addToast({ message: "Code copied to clipboard", type: "success", duration: 2000 });
          }
        },
      },
      {
        id: "export-file",
        label: "Download File",
        category: "Actions",
        icon: <Download style={{ width: 14, height: 14 }} />,
        action: () => {
          if (activeFile) {
            const blob = new Blob([activeFile.content], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = activeFile.name;
            a.click();
            URL.revokeObjectURL(url);
            addToast({ message: `Downloaded ${activeFile.name}`, type: "success", duration: 2000 });
          }
        },
      },
      {
        id: "toggle-sound",
        label: editorSettings.soundEffects ? "Disable Sound Effects" : "Enable Sound Effects",
        category: "Settings",
        icon: editorSettings.soundEffects
          ? <VolumeX style={{ width: 14, height: 14 }} />
          : <Volume2 style={{ width: 14, height: 14 }} />,
        action: () => {
          updateEditorSettings({ soundEffects: !editorSettings.soundEffects });
          addToast({
            message: editorSettings.soundEffects ? "Sound effects disabled" : "Sound effects enabled",
            type: "info",
            duration: 1500,
          });
        },
      },
      {
        id: "toggle-minimap",
        label: editorSettings.minimap ? "Hide Minimap" : "Show Minimap",
        category: "Settings",
        icon: <Settings style={{ width: 14, height: 14 }} />,
        action: () => {
          updateEditorSettings({ minimap: !editorSettings.minimap });
        },
      },
      {
        id: "toggle-word-wrap",
        label: editorSettings.wordWrap === "on" ? "Disable Word Wrap" : "Enable Word Wrap",
        category: "Settings",
        icon: <Settings style={{ width: 14, height: 14 }} />,
        action: () => {
          updateEditorSettings({ wordWrap: editorSettings.wordWrap === "on" ? "off" : "on" });
        },
      },
    ];

    // Add "New [Language] File" actions
    (Object.keys(LANGUAGE_CONFIGS) as Language[]).forEach((lang) => {
      const config = LANGUAGE_CONFIGS[lang];
      list.push({
        id: `new-file-${lang}`,
        label: `New ${config.label} File`,
        category: "File",
        icon: <FilePlus style={{ width: 14, height: 14 }} />,
        action: () => createFile(`untitled${config.extension}`, lang),
      });
    });

    return list;
  }, [activeFile, editorSettings, toggleOutputPanel, toggleSettings, clearOutput, createFile, updateEditorSettings, addToast]);

  // Filter actions by query
  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
    );
  }, [actions, query]);

  // Reset on open
  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [commandPaletteOpen]);

  // Scroll selected into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          filtered[selectedIndex].action();
          toggleCommandPalette();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        toggleCommandPalette();
      }
    },
    [filtered, selectedIndex, toggleCommandPalette]
  );

  if (!commandPaletteOpen) return null;

  // Group by category
  const grouped = new Map<string, typeof filtered>();
  filtered.forEach((a) => {
    const list = grouped.get(a.category) || [];
    list.push(a);
    grouped.set(a.category, list);
  });

  let globalIdx = 0;

  return (
    <div className="palette-overlay" onClick={toggleCommandPalette}>
      <div className="palette-container" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-row">
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <button className="palette-close" onClick={toggleCommandPalette}>
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="palette-empty">No matching commands</div>
          ) : (
            Array.from(grouped.entries()).map(([category, items]) => (
              <div key={category}>
                <div className="palette-category">{category}</div>
                {items.map((item) => {
                  const idx = globalIdx++;
                  return (
                    <button
                      key={item.id}
                      className={`palette-item ${idx === selectedIndex ? "palette-item-active" : ""}`}
                      onClick={() => {
                        item.action();
                        toggleCommandPalette();
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                    >
                      <span className="palette-item-icon">{item.icon}</span>
                      <span className="palette-item-label">{item.label}</span>
                      {item.shortcut && (
                        <span className="palette-item-shortcut">{item.shortcut}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
