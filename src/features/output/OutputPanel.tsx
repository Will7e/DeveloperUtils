// ============================================================
// Output Panel — Console output display (right side)
// ============================================================

import { useEffect, useRef, useState } from "react";
import { Terminal, Trash2, X, Clock, ChevronDown, Copy, Check } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import { formatTime, formatDuration } from "@/lib/utils";
import { cn } from "@/lib/utils";

export function OutputPanel() {
  const outputRef = useRef<HTMLDivElement>(null);
  const outputEntries = useAppStore((s) => s.outputEntries);
  const executionResults = useAppStore((s) => s.executionResults);
  const clearOutput = useAppStore((s) => s.clearOutput);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const isRunning = useAppStore((s) => s.isRunning);
  const outputFlash = useAppStore((s) => s.outputFlash);
  const [showHistory, setShowHistory] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputEntries]);

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
        </div>
        <div className="output-header-right">
          {/* Execution history toggle */}
          {executionResults.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="toolbar-icon-btn"
                  onClick={() => setShowHistory(!showHistory)}
                  style={{
                    width: 24,
                    height: 24,
                    color: showHistory ? "#0ea5e9" : undefined,
                  }}
                >
                  <Clock style={{ width: 12, height: 12 }} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Execution History</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-icon-btn"
                onClick={() => {
                  const text = outputEntries.map(e => `[${formatTime(e.timestamp)}] ${e.content}`).join('\n');
                  navigator.clipboard.writeText(text);
                  setIsCopied(true);
                  setTimeout(() => setIsCopied(false), 2000);
                }}
                disabled={outputEntries.length === 0}
                style={{ width: 24, height: 24, color: isCopied ? "var(--green)" : undefined }}
              >
                {isCopied ? (
                  <Check style={{ width: 12, height: 12 }} />
                ) : (
                  <Copy style={{ width: 12, height: 12 }} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>{isCopied ? "Copied!" : "Copy Output"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-icon-btn"
                onClick={clearOutput}
                style={{ width: 24, height: 24 }}
              >
                <Trash2 style={{ width: 12, height: 12 }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Clear</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-icon-btn"
                onClick={toggleOutputPanel}
                style={{ width: 24, height: 24 }}
              >
                <X style={{ width: 13, height: 13 }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Close Panel <kbd>⌘J</kbd></TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Execution history panel */}
      {showHistory && executionResults.length > 0 && (
        <div className="execution-history">
          <div className="execution-history-title">
            <ChevronDown style={{ width: 12, height: 12, opacity: 0.5 }} />
            <span>Recent Runs</span>
          </div>
          <div className="execution-history-list">
            {executionResults
              .slice(-10)
              .reverse()
              .map((result, i) => (
                <div
                  key={i}
                  className={cn(
                    "execution-history-item",
                    result.exitCode === 0
                      ? "execution-history-success"
                      : "execution-history-error"
                  )}
                >
                  <span className="execution-history-status">
                    {result.exitCode === 0 ? "✓" : "✗"}
                  </span>
                  <span className="execution-history-time">
                    {formatTime(result.timestamp)}
                  </span>
                  <span className="execution-history-duration">
                    {formatDuration(result.duration)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Output content */}
      <div className="output-content" ref={outputRef}>
        {outputEntries.length === 0 ? (
          <div className="output-empty">
            <div className="output-empty-icon">
              <Terminal style={{ width: 36, height: 36 }} />
            </div>
            <p className="output-empty-title">No output yet</p>
            <p className="output-empty-hint">Run your code to see output here</p>
          </div>
        ) : (
          <div className="output-entries">
            {outputEntries.map((entry) => (
              <div
                key={entry.id}
                className={cn("output-entry", `output-${entry.type}`)}
              >
                <span className="output-timestamp">
                  {formatTime(entry.timestamp)}
                </span>
                <pre className="output-text">{entry.content}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
