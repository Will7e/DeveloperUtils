// ============================================================
// Keyboard Shortcuts Hook
// ============================================================

import { useEffect, useCallback } from "react";
import { useAppStore } from "@/stores/app.store";
import { compilerService } from "@/services/compiler.service";
import { formatCode, supportsFormatting } from "@/services/formatter.service";
import { formatDuration } from "@/lib/utils";
import { playSound } from "@/lib/sounds";

export function useKeyboardShortcuts() {
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const isRunning = useAppStore((s) => s.isRunning);
  const setIsRunning = useAppStore((s) => s.setIsRunning);
  const clearOutput = useAppStore((s) => s.clearOutput);
  const addOutputEntry = useAppStore((s) => s.addOutputEntry);
  const updateFileContent = useAppStore((s) => s.updateFileContent);
  const addExecutionResult = useAppStore((s) => s.addExecutionResult);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);
  const setExecutionStartTime = useAppStore((s) => s.setExecutionStartTime);
  const setOutputFlash = useAppStore((s) => s.setOutputFlash);
  const addToast = useAppStore((s) => s.addToast);
  const outputPanelOpen = useAppStore((s) => s.outputPanelOpen);
  const soundEffects = useAppStore((s) => s.editorSettings.soundEffects);
  const executionTimeout = useAppStore((s) => s.editorSettings.executionTimeout);
  const cancelExecution = useAppStore((s) => s.cancelExecution);

  const activeFile = files.find((f) => f.id === activeFileId);

  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Ctrl/Cmd + K = Command Palette
      if (mod && e.key === "k") {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }

      // Ctrl/Cmd + Shift + C = Cancel execution
      if (mod && e.shiftKey && e.key === "c") {
        e.preventDefault();
        if (isRunning) {
          await compilerService.cancel();
          cancelExecution();
          addOutputEntry({
            type: "error",
            content: "⛔ Execution cancelled by user",
          });
          setOutputFlash("error");
          if (soundEffects) playSound("error");
          addToast({ message: "Execution cancelled", type: "error", duration: 2000 });
        }
        return;
      }

      // Ctrl/Cmd + Enter = Run
      if (mod && e.key === "Enter") {
        e.preventDefault();
        if (!activeFile || isRunning || activeFile.language === "html") return;

        // Ensure output panel is visible
        if (!outputPanelOpen) {
          toggleOutputPanel();
        }

        setIsRunning(true);
        setExecutionStartTime(Date.now());
        clearOutput();
        if (soundEffects) playSound("run");
        addOutputEntry({ type: "info", content: `Running ${activeFile.name}...` });
        addToast({ message: `Running ${activeFile.name}...`, type: "info", duration: 2000 });

        try {
          if (activeFile.language === "python") {
            const ready = await compilerService.isReady("python");
            if (!ready) {
              addOutputEntry({
                type: "info",
                content: "Loading Python runtime...",
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
          if (result.stdout) addOutputEntry({ type: "stdout", content: result.stdout });
          if (result.stderr) addOutputEntry({ type: "stderr", content: result.stderr });

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
      }

      // Ctrl/Cmd + S = Format & Save
      if (mod && e.key === "s") {
        e.preventDefault();
        if (!activeFile) return;

        if (supportsFormatting(activeFile.language)) {
          try {
            const formatted = await formatCode(activeFile.content, activeFile.language);
            updateFileContent(activeFile.id, formatted);
            addToast({ message: "Formatted & saved", type: "success", duration: 1500 });
          } catch {
            addToast({ message: "Saved (formatting not available)", type: "info", duration: 1500 });
          }
        } else {
          addToast({ message: "Saved", type: "info", duration: 1500 });
        }
        return;
      }

      // Ctrl/Cmd + J = Toggle output panel
      if (mod && e.key === "j") {
        e.preventDefault();
        toggleOutputPanel();
      }

      // Ctrl/Cmd + , = Settings
      if (mod && e.key === ",") {
        e.preventDefault();
        toggleSettings();
      }
    },
    [activeFile, isRunning, outputPanelOpen, soundEffects, executionTimeout, setIsRunning, clearOutput, addOutputEntry, addExecutionResult, toggleOutputPanel, toggleSettings, toggleCommandPalette, setExecutionStartTime, setOutputFlash, addToast, cancelExecution, updateFileContent]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
