// ============================================================
// Toolbar — Top bar with run, language, and actions
// ============================================================

import { useCallback, useState } from "react";
import {
  Play,
  Square,
  Plus,
  Settings,
  Trash2,
  PanelBottom,
  PanelLeft,
  Zap,
  Download,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { useAppStore } from "@/stores/app.store";
import { compilerService } from "@/services/compiler.service";
import { LANGUAGE_CONFIGS } from "@/config";
import type { Language } from "@/types";
import { formatDuration } from "@/lib/utils";

export function Toolbar() {
  const [copied, setCopied] = useState(false);
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const isRunning = useAppStore((s) => s.isRunning);
  const setIsRunning = useAppStore((s) => s.setIsRunning);
  const addOutputEntry = useAppStore((s) => s.addOutputEntry);
  const addExecutionResult = useAppStore((s) => s.addExecutionResult);
  const clearOutput = useAppStore((s) => s.clearOutput);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const outputPanelOpen = useAppStore((s) => s.outputPanelOpen);
  const createFile = useAppStore((s) => s.createFile);

  const activeFile = files.find((f) => f.id === activeFileId);

  const handleRun = useCallback(async () => {
    if (!activeFile || isRunning) return;

    setIsRunning(true);
    clearOutput();

    addOutputEntry({
      type: "info",
      content: `⚡ Running ${activeFile.name}...`,
    });

    try {
      // Initialize engine if needed
      if (activeFile.language === "python") {
        const ready = await compilerService.isReady("python");
        if (!ready) {
          addOutputEntry({
            type: "info",
            content: "🐍 Loading Python runtime (Pyodide)... This may take a moment on first run.",
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

      addOutputEntry({
        type: result.exitCode === 0 ? "success" : "error",
        content:
          result.exitCode === 0
            ? `✓ Finished in ${formatDuration(result.duration)}`
            : `✗ Failed with exit code ${result.exitCode} (${formatDuration(result.duration)})`,
      });
    } catch (error) {
      addOutputEntry({
        type: "error",
        content: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setIsRunning(false);
    }
  }, [
    activeFile,
    isRunning,
    setIsRunning,
    clearOutput,
    addOutputEntry,
    addExecutionResult,
  ]);

  const handleNewFile = useCallback(() => {
    const languages: Language[] = ["javascript", "typescript", "python", "html"];
    const currentLang = activeFile?.language || "javascript";
    createFile(`untitled${LANGUAGE_CONFIGS[currentLang].extension}`, currentLang);
  }, [activeFile, createFile]);

  const handleCopyCode = useCallback(async () => {
    if (!activeFile) return;
    await navigator.clipboard.writeText(activeFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [activeFile]);

  const handleDownload = useCallback(() => {
    if (!activeFile) return;
    const blob = new Blob([activeFile.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = activeFile.name;
    a.click();
    URL.revokeObjectURL(url);
  }, [activeFile]);

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSidebar}
              className={sidebarOpen ? "text-primary" : "text-muted-foreground"}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle Sidebar</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-5 mx-1" />

        {/* Run Button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="glow"
              size="sm"
              onClick={handleRun}
              disabled={isRunning || !activeFile || activeFile.language === "html"}
              className="run-button gap-1.5"
            >
              {isRunning ? (
                <>
                  <Square className="h-3.5 w-3.5 fill-current" />
                  <span>Running...</span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5 fill-current" />
                  <span>Run</span>
                </>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {activeFile?.language === "html"
              ? "HTML is previewed live"
              : "Run Code (Ctrl+Enter)"}
          </TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-5 mx-1" />

        {/* Language indicator */}
        {activeFile && (
          <div className="language-badge">
            <Zap className="h-3 w-3" />
            <span>{LANGUAGE_CONFIGS[activeFile.language].label}</span>
          </div>
        )}
      </div>

      <div className="toolbar-center">
        <div className="app-title">
          <span className="app-title-icon">⚡</span>
          <span className="app-title-text">CodeForge</span>
        </div>
      </div>

      <div className="toolbar-right">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={handleCopyCode} disabled={!activeFile}>
              {copied ? (
                <Check className="h-4 w-4 text-emerald-400" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copied ? "Copied!" : "Copy Code"}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={handleDownload} disabled={!activeFile}>
              <Download className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download File</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={handleNewFile}>
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New File</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-5 mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleOutputPanel}
              className={outputPanelOpen ? "text-primary" : "text-muted-foreground"}
            >
              <PanelBottom className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle Output</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={toggleSettings}>
              <Settings className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
