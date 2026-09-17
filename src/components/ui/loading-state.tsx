// ============================================================
// Unified LoadingState Component — Full-page, section, and inline states
// ============================================================

import React from "react";
import { cn } from "@/lib/utils";
import { Spinner, type SpinnerSize, type SpinnerVariant } from "./spinner";

export interface LoadingStateProps {
  /** Primary heading or title */
  title?: string;
  /** Single-line message (shorthand for title or compact label) */
  message?: string;
  /** Secondary detailed description text */
  description?: string;
  /** Spinner size */
  size?: SpinnerSize;
  /** Spinner color variant */
  variant?: SpinnerVariant;
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
  variant = "accent",
  fullPage = false,
  inline = false,
  icon,
  minHeight,
  className,
}: LoadingStateProps) {
  // Determine effective spinner size based on mode
  const effectiveSize: SpinnerSize = size || (fullPage ? "xl" : inline ? "sm" : "md");
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
        {icon || <Spinner size={effectiveSize} variant={variant} />}
        {(displayTitle || message) && <span>{displayTitle || message}</span>}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center w-full overflow-hidden loading-fade-in",
        fullPage
          ? "flex-1 h-full min-h-[360px] p-8"
          : "p-6",
        className
      )}
      style={minHeight ? { minHeight } : undefined}
    >
      {/* Subtle ambient glowing backdrop for full-page and major sections */}
      {fullPage && <div className="loading-ambient-glow" />}

      <div className="relative z-10 flex flex-col items-center text-center max-w-sm">
        {icon ? (
          <div className="mb-4">{icon}</div>
        ) : (
          <div className="mb-4">
            <Spinner size={effectiveSize} variant={variant} />
          </div>
        )}

        {displayTitle && (
          <h3 className="text-sm font-semibold text-text-1 tracking-tight mb-1">
            {displayTitle}
          </h3>
        )}

        {displayDescription && (
          <p className="text-xs text-text-2 leading-relaxed font-normal">
            {displayDescription}
          </p>
        )}
      </div>
    </div>
  );
}

export default LoadingState;
