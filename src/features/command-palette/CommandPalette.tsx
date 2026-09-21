// ============================================================
// Command Palette — ⌘K fuzzy search for actions
// ============================================================

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Terminal,
  Settings,
  FilePlus,
  Trash2,
  Copy,
  Download,
  Sun,
  Moon,
  X,
  StopCircle,
  Wand2,
  LayoutDashboard,
  Globe,
  Library,
  GitCompare,
  Network,
  Code2,
  MessageSquareText,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { compilerService } from "@/services/compiler.service";
import { formatCode, supportsFormatting } from "@/services/formatter.service";
import { useAppStore } from "@/stores/app.store";
import { useApiTesterStore } from "@/stores/api-tester.store";
import { LANGUAGE_CONFIGS } from "@/config";
import type { Language } from "@/types";
import { SimpleTooltip } from "@/components/ui/tooltip";


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
  const closeCommandPalette = useAppStore((s) => s.closeCommandPalette);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const createFile = useAppStore((s) => s.createFile);
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const editorSettings = useAppStore((s) => s.editorSettings);
  const updateEditorSettings = useAppStore((s) => s.updateEditorSettings);
  const addToast = useAppStore((s) => s.addToast);
  const isRunning = useAppStore((s) => s.isRunning);
  const updateFileContent = useAppStore((s) => s.updateFileContent);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleSidebarCollapse = useAppStore((s) => s.toggleSidebarCollapse);
  const createFormatterFile = useAppStore((s) => s.createFormatterFile);
  const createComparatorSession = useAppStore((s) => s.createComparatorSession);
  const createDiffSession = useAppStore((s) => s.createDiffSession);
  const createWorkflow = useAppStore((s) => s.createWorkflow);
  const addApiTesterTab = useApiTesterStore((s) => s.addTab);
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const activeFile = files.find((f) => f.id === activeFileId);

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];

    // Cancel execution (only show when running)
    if (isRunning) {
      list.push({
        id: "cancel-execution",
        label: "Cancel Execution",
        shortcut: "⌘⇧C",
        category: "Actions",
        icon: <StopCircle style={{ width: 14, height: 14, color: "var(--red)" }} />,
        action: () => {
          void useAppStore.getState().cancelRun();
        },
      });
    }

    list.push(
      {
        id: "toggle-console",
        label: "Toggle Console",
        shortcut: "⌘J",
        category: "View",
        icon: <Terminal style={{ width: 14, height: 14 }} />,
        action: () => {
          const pathname = window.location.pathname;
          if (pathname !== "/" && !pathname.startsWith("/compiler")) {
            useAppStore.getState().setOutputPanelOpen(true);
            navigate("/compiler");
            addToast({ message: "Console opened in Compiler", type: "info", duration: 1500 });
          } else {
            toggleOutputPanel();
          }
        },
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
          const state = useAppStore.getState();
          if (state.activeFileId) {
            state.clearTabOutput(state.activeFileId);
          }
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
          } else {
            addToast({ message: "No active code file to copy", type: "info", duration: 1500 });
          }
        },
      },
      {
        id: "format-document",
        label: "Format Document",
        shortcut: "⌘S",
        category: "Actions",
        icon: <Wand2 style={{ width: 14, height: 14 }} />,
        action: async () => {
          const pathname = window.location.pathname;

          if (pathname.startsWith("/formatters")) {
            window.dispatchEvent(new CustomEvent("intab:format-formatter"));
            return;
          }
          if (pathname.startsWith("/diff")) {
            window.dispatchEvent(new CustomEvent("intab:format-diff"));
            return;
          }
          if (pathname.startsWith("/api-tester")) {
            window.dispatchEvent(new CustomEvent("intab:format-api-tester"));
            return;
          }

          if (activeFile) {
            if (supportsFormatting(activeFile.language)) {
              try {
                const formatted = await formatCode(activeFile.content, activeFile.language);
                updateFileContent(activeFile.id, formatted);
                useAppStore.getState().saveFile(activeFile.id);
                addToast({ message: "Formatted & saved", type: "success", duration: 1500 });
              } catch {
                addToast({ message: "Format failed", type: "error", duration: 2000 });
              }
            } else {
              addToast({ message: `Formatting not supported for ${activeFile.language}`, type: "info", duration: 2000 });
            }
          } else {
            addToast({ message: "No active code file to format", type: "info", duration: 1500 });
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
          } else {
            addToast({ message: "No active code file to download", type: "info", duration: 1500 });
          }
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
      {
        id: "toggle-theme",
        label: editorSettings.theme === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme",
        category: "Settings",
        icon: editorSettings.theme === "dark" ? <Sun style={{ width: 14, height: 14 }} /> : <Moon style={{ width: 14, height: 14 }} />,
        action: () => {
          updateEditorSettings({ theme: editorSettings.theme === "dark" ? "light" : "dark" });
        },
      },
      {
        id: "toggle-sidebar",
        label: "Toggle Sidebar",
        shortcut: "⌘B",
        category: "View",
        icon: <Settings style={{ width: 14, height: 14 }} />,
        action: () => {
          toggleSidebarCollapse();
          toggleSidebar();
        },
      },
      {
        id: "new-json-formatter",
        label: "New JSON Formatter File",
        category: "File",
        icon: <FilePlus style={{ width: 14, height: 14 }} />,
        action: () => {
          createFormatterFile("json");
          navigate("/formatters");
        },
      },
      {
        id: "new-xml-formatter",
        label: "New XML Formatter File",
        category: "File",
        icon: <FilePlus style={{ width: 14, height: 14 }} />,
        action: () => {
          createFormatterFile("xml");
          navigate("/formatters");
        },
      },
      {
        id: "new-comparator-session",
        label: "New Comparator Session",
        category: "File",
        icon: <FilePlus style={{ width: 14, height: 14 }} />,
        action: () => {
          createComparatorSession();
          navigate("/comparators");
        },
      },
      {
        id: "new-diff-session",
        label: "New Diff Session",
        shortcut: "⌘⌥D",
        category: "File",
        icon: <FilePlus style={{ width: 14, height: 14 }} />,
        action: () => {
          createDiffSession();
          navigate("/diff");
        },
      },
      {
        id: "new-workflow",
        label: "New DrawFlow Diagram",
        shortcut: "⌘⌥W",
        category: "File",
        icon: <FilePlus style={{ width: 14, height: 14 }} />,
        action: () => {
          createWorkflow();
          navigate("/drawflows");
        },
      },
      {
        id: "new-api-request",
        label: "New API Request Tab",
        shortcut: "⌘⌥T",
        category: "File",
        icon: <FilePlus style={{ width: 14, height: 14 }} />,
        action: () => {
          addApiTesterTab();
          navigate("/api-tester");
        },
      },
      {
        id: "new-chat",
        label: "New AI Chat",
        category: "File",
        icon: <MessageSquareText style={{ width: 14, height: 14 }} />,
        action: () => navigate("/chat"),
      },
      {
        id: "nav-dashboard",
        label: "Go to Dashboard",
        shortcut: "⌘⌥1",
        category: "Navigation",
        icon: <LayoutDashboard style={{ width: 14, height: 14 }} />,
        action: () => navigate("/"),
      },
      {
        id: "nav-compiler",
        label: "Go to Compiler",
        shortcut: "⌘⌥2",
        category: "Navigation",
        icon: <Code2 style={{ width: 14, height: 14 }} />,
        action: () => navigate("/compiler"),
      },
      {
        id: "nav-api-tester",
        label: "Go to API Tester",
        shortcut: "⌘⌥3",
        category: "Navigation",
        icon: <Globe style={{ width: 14, height: 14 }} />,
        action: () => navigate("/api-tester"),
      },
      {
        id: "nav-formatters",
        label: "Go to Formatters",
        shortcut: "⌘⌥4",
        category: "Navigation",
        icon: <Wand2 style={{ width: 14, height: 14 }} />,
        action: () => navigate("/formatters"),
      },
      {
        id: "nav-comparators",
        label: "Go to Comparators",
        shortcut: "⌘⌥5",
        category: "Navigation",
        icon: <GitCompare style={{ width: 14, height: 14 }} />,
        action: () => navigate("/comparators"),
      },
      {
        id: "nav-diff-checker",
        label: "Go to Diff Checker",
        shortcut: "⌘⌥6",
        category: "Navigation",
        icon: <GitCompare style={{ width: 14, height: 14 }} />,
        action: () => navigate("/diff"),
      },
      {
        id: "nav-library",
        label: "Go to Code Library",
        shortcut: "⌘⌥7",
        category: "Navigation",
        icon: <Library style={{ width: 14, height: 14 }} />,
        action: () => navigate("/library"),
      },
      {
        id: "nav-workflows",
        label: "Go to DrawFlows",
        shortcut: "⌘⌥8",
        category: "Navigation",
        icon: <Network style={{ width: 14, height: 14 }} />,
        action: () => navigate("/drawflows"),
      },
      {
        id: "nav-chat",
        label: "Go to AI Chat",
        shortcut: "⌘⌥9",
        category: "Navigation",
        icon: <MessageSquareText style={{ width: 14, height: 14 }} />,
        action: () => navigate("/chat"),
      }
    );

    // Add "New [Language] File" actions
    (Object.keys(LANGUAGE_CONFIGS) as Language[]).forEach((lang) => {
      const config = LANGUAGE_CONFIGS[lang];
      list.push({
        id: `new-file-${lang}`,
        label: `New ${config.label} File`,
        category: "File",
        icon: <FilePlus style={{ width: 14, height: 14 }} />,
        action: () => {
          createFile(`untitled${config.extension}`, lang);
          navigate("/compiler");
        },
      });
    });

    return list;
  }, [
    activeFile, editorSettings, isRunning, toggleOutputPanel, toggleSettings, 
    createFile, updateEditorSettings, addToast, updateFileContent, toggleSidebar, 
    createFormatterFile, createComparatorSession, createDiffSession,
    createWorkflow, addApiTesterTab, navigate
  ]);

  // Filter actions by query
  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        (a.shortcut && a.shortcut.toLowerCase().includes(q))
    );
  }, [actions, query]);

  // Group by category and build flatOrdered in exact visual order
  const { grouped, flatOrdered } = useMemo(() => {
    const groupedMap = new Map<string, PaletteAction[]>();
    filtered.forEach((a) => {
      const list = groupedMap.get(a.category) || [];
      list.push(a);
      groupedMap.set(a.category, list);
    });

    const flat: PaletteAction[] = [];
    groupedMap.forEach((items) => {
      flat.push(...items);
    });

    return { grouped: groupedMap, flatOrdered: flat };
  }, [filtered]);

  // Reset on open. Deferred so setState happens outside the effect body
  // (avoids cascading renders on effect flush).
  useEffect(() => {
    if (commandPaletteOpen) {
      const timer = setTimeout(() => {
        setQuery("");
        setSelectedIndex(0);
        inputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [commandPaletteOpen]);

  // Ensure selectedIndex is always within valid bounds
  const validSelectedIndex = useMemo(() => {
    if (flatOrdered.length === 0) return 0;
    return Math.min(Math.max(0, selectedIndex), flatOrdered.length - 1);
  }, [selectedIndex, flatOrdered.length]);

  // Scroll selected into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector(".palette-item-active") as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [validSelectedIndex]);

  const executeAction = useCallback(
    (actionItem: PaletteAction) => {
      closeCommandPalette();
      setTimeout(() => {
        actionItem.action();
      }, 10);
    },
    [closeCommandPalette]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent | KeyboardEvent) => {
      if (flatOrdered.length === 0) {
        if (e.key === "Escape") {
          e.preventDefault();
          closeCommandPalette();
        }
        return;
      }

      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % flatOrdered.length);
      } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + flatOrdered.length) % flatOrdered.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const actionItem = flatOrdered[validSelectedIndex];
        if (actionItem) {
          executeAction(actionItem);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeCommandPalette();
      }
    },
    [flatOrdered, validSelectedIndex, executeAction, closeCommandPalette]
  );

  // Global window listener in capture phase so keys work everywhere and never double-trigger
  useEffect(() => {
    if (!commandPaletteOpen) return;

    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "Enter" ||
        e.key === "Escape" ||
        e.key === "Tab"
      ) {
        e.preventDefault();
        e.stopPropagation();
        handleKeyDown(e);
      }
    };

    window.addEventListener("keydown", onGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", onGlobalKeyDown, true);
  }, [commandPaletteOpen, handleKeyDown]);

  if (!commandPaletteOpen) return null;

  let globalCounter = 0;

  return (
    <div className="palette-overlay" onClick={closeCommandPalette}>
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
          />
          <SimpleTooltip content="Close Palette (Esc)" side="left">
            <button className="palette-close" onClick={closeCommandPalette}>
              <X style={{ width: 14, height: 14 }} />
            </button>
          </SimpleTooltip>
        </div>

        <div className="palette-list" ref={listRef}>
          {flatOrdered.length === 0 ? (
            <div className="palette-empty">No matching commands</div>
          ) : (
            Array.from(grouped.entries()).map(([category, items]) => (
              <div key={category}>
                <div className="palette-category">{category}</div>
                {items.map((item) => {
                  const idx = globalCounter++;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`palette-item ${idx === validSelectedIndex ? "palette-item-active" : ""}`}
                      onClick={() => executeAction(item)}
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
