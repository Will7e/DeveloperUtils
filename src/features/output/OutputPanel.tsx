// ============================================================
// Output Panel — Per-tab console, split view, stdin & run history
// ============================================================
// Each editor tab owns its console. This panel renders the ACTIVE
// tab's console, and can split to show a second tab's console
// side-by-side for comparing runs. Includes a stdin box for
// input()-style scripts and a restorable run history with a
// source diff against the current code.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Terminal,
  Trash2,
  X,
  Clock,
  ChevronDown,
  Copy,
  Check,
  Columns2,
  FileInput,
  History,
  RotateCcw,
  GitCompare,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import { formatTime, formatDuration, cn } from "@/lib/utils";

// ============================================================
// Tiny line diff (LCS) — used to compare a historical run's source
// against the tab's current code. No external dependency.
// ============================================================

type DiffLine = { type: "same" | "add" | "del"; text: string };

function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS table (capped so pathological inputs don't explode memory)
  if (n * m > 1_000_000) {
    return [
      { type: "del", text: `(previous version — ${n} lines)` },
      { type: "add", text: `(current version — ${m} lines)` },
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", text: a[i++]! });
    } else {
      out.push({ type: "add", text: b[j++]! });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}

function SourceDiff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const changed = lines.filter((l) => l.type !== "same").length;
  return (
    <div className="console-source-diff">
      <div className="console-source-diff-title">
        <GitCompare style={{ width: 11, height: 11 }} />
        <span>Source changes since that run ({changed} lines)</span>
      </div>
      <div className="console-source-diff-body">
        {lines.map((l, idx) =>
          l.type === "same" ? null : (
            <div
              key={idx}
              className={cn(
                "console-source-diff-line",
                l.type === "add" && "console-source-diff-add",
                l.type === "del" && "console-source-diff-del"
              )}
            >
              <span className="console-source-diff-sign">{l.type === "add" ? "+" : "−"}</span>
              <span className="console-source-diff-text">{l.text || " "}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ============================================================
// ConsolePane — one tab's console (used for main + split panes)
// ============================================================

interface ConsolePaneProps {
  fileId: string;
  fileName: string;
  compact?: boolean;
}

function ConsolePane({ fileId, fileName, compact }: ConsolePaneProps) {
  const outputRef = useRef<HTMLDivElement>(null);
  const exec = useAppStore((s) => s.tabExec[fileId]);
  const files = useAppStore((s) => s.files);
  const restoreRunHistory = useAppStore((s) => s.restoreRunHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  const entries = exec?.outputEntries ?? [];
  const history = exec?.runHistory ?? [];
  const restoredId = exec?.restoredHistoryId ?? null;
  const restored = restoredId ? history.find((h) => h.id === restoredId) ?? null : null;
  const currentFile = files.find((f) => f.id === fileId);
  const isRunning = Boolean(exec?.isRunning);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [entries]);

  const restoredSource = restored?.result.sourceCode;
  const canDiff = Boolean(restoredSource && currentFile && restoredSource !== currentFile.content);

  return (
    <div className={cn("console-pane", compact && "console-pane-compact")}>
      <div className="console-pane-header">
        <span className="console-pane-name" title={`Console for ${fileName}`}>
          {fileName}
        </span>
        {isRunning && (
          <div className="running-indicator">
            <div className="running-dot" />
            <span>Running</span>
          </div>
        )}
        {entries.length > 0 && <span className="output-count">{entries.length}</span>}
        <div className="console-pane-actions">
          {history.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="toolbar-icon-btn"
                  style={{ width: 22, height: 22, color: showHistory ? "var(--accent)" : undefined }}
                  onClick={() => setShowHistory(!showHistory)}
                >
                  <Clock style={{ width: 12, height: 12 }} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Run history ({history.length})</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Restored-run banner */}
      {restored && (
        <div className="console-restored-banner">
          <History style={{ width: 11, height: 11 }} />
          <span>
            Viewing run from {formatTime(restored.ranAt)} · {formatDuration(restored.result.duration)}
          </span>
          {canDiff && (
            <button className="console-restored-btn" onClick={() => setShowDiff(!showDiff)}>
              <GitCompare style={{ width: 10, height: 10 }} />
              {showDiff ? "Hide diff" : "Diff source"}
            </button>
          )}
          <button className="console-restored-btn" onClick={() => restoreRunHistory(fileId, null)}>
            <RotateCcw style={{ width: 10, height: 10 }} />
            Live
          </button>
        </div>
      )}

      {/* Run history dropdown */}
      {showHistory && history.length > 0 && (
        <div className="execution-history">
          <div className="execution-history-title">
            <ChevronDown style={{ width: 12, height: 12, opacity: 0.5 }} />
            <span>Recent Runs — click to view</span>
          </div>
          <div className="execution-history-list">
            {[...history]
              .slice(-20)
              .reverse()
              .map((h) => (
                <button
                  key={h.id}
                  className={cn(
                    "execution-history-item execution-history-clickable",
                    h.id === restoredId && "execution-history-selected"
                  )}
                  onClick={() => {
                    restoreRunHistory(fileId, h.id === restoredId ? null : h.id);
                    setShowHistory(false);
                    setShowDiff(false);
                  }}
                  title="Restore this run's output"
                >
                  <span className={cn("execution-history-status", h.result.exitCode === 0 ? "execution-history-success" : "execution-history-error")}>
                    {h.result.exitCode === 0 ? "✓" : "✗"}
                  </span>
                  <span className="execution-history-time">{formatTime(h.ranAt)}</span>
                  <span className="execution-history-duration">{formatDuration(h.result.duration)}</span>
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Source diff (restored run vs current code) */}
      {restored && showDiff && restoredSource && currentFile && (
        <SourceDiff before={restoredSource} after={currentFile.content} />
      )}

      {/* Output content */}
      <div className="output-content" ref={outputRef}>
        {entries.length === 0 ? (
          <div className="output-empty">
            <div className="output-empty-icon">
              <Terminal style={{ width: compact ? 24 : 36, height: compact ? 24 : 36 }} />
            </div>
            <p className="output-empty-title">{compact ? `No output for ${fileName}` : "No output yet"}</p>
            <p className="output-empty-hint">Run your code to see output here</p>
          </div>
        ) : (
          <div className="output-entries">
            {entries.map((entry) => (
              <div key={entry.id} className={cn("output-entry", `output-${entry.type}`)}>
                <span className="output-timestamp">{formatTime(entry.timestamp)}</span>
                <pre className="output-text">{entry.content}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// OutputPanel — layout, stdin box, split orchestration
// ============================================================

export function OutputPanel() {
  const outputRef = useRef<HTMLDivElement>(null);

  const activeFileId = useAppStore((s) => s.activeFileId);
  const files = useAppStore((s) => s.files);
  const tabExec = useAppStore((s) => s.tabExec);
  const clearTabOutput = useAppStore((s) => s.clearTabOutput);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const setTabStdin = useAppStore((s) => s.setTabStdin);
  const splitConsoleOpen = useAppStore((s) => s.splitConsoleOpen);
  const splitConsoleFileId = useAppStore((s) => s.splitConsoleFileId);
  const toggleSplitConsole = useAppStore((s) => s.toggleSplitConsole);
  const setSplitConsoleFile = useAppStore((s) => s.setSplitConsoleFile);
  const setOutputPanelOpen = useAppStore((s) => s.setOutputPanelOpen);
  const outputFlash = useAppStore((s) => s.outputFlash);

  const activeFile = files.find((f) => f.id === activeFileId);
  const exec = activeFileId ? tabExec[activeFileId] : undefined;
  const outputEntries = exec?.outputEntries ?? [];
  const stdin = exec?.stdin ?? "";
  const isRunning = Boolean(exec?.isRunning);

  const [stdinOpen, setStdinOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const restoreRunHistory = useAppStore((s) => s.restoreRunHistory);
  const history = exec?.runHistory ?? [];
  const restoredId = exec?.restoredHistoryId ?? null;

  // Auto-scroll main pane
  useEffect(() => {
    if (outputRef.current && !splitConsoleOpen) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputEntries, splitConsoleOpen]);

  // Resolve the split target: explicit choice, else first other file
  const splitFile =
    files.find((f) => f.id === splitConsoleFileId && f.id !== activeFileId) ??
    files.find((f) => f.id !== activeFileId) ??
    null;
  const canSplit = files.length > 1;

  const handleToggleSplit = () => {
    if (!splitConsoleOpen && !canSplit) return;
    toggleSplitConsole();
  };

  return (
    <div
      className={cn(
        "output-panel",
        outputFlash === "success" && "output-flash-success",
        outputFlash === "error" && "output-flash-error"
      )}
    >
      {/* Header */}
      <div className="output-header">
        <div className="output-header-left">
          <Terminal style={{ width: 14, height: 14, color: "var(--accent)" }} />
          <span className="output-title">Console</span>
          {isRunning && (
            <div className="running-indicator">
              <div className="running-dot" />
              <span>Running</span>
            </div>
          )}
          {outputEntries.length > 0 && (
            <span className={cn("output-count", outputEntries.length > 0 && "output-count-pulse")}>
              {outputEntries.length}
            </span>
          )}
          {activeFile && !splitConsoleOpen && (
            <span className="output-tab-name" title={`Console for ${activeFile.name}`}>
              {activeFile.name}
            </span>
          )}
        </div>
        <div className="output-header-right">
          {/* Run history (active tab) */}
          {history.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="toolbar-icon-btn"
                  style={{ width: 24, height: 24, color: showHistory ? "var(--accent)" : undefined }}
                  onClick={() => setShowHistory(!showHistory)}
                >
                  <Clock style={{ width: 12, height: 12 }} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Run history ({history.length})</TooltipContent>
            </Tooltip>
          )}

          {/* Stdin toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-icon-btn"
                style={{ width: 24, height: 24, color: stdinOpen || stdin ? "var(--accent)" : undefined }}
                onClick={() => setStdinOpen(!stdinOpen)}
              >
                <FileInput style={{ width: 12, height: 12 }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Stdin input {stdin ? "•" : ""}</TooltipContent>
          </Tooltip>

          {/* Split console */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-icon-btn"
                style={{ width: 24, height: 24, color: splitConsoleOpen ? "var(--accent)" : undefined, opacity: canSplit ? 1 : 0.35 }}
                onClick={handleToggleSplit}
                disabled={!canSplit}
              >
                <Columns2 style={{ width: 13, height: 13 }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{canSplit ? "Split console (compare two tabs)" : "Open another tab first"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-icon-btn"
                onClick={() => {
                  const text = outputEntries.map((e) => `[${formatTime(e.timestamp)}] ${e.content}`).join("\n");
                  navigator.clipboard.writeText(text);
                  setIsCopied(true);
                  setTimeout(() => setIsCopied(false), 2000);
                }}
                disabled={outputEntries.length === 0}
                style={{ width: 24, height: 24, color: isCopied ? "var(--green)" : undefined }}
              >
                {isCopied ? <Check style={{ width: 12, height: 12 }} /> : <Copy style={{ width: 12, height: 12 }} />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{isCopied ? "Copied!" : "Copy Output"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-icon-btn"
                onClick={() => activeFileId && clearTabOutput(activeFileId)}
                disabled={outputEntries.length === 0}
                style={{ width: 24, height: 24 }}
              >
                <Trash2 style={{ width: 12, height: 12 }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Clear</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button className="toolbar-icon-btn" onClick={setOutputPanelOpen ? () => setOutputPanelOpen(false) : toggleOutputPanel} style={{ width: 24, height: 24 }}>
                <X style={{ width: 13, height: 13 }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Close Panel <kbd>⌘J</kbd></TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Split pane picker */}
      {splitConsoleOpen && canSplit && (
        <div className="console-split-picker">
          <span className="console-split-label">Comparing with</span>
          <div className="console-split-options">
            {files
              .filter((f) => f.id !== activeFileId)
              .map((f) => (
                <button
                  key={f.id}
                  className={cn("console-split-option", splitFile?.id === f.id && "console-split-option-active")}
                  onClick={() => setSplitConsoleFile(f.id)}
                >
                  {f.name}
                </button>
              ))}
          </div>
          <button className="console-split-close" onClick={() => setSplitConsoleFile(null)} title="Exit split view">
            <X style={{ width: 11, height: 11 }} />
          </button>
        </div>
      )}

      {/* Run history dropdown (main pane) */}
      {showHistory && history.length > 0 && (
        <div className="execution-history">
          <div className="execution-history-title">
            <ChevronDown style={{ width: 12, height: 12, opacity: 0.5 }} />
            <span>Recent Runs — click to view</span>
          </div>
          <div className="execution-history-list">
            {[...history]
              .slice(-20)
              .reverse()
              .map((h) => (
                <button
                  key={h.id}
                  className={cn(
                    "execution-history-item execution-history-clickable",
                    h.id === restoredId && "execution-history-selected"
                  )}
                  onClick={() => {
                    if (activeFileId) restoreRunHistory(activeFileId, h.id === restoredId ? null : h.id);
                    setShowHistory(false);
                  }}
                  title="Restore this run's output"
                >
                  <span className={cn("execution-history-status", h.result.exitCode === 0 ? "execution-history-success" : "execution-history-error")}>
                    {h.result.exitCode === 0 ? "✓" : "✗"}
                  </span>
                  <span className="execution-history-time">{formatTime(h.ranAt)}</span>
                  <span className="execution-history-duration">{formatDuration(h.result.duration)}</span>
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Stdin box */}
      {stdinOpen && activeFileId && (
        <div className="console-stdin">
          <div className="console-stdin-header">
            <FileInput style={{ width: 11, height: 11, color: "var(--accent)" }} />
            <span>Stdin for {activeFile?.name ?? "this tab"}</span>
            <span className="console-stdin-hint">one value per line · read via input() / readline()</span>
          </div>
          <textarea
            className="console-stdin-input"
            value={stdin}
            onChange={(e) => setTabStdin(activeFileId, e.target.value)}
            placeholder={"Alice\nBob"}
            rows={3}
            spellCheck={false}
          />
        </div>
      )}

      {/* Console content — single or split */}
      {activeFileId ? (
        splitConsoleOpen && splitFile ? (
          <div className="console-split-wrap">
            <ConsolePane fileId={activeFileId} fileName={activeFile?.name ?? ""} />
            <div className="console-split-divider" />
            <ConsolePane fileId={splitFile.id} fileName={splitFile.name} compact />
          </div>
        ) : (
          <ConsolePane fileId={activeFileId} fileName={activeFile?.name ?? ""} />
        )
      ) : null}
    </div>
  );
}
