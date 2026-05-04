// ============================================================
// Keyboard Shortcuts Hook
// ============================================================

import { useEffect, useCallback } from "react";
import { useAppStore } from "@/stores/app.store";
import { compilerService } from "@/services/compiler.service";
import { formatDuration } from "@/lib/utils";

export function useKeyboardShortcuts() {
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const isRunning = useAppStore((s) => s.isRunning);
  const setIsRunning = useAppStore((s) => s.setIsRunning);
  const clearOutput = useAppStore((s) => s.clearOutput);
  const addOutputEntry = useAppStore((s) => s.addOutputEntry);
  const addExecutionResult = useAppStore((s) => s.addExecutionResult);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const toggleSettings = useAppStore((s) => s.toggleSettings);

  const activeFile = files.find((f) => f.id === activeFileId);

  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Ctrl/Cmd + Enter = Run
      if (mod && e.key === "Enter") {
        e.preventDefault();
        if (!activeFile || isRunning || activeFile.language === "html") return;

        setIsRunning(true);
        clearOutput();
        addOutputEntry({ type: "info", content: `⚡ Running ${activeFile.name}...` });

        try {
          if (activeFile.language === "python") {
            const ready = await compilerService.isReady("python");
            if (!ready) {
              addOutputEntry({
                type: "info",
                content: "🐍 Loading Python runtime...",
              });
              await compilerService.initialize("python");
            }
          }

          const result = await compilerService.execute(activeFile.content, activeFile.language);
          addExecutionResult(result);
          if (result.stdout) addOutputEntry({ type: "stdout", content: result.stdout });
          if (result.stderr) addOutputEntry({ type: "stderr", content: result.stderr });
          addOutputEntry({
            type: result.exitCode === 0 ? "success" : "error",
            content: result.exitCode === 0
              ? `✓ Finished in ${formatDuration(result.duration)}`
              : `✗ Failed (${formatDuration(result.duration)})`,
          });
        } catch (error) {
          addOutputEntry({
            type: "error",
            content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          });
        } finally {
          setIsRunning(false);
        }
      }

      // Ctrl/Cmd + B = Toggle sidebar
      if (mod && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }

      // Ctrl/Cmd + J = Toggle output
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
    [activeFile, isRunning, setIsRunning, clearOutput, addOutputEntry, addExecutionResult, toggleSidebar, toggleOutputPanel, toggleSettings]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
