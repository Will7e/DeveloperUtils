// ============================================================
// Unified LoadingState Component — Full-page, section, and inline states
// Powered by InTab branded loader
// ============================================================

import React from "react";
import { cn } from "@/lib/utils";
import { InTabLoader, type InTabLoaderSize } from "./intab-loader";

export interface LoadingStateProps {
  /** Primary heading or title */
  title?: string;
  /** Single-line message (shorthand for title or compact label) */
  message?: string;
  /** Secondary detailed description text */
  description?: string;
  /** Size variant */
  size?: InTabLoaderSize;
  /** Render as full-page or full-container centered layout */
  fullPage?: boolean;
  /** Render as compact inline horizontal layout */
  inline?: boolean;
  /** Optional custom icon or logo */
  icon?: React.ReactNode;
  /** Minimum container height (for sections/panels) */
  minHeight?: number | string;
  /** Additional custom class */
  className?: string;
}

export function LoadingState({
  title,
  message,
  description,
  size,
  fullPage = false,
  inline = false,
  icon,
  minHeight,
  className,
}: LoadingStateProps) {
  // Determine effective loader size based on mode
  const effectiveSize: InTabLoaderSize =
    size || (fullPage ? "xl" : inline ? "xs" : "md");
  const displayTitle = title || (!description ? message : undefined);
  const displayDescription = description || (title ? message : undefined);

  if (inline) {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-2 text-text-3 text-xs font-medium loading-fade-in",
          className
        )}
      >
        <InTabLoader
          size={effectiveSize}
          inline
          icon={icon}
          message={displayTitle || message}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center w-full overflow-hidden loading-fade-in",
        fullPage ? "flex-1 h-full min-h-[360px] p-8" : "p-6",
        className
      )}
      style={minHeight ? { minHeight } : undefined}
    >
      {/* Subtle ambient glowing backdrop for full-page and major sections */}
      {fullPage && <div className="loading-ambient-glow" />}

      <div className="relative z-10 flex flex-col items-center text-center max-w-sm">
        <InTabLoader
          size={effectiveSize}
          icon={icon}
          title={displayTitle}
          description={displayDescription}
          showBar={true}
        />
      </div>
    </div>
  );
}

export default LoadingState;
