// ============================================================
// DiffChecker — Fast, clean, robust Monaco diff viewer
// Smart dual-pane language auto-detection, seamless auto-format,
// streamlined toolbar, and live Monaco diff stats.
// ============================================================

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Monaco } from "@monaco-editor/react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { DndContext, closestCenter, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { SortableTab } from "@/components/ui/SortableTab";
import { setupMonacoTheme } from "@/utils/monaco-theme";
import { registerMonacoFormatShortcut } from "@/utils/monaco-format";
import {
  ArrowLeftRight,
  Trash2,
  Download,
  Settings2,
  ChevronDown,
  ChevronUp,
  Plus,
  X,
  Columns,
  Rows,
  FileCode2,
  Minus,
  Equal,
  Sparkles,
  Search,
  Check,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  SimpleTooltip,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import type { editor } from "monaco-editor";
import {
  DIFF_LANGUAGES,
  detectLanguageFromInputs,
  getLanguageInfo,
  type DetectionResult,
} from "./diffDetector";
import {
  formatContent,
  formatBothSides,
} from "./diffFormatter";

interface ActionTooltipProps {
  children: React.ReactNode;
  content: string;
  side?: "top" | "bottom" | "left" | "right";
}

const ActionTooltip = ({ children, content, side = "top" }: ActionTooltipProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      {children}
    </TooltipTrigger>
    <TooltipContent side={side}>
      <p>{content}</p>
    </TooltipContent>
  </Tooltip>
);

interface DiffStats {
  additions: number;
  deletions: number;
  modifications: number;
  unchanged: number;
  totalDiffs: number;
}

const SAMPLE_ORIGINAL = JSON.stringify({
  service: "billing-gateway",
  version: "2.4.0",
  environment: "production",
  features: {
    instantPayouts: false,
    cryptoBilling: false,
    multiCurrency: true
  },
  rateLimits: {
    perMinute: 1200,
    burst: 2000
  },
  supportedCurrencies: ["USD", "EUR", "GBP", "CAD"],
  endpoints: [
    "/v1/charges",
    "/v1/customers",
    "/v1/invoices"
  ]
}, null, 2);

const SAMPLE_MODIFIED = JSON.stringify({
  service: "billing-gateway",
  version: "2.5.0",
  environment: "production",
  features: {
    instantPayouts: true,
    cryptoBilling: false,
    multiCurrency: true,
    smartRouting: true
  },
  rateLimits: {
    perMinute: 2400,
    burst: 3500
  },
  supportedCurrencies: ["USD", "EUR", "GBP", "CAD", "JPY", "AUD"],
  endpoints: [
    "/v1/charges",
    "/v1/customers",
    "/v1/invoices",
    "/v1/subscriptions",
    "/v1/refunds"
  ]
}, null, 2);

export function DiffChecker() {
  // Store state
  const sessions = useAppStore((s) => s.diffSessions);
  const activeSessionId = useAppStore((s) => s.activeDiffSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveDiffSession);
  const createSession = useAppStore((s) => s.createDiffSession);
  const deleteSession = useAppStore((s) => s.deleteDiffSession);
  const renameSession = useAppStore((s) => s.renameDiffSession);
  const updateSessionInput = useAppStore((s) => s.updateDiffSessionInput);
  const updateSessionLanguage = useAppStore((s) => s.updateDiffSessionLanguage);
  const reorderSessions = useAppStore((s) => s.reorderDiffSessions);
  const diffSettings = useAppStore((s) => s.diffSettings);
  const updateDiffSettings = useAppStore((s) => s.updateDiffSettings);
  const addToast = useAppStore((s) => s.addToast);
  const currentThemeSetting = useAppStore((s) => s.editorSettings.theme);

  // Active session
  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0]!;

  // Local state
  const [localOriginal, setLocalOriginal] = useState(activeSession.original);
  const [localModified, setLocalModified] = useState(activeSession.modified);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const [langSearch, setLangSearch] = useState("");
  const [isFormatting, setIsFormatting] = useState(false);

  // Live diff stats from Monaco
  const [diffStats, setDiffStats] = useState<DiffStats>({
    additions: 0,
    deletions: 0,
    modifications: 0,
    unchanged: 0,
    totalDiffs: 0,
  });
  const [currentDiffIndex, setCurrentDiffIndex] = useState(0);

  // Smart detection state
  const [detection, setDetection] = useState<DetectionResult>(() =>
    detectLanguageFromInputs(activeSession.original, activeSession.modified)
  );

  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const originalEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modifiedEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const disposablesRef = useRef<{ dispose: () => void }[]>([]);

  // DnD sensors for tabs
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sessions.findIndex((s) => s.id === active.id);
    const newIndex = sessions.findIndex((s) => s.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      reorderSessions(oldIndex, newIndex);
    }
  }, [sessions, reorderSessions]);

  // Session switch sync
  const [prevSessionId, setPrevSessionId] = useState(activeSession.id);
  if (prevSessionId !== activeSession.id) {
    setPrevSessionId(activeSession.id);
    setLocalOriginal(activeSession.original);
    setLocalModified(activeSession.modified);
  }

  // Layout resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      diffEditorRef.current?.layout();
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Update diff statistics directly from Monaco diff engine
  const updateStatsFromMonaco = useCallback(() => {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor) return;

    const lineChanges = diffEditor.getLineChanges();
    const orig = originalEditorRef.current?.getValue() ?? localOriginal;
    const mod = modifiedEditorRef.current?.getValue() ?? localModified;

    if (!orig && !mod) {
      setDiffStats({ additions: 0, deletions: 0, modifications: 0, unchanged: 0, totalDiffs: 0 });
      setCurrentDiffIndex(0);
      return;
    }

    if (!lineChanges || lineChanges.length === 0) {
      const totalLines = mod ? mod.split("\n").length : (orig ? orig.split("\n").length : 0);
      setDiffStats({ additions: 0, deletions: 0, modifications: 0, unchanged: totalLines, totalDiffs: 0 });
      setCurrentDiffIndex(0);
      return;
    }

    let additions = 0;
    let deletions = 0;
    let modifications = 0;

    for (const change of lineChanges) {
      const origCount = change.originalEndLineNumber >= change.originalStartLineNumber
        ? change.originalEndLineNumber - change.originalStartLineNumber + 1
        : 0;
      const modCount = change.modifiedEndLineNumber >= change.modifiedStartLineNumber
        ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
        : 0;

      if (origCount === 0 && modCount > 0) {
        additions += modCount;
      } else if (origCount > 0 && modCount === 0) {
        deletions += origCount;
      } else {
        additions += modCount;
        deletions += origCount;
        modifications++;
      }
    }

    const modLinesTotal = mod ? mod.split("\n").length : 0;
    const unchanged = Math.max(0, modLinesTotal - additions);

    setDiffStats({
      additions,
      deletions,
      modifications,
      unchanged,
      totalDiffs: lineChanges.length,
    });
    if (currentDiffIndex === 0 && lineChanges.length > 0) {
      setCurrentDiffIndex(1);
    }
  }, [localOriginal, localModified, currentDiffIndex]);

  // Sync language with Monaco models
  useEffect(() => {
    const m = monacoRef.current;
    if (!m) return;
    const origModel = originalEditorRef.current?.getModel();
    const modModel = modifiedEditorRef.current?.getModel();
    const effectiveLang = activeSession.language;
    if (origModel) m.editor.setModelLanguage(origModel, effectiveLang);
    if (modModel) m.editor.setModelLanguage(modModel, effectiveLang);
  }, [activeSession.language]);

  // Auto-format helper
  const applyFormattedValue = useCallback((side: "original" | "modified", formatted: string) => {
    if (side === "original") {
      setLocalOriginal(formatted);
      originalEditorRef.current?.setValue(formatted);
      updateSessionInput(activeSession.id, "original", formatted);
    } else {
      setLocalModified(formatted);
      modifiedEditorRef.current?.setValue(formatted);
      updateSessionInput(activeSession.id, "modified", formatted);
    }
  }, [activeSession.id, updateSessionInput]);

  // Format Both
  const handleFormatBoth = useCallback(async () => {
    const orig = originalEditorRef.current?.getValue() ?? localOriginal;
    const mod = modifiedEditorRef.current?.getValue() ?? localModified;
    if (!orig.trim() && !mod.trim()) {
      addToast({ message: "Nothing to format", type: "info", duration: 1500 });
      return;
    }

    setIsFormatting(true);
    try {
      const res = await formatBothSides(orig, mod, activeSession.language);
      if (res.changed) {
        if (res.original !== orig) applyFormattedValue("original", res.original);
        if (res.modified !== mod) applyFormattedValue("modified", res.modified);
        if (res.original !== orig && res.modified !== mod) {
          addToast({ message: `Formatted both sides (${activeSession.language})`, type: "success" });
        } else if (res.original !== orig) {
          addToast({ message: `Formatted original (${activeSession.language})`, type: "success" });
        } else {
          addToast({ message: `Formatted modified (${activeSession.language})`, type: "success" });
        }
      } else if (res.errors.length > 0) {
        addToast({ message: `Formatting: ${res.errors.join("; ")}`, type: "error" });
      } else {
        addToast({ message: "Both sides are already formatted", type: "info" });
      }
    } catch (err: unknown) {
      addToast({ message: `Formatting failed: ${String(err)}`, type: "error" });
    } finally {
      setIsFormatting(false);
    }
  }, [activeSession.language, localOriginal, localModified, applyFormattedValue, addToast]);

  const handleFormatBothRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    handleFormatBothRef.current = handleFormatBoth;
  });

  // Listen for global format event when /diff is active
  useEffect(() => {
    const handleExternalFormat = () => {
      handleFormatBothRef.current?.();
    };
    window.addEventListener("devutils:format-diff", handleExternalFormat);
    return () => window.removeEventListener("devutils:format-diff", handleExternalFormat);
  }, []);

  // Auto-format on Paste
  const handlePasteEvent = useCallback((side: "original" | "modified") => {
    const settings = useAppStore.getState().diffSettings;
    if (settings.autoFormatOnPaste === false) return;

    setTimeout(async () => {
      const orig = originalEditorRef.current?.getValue() ?? "";
      const mod = modifiedEditorRef.current?.getValue() ?? "";
      const targetEditor = side === "original" ? originalEditorRef.current : modifiedEditorRef.current;
      if (!targetEditor) return;

      const raw = targetEditor.getValue();
      if (!raw.trim() || raw.trim().length < 8) return;

      const det = detectLanguageFromInputs(orig, mod);
      setDetection(det);

      const storeSession = useAppStore.getState().diffSessions.find((s) => s.id === useAppStore.getState().activeDiffSessionId);
      const isAuto = storeSession?.autoDetect !== false;
      const targetLang = isAuto ? det.language : (storeSession?.language || "plaintext");

      if (isAuto && det.language !== "plaintext" && det.language !== storeSession?.language) {
        useAppStore.getState().updateDiffSessionLanguage(storeSession?.id || "", det.language, true);
      }

      try {
        const res = await formatContent(raw, targetLang);
        if (res.success && res.formatted !== raw) {
          targetEditor.setValue(res.formatted);
          if (side === "original") {
            setLocalOriginal(res.formatted);
            useAppStore.getState().updateDiffSessionInput(storeSession?.id || "", "original", res.formatted);
          } else {
            setLocalModified(res.formatted);
            useAppStore.getState().updateDiffSessionInput(storeSession?.id || "", "modified", res.formatted);
          }
          addToast({ message: `Auto-formatted ${getLanguageInfo(targetLang).label}`, type: "info" });
        }
      } catch {
        // Safe: preserve raw code if parse fails
      }
    }, 60);
  }, [addToast]);

  // Mount Monaco Diff Editor
  const handleDiffEditorMount: DiffOnMount = useCallback((diffEditor, monaco) => {
    diffEditorRef.current = diffEditor;
    monacoRef.current = monaco;

    disposablesRef.current.forEach((d) => d.dispose());
    disposablesRef.current = [];

    // Custom themes matching clean minimalist palette with WCAG compliant colors
    setupMonacoTheme(monaco);

    const initTheme = useAppStore.getState().editorSettings.theme;
    monaco.editor.setTheme(initTheme === "light" ? "devutils-light" : "devutils-dark");

    const origEditor = diffEditor.getOriginalEditor();
    const modEditor = diffEditor.getModifiedEditor();
    originalEditorRef.current = origEditor;
    modifiedEditorRef.current = modEditor;

    // Register Cmd+S / Ctrl+S and Shift+Alt+F format shortcut for both editors
    registerMonacoFormatShortcut(origEditor, monaco, {
      onFormat: () => handleFormatBothRef.current?.(),
    });
    registerMonacoFormatShortcut(modEditor, monaco, {
      onFormat: () => handleFormatBothRef.current?.(),
    });

    // Diff update listener
    const dDiff = diffEditor.onDidUpdateDiff(() => {
      updateStatsFromMonaco();
    });
    disposablesRef.current.push(dDiff);

    // Debounced content change listener
    let contentTimer: ReturnType<typeof setTimeout>;
    const handleContentChange = () => {
      clearTimeout(contentTimer);
      contentTimer = setTimeout(() => {
        let origVal: string;
        let modVal: string;
        try {
          origVal = origEditor.getValue();
          modVal = modEditor.getValue();
        } catch {
          return;
        }

        setLocalOriginal(origVal);
        setLocalModified(modVal);

        const store = useAppStore.getState();
        store.updateDiffSessionInput(store.activeDiffSessionId, "original", origVal);
        store.updateDiffSessionInput(store.activeDiffSessionId, "modified", modVal);

        const det = detectLanguageFromInputs(origVal, modVal);
        setDetection(det);

        const activeSess = store.diffSessions.find((s) => s.id === store.activeDiffSessionId);
        if (activeSess?.autoDetect !== false && det.language !== "plaintext" && det.language !== activeSess?.language) {
          store.updateDiffSessionLanguage(store.activeDiffSessionId, det.language, true);
        }

        updateStatsFromMonaco();
      }, 150);
    };

    const d1 = origEditor.onDidChangeModelContent(handleContentChange);
    const d2 = modEditor.onDidChangeModelContent(handleContentChange);
    disposablesRef.current.push(d1, d2);

    // Auto-format on paste
    const dPasteOrig = origEditor.onDidPaste(() => handlePasteEvent("original"));
    const dPasteMod = modEditor.onDidPaste(() => handlePasteEvent("modified"));
    disposablesRef.current.push(dPasteOrig, dPasteMod);

    setTimeout(() => {
      updateStatsFromMonaco();
    }, 100);
  }, [updateStatsFromMonaco, handlePasteEvent]);

  useEffect(() => {
    return () => {
      disposablesRef.current.forEach((d) => d.dispose());
      disposablesRef.current = [];
    };
  }, []);

  // Theme change
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(currentThemeSetting === "light" ? "devutils-light" : "devutils-dark");
    }
  }, [currentThemeSetting]);

  // Difference stepping
  const handleNextDiff = useCallback(() => {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor || diffStats.totalDiffs === 0) return;
    diffEditor.goToDiff("next");
    setCurrentDiffIndex((prev) => (prev < diffStats.totalDiffs ? prev + 1 : 1));
  }, [diffStats.totalDiffs]);

  const handlePrevDiff = useCallback(() => {
    const diffEditor = diffEditorRef.current;
    if (!diffEditor || diffStats.totalDiffs === 0) return;
    diffEditor.goToDiff("previous");
    setCurrentDiffIndex((prev) => (prev > 1 ? prev - 1 : diffStats.totalDiffs));
  }, [diffStats.totalDiffs]);

  // Swap
  const handleSwap = useCallback(() => {
    const orig = originalEditorRef.current?.getValue() ?? localOriginal;
    const mod = modifiedEditorRef.current?.getValue() ?? localModified;
    updateSessionInput(activeSession.id, "original", mod);
    updateSessionInput(activeSession.id, "modified", orig);
    setLocalOriginal(mod);
    setLocalModified(orig);
    originalEditorRef.current?.setValue(mod);
    modifiedEditorRef.current?.setValue(orig);
    addToast({ message: "Swapped sides", type: "info" });
  }, [activeSession.id, localOriginal, localModified, updateSessionInput, addToast]);

  // Clear all
  const handleClearAll = useCallback(() => {
    updateSessionInput(activeSession.id, "original", "");
    updateSessionInput(activeSession.id, "modified", "");
    updateSessionLanguage(activeSession.id, "plaintext", true);
    setLocalOriginal("");
    setLocalModified("");
    originalEditorRef.current?.setValue("");
    modifiedEditorRef.current?.setValue("");
    setDiffStats({ additions: 0, deletions: 0, modifications: 0, unchanged: 0, totalDiffs: 0 });
    setCurrentDiffIndex(0);
    setDetection({ language: "plaintext", label: "Plain Text", confidence: 0 });
    addToast({ message: "Diff cleared", type: "info" });
  }, [activeSession.id, updateSessionInput, updateSessionLanguage, addToast]);

  // Load sample diff
  const handleLoadSample = useCallback(() => {
    updateSessionInput(activeSession.id, "original", SAMPLE_ORIGINAL);
    updateSessionInput(activeSession.id, "modified", SAMPLE_MODIFIED);
    updateSessionLanguage(activeSession.id, "json", true);
    setLocalOriginal(SAMPLE_ORIGINAL);
    setLocalModified(SAMPLE_MODIFIED);
    originalEditorRef.current?.setValue(SAMPLE_ORIGINAL);
    modifiedEditorRef.current?.setValue(SAMPLE_MODIFIED);
    const det = detectLanguageFromInputs(SAMPLE_ORIGINAL, SAMPLE_MODIFIED);
    setDetection(det);
    addToast({ message: "Sample loaded", type: "success" });
  }, [activeSession.id, updateSessionInput, updateSessionLanguage, addToast]);

  // Export diff file
  const handleExportDiff = useCallback(() => {
    const orig = originalEditorRef.current?.getValue() ?? localOriginal;
    const mod = modifiedEditorRef.current?.getValue() ?? localModified;
    const origLines = orig.split("\n");
    const modLines = mod.split("\n");

    const lines: string[] = [];
    lines.push(`--- Original`);
    lines.push(`+++ Modified`);
    lines.push(`@@ Diff (${activeSession.language}) @@`);

    const maxLen = Math.max(origLines.length, modLines.length);
    for (let i = 0; i < maxLen; i++) {
      const origLine = origLines[i];
      const modLine = modLines[i];
      if (origLine === modLine) {
        lines.push(` ${origLine ?? ""}`);
      } else {
        if (origLine !== undefined) lines.push(`-${origLine}`);
        if (modLine !== undefined) lines.push(`+${modLine}`);
      }
    }

    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diff_${activeSession.name.replace(/\s+/g, "_")}.diff`;
    a.click();
    URL.revokeObjectURL(url);
    addToast({ message: "Diff exported", type: "success" });
  }, [activeSession.name, activeSession.language, localOriginal, localModified, addToast]);

  // Filtered languages
  const filteredLanguages = useMemo(() => {
    if (!langSearch.trim()) return DIFF_LANGUAGES;
    const q = langSearch.toLowerCase();
    return DIFF_LANGUAGES.filter(
      (l) => l.label.toLowerCase().includes(q) || l.id.toLowerCase().includes(q)
    );
  }, [langSearch]);

  const currentLang = getLanguageInfo(activeSession.language);
  const isAutoDetectActive = activeSession.autoDetect !== false;
  const origLineCount = localOriginal ? localOriginal.split("\n").length : 0;
  const modLineCount = localModified ? localModified.split("\n").length : 0;

  return (
    <div className="diff-checker-container">
      {/* 1. Clean Tab Bar */}
      <div className="tabs-bar">
        <div className="tabs-list">
          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sessions.map((s) => s.id)} strategy={horizontalListSortingStrategy}>
              {sessions.map((session) => (
                <SortableTab key={session.id} id={session.id}>
                  <button
                    className={cn(
                      "tab",
                      activeSessionId === session.id && "tab-active"
                    )}
                    onClick={() => setActiveSession(session.id)}
                    onDoubleClick={() => {
                      setEditName(session.name);
                      setEditingSessionId(session.id);
                    }}
                  >
                    <span className="tab-icon tab-icon-diff">
                      <FileCode2 className="h-3 w-3" />
                    </span>
                    {editingSessionId === session.id ? (
                      <input
                        autoFocus
                        className="tab-rename-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onBlur={() => {
                          if (editName.trim() && editName !== session.name) {
                            renameSession(session.id, editName.trim());
                          }
                          setEditingSessionId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            setEditingSessionId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="tab-name">
                        {session.name}
                      </span>
                    )}
                    <SimpleTooltip content="Close Tab">
                      <span
                        className="tab-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSession(session.id);
                        }}
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </SimpleTooltip>
                  </button>
                </SortableTab>
              ))}
            </SortableContext>
          </DndContext>
          <SimpleTooltip content="New Diff Session">
            <button
              className="tab-new"
              onClick={() => createSession()}
            >
              <Plus className="h-4 w-4" />
            </button>
          </SimpleTooltip>
        </div>

        {/* 2. Streamlined Controls Toolbar */}
        <div className="tabs-toolbar">
          {/* Smart Language Dropdown */}
          <DropdownMenu open={langDropdownOpen} onOpenChange={setLangDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "toolbar-btn",
                  isAutoDetectActive && "text-accent font-medium"
                )}
              >
                {isAutoDetectActive ? (
                  <Sparkles className="h-3.5 w-3.5 text-accent" />
                ) : (
                  <FileCode2 className="h-3.5 w-3.5" />
                )}
                <span>
                  {isAutoDetectActive
                    ? `Auto (${detection.language !== "plaintext" ? detection.label : currentLang.label})`
                    : currentLang.label}
                </span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 p-1">
              <div className="flex items-center gap-2 px-2 py-1 mb-1 bg-bg-2 rounded border border-border-1">
                <Search className="h-3 w-3 text-text-3" />
                <input
                  type="text"
                  placeholder="Filter languages..."
                  className="w-full bg-transparent text-xs text-text-1 placeholder:text-text-3 outline-none"
                  value={langSearch}
                  onChange={(e) => setLangSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              <DropdownMenuItem
                className={cn(
                  "flex items-center justify-between px-2 py-1.5 rounded text-xs cursor-pointer",
                  isAutoDetectActive && "bg-accent/15 text-accent font-semibold"
                )}
                onSelect={() => {
                  const det = detectLanguageFromInputs(localOriginal, localModified);
                  updateSessionLanguage(activeSession.id, det.language, true);
                  setLangDropdownOpen(false);
                }}
              >
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-accent" />
                  <span>Auto-Detect</span>
                </div>
                {detection.confidence > 0 && (
                  <span className="text-[10px] opacity-70">{detection.label}</span>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="my-1" />
              <div className="max-h-48 overflow-y-auto space-y-0.5">
                {filteredLanguages.map((lang) => (
                  <DropdownMenuItem
                    key={lang.id}
                    className={cn(
                      "flex items-center justify-between px-2 py-1 rounded text-xs cursor-pointer",
                      !isAutoDetectActive && activeSession.language === lang.id && "bg-bg-2 text-accent font-semibold"
                    )}
                    onSelect={() => {
                      updateSessionLanguage(activeSession.id, lang.id, false);
                      setLangDropdownOpen(false);
                    }}
                  >
                    <span>{lang.label}</span>
                    {!isAutoDetectActive && activeSession.language === lang.id && (
                      <Check className="h-3 w-3 text-accent" />
                    )}
                  </DropdownMenuItem>
                ))}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="tabs-toolbar-sep" />

          {/* Format Both */}
          <ActionTooltip content="Auto-format both inputs (⌘S / Shift+Alt+F)">
            <button
              className="toolbar-btn"
              onClick={handleFormatBoth}
              disabled={isFormatting}
            >
              <Sparkles className={cn("h-3.5 w-3.5 text-accent", isFormatting && "animate-spin")} />
              <span>Format</span>
            </button>
          </ActionTooltip>

          {/* Swap */}
          <ActionTooltip content="Swap original ↔ modified">
            <button className="toolbar-btn" onClick={handleSwap}>
              <ArrowLeftRight className="h-3.5 w-3.5" />
              <span>Swap</span>
            </button>
          </ActionTooltip>

          {/* View Toggle */}
          <ActionTooltip content={diffSettings.renderSideBySide ? "Switch to inline view" : "Switch to side-by-side"}>
            <button
              className="toolbar-btn"
              onClick={() => updateDiffSettings({ renderSideBySide: !diffSettings.renderSideBySide })}
            >
              {diffSettings.renderSideBySide ? (
                <Rows className="h-3.5 w-3.5" />
              ) : (
                <Columns className="h-3.5 w-3.5" />
              )}
              <span>{diffSettings.renderSideBySide ? "Inline" : "Split"}</span>
            </button>
          </ActionTooltip>

          {/* Options Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="toolbar-btn">
                <Settings2 className="h-3.5 w-3.5" />
                <span>Options</span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={handleLoadSample}>
                <Sparkles className="h-3.5 w-3.5 text-accent mr-2" />
                <span>Load Sample Diff</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleExportDiff}>
                <Download className="h-3.5 w-3.5 mr-2" />
                <span>Export as .diff</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={diffSettings.autoFormatOnPaste !== false}
                onCheckedChange={(checked) => updateDiffSettings({ autoFormatOnPaste: checked })}
                onSelect={(e) => e.preventDefault()}
              >
                Auto-Format on Paste
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={diffSettings.ignoreTrimWhitespace}
                onCheckedChange={(checked) => updateDiffSettings({ ignoreTrimWhitespace: checked })}
                onSelect={(e) => e.preventDefault()}
              >
                Ignore Whitespace
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={diffSettings.wordWrap ?? false}
                onCheckedChange={(checked) => updateDiffSettings({ wordWrap: checked })}
                onSelect={(e) => e.preventDefault()}
              >
                Wrap Long Lines
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={diffSettings.enableSplitViewResizing}
                onCheckedChange={(checked) => updateDiffSettings({ enableSplitViewResizing: checked })}
                onSelect={(e) => e.preventDefault()}
              >
                Resizable Split
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="tabs-toolbar-sep" />

          {/* Clear */}
          <ActionTooltip content="Clear inputs">
            <button className="toolbar-btn text-red hover:bg-red-dim" onClick={handleClearAll}>
              <Trash2 className="h-3.5 w-3.5" />
              <span>Clear</span>
            </button>
          </ActionTooltip>
        </div>
      </div>

      {/* 3. Compact Diff Stats & Navigation Bar */}
      <div className="diff-stats-bar">
        <div className="diff-stat diff-stat-add">
          <Plus className="h-3 w-3" />
          <span>{diffStats.additions}</span>
        </div>
        <div className="diff-stat diff-stat-del">
          <Minus className="h-3 w-3" />
          <span>{diffStats.deletions}</span>
        </div>
        <div className="diff-stat diff-stat-eq">
          <Equal className="h-3 w-3" />
          <span>{diffStats.unchanged} unchanged</span>
        </div>

        {/* Diff stepper */}
        {diffStats.totalDiffs > 0 && (
          <div className="flex items-center gap-1 ml-2 pl-2 border-l border-border-1">
            <ActionTooltip content="Previous change (Shift+F7)">
              <button className="diff-nav-btn" onClick={handlePrevDiff}>
                <ChevronUp className="h-3 w-3" />
              </button>
            </ActionTooltip>
            <span className="diff-nav-counter">
              {currentDiffIndex > 0 ? `${currentDiffIndex} of ${diffStats.totalDiffs}` : `${diffStats.totalDiffs} diffs`}
            </span>
            <ActionTooltip content="Next change (F7)">
              <button className="diff-nav-btn" onClick={handleNextDiff}>
                <ChevronDown className="h-3 w-3" />
              </button>
            </ActionTooltip>
          </div>
        )}

        <div className="diff-stat-spacer" />

        {/* Sample quick button if empty */}
        {!localOriginal.trim() && !localModified.trim() && (
          <button
            className="diff-pill-toggle text-accent hover:border-accent"
            onClick={handleLoadSample}
          >
            <Sparkles className="h-3 w-3 mr-1" />
            <span>Load Sample</span>
          </button>
        )}
      </div>

      {/* 4. Super Clean Subdued Pane Strip */}
      <div className="diff-pane-strip">
        <div className="diff-pane-strip-side">
          <span className="diff-pane-tag diff-pane-tag-orig">Original</span>
          {origLineCount > 0 && <span className="diff-pane-count">{origLineCount} lines</span>}
        </div>
        {diffSettings.renderSideBySide && (
          <div className="diff-pane-strip-side">
            <span className="diff-pane-tag diff-pane-tag-mod">Modified</span>
            {modLineCount > 0 && <span className="diff-pane-count">{modLineCount} lines</span>}
          </div>
        )}
      </div>

      {/* 5. Direct Monaco Diff Editor — Clean Canvas, Zero Popups */}
      <div className="diff-editor-container" ref={containerRef}>
        <DiffEditor
          key={activeSession.id}
          height="100%"
          language={activeSession.language}
          original={activeSession.original}
          modified={activeSession.modified}
          onMount={handleDiffEditorMount}
          theme={currentThemeSetting === "light" ? "devutils-light" : "devutils-dark"}
          options={{
            renderSideBySide: diffSettings.renderSideBySide,
            ignoreTrimWhitespace: diffSettings.ignoreTrimWhitespace,
            enableSplitViewResizing: diffSettings.enableSplitViewResizing,
            originalEditable: true,
            readOnly: false,
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            minimap: { enabled: false },
            lineNumbers: "on",
            smoothScrolling: true,
            cursorBlinking: "smooth",
            cursorSmoothCaretAnimation: "on",
            renderLineHighlight: "all",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 6, bottom: 10 },
            scrollbar: {
              verticalScrollbarSize: 7,
              horizontalScrollbarSize: 7,
            },
            diffWordWrap: diffSettings.wordWrap ? "on" : "off",
            renderOverviewRuler: true,
          }}
          loading={
            <div className="flex-1 flex items-center justify-center bg-editor h-full">
              <span className="text-xs text-text-3">Loading diff editor...</span>
            </div>
          }
        />
      </div>
    </div>
  );
}
