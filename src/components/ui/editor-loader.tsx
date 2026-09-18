// ============================================================
// EditorLoadingFallback — Standardized loading placeholder for Monaco editors
// Powered by DevUtils branded loader (pulsing bolt + gradient text + sliding bar)
// ============================================================

import React from "react";
import { cn } from "@/lib/utils";
import { DevUtilsLoader } from "./devutils-loader";

export interface EditorLoadingFallbackProps {
  message?: string;
  className?: string;
}

export function EditorLoadingFallback({
  message = "Loading editor...",
  className,
}: EditorLoadingFallbackProps) {
  const [isSlow, setIsSlow] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => setIsSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={cn(
        "flex-1 flex items-center justify-center w-full h-full min-h-[140px] bg-editor select-none loading-fade-in",
        className
      )}
    >
      <div className="flex flex-col items-center gap-2.5 px-6 py-4 rounded-xl border border-border-1 bg-bg-1/60 backdrop-blur-md shadow-sm text-center max-w-sm">
        <DevUtilsLoader size="sm" showBar />
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
    </div>
  );
}

export default EditorLoadingFallback;
