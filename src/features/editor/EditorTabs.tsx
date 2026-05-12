// ============================================================
// Editor Tabs — File tabs with new-file dropdown & run controls
// ============================================================

import { useState, useRef, useEffect, useCallback } from "react";
import { X, Plus, Terminal, Play, Square, Eye, Copy, Check } from "lucide-react";
import { DndContext, closestCenter, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { SortableTab } from "@/components/ui/SortableTab";
import { useAppStore } from "@/stores/app.store";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LANGUAGE_CONFIGS } from "@/config";
import { cn } from "@/lib/utils";
import { compilerService } from "@/services/compiler.service";
import { formatDuration } from "@/lib/utils";
import { playSound } from "@/lib/sounds";
import type { Language } from "@/types";

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

const tabIcons: Record<Language, string> = {
  javascript: "JS",
  typescript: "TS",
  python: "PY",
  html: "<>",
};

const langBadges: Record<Language, { cls: string; label: string }> = {
  javascript: { cls: "lang-badge-js", label: "JavaScript" },
  typescript: { cls: "lang-badge-ts", label: "TypeScript" },
  python: { cls: "lang-badge-py", label: "Python" },
  html: { cls: "lang-badge-html", label: "HTML" },
};

export function EditorTabs() {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const setActiveFile = useAppStore((s) => s.setActiveFile);
  const deleteFile = useAppStore((s) => s.deleteFile);
  const renameFile = useAppStore((s) => s.renameFile);
  const createFile = useAppStore((s) => s.createFile);
  const reorderFiles = useAppStore((s) => s.reorderFiles);

  // Run-related state
  const isRunning = useAppStore((s) => s.isRunning);
  const setIsRunning = useAppStore((s) => s.setIsRunning);
  const addOutputEntry = useAppStore((s) => s.addOutputEntry);
  const addExecutionResult = useAppStore((s) => s.addExecutionResult);
  const clearOutput = useAppStore((s) => s.clearOutput);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const outputPanelOpen = useAppStore((s) => s.outputPanelOpen);
  const setExecutionStartTime = useAppStore((s) => s.setExecutionStartTime);
  const setOutputFlash = useAppStore((s) => s.setOutputFlash);
  const addToast = useAppStore((s) => s.addToast);
  const soundEffects = useAppStore((s) => s.editorSettings.soundEffects);
  const executionTimeout = useAppStore((s) => s.editorSettings.executionTimeout);
  const cancelExecution = useAppStore((s) => s.cancelExecution);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isCopied, setIsCopied] = useState(false);

  const activeFile = files.find((f) => f.id === activeFileId);
  const isHtml = activeFile?.language === "html";
  const canRun = activeFile && !isHtml;

  // DnD sensor with activation constraint to allow clicks without triggering drag
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = files.findIndex((f) => f.id === active.id);
    const newIndex = files.findIndex((f) => f.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      reorderFiles(oldIndex, newIndex);
    }
  }, [files, reorderFiles]);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  const handleToggleMenu = () => {
    if (!showMenu && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 2, left: rect.left });
    }
    setShowMenu(!showMenu);
  };

  const handleCreate = (lang: Language) => {
    const config = LANGUAGE_CONFIGS[lang];
    createFile(`untitled${config.extension}`, lang);
    setShowMenu(false);
  };

  // ── Run Code ──────────────────────────────────────────────
  const handleRun = useCallback(async () => {
    if (!activeFile || isRunning || isHtml) return;

    // Ensure output panel is visible when running
    if (!outputPanelOpen) {
      toggleOutputPanel();
    }

    setIsRunning(true);
    setExecutionStartTime(Date.now());
    clearOutput();

    if (soundEffects) playSound("run");

    addOutputEntry({
      type: "info",
      content: `Running ${activeFile.name}...`,
    });

    addToast({ message: `Running ${activeFile.name}...`, type: "info", duration: 2000 });

    try {
      if (activeFile.language === "python") {
        const ready = await compilerService.isReady("python");
        if (!ready) {
          addOutputEntry({
            type: "info",
            content: "Loading Python runtime (Pyodide)...",
          });
          await compilerService.initialize("python");
        }
      }

      if (activeFile.language === "typescript") {
        const ready = await compilerService.isReady("typescript");
        if (!ready) {
          addOutputEntry({
            type: "info",
            content: "Loading TypeScript compiler...",
          });
          await compilerService.initialize("typescript");
        }
      }

      const result = await compilerService.execute(
        activeFile.content,
        activeFile.language,
        { timeout: executionTimeout }
      );

      addExecutionResult(result);

      if (result.stdout) {
        addOutputEntry({ type: "stdout", content: result.stdout });
      }
      if (result.stderr) {
        addOutputEntry({ type: "stderr", content: result.stderr });
      }

      const isSuccess = result.exitCode === 0;
      addOutputEntry({
        type: isSuccess ? "success" : "error",
        content: isSuccess
          ? `Completed in ${formatDuration(result.duration)}`
          : `Exit code ${result.exitCode} (${formatDuration(result.duration)})`,
      });

      setOutputFlash(isSuccess ? "success" : "error");
      if (soundEffects) playSound(isSuccess ? "success" : "error");

    } catch (error) {
      addOutputEntry({
        type: "error",
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
      setOutputFlash("error");
      if (soundEffects) playSound("error");
    } finally {
      setIsRunning(false);
      setExecutionStartTime(null);
    }
  }, [
    activeFile,
    isRunning,
    isHtml,
    outputPanelOpen,
    setIsRunning,
    clearOutput,
    addOutputEntry,
    addExecutionResult,
    toggleOutputPanel,
    setExecutionStartTime,
    setOutputFlash,
    addToast,
    soundEffects,
    executionTimeout,
  ]);

  const handleCopy = useCallback(() => {
    if (!activeFile) return;
    
    navigator.clipboard.writeText(activeFile.content);
    setIsCopied(true);
    addToast({ message: "Content copied to clipboard", type: "success", duration: 2000 });
    
    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  }, [activeFile, addToast]);

  // ── Cancel Execution ──────────────────────────────────────
  const handleCancel = useCallback(async () => {
    if (!isRunning) return;

    await compilerService.cancel();
    cancelExecution();

    addOutputEntry({
      type: "error",
      content: "⛔ Execution cancelled by user",
    });

    setOutputFlash("error");
    if (soundEffects) playSound("error");

    addToast({ message: "Execution cancelled", type: "error", duration: 2000 });
  }, [isRunning, cancelExecution, addOutputEntry, setOutputFlash, soundEffects, addToast]);

  return (
    <>
      <div className="tabs-bar">
        <div className="tabs-list">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={files.map((f) => f.id)} strategy={horizontalListSortingStrategy}>
              {files.map((file) => (
                <SortableTab key={file.id} id={file.id}>
                  <button
                    className={cn("tab", file.id === activeFileId && "tab-active")}
                    onClick={() => setActiveFile(file.id)}
                    onDoubleClick={() => {
                      setRenamingId(file.id);
                      setRenameValue(file.name);
                    }}
                  >
                    <span className={cn("tab-icon", `tab-icon-${file.language}`)}>
                      {tabIcons[file.language]}
                    </span>
                    {renamingId === file.id ? (
                      <input
                        autoFocus
                        className="tab-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => {
                          if (renameValue.trim() && renameValue !== file.name) {
                            renameFile(file.id, renameValue.trim());
                          }
                          setRenamingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            if (renameValue.trim() && renameValue !== file.name) {
                              renameFile(file.id, renameValue.trim());
                            }
                            setRenamingId(null);
                          } else if (e.key === "Escape") {
                            setRenamingId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <span className="tab-name">{file.name}</span>
                        {file.isDirty && <span className="tab-dirty" />}
                      </>
                    )}
                    {files.length > 1 && (
                      <ActionTooltip content="Close Tab" side="bottom">
                        <span
                          className="tab-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteFile(file.id);
                          }}
                        >
                          <X className="h-3 w-3" />
                        </span>
                      </ActionTooltip>
                    )}
                  </button>
                </SortableTab>
              ))}
            </SortableContext>
          </DndContext>

          <ActionTooltip content="New File" side="bottom">
            <button
              ref={btnRef}
              className="tab-new"
              onClick={handleToggleMenu}
            >
              <Plus className="h-4 w-4" />
            </button>
          </ActionTooltip>
        </div>

        {/* ── Premium Toolbar Actions ─────────────────────────── */}
        <div className="tabs-toolbar">
          <div className="tabs-toolbar-sep" />

          {/* Console toggle */}
          {!isHtml && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className={cn(
                      "console-toggle-btn",
                      outputPanelOpen && "console-toggle-btn-active"
                    )}
                    onClick={toggleOutputPanel}
                  >
                    <Terminal className="h-3.5 w-3.5" />
                    <span className="console-toggle-label">Console</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Toggle Console <kbd>⌘J</kbd></TooltipContent>
              </Tooltip>
              <div className="tabs-toolbar-sep" />
            </>
          )}

          {/* Copy button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  "toolbar-action-btn",
                  isCopied && "toolbar-action-btn-active"
                )}
                onClick={handleCopy}
                disabled={!activeFile}
              >
                {isCopied ? (
                  <Check className="h-3.5 w-3.5 text-green-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span className="toolbar-action-label">Copy</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isCopied ? "Copied!" : "Copy Code"}
            </TooltipContent>
          </Tooltip>

          <div className="tabs-toolbar-sep" />

          {/* Run / Stop / Preview button */}
          {isHtml ? (
            <div className="tabs-preview-badge">
              <Eye className="h-3.5 w-3.5" />
              <span>Preview</span>
            </div>
          ) : isRunning ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="tabs-run-btn tabs-run-btn-stop"
                  onClick={handleCancel}
                >
                  <Square className="h-3 w-3" style={{ fill: "currentColor" }} />
                  <span>Stop</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Cancel Execution <kbd>⌘⇧C</kbd></TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="tabs-run-btn"
                  onClick={handleRun}
                  disabled={!canRun}
                >
                  <Play className="h-3.5 w-3.5" style={{ fill: "currentColor" }} />
                  <span>Run</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Run Code <kbd>⌘↵</kbd></TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* New file dropdown — rendered as fixed-position portal to avoid overflow clipping */}
      {showMenu && (
        <>
          <div className="dropdown-backdrop" onClick={() => setShowMenu(false)} />
          <div
            ref={menuRef}
            className="new-file-dropdown"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {(Object.keys(LANGUAGE_CONFIGS) as Language[]).map((lang) => (
              <button
                key={lang}
                className="new-file-option"
                onClick={() => handleCreate(lang)}
              >
                <span className={cn("lang-badge", langBadges[lang].cls)}>
                  {tabIcons[lang]}
                </span>
                <span>{langBadges[lang].label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
