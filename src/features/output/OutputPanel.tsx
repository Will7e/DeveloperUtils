// ============================================================
// Output Panel — Console output display
// ============================================================

import { useEffect, useRef } from "react";
import { Terminal, Trash2, ChevronRight, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import { formatTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

export function OutputPanel() {
  const outputRef = useRef<HTMLDivElement>(null);
  const outputEntries = useAppStore((s) => s.outputEntries);
  const clearOutput = useAppStore((s) => s.clearOutput);
  const outputPanelOpen = useAppStore((s) => s.outputPanelOpen);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const isRunning = useAppStore((s) => s.isRunning);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputEntries]);

  return (
    <div className={cn("output-panel", !outputPanelOpen && "output-collapsed")}>
      {/* Header */}
      <div className="output-header">
        <div className="output-header-left">
          <Terminal className="h-3.5 w-3.5 text-primary" />
          <span className="output-title">Output</span>
          {isRunning && (
            <div className="running-indicator">
              <div className="running-dot" />
              <span>Running</span>
            </div>
          )}
          {outputEntries.length > 0 && (
            <span className="output-count">{outputEntries.length}</span>
          )}
        </div>
        <div className="output-header-right">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={clearOutput}
                className="h-6 w-6 btn-clear"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear Output</TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleOutputPanel}
            className="h-6 w-6"
          >
            {outputPanelOpen ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Output content */}
      {outputPanelOpen && (
        <div className="output-content" ref={outputRef}>
          {outputEntries.length === 0 ? (
            <div className="output-empty">
              <Terminal className="h-8 w-8 opacity-20" />
              <p>Run your code to see output here</p>
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
      )}
    </div>
  );
}
