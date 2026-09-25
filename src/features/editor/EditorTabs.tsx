// ============================================================
// Editor Tabs — File tabs with new-file dropdown & run controls
// ============================================================
// Each tab owns its own console: runs, output, and history are
// tracked per file (tabExec) instead of a single shared console.

import { useState, useRef, useMemo } from "react";
import { Plus, Terminal, Play, Square, Eye, Copy, Check } from "lucide-react";
import { WorkspaceTabBar, type TabItem } from "@/components/ui/WorkspaceTabBar";
import { useAppStore } from "@/stores/app.store";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LANGUAGE_CONFIGS } from "@/config";
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

  // Per-tab execution — each tab runs against its own console
  const runFile = useAppStore((s) => s.runFile);
  const cancelRun = useAppStore((s) => s.cancelRun);
  const tabExec = useAppStore((s) => s.tabExec);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const outputPanelOpen = useAppStore((s) => s.outputPanelOpen);

  const [isCopied, setIsCopied] = useState(false);

  const activeFile = files.find((f) => f.id === activeFileId);
  const isHtml = activeFile?.language === "html";
  const activeExec = activeFileId ? tabExec[activeFileId] : undefined;
  const isActiveRunning = Boolean(activeExec?.isRunning);

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

  // ── Run / Cancel (delegated to store — per-tab console) ────
  const handleRun = () => {
    if (!activeFileId || isActiveRunning || isHtml) return;
    void runFile(activeFileId);
  };

  const handleCancel = () => {
    if (!activeFileId || !isActiveRunning) return;
    void cancelRun(activeFileId);
  };

  const handleCopy = () => {
    if (!activeFile) return;

    navigator.clipboard.writeText(activeFile.content);
    setIsCopied(true);
    addCopyToast();

    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  };

  const addCopyToast = () => {
    useAppStore.getState().addToast({ message: "Content copied to clipboard", type: "success", duration: 2000 });
  };

  // Map files to standardized TabItems — tabs running in the
  // background get a pulsing dot so users don't lose track of them
  const tabs: TabItem[] = useMemo(
    () =>
      files.map((file) => ({
        id: file.id,
        name: file.name,
        icon: <LanguageIcon language={file.language} size="sm" />,
        isDirty: file.isDirty,
        isRunning: Boolean(tabExec[file.id]?.isRunning),
        closable: files.length > 1,
      })),
    [files, tabExec]
  );

  const handleCopyTabContent = (id: string) => {
    const file = files.find((f) => f.id === id);
    if (file) {
      navigator.clipboard.writeText(file.content);
      useAppStore.getState().addToast({ message: `Copied ${file.name} content to clipboard`, type: "success", duration: 2000 });
    }
  };

  const handleCopyTabName = (id: string) => {
    const file = files.find((f) => f.id === id);
    if (file) {
      navigator.clipboard.writeText(file.name);
      useAppStore.getState().addToast({ message: "File name copied", type: "info", duration: 1500 });
    }
  };

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
                    <Check className="h-3.5 w-3.5 text-[var(--green)]" />
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
            ) : isActiveRunning ? (
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
                    disabled={!activeFile}
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
