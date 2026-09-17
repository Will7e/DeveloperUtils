// ============================================================
// EditorLoadingFallback — Standardized loading placeholder for Monaco editors
// ============================================================

import React from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

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
      <div className="flex items-center gap-3 px-4 py-2 rounded-lg border border-border-1 bg-bg-1/40 backdrop-blur-xs shadow-xs">
        <Spinner size="sm" variant="accent" />
        <span className="text-xs font-mono text-text-3 tracking-wide">
          {message}
        </span>
      </div>
    </div>
  );
}

export default EditorLoadingFallback;
