// ============================================================
// Toolbar — Minimal top bar: brand, run, console toggle, settings
// ============================================================

import { useCallback } from "react";
import { Play, Square, Settings, Terminal, Zap, Eye } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import { compilerService } from "@/services/compiler.service";
import { LANGUAGE_CONFIGS } from "@/config";
import { formatDuration } from "@/lib/utils";
import { playSound } from "@/lib/sounds";

export function Toolbar() {
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const isRunning = useAppStore((s) => s.isRunning);
  const setIsRunning = useAppStore((s) => s.setIsRunning);
  const addOutputEntry = useAppStore((s) => s.addOutputEntry);
  const addExecutionResult = useAppStore((s) => s.addExecutionResult);
  const clearOutput = useAppStore((s) => s.clearOutput);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const outputPanelOpen = useAppStore((s) => s.outputPanelOpen);
  const setExecutionStartTime = useAppStore((s) => s.setExecutionStartTime);
  const setOutputFlash = useAppStore((s) => s.setOutputFlash);
  const addToast = useAppStore((s) => s.addToast);
  const soundEffects = useAppStore((s) => s.editorSettings.soundEffects);

  const activeFile = files.find((f) => f.id === activeFileId);

  const handleRun = useCallback(async () => {
    if (!activeFile || isRunning) return;

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

      const result = await compilerService.execute(
        activeFile.content,
        activeFile.language
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
  ]);

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        {/* Brand */}
        <div className="brand">
          <Zap className="brand-icon-svg" />
          <span className="brand-text">DevUtils</span>
          <span className="brand-cursor" />
        </div>

        {activeFile && (
          <>
            <div className="toolbar-sep" />
            <div className="lang-indicator">
              <span className={`lang-indicator-dot lang-dot-${activeFile.language}`} />
              <span>{LANGUAGE_CONFIGS[activeFile.language].label}</span>
            </div>
          </>
        )}
      </div>

      <div className="toolbar-right">
        {/* Run / Preview */}
        {activeFile?.language === "html" ? (
          <div className="preview-indicator">
            <Eye style={{ width: 14, height: 14 }} />
            <span>Preview</span>
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="run-btn"
                onClick={handleRun}
                disabled={isRunning || !activeFile}
              >
                {isRunning ? (
                  <>
                    <Square style={{ fill: "currentColor" }} />
                    <span>Running…</span>
                  </>
                ) : (
                  <>
                    <Play style={{ fill: "currentColor" }} />
                    <span>Run</span>
                  </>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>Run Code <kbd>⌘↵</kbd></TooltipContent>
          </Tooltip>
        )}

        <div className="toolbar-sep" />

        {/* Console toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="toolbar-icon-btn"
              onClick={toggleOutputPanel}
              style={{ color: outputPanelOpen ? "#818cf8" : undefined }}
            >
              <Terminal />
            </button>
          </TooltipTrigger>
          <TooltipContent>Console <kbd>⌘J</kbd></TooltipContent>
        </Tooltip>

        {/* Settings */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="toolbar-icon-btn" onClick={toggleSettings}>
              <Settings />
            </button>
          </TooltipTrigger>
          <TooltipContent>Settings <kbd>⌘,</kbd></TooltipContent>
        </Tooltip>
      </div>

      {/* Progress bar */}
      {isRunning && <div className="execution-progress-bar" />}
    </div>
  );
}
