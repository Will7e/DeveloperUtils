import * as React from "react";
import { MoreHorizontal, MoreVertical } from "lucide-react";
import { cn } from "@/lib/utils";

/* ============================================================
   1. Geist Loading Dots
   ============================================================ */

export interface LoadingDotsProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: "xs" | "sm" | "md" | "lg";
  label?: React.ReactNode;
}

const dotSizes = {
  xs: "size-0.5",
  sm: "size-1",
  md: "size-1.5",
  lg: "size-2",
};

export const LoadingDots = React.forwardRef<HTMLSpanElement, LoadingDotsProps>(
  ({ size = "sm", label, className, ...props }, ref) => {
    return (
      <span
        ref={ref}
        aria-label="Loading"
        data-testid="geistcn/loading-dots"
        className={cn("inline-flex items-center select-none", className)}
        {...props}
      >
        {label && (
          <span className="mr-2 text-sm text-[var(--ds-gray-900)] font-medium">
            {label}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <span
            className={cn(
              "inline-block rounded-full bg-[var(--ds-gray-900)] animate-geist-blink",
              dotSizes[size]
            )}
            style={{ animationDelay: "0ms" }}
          />
          <span
            className={cn(
              "inline-block rounded-full bg-[var(--ds-gray-900)] animate-geist-blink",
              dotSizes[size]
            )}
            style={{ animationDelay: "200ms" }}
          />
          <span
            className={cn(
              "inline-block rounded-full bg-[var(--ds-gray-900)] animate-geist-blink",
              dotSizes[size]
            )}
            style={{ animationDelay: "400ms" }}
          />
        </span>
      </span>
    );
  }
);
LoadingDots.displayName = "LoadingDots";

/* ============================================================
   2. Geist Status Dot
   ============================================================ */

export type StatusDotVariant =
  | "queued"
  | "ready"
  | "success"
  | "building"
  | "warning"
  | "error"
  | "neutral";

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: StatusDotVariant;
  size?: "sm" | "md" | "lg";
  pulse?: boolean;
  label?: React.ReactNode;
}

const statusSizes = {
  sm: "size-2",
  md: "size-2.5",
  lg: "size-3",
};

const statusColors: Record<StatusDotVariant, { bg: string; ring: string }> = {
  queued: {
    bg: "bg-[var(--ds-gray-600)]",
    ring: "ring-[var(--ds-gray-500)]",
  },
  ready: {
    bg: "bg-[var(--ds-blue-700)]",
    ring: "ring-[var(--ds-blue-500)]",
  },
  success: {
    bg: "bg-[var(--ds-blue-700)]",
    ring: "ring-[var(--ds-blue-700)]/40",
  },
  building: {
    bg: "bg-[var(--ds-amber-700)]",
    ring: "ring-[var(--ds-amber-500)]",
  },
  warning: {
    bg: "bg-[var(--ds-amber-700)]",
    ring: "ring-[var(--ds-amber-700)]/40",
  },
  error: {
    bg: "bg-[var(--ds-red-800)]",
    ring: "ring-[var(--ds-red-600)]",
  },
  neutral: {
    bg: "bg-[var(--ds-gray-700)]",
    ring: "ring-[var(--ds-gray-600)]",
  },
};

export const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(
  (
    {
      status = "ready",
      size = "md",
      pulse = false,
      label,
      title,
      className,
      ...props
    },
    ref
  ) => {
    const { bg, ring } = statusColors[status] || statusColors.ready;

    return (
      <span
        ref={ref}
        title={title || status}
        aria-label={title || status}
        data-testid="geistcn/status-dot"
        className={cn("inline-flex items-center gap-2 select-none", className)}
        {...props}
      >
        <span className="relative flex items-center justify-center shrink-0">
          {pulse && (
            <span
              className={cn(
                "absolute inline-flex rounded-full opacity-75 animate-ping",
                statusSizes[size],
                bg
              )}
            />
          )}
          <span
            className={cn(
              "relative inline-block rounded-full shrink-0 shadow-xs",
              statusSizes[size],
              bg,
              pulse && `ring-2 ${ring}`
            )}
          />
        </span>
        {label && (
          <span className="text-[13px] font-medium text-[var(--ds-gray-900)] capitalize">
            {label}
          </span>
        )}
      </span>
    );
  }
);
StatusDot.displayName = "StatusDot";

/* ============================================================
   3. Geist Dots Menu Trigger
   ============================================================ */

export interface DotsMenuProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  orientation?: "vertical" | "horizontal";
  size?: "sm" | "md";
}

export const DotsMenu = React.forwardRef<HTMLButtonElement, DotsMenuProps>(
  (
    {
      orientation = "vertical",
      size = "md",
      className,
      "aria-label": ariaLabel = "Actions menu",
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        type="button"
        data-geist-dots-menu=""
        aria-label={ariaLabel}
        className={cn(
          "inline-flex items-center justify-center rounded-md border border-transparent text-[var(--ds-gray-900)] transition-all duration-150 cursor-pointer outline-none",
          "hover:bg-[var(--ds-gray-200)] hover:text-[var(--ds-gray-1000)] hover:border-[var(--ds-gray-alpha-400)] active:scale-[0.96]",
          "focus-visible:shadow-[var(--ds-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" ? "size-7" : "size-8",
          className
        )}
        {...props}
      >
        {orientation === "vertical" ? (
          <MoreVertical className={size === "sm" ? "size-3.5" : "size-4"} />
        ) : (
          <MoreHorizontal className={size === "sm" ? "size-3.5" : "size-4"} />
        )}
      </button>
    );
  }
);
DotsMenu.displayName = "DotsMenu";
