// ============================================================
// Compiler Page — Main IDE view
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { Code2, TerminalSquare } from "lucide-react";
import { CodeEditor } from "@/features/editor/CodeEditor";
import { EditorTabs } from "@/features/editor/EditorTabs";
import { OutputPanel } from "@/features/output/OutputPanel";
import { HtmlPreview } from "@/features/preview/HtmlPreview";
import { useResizable } from "@/hooks/useResizable";
import { useAppStore } from "@/stores/app.store";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { useFileDrop } from "@/hooks/useFileDrop";
import { DropOverlay } from "@/hooks/DropOverlay";
import { importTextFiles, languageFromFilename, baseFileName } from "@/lib/file-import";
import { formatDuration } from "@/lib/utils";

/** Live execution timer for the ACTIVE tab's run */
function useExecutionTimer() {
  const activeFileId = useAppStore((s) => s.activeFileId);
  const activeExec = useAppStore((s) => (s.activeFileId ? s.tabExec[s.activeFileId] : undefined));
  const isRunning = Boolean(activeExec?.isRunning);
  const executionStartTime = activeExec?.executionStartTime ?? null;
  const [now, setNow] = useState(() => 0);

  useEffect(() => {
    if (!isRunning || !executionStartTime) return;

    const interval = setInterval(() => {
      setNow(Date.now());
    }, 50);

    return () => clearInterval(interval);
  }, [isRunning, executionStartTime]);

  const elapsed = isRunning && executionStartTime ? Math.max(0, now - executionStartTime) : 0;
  return { isRunning, elapsed, activeFileId, activeExec };
}

