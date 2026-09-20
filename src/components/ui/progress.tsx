import * as React from "react";
import { cn } from "@/lib/utils";

export type ProgressVariant = "default" | "success" | "warning" | "error" | "blue";
export type ProgressSize = "xs" | "sm" | "md" | "lg";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
  variant?: ProgressVariant;
  size?: ProgressSize;
  indeterminate?: boolean;
}

const heightMap: Record<ProgressSize, string> = {
  xs: "h-[2px]",
  sm: "h-1",
  md: "h-2",
  lg: "h-3",
};

const variantMap: Record<ProgressVariant, string> = {
  default: "bg-[var(--ds-gray-1000)]",
  success: "bg-[var(--ds-green-700)]",
  blue: "bg-[var(--ds-blue-700)]",
  warning: "bg-[var(--ds-amber-700)]",
  error: "bg-[var(--ds-red-800)]",
};

export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  (
    {
      value,
      max = 100,
      variant = "default",
      size = "md",
      indeterminate = false,
      className,
      ...props
    },
    ref
  ) => {
    const isIndeterminate = indeterminate || value === undefined;
    const percentage = isIndeterminate
      ? 0
      : Math.min(100, Math.max(0, (value / max) * 100));

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuenow={isIndeterminate ? undefined : value}
        aria-valuemin={0}
        aria-valuemax={max}
        data-geist-progress=""
        className={cn(
          "relative w-full overflow-hidden rounded-full bg-[var(--ds-gray-200)]",
          heightMap[size],
          className
        )}
        {...props}
      >
        {isIndeterminate ? (
          <div
            className={cn(
              "h-full w-2/5 rounded-full animate-progress-indeterminate",
              variantMap[variant]
            )}
          />
        ) : (
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300 ease-out",
              variantMap[variant]
            )}
            style={{ width: `${percentage}%` }}
          />
        )}
      </div>
    );
  }
);
Progress.displayName = "Progress";
