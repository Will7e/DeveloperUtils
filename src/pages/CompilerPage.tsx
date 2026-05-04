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

/** Live execution timer hook */
function useExecutionTimer() {
  const isRunning = useAppStore((s) => s.isRunning);
  const executionStartTime = useAppStore((s) => s.executionStartTime);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRunning || !executionStartTime) {
      setElapsed(0);
      return;
    }

    const interval = setInterval(() => {
      setElapsed(Date.now() - executionStartTime);
    }, 50);

    return () => clearInterval(interval);
  }, [isRunning, executionStartTime]);

  return { isRunning, elapsed };
}

export function CompilerPage() {
  const activeFileId = useAppStore((s) => s.activeFileId);
  const files = useAppStore((s) => s.files);
  const outputPanelOpen = useAppStore((s) => s.outputPanelOpen);
  const executionResults = useAppStore((s) => s.executionResults);

  const { isRunning, elapsed } = useExecutionTimer();

  const resizable = useResizable({
    direction: "horizontal",
    initialSize: 65,
    minSize: 30,
    maxSize: 85,
    storageKey: "devutils-editor-size",
  });

  const activeFile = files.find((f) => f.id === activeFileId);
  const isHtml = activeFile?.language === "html";
  const editorSize = resizable.size;

  const lastResult = executionResults.length > 0 ? executionResults[executionResults.length - 1] : null;

  return (
    <div className="compiler-view">
      <Sidebar />
      
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Main content area — horizontal split */}
        <div 
          className="app-main" 
          ref={resizable.containerRef}
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
              onMouseDown={resizable.handleMouseDown}
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
            <span className="status-item status-brand">DevUtils</span>
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
