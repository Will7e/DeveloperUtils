// ============================================================
// Keyboard Shortcuts Hook
// ============================================================

import { useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/app.store";
import { useApiTesterStore } from "@/stores/api-tester.store";
import { compilerService } from "@/services/compiler.service";
import { formatCode, supportsFormatting } from "@/services/formatter.service";
import { formatDuration } from "@/lib/utils";

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
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
  const executionTimeout = useAppStore((s) => s.editorSettings.executionTimeout);
  const cancelExecution = useAppStore((s) => s.cancelExecution);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  const activeFile = files.find((f) => f.id === activeFileId);

  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const keyLower = e.key.toLowerCase();

      // Ctrl/Cmd + K = Command Palette
      if (mod && (keyLower === "k" || e.code === "KeyK")) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }

      // Ctrl/Cmd + Shift + C = Cancel execution
      if (mod && e.shiftKey && (keyLower === "c" || e.code === "KeyC")) {
        e.preventDefault();
        if (isRunning) {
          await compilerService.cancel();
          cancelExecution();
          addOutputEntry({
            type: "error",
            content: "⛔ Execution cancelled by user",
          });
          setOutputFlash("error");
          addToast({ message: "Execution cancelled", type: "error", duration: 2000 });
        }
        return;
      }

      // Ctrl/Cmd + Enter = Run (Code Editor / Compiler)
      if (mod && (e.key === "Enter" || e.code === "Enter")) {
        const pathname = window.location.pathname;
        if (pathname === "/" || pathname.startsWith("/compiler")) {
          e.preventDefault();
          if (!activeFile || isRunning || activeFile.language === "html") return;

          // Ensure output panel is visible
          if (!outputPanelOpen) {
            toggleOutputPanel();
          }

          setIsRunning(true);
          setExecutionStartTime(Date.now());
          clearOutput();
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
          return;
        }
      }

      // Ctrl/Cmd + S = Universal Format & Save
      if (mod && (keyLower === "s" || e.code === "KeyS")) {
        e.preventDefault();

        const pathname = window.location.pathname;

        // 1. Formatters (/formatters)
        if (pathname.startsWith("/formatters")) {
          window.dispatchEvent(new CustomEvent("devutils:format-formatter"));
          return;
        }

        // 2. Diff Checker (/diff)
        if (pathname.startsWith("/diff")) {
          window.dispatchEvent(new CustomEvent("devutils:format-diff"));
          return;
        }

        // 3. API Tester (/api-tester)
        if (pathname.startsWith("/api-tester")) {
          window.dispatchEvent(new CustomEvent("devutils:format-api-tester"));
          return;
        }

        // 4. Compiler / Code Editor (/compiler and /)
        if (pathname === "/" || pathname.startsWith("/compiler")) {
          if (!activeFile) return;

          if (supportsFormatting(activeFile.language)) {
            try {
              const formatted = await formatCode(activeFile.content, activeFile.language);
              updateFileContent(activeFile.id, formatted);
              useAppStore.getState().saveFile(activeFile.id);
              addToast({ message: "Formatted & saved", type: "success", duration: 1500 });
            } catch {
              useAppStore.getState().saveFile(activeFile.id);
              addToast({ message: "Saved (formatting not available)", type: "info", duration: 1500 });
            }
          } else {
            useAppStore.getState().saveFile(activeFile.id);
            addToast({ message: "Saved", type: "info", duration: 1500 });
          }
          return;
        }
        return;
      }

      // Ctrl/Cmd + B = Toggle sidebar
      if (mod && (keyLower === "b" || e.code === "KeyB")) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Ctrl/Cmd + J = Toggle output panel
      if (mod && (keyLower === "j" || e.code === "KeyJ")) {
        e.preventDefault();
        toggleOutputPanel();
        return;
      }

      // Ctrl/Cmd + , = Settings
      if (mod && (e.key === "," || e.code === "Comma")) {
        e.preventDefault();
        toggleSettings();
        return;
      }

      // App Navigation (Cmd/Ctrl + Option + 1-8 / t, d, w)
      if (mod && e.altKey) {
        switch (keyLower) {
          case "1":
            e.preventDefault();
            navigate("/");
            return;
          case "2":
            e.preventDefault();
            navigate("/compiler");
            return;
          case "3":
            e.preventDefault();
            navigate("/api-tester");
            return;
          case "4":
            e.preventDefault();
            navigate("/formatters");
            return;
          case "5":
            e.preventDefault();
            navigate("/comparators");
            return;
          case "6":
            e.preventDefault();
            navigate("/diff");
            return;
          case "7":
            e.preventDefault();
            navigate("/library");
            return;
          case "8":
            e.preventDefault();
            navigate("/drawflows");
            return;
          
          // Quick creators
          case "t":
            e.preventDefault();
            useApiTesterStore.getState().addTab();
            navigate("/api-tester");
            return;
          case "d":
            e.preventDefault();
            useAppStore.getState().createDiffSession();
            navigate("/diff");
            return;
          case "w":
            e.preventDefault();
            useAppStore.getState().createWorkflow();
            navigate("/drawflows");
            return;
        }
      }
    },
    [activeFile, isRunning, outputPanelOpen, executionTimeout, setIsRunning, clearOutput, addOutputEntry, addExecutionResult, toggleOutputPanel, toggleSettings, toggleCommandPalette, setExecutionStartTime, setOutputFlash, addToast, cancelExecution, updateFileContent, toggleSidebar, navigate]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
