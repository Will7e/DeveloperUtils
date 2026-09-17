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
  return (
    <div
      className={cn(
        "flex-1 flex items-center justify-center w-full h-full min-h-[140px] bg-editor select-none loading-fade-in",
        className
      )}
    >
      <div className="flex flex-col items-center gap-2.5 px-6 py-4 rounded-xl border border-border-1 bg-bg-1/60 backdrop-blur-md shadow-sm">
        <DevUtilsLoader size="sm" showBar />
        {message && (
          <span className="text-[11px] font-mono text-text-3 tracking-wide mt-0.5">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}

export default EditorLoadingFallback;
