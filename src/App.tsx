// ============================================================
// App — Root application component
// ============================================================

import { useState, useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toolbar } from "@/features/toolbar/Toolbar";
import { CodeEditor } from "@/features/editor/CodeEditor";
import { EditorTabs } from "@/features/editor/EditorTabs";
import { OutputPanel } from "@/features/output/OutputPanel";
import { HtmlPreview } from "@/features/preview/HtmlPreview";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { CommandPalette } from "@/features/command-palette/CommandPalette";
import { ToastContainer } from "@/features/toast/ToastContainer";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useResizable } from "@/hooks/useResizable";
import { useAppStore } from "@/stores/app.store";
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

function App() {
  useKeyboardShortcuts();

  const activeFileId = useAppStore((s) => s.activeFileId);
  const files = useAppStore((s) => s.files);
  const outputPanelOpen = useAppStore((s) => s.outputPanelOpen);
  const executionResults = useAppStore((s) => s.executionResults);

  const { isRunning, elapsed } = useExecutionTimer();

  // Always call the hook (React rules of hooks — never conditional)
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

  // Last execution for status bar
  const lastResult = executionResults.length > 0 ? executionResults[executionResults.length - 1] : null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="app-root">
        {/* Top toolbar */}
        <Toolbar />

        {/* Main content area — horizontal split */}
        <div className="app-main" ref={resizable.containerRef}>
          {/* Editor section */}
          <div
            className="app-editor-section"
            style={{ 
              flex: (outputPanelOpen || isHtml) ? `0 0 ${editorSize}%` : "1 1 0%",
              minWidth: 0,
              overflow: "hidden"
            }}
          >
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
            <div
              className="app-output-section"
              style={{ flex: 1, minWidth: 0, overflow: "hidden" }}
            >
              <HtmlPreview />
            </div>
          ) : (
            outputPanelOpen && (
              <div
                className="app-output-section"
                style={{ flex: 1, minWidth: 0, overflow: "hidden" }}
              >
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
                {/* Auto-save indicator */}
                <span className="status-dot">·</span>
                <span className={`status-item status-save ${activeFile.isDirty ? "status-unsaved" : "status-saved"}`}>
                  {activeFile.isDirty ? "Unsaved" : "Saved"}
                </span>
              </>
            )}
          </div>
          <div className="status-right">
            {/* Live execution timer */}
            {isRunning && (
              <>
                <span className="status-item status-timer">
                  <span className="status-timer-dot" />
                  {formatDuration(elapsed)}
                </span>
                <span className="status-dot">·</span>
              </>
            )}
            {/* Last run result */}
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
            <span className="status-dot">·</span>
            <span className="status-item status-shortcut">⌘J Console</span>
          </div>
        </div>

        {/* Overlays */}
        <SettingsPanel />
        <CommandPalette />
        <ToastContainer />
      </div>
    </TooltipProvider>
  );
}

export default App;
