// ============================================================
// Editor Tabs — File tabs with new-file dropdown & run controls
// ============================================================

import { useState, useRef, useCallback, useMemo } from "react";
import { Plus, Terminal, Play, Square, Eye, Copy, Check } from "lucide-react";
import { WorkspaceTabBar, type TabItem } from "@/components/ui/WorkspaceTabBar";
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
import { LanguageIcon } from "./language-icon";
import { NewFileMenu } from "./NewFileMenu";
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

/** Languages whose runtime must be initialized before first run */
const RUNTIME_LANGUAGES: Language[] = ["python", "typescript", "sql", "lua"];

const RUNTIME_LABELS: Partial<Record<Language, string>> = {
  python: "Loading Python runtime (Pyodide)...",
  typescript: "Loading TypeScript compiler...",
  sql: "Loading SQLite runtime (WASM)...",
  lua: "Loading Lua runtime (WASM)...",
};

export function EditorTabs() {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const setActiveFile = useAppStore((s) => s.setActiveFile);
  const deleteFile = useAppStore((s) => s.deleteFile);
  const duplicateFile = useAppStore((s) => s.duplicateFile);
  const closeOtherFiles = useAppStore((s) => s.closeOtherFiles);
  const closeFilesToRight = useAppStore((s) => s.closeFilesToRight);
  const closeAllFiles = useAppStore((s) => s.closeAllFiles);
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
  const executionTimeout = useAppStore((s) => s.editorSettings.executionTimeout);
  const cancelExecution = useAppStore((s) => s.cancelExecution);

  const [isCopied, setIsCopied] = useState(false);

  const activeFile = files.find((f) => f.id === activeFileId);
  const isHtml = activeFile?.language === "html";
  const canRun = activeFile && !isHtml;

  const handleToggleMenu = () => {
    if (!showMenu && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 6, left: rect.left });
    }
    setShowMenu(!showMenu);
  };

  const handleCreate = (lang: Language) => {
    const config = LANGUAGE_CONFIGS[lang];
    createFile(`untitled${config.extension}`, lang);
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

    addOutputEntry({
      type: "info",
      content: `Running ${activeFile.name}...`,
    });

    addToast({ message: `Running ${activeFile.name}...`, type: "info", duration: 2000 });

    try {
      // Initialize the WASM / compiler runtime on first use
      if (RUNTIME_LANGUAGES.includes(activeFile.language)) {
        const ready = await compilerService.isReady(activeFile.language);
        if (!ready) {
          addOutputEntry({
            type: "info",
            content: RUNTIME_LABELS[activeFile.language] ?? "Loading runtime...",
          });
          await compilerService.initialize(activeFile.language);
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

    } catch (error) {
      addOutputEntry({
        type: "error",
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
      setOutputFlash("error");
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

    addToast({ message: "Execution cancelled", type: "error", duration: 2000 });
  }, [isRunning, cancelExecution, addOutputEntry, setOutputFlash, addToast]);

  // Map files to standardized TabItems
  const tabs: TabItem[] = useMemo(
    () =>
      files.map((file) => ({
        id: file.id,
        name: file.name,
        icon: <LanguageIcon language={file.language} size="sm" />,
        isDirty: file.isDirty,
        closable: files.length > 1,
      })),
    [files]
  );

  const handleCopyTabContent = useCallback(
    (id: string) => {
      const file = files.find((f) => f.id === id);
      if (file) {
        navigator.clipboard.writeText(file.content);
        addToast({ message: `Copied ${file.name} content to clipboard`, type: "success", duration: 2000 });
      }
    },
    [files, addToast]
  );

  const handleCopyTabName = useCallback(
    (id: string) => {
      const file = files.find((f) => f.id === id);
      if (file) {
        navigator.clipboard.writeText(file.name);
        addToast({ message: "File name copied", type: "info", duration: 1500 });
      }
    },
    [files, addToast]
  );

  return (
    <>
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId={activeFileId || (files[0]?.id ?? "")}
        onSelectTab={setActiveFile}
        onCloseTab={deleteFile}
        onRenameTab={(id, newName) => renameFile(id, newName)}
        onReorderTabs={(_activeId, _overId, oldIndex, newIndex) =>
          reorderFiles(oldIndex, newIndex)
        }
        onDuplicateTab={duplicateFile}
        onCloseOthers={closeOtherFiles}
        onCloseToRight={closeFilesToRight}
        onCloseAll={closeAllFiles}
        onCopyContent={handleCopyTabContent}
        onCopyName={handleCopyTabName}
        renderNewTabButton={() => (
          <ActionTooltip content="New File" side="bottom">
            <button
              ref={btnRef}
              type="button"
              className="tab-new"
              onClick={handleToggleMenu}
            >
              <Plus className="h-4 w-4" />
            </button>
          </ActionTooltip>
        )}
        rightContent={
          <>
            <div className="tabs-toolbar-sep" />

            {/* Console toggle */}
            {!isHtml && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
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
                  type="button"
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
                    type="button"
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
                    type="button"
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
          </>
        }
      />

      {/* Shared language-picker popover (fixed-position to avoid overflow clipping) */}
      <NewFileMenu
        open={showMenu}
        anchor={menuPos}
        onClose={() => setShowMenu(false)}
        onCreate={handleCreate}
      />
    </>
  );
}
