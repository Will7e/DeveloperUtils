// ============================================================
// DiffChecker — Fast, clean, robust Monaco diff viewer
// Smart dual-pane language auto-detection, seamless auto-format,
// streamlined toolbar, and live Monaco diff stats.
// ============================================================

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Monaco } from "@monaco-editor/react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { WorkspaceTabBar, type TabItem } from "@/components/ui/WorkspaceTabBar";
import { setupMonacoTheme } from "@/utils/monaco-theme";
import { registerMonacoFormatShortcut } from "@/utils/monaco-format";
import { EditorLoadingFallback } from "@/components/ui/editor-loader";
import { InTabLoader } from "@/components/ui/intab-loader";
import {
  ArrowLeftRight,
  Trash2,
  Download,
  Settings2,
  ChevronDown,
  ChevronUp,
  Plus,
  Rows,
  Columns,
  FileCode2,
  Minus,
  AlignLeft,
  ScanSearch,
  Check,
  Copy,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
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

const ActionTooltip = React.memo(({ children, content, side = "top" }: ActionTooltipProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      {children}
    </TooltipTrigger>
    <TooltipContent side={side}>
      <p>{content}</p>
    </TooltipContent>
  </Tooltip>
));
ActionTooltip.displayName = "ActionTooltip";

interface DiffStats {
  additions: number;
  deletions: number;
  modifications: number;
  unchanged: number;
  totalDiffs: number;
}

export function DiffChecker() {
  // Store state
  const sessions = useAppStore((s) => s.diffSessions);
  const activeSessionId = useAppStore((s) => s.activeDiffSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveDiffSession);
  const createSession = useAppStore((s) => s.createDiffSession);
  const duplicateSession = useAppStore((s) => s.duplicateDiffSession);
  const deleteSession = useAppStore((s) => s.deleteDiffSession);
  const closeOtherSessions = useAppStore((s) => s.closeOtherDiffSessions);
  const closeSessionsToRight = useAppStore((s) => s.closeDiffSessionsToRight);
  const closeAllSessions = useAppStore((s) => s.closeAllDiffSessions);
  const renameSession = useAppStore((s) => s.renameDiffSession);
  const updateSessionInput = useAppStore((s) => s.updateDiffSessionInput);
  const updateSessionLanguage = useAppStore((s) => s.updateDiffSessionLanguage);
  const reorderSessions = useAppStore((s) => s.reorderDiffSessions);
  const diffSettings = useAppStore((s) => s.diffSettings);
  const updateDiffSettings = useAppStore((s) => s.updateDiffSettings);
  const addToast = useAppStore((s) => s.addToast);
  const currentThemeSetting = useAppStore((s) => s.editorSettings.theme);

  // Active session
  const activeSession =
    sessions.find((s) => s.id === activeSessionId) ||
    sessions[0] || {
      id: "default-diff",
      name: "Diff Check",
      original: "",
      modified: "",
      language: "plaintext",
      autoDetect: true,
    };

  // Local state
  const [localOriginal, setLocalOriginal] = useState(activeSession.original);
  const [localModified, setLocalModified] = useState(activeSession.modified);
  const [copiedOrig, setCopiedOrig] = useState(false);
  const [copiedMod, setCopiedMod] = useState(false);
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
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

  // Tab items for WorkspaceTabBar
  const tabs: TabItem[] = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.id,
        name: session.name,
        icon: (
          <span className="tab-icon tab-icon-diff">
            <FileCode2 className="h-3 w-3" />
          </span>
        ),
        closable: sessions.length > 1,
      })),
    [sessions]
  );

  const handleDeleteSession = useCallback(
    (id: string) => {
      deleteSession(id);
    },
    [deleteSession]
  );

  const handleCopyOriginal = useCallback(async () => {
    const orig = originalEditorRef.current?.getValue() ?? localOriginal;
    if (!orig) return;
    await navigator.clipboard.writeText(orig);
    setCopiedOrig(true);
    setTimeout(() => setCopiedOrig(false), 2000);
    addToast({ message: "Original content copied", type: "success", duration: 1500 });
  }, [localOriginal, addToast]);

  const handleCopyModified = useCallback(async () => {
    const mod = modifiedEditorRef.current?.getValue() ?? localModified;
    if (!mod) return;
    await navigator.clipboard.writeText(mod);
    setCopiedMod(true);
    setTimeout(() => setCopiedMod(false), 2000);
    addToast({ message: "Modified content copied", type: "success", duration: 1500 });
  }, [localModified, addToast]);

  const handleCopyTabContent = useCallback(
    async (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (!session) return;
      const orig =
        id === activeSession.id
          ? originalEditorRef.current?.getValue() ?? localOriginal
          : session.original;
      const mod =
        id === activeSession.id
          ? modifiedEditorRef.current?.getValue() ?? localModified
          : session.modified;
      const combined = `// ── Original ──\n${orig}\n\n// ── Modified ──\n${mod}`;
      await navigator.clipboard.writeText(combined);
      addToast({
        message: `Copied "${session.name}" content to clipboard`,
        type: "success",
        duration: 1500,
      });
    },
    [sessions, activeSession.id, localOriginal, localModified, addToast]
  );

  const handleCopyTabName = useCallback(
    async (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (!session) return;
      await navigator.clipboard.writeText(session.name);
      addToast({
        message: `Copied tab name "${session.name}"`,
        type: "success",
        duration: 1500,
      });
    },
    [sessions, addToast]
  );

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
    window.addEventListener("intab:format-diff", handleExternalFormat);
    window.addEventListener("devutils:format-diff", handleExternalFormat);
    return () => {
      window.removeEventListener("intab:format-diff", handleExternalFormat);
      window.removeEventListener("devutils:format-diff", handleExternalFormat);
    };
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
    monaco.editor.setTheme(initTheme === "light" ? "intab-light" : "intab-dark");

    const origEditor = diffEditor.getOriginalEditor();
    const modEditor = diffEditor.getModifiedEditor();
    originalEditorRef.current = origEditor;
    modifiedEditorRef.current = modEditor;

    // Trigger immediate layout pass so split panes and editors adapt to container bounds
    diffEditor.layout();
    requestAnimationFrame(() => {
      diffEditor.layout();
    });

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
      monacoRef.current.editor.setTheme(currentThemeSetting === "light" ? "intab-light" : "intab-dark");
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

  const currentLang = getLanguageInfo(activeSession.language);
  const isAutoDetectActive = activeSession.autoDetect !== false;
  const origLineCount = localOriginal ? localOriginal.split("\n").length : 0;
  const modLineCount = localModified ? localModified.split("\n").length : 0;

  const diffEditorOptions: editor.IDiffEditorConstructionOptions = useMemo(
    () => ({
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
      padding: { top: 8, bottom: 8 },
      scrollbar: {
        verticalScrollbarSize: 7,
        horizontalScrollbarSize: 7,
      },
      diffWordWrap: diffSettings.wordWrap ? "on" : "off",
      renderOverviewRuler: true,
    }),
    [
      diffSettings.renderSideBySide,
      diffSettings.ignoreTrimWhitespace,
      diffSettings.enableSplitViewResizing,
      diffSettings.wordWrap,
    ]
  );

  return (
    <div className="diff-checker-container">
      {/* 1. Reusable Workspace Tab Bar */}
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId={activeSession.id}
        onSelectTab={setActiveSession}
        onCloseTab={handleDeleteSession}
        onNewTab={() => createSession()}
        onRenameTab={(id, newName) => renameSession(id, newName)}
        onReorderTabs={(_activeId, _overId, oldIndex, newIndex) =>
          reorderSessions(oldIndex, newIndex)
        }
        onDuplicateTab={(id) => duplicateSession(id)}
        onCloseOthers={(id) => closeOtherSessions(id)}
        onCloseToRight={(id) => closeSessionsToRight(id)}
        onCloseAll={() => closeAllSessions()}
        onCopyContent={handleCopyTabContent}
        onCopyName={handleCopyTabName}
        newTabTooltip="New Diff Session"
        closeTabTooltip="Close Tab"
        rightContent={
          <>
            {/* Cluster 1: Transforms (Language, Format, Swap) */}
            <DropdownMenu open={langDropdownOpen} onOpenChange={setLangDropdownOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "toolbar-btn",
                    isAutoDetectActive && "text-accent font-medium"
                  )}
                >
                  {isAutoDetectActive ? (
                    <ScanSearch className="h-3.5 w-3.5 text-accent" />
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
              <DropdownMenuContent align="end" className="w-56 diff-lang-dropdown custom-scrollbar">
                <DropdownMenuLabel>Detection</DropdownMenuLabel>
                <DropdownMenuCheckboxItem
                  checked={isAutoDetectActive}
                  onCheckedChange={() => {
                    const det = detectLanguageFromInputs(localOriginal, localModified);
                    updateSessionLanguage(activeSession.id, det.language, true);
                    setLangDropdownOpen(false);
                  }}
                >
                  <span className="flex-1">Auto-Detect</span>
                  {detection.confidence > 0 && (
                    <span className="text-[10px] text-text-3 font-mono opacity-70 ml-2">
                      ({detection.label})
                    </span>
                  )}
                </DropdownMenuCheckboxItem>

                <DropdownMenuSeparator />
                <DropdownMenuLabel>Syntax Language</DropdownMenuLabel>

                {DIFF_LANGUAGES.map((lang) => {
                  const isChecked = !isAutoDetectActive && activeSession.language === lang.id;
                  return (
                    <DropdownMenuCheckboxItem
                      key={lang.id}
                      checked={isChecked}
                      className={cn(isChecked && "text-text-1 font-medium")}
                      onCheckedChange={() => {
                        updateSessionLanguage(activeSession.id, lang.id, false);
                        setLangDropdownOpen(false);
                      }}
                    >
                      <span className="flex-1">{lang.label}</span>
                      {lang.extensions?.[0] && (
                        <span className="text-[10px] text-text-3 font-mono opacity-50 ml-2">
                          {lang.extensions[0]}
                        </span>
                      )}
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <ActionTooltip content="Auto-format both inputs (⌘S / Shift+Alt+F)">
              <button
                type="button"
                className="toolbar-btn"
                onClick={handleFormatBoth}
                disabled={isFormatting}
              >
                {isFormatting ? (
                  <InTabLoader size="xs" />
                ) : (
                  <AlignLeft className="h-3.5 w-3.5 text-accent" />
                )}
                <span>Format</span>
              </button>
            </ActionTooltip>

            <ActionTooltip content="Swap original ↔ modified">
              <button type="button" className="toolbar-btn" onClick={handleSwap}>
                <ArrowLeftRight className="h-3.5 w-3.5" />
                <span>Swap</span>
              </button>
            </ActionTooltip>

            <div className="tabs-toolbar-sep" />

            {/* Cluster 2: View Modes (Split / Inline & Options) */}
            <ActionTooltip content={diffSettings.renderSideBySide ? "Switch to inline view" : "Switch to side-by-side"}>
              <button
                type="button"
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

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="toolbar-btn">
                  <Settings2 className="h-3.5 w-3.5" />
                  <span>Options</span>
                  <ChevronDown className="h-3 w-3 opacity-50" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
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

            {/* Cluster 3: Danger / Reset */}
            <ActionTooltip content="Clear inputs">
              <button
                type="button"
                className="toolbar-btn toolbar-btn-danger"
                onClick={handleClearAll}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear</span>
              </button>
            </ActionTooltip>
          </>
        }
      />

      {/* 2. Consolidated 30px Sub-Header (Pane Headers + Diff Status) */}
      <div className="diff-sub-header">
        {diffSettings.renderSideBySide ? (
          <>
            {/* Original Pane Header (Left 50%) */}
            <div className="diff-sub-pane diff-sub-pane-original">
              <div className="diff-pane-left">
                <span className="diff-pane-tag diff-pane-tag-orig">Original</span>
                {origLineCount > 0 && (
                  <span className="diff-pane-count">{origLineCount} lines</span>
                )}
              </div>
              <div className="diff-pane-right">
                <ActionTooltip content="Copy original content">
                  <button
                    type="button"
                    className="diff-pane-action-btn"
                    onClick={handleCopyOriginal}
                    disabled={!localOriginal}
                  >
                    {copiedOrig ? <Check className="h-3 w-3 text-green" /> : <Copy className="h-3 w-3" />}
                  </button>
                </ActionTooltip>
              </div>
            </div>

            {/* Modified Pane Header (Right 50%) */}
            <div className="diff-sub-pane">
              <div className="diff-pane-left">
                <span className="diff-pane-tag diff-pane-tag-mod">Modified</span>
                {modLineCount > 0 && (
                  <span className="diff-pane-count">{modLineCount} lines</span>
                )}

                {/* Diff Stats Badges */}
                <div className="flex items-center gap-1.5 ml-2">
                  <span className="diff-stat-pill diff-stat-pill-add" title={`${diffStats.additions} additions`}>
                    <Plus className="h-2.5 w-2.5" />
                    {diffStats.additions}
                  </span>
                  <span className="diff-stat-pill diff-stat-pill-del" title={`${diffStats.deletions} deletions`}>
                    <Minus className="h-2.5 w-2.5" />
                    {diffStats.deletions}
                  </span>
                  {diffStats.unchanged > 0 && (
                    <span className="diff-stat-pill-eq" title={`${diffStats.unchanged} unchanged lines`}>
                      {diffStats.unchanged} unchanged
                    </span>
                  )}
                </div>
              </div>

              <div className="diff-pane-right">
                {/* Stepper Controls */}
                {diffStats.totalDiffs > 0 && (
                  <div className="flex items-center gap-1 mr-1">
                    <ActionTooltip content="Previous change (Shift+F7)">
                      <button
                        type="button"
                        className="diff-nav-btn"
                        onClick={handlePrevDiff}
                      >
                        <ChevronUp className="h-3 w-3" />
                      </button>
                    </ActionTooltip>
                    <span className="diff-nav-counter">
                      {currentDiffIndex > 0
                        ? `${currentDiffIndex}/${diffStats.totalDiffs}`
                        : `${diffStats.totalDiffs} diffs`}
                    </span>
                    <ActionTooltip content="Next change (F7)">
                      <button
                        type="button"
                        className="diff-nav-btn"
                        onClick={handleNextDiff}
                      >
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </ActionTooltip>
                  </div>
                )}

                <ActionTooltip content="Copy modified content">
                  <button
                    type="button"
                    className="diff-pane-action-btn"
                    onClick={handleCopyModified}
                    disabled={!localModified}
                  >
                    {copiedMod ? <Check className="h-3 w-3 text-green" /> : <Copy className="h-3 w-3" />}
                  </button>
                </ActionTooltip>
              </div>
            </div>
          </>
        ) : (
          /* Inline View Sub-Header */
          <div className="diff-sub-pane diff-sub-pane-inline">
            <div className="diff-pane-left">
              <span className="diff-pane-tag diff-pane-tag-inline">Inline Diff</span>
              <span className="diff-pane-count">
                {origLineCount} orig · {modLineCount} mod
              </span>
              <div className="flex items-center gap-1.5 ml-3">
                <span className="diff-stat-pill diff-stat-pill-add" title={`${diffStats.additions} additions`}>
                  <Plus className="h-2.5 w-2.5" />
                  {diffStats.additions}
                </span>
                <span className="diff-stat-pill diff-stat-pill-del" title={`${diffStats.deletions} deletions`}>
                  <Minus className="h-2.5 w-2.5" />
                  {diffStats.deletions}
                </span>
                {diffStats.unchanged > 0 && (
                  <span className="diff-stat-pill-eq" title={`${diffStats.unchanged} unchanged lines`}>
                    {diffStats.unchanged} unchanged
                  </span>
                )}
              </div>
            </div>
            <div className="diff-pane-right">
              {diffStats.totalDiffs > 0 && (
                <div className="flex items-center gap-1">
                  <ActionTooltip content="Previous change (Shift+F7)">
                    <button
                      type="button"
                      className="diff-nav-btn"
                      onClick={handlePrevDiff}
                    >
                      <ChevronUp className="h-3 w-3" />
                    </button>
                  </ActionTooltip>
                  <span className="diff-nav-counter">
                    {currentDiffIndex > 0
                      ? `${currentDiffIndex}/${diffStats.totalDiffs}`
                      : `${diffStats.totalDiffs} diffs`}
                  </span>
                  <ActionTooltip content="Next change (F7)">
                    <button
                      type="button"
                      className="diff-nav-btn"
                      onClick={handleNextDiff}
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </ActionTooltip>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 3. Direct Monaco Diff Editor */}
      <div className="diff-editor-container" ref={containerRef}>
        <DiffEditor
          key={activeSession.id}
          height="100%"
          language={activeSession.language}
          original={activeSession.original}
          modified={activeSession.modified}
          onMount={handleDiffEditorMount}
          theme={currentThemeSetting === "light" ? "intab-light" : "intab-dark"}
          options={diffEditorOptions}
          loading={<EditorLoadingFallback message="Loading diff editor..." />}
        />
      </div>
    </div>
  );
}
