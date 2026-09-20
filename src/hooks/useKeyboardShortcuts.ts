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
  const toggleSidebarCollapse = useAppStore((s) => s.toggleSidebarCollapse);
  const closeCommandPalette = useAppStore((s) => s.closeCommandPalette);

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
          window.dispatchEvent(new CustomEvent("intab:format-formatter"));
          return;
        }

        // 2. Diff Checker (/diff)
        if (pathname.startsWith("/diff")) {
          window.dispatchEvent(new CustomEvent("intab:format-diff"));
          return;
        }

        // 3. API Tester (/api-tester)
        if (pathname.startsWith("/api-tester")) {
          window.dispatchEvent(new CustomEvent("intab:format-api-tester"));
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
        toggleSidebarCollapse();
        toggleSidebar();
        return;
      }

      // Ctrl/Cmd + J = Toggle output panel
      if (mod && (keyLower === "j" || e.code === "KeyJ")) {
        e.preventDefault();
        const pathname = window.location.pathname;
        if (pathname !== "/" && !pathname.startsWith("/compiler")) {
          useAppStore.getState().setOutputPanelOpen(true);
          navigate("/compiler");
          addToast({ message: "Console opened in Compiler", type: "info", duration: 1500 });
        } else {
          toggleOutputPanel();
        }
        return;
      }

      // Ctrl/Cmd + , = Settings
      if (mod && (e.key === "," || e.code === "Comma")) {
        e.preventDefault();
        toggleSettings();
        return;
      }

      // App Navigation (Cmd/Ctrl + Option + 1-8 / t, d, w, or Option + 1-8 outside inputs)
      const isTextInput = () => {
        const active = document.activeElement;
        if (!active) return false;
        const tag = active.tagName.toLowerCase();
        return tag === "input" || tag === "textarea" || (active as HTMLElement).isContentEditable;
      };

      const isAltNav = (mod && e.altKey) || (e.altKey && !mod && !isTextInput());

      if (isAltNav) {
        const closePaletteIfOpen = () => {
          closeCommandPalette();
        };

        // 1. Dashboard
        if (e.code === "Digit1" || e.code === "Numpad1" || keyLower === "1" || e.key === "¡") {
          e.preventDefault();
          closePaletteIfOpen();
          navigate("/");
          addToast({ message: "Navigated to Dashboard", type: "info", duration: 1500 });
          return;
        }

        // 2. Compiler
        if (e.code === "Digit2" || e.code === "Numpad2" || keyLower === "2" || e.key === "™" || e.key === "@" || e.key === "²") {
          e.preventDefault();
          closePaletteIfOpen();
          navigate("/compiler");
          addToast({ message: "Navigated to Compiler", type: "info", duration: 1500 });
          return;
        }

        // 3. API Tester
        if (e.code === "Digit3" || e.code === "Numpad3" || keyLower === "3" || e.key === "£" || e.key === "³") {
          e.preventDefault();
          closePaletteIfOpen();
          navigate("/api-tester");
          addToast({ message: "Navigated to API Tester", type: "info", duration: 1500 });
          return;
        }

        // 4. Formatters
        if (e.code === "Digit4" || e.code === "Numpad4" || keyLower === "4" || e.key === "¢" || e.key === "$") {
          e.preventDefault();
          closePaletteIfOpen();
          navigate("/formatters");
          addToast({ message: "Navigated to Formatters", type: "info", duration: 1500 });
          return;
        }

        // 5. Comparators
        if (e.code === "Digit5" || e.code === "Numpad5" || keyLower === "5" || e.key === "∞" || e.key === "€") {
          e.preventDefault();
          closePaletteIfOpen();
          navigate("/comparators");
          addToast({ message: "Navigated to Comparators", type: "info", duration: 1500 });
          return;
        }

        // 6. Diff Checker
        if (e.code === "Digit6" || e.code === "Numpad6" || keyLower === "6" || e.key === "§") {
          e.preventDefault();
          closePaletteIfOpen();
          navigate("/diff");
          addToast({ message: "Navigated to Diff Checker", type: "info", duration: 1500 });
          return;
        }

        // 7. Library
        if (e.code === "Digit7" || e.code === "Numpad7" || keyLower === "7" || e.key === "¶" || e.key === "|") {
          e.preventDefault();
          closePaletteIfOpen();
          navigate("/library");
          addToast({ message: "Navigated to Code Library", type: "info", duration: 1500 });
          return;
        }

        // 8. DrawFlows
        if (e.code === "Digit8" || e.code === "Numpad8" || keyLower === "8" || e.key === "•" || e.key === "[") {
          e.preventDefault();
          closePaletteIfOpen();
          navigate("/drawflows");
          addToast({ message: "Navigated to DrawFlows", type: "info", duration: 1500 });
          return;
        }

        // 9. AI Chat
        if (e.code === "Digit9" || e.code === "Numpad9" || keyLower === "9" || e.key === "ª") {
          e.preventDefault();
          closePaletteIfOpen();
          navigate("/chat");
          addToast({ message: "Navigated to AI Chat", type: "info", duration: 1500 });
          return;
        }

        // Quick creators: t, d, w (only with mod + altKey to prevent conflicts)
        if (mod && e.altKey) {
          if (e.code === "KeyT" || keyLower === "t" || e.key === "†") {
            e.preventDefault();
            closePaletteIfOpen();
            useApiTesterStore.getState().addTab();
            navigate("/api-tester");
            addToast({ message: "New API Request tab created", type: "success", duration: 1500 });
            return;
          }
          if (e.code === "KeyD" || keyLower === "d" || e.key === "∂") {
            e.preventDefault();
            closePaletteIfOpen();
            useAppStore.getState().createDiffSession();
            navigate("/diff");
            addToast({ message: "New Diff Session created", type: "success", duration: 1500 });
            return;
          }
          if (e.code === "KeyW" || keyLower === "w" || e.key === "∑") {
            e.preventDefault();
            closePaletteIfOpen();
            useAppStore.getState().createWorkflow();
            navigate("/drawflows");
            addToast({ message: "New DrawFlow Diagram created", type: "success", duration: 1500 });
            return;
          }
        }
      }
    },
    [activeFile, isRunning, outputPanelOpen, executionTimeout, setIsRunning, clearOutput, addOutputEntry, addExecutionResult, toggleOutputPanel, toggleSettings, toggleCommandPalette, closeCommandPalette, setExecutionStartTime, setOutputFlash, addToast, cancelExecution, updateFileContent, toggleSidebar, toggleSidebarCollapse, navigate]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Support global navigation events from Monaco editor or components
  useEffect(() => {
    const handleNavEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      if (customEvent.detail) {
        if (useAppStore.getState().commandPaletteOpen) {
          useAppStore.getState().toggleCommandPalette();
        }
        navigate(customEvent.detail);
      }
    };
    window.addEventListener("intab:navigate", handleNavEvent);
    return () => {
      window.removeEventListener("intab:navigate", handleNavEvent);
    };
  }, [navigate]);
}
