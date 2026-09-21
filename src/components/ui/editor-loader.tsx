// ============================================================
// EditorLoadingFallback — Skeleton placeholder for Monaco editors
// ============================================================
// Shows an editor-shaped skeleton (code lines + gutters) after a
// short grace period that avoids flashing on fast mounts. If the
// editor takes unusually long, offers a reload escape hatch.

import React from "react";
import { cn } from "@/lib/utils";
import { EditorSkeleton } from "./skeleton";

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
        "flex-1 relative flex items-center justify-center w-full h-full min-h-[140px] bg-editor select-none",
        className
      )}
    >
      {showContent && (
        <>
          <EditorSkeleton lines={9} />

          {isSlow && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg-0/60 backdrop-blur-[2px] loading-fade-in">
              <div className="flex flex-col items-center gap-2 px-6 py-4 rounded-xl border border-border-1 bg-bg-1/80 backdrop-blur-md shadow-sm text-center max-w-sm">
                <span className="text-[11px] text-text-muted">
                  {message} — taking longer than expected.
                </span>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="text-[11px] px-2.5 py-1 rounded bg-bg-2 hover:bg-bg-hover text-text-1 border border-border-1 transition-colors cursor-pointer"
                >
                  Reload
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default EditorLoadingFallback;
