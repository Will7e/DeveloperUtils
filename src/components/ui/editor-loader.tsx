// ============================================================
// EditorLoadingFallback — Standardized loading placeholder for Monaco editors
// Powered by InTab branded loader
// ============================================================

import React from "react";
import { cn } from "@/lib/utils";
import { InTabLoader } from "./intab-loader";

export interface EditorLoadingFallbackProps {
  message?: string;
  className?: string;
}

export function EditorLoadingFallback({
  message = "Loading editor...",
  className,
}: EditorLoadingFallbackProps) {
  const [showContent, setShowContent] = React.useState(false);
  const [isSlow, setIsSlow] = React.useState(false);

  React.useEffect(() => {
    // Grace period: prevent jarring micro-flashes if Monaco attaches within 150ms
    const showTimer = setTimeout(() => setShowContent(true), 150);
    const slowTimer = setTimeout(() => setIsSlow(true), 8000);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(slowTimer);
    };
  }, []);

  return (
    <div
      className={cn(
        "flex-1 flex items-center justify-center w-full h-full min-h-[140px] bg-editor select-none",
        className
      )}
    >
      {showContent && (
        <div className="flex flex-col items-center gap-2.5 px-6 py-4 rounded-xl border border-border-1 bg-bg-1/60 backdrop-blur-md shadow-sm text-center max-w-sm loading-fade-in">
          <InTabLoader size="sm" showBar />
          {message && (
            <span className="text-[11px] font-mono text-text-3 tracking-wide mt-0.5">
              {message}
            </span>
          )}
          {isSlow && (
            <div className="flex flex-col items-center gap-1.5 mt-2 pt-2 border-t border-border-1">
              <span className="text-[11px] text-text-muted">
                Loading is taking longer than expected.
              </span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="text-[11px] px-2.5 py-1 rounded bg-bg-2 hover:bg-bg-hover text-text-1 border border-border-1 transition-colors cursor-pointer"
              >
                Reload
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default EditorLoadingFallback;
