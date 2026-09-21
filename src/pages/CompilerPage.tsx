// ============================================================
// Compiler Page — Main IDE view
// ============================================================

import { useState, useEffect } from "react";
import { CodeEditor } from "@/features/editor/CodeEditor";
import { EditorTabs } from "@/features/editor/EditorTabs";
import { OutputPanel } from "@/features/output/OutputPanel";
import { HtmlPreview } from "@/features/preview/HtmlPreview";
import { useResizable } from "@/hooks/useResizable";
import { useAppStore } from "@/stores/app.store";
import { Sidebar } from "@/features/sidebar/Sidebar";
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

  // Last result of the ACTIVE tab's own console
  const activeResults = activeExec?.executionResults ?? [];
  const lastResult = activeResults.length > 0 ? activeResults[activeResults.length - 1] : null;

  return (
    <div className="compiler-view">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Main content area — horizontal split */}
        <div
          className="app-main"
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