export function CompilerPage() {
  const activeFileId = useAppStore((s) => s.activeFileId);
  const files = useAppStore((s) => s.files);
  const outputPanelOpen = useAppStore((s) => s.outputPanelOpen);
  const anyRunning = useAppStore((s) => s.isRunning);

  const { isRunning, elapsed, activeExec } = useExecutionTimer();

  const {
    size: editorSize,
    containerRef,
    handleMouseDown,
  } = useResizable({
    direction: "horizontal",
    initialSize: 65,
    minSize: 30,
    maxSize: 85,
    storageKey: "intab-editor-size",
  });

  const activeFile = files.find((f) => f.id === activeFileId);
  const isHtml = activeFile?.language === "html";

  // ── Mobile pane toggle (≤760px) ──────────────────────────
  // Below 760px the CSS stacks editor/output into a single column
  // and hides the inactive pane; this toggle chooses which one is
  // visible. On desktop the class is inert (see styles/responsive.css).
  const [mobilePane, setMobilePane] = useState<"editor" | "output">("editor");
  const mobilePaneClass =
    mobilePane === "output" ? " mobile-pane-output" : " mobile-pane-editor";

  const createFile = useAppStore((s) => s.createFile);
  const addToast = useAppStore((s) => s.addToast);

  // ── File drop → new editor tabs ─────────────────────────
  // Supported extensions (.js .ts .py .html .sql .lua …) become new
  // tabs; unsupported files show a clear rejection toast.

  const handleDropFiles = useCallback(
    async (incoming: File[]) => {
      const { imported, rejected } = await importTextFiles(incoming);
      rejected.forEach(({ name, reason }) =>
        addToast({ message: `${name}: ${reason}`, type: "error", duration: 3500 })
      );

      for (const file of imported) {
        const language = languageFromFilename(file.name);
        if (!language) {
          addToast({
            message: `${file.name}: unsupported in the editor (js, ts, py, html, sql, lua only)`,
            type: "error",
            duration: 3500,
          });
          continue;
        }
        createFile(baseFileName(file.name) || file.name, language as Parameters<typeof createFile>[1], file.text);
        addToast({ message: `Opened ${file.name}`, type: "success", duration: 2000 });
      }
    },
    [createFile, addToast]
  );

  const { isOver, dropHandlers } = useFileDrop(handleDropFiles);

  // Last result of the ACTIVE tab's own console
  const activeResults = activeExec?.executionResults ?? [];
  const lastResult = activeResults.length > 0 ? activeResults[activeResults.length - 1] : null;

  return (
    <div className="compiler-view" {...dropHandlers}>
      <DropOverlay show={isOver} label="Drop a code file to open it as a tab" />
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Main content area — horizontal split */}
        <div
          className={`app-main${mobilePaneClass}`}
          ref={containerRef}
          style={{
            display: "grid",
            gridTemplateColumns: (outputPanelOpen || isHtml)
              ? `${editorSize}% 6px 1fr`
              : "1fr",
          }}
        >
          {/* Editor section */}
          <div className="app-editor-section" style={{ minWidth: 0 }}>
            <EditorTabs />
            <div className="app-editor-content">
              <div className="editor-full">
                <CodeEditor />
              </div>
            </div>
          </div>

          {/* Mobile pane switch — sits between the two sections; CSS
              renders it as a slim bar above the status bar on phones.
              Only rendered when an output pane exists to switch to. */}
          {(outputPanelOpen || isHtml) && (
          <div className="compiler-mobile-toggle-bar">
            <div className="compiler-mobile-toggle" role="tablist" aria-label="Editor or output pane">
              <button
                type="button"
                role="tab"
                aria-selected={mobilePane === "editor"}
                className={mobilePane === "editor" ? "active" : ""}
                onClick={() => setMobilePane("editor")}
              >
                <Code2 className="h-3.5 w-3.5" />
                Editor
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mobilePane === "output"}
                className={mobilePane === "output" ? "active" : ""}
                onClick={() => setMobilePane("output")}
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                Output
              </button>
            </div>
          </div>
          )}

          {/* Resize handle */}
          {(outputPanelOpen || isHtml) && (
            <div
              className="resize-handle resize-handle-horizontal"
              onMouseDown={handleMouseDown}
            >
              <div className="resize-handle-indicator" />
            </div>
          )}

          {/* Right panel — HTML Preview or Console */}
          {isHtml ? (
            <div className="app-output-section" style={{ minWidth: 0 }}>
              <HtmlPreview />
            </div>
          ) : (
            outputPanelOpen && (
              <div className="app-output-section" style={{ minWidth: 0 }}>
                <OutputPanel />
              </div>
            )
          )}
        </div>

        {/* Status bar */}
        <div className="status-bar">
          <div className="status-left">
            <span className="status-item status-brand">InTab</span>
            {activeFile && (
              <>
                <span className="status-dot">·</span>
                <span className="status-item">{activeFile.language.toUpperCase()}</span>
                <span className="status-dot">·</span>
                <span className="status-item">
                  Ln {activeFile.content.split("\n").length}
                </span>
                <span className="status-dot">·</span>
                <span className={`status-item status-save ${activeFile.isDirty ? "status-unsaved" : "status-saved"}`}>
                  {activeFile.isDirty ? "Unsaved" : "Saved"}
                </span>
              </>
            )}
          </div>
          <div className="status-right">
            {isRunning && (
              <>
                <span className="status-item status-timer">
                  <span className="status-timer-dot" />
                  {formatDuration(elapsed)}
                </span>
                <span className="status-dot">·</span>
              </>
            )}
            {!isRunning && anyRunning && (
              <>
                <span className="status-item status-timer" title="Another tab is running — switch to it to see its console">
                  <span className="status-timer-dot" />
                  Background run
                </span>
                <span className="status-dot">·</span>
              </>
            )}
            {!isRunning && lastResult && (
              <>
                <span className={`status-item ${lastResult.exitCode === 0 ? "status-last-success" : "status-last-error"}`}>
                  {lastResult.exitCode === 0 ? "✓" : "✗"} {formatDuration(lastResult.duration)}
                </span>
                <span className="status-dot">·</span>
              </>
            )}
            {isRunning ? (
              <span className="status-item status-shortcut" style={{ color: "var(--red)" }}>⌘⇧C Stop</span>
            ) : (
              <span className="status-item status-shortcut">⌘↵ Run</span>
            )}
            <span className="status-dot">·</span>
            <span className="status-item status-shortcut">⌘S Format</span>
            <span className="status-dot">·</span>
            <span className="status-item status-shortcut">⌘K Commands</span>
          </div>
        </div>
      </div>
    </div>
  );
}
