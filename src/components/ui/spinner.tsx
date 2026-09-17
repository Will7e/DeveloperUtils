// ============================================================
// Unified Spinner Component — Accessible, scalable, theme-aware
// ============================================================

import React from "react";
import { cn } from "@/lib/utils";

export type SpinnerSize = "xs" | "sm" | "md" | "lg" | "xl";
export type SpinnerVariant = "accent" | "muted" | "white" | "current";

export interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
  label?: string;
  className?: string;
}

const SIZE_MAP: Record<SpinnerSize, { dimension: number; strokeWidth: number }> = {
  xs: { dimension: 12, strokeWidth: 2.2 },
  sm: { dimension: 16, strokeWidth: 2.2 },
  md: { dimension: 22, strokeWidth: 2.4 },
  lg: { dimension: 32, strokeWidth: 2.6 },
  xl: { dimension: 42, strokeWidth: 2.8 },
};

const VARIANT_MAP: Record<SpinnerVariant, { track: string; head: string }> = {
  accent: {
    track: "var(--border-2)",
    head: "var(--accent)",
  },
  muted: {
    track: "rgba(255, 255, 255, 0.08)",
    head: "var(--text-3)",
  },
  white: {
    track: "rgba(255, 255, 255, 0.2)",
    head: "#ffffff",
  },
  current: {
    track: "currentColor",
    head: "currentColor",
  },
};

export function Spinner({
  size = "md",
  variant = "accent",
  label = "Loading...",
  className,
  ...props
}: SpinnerProps) {
  const { dimension, strokeWidth } = SIZE_MAP[size] || SIZE_MAP.md;
  const colors = VARIANT_MAP[variant] || VARIANT_MAP.accent;
  const radius = (dimension - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // Arc length approx 25-30% of perimeter
  const dashLength = circumference * 0.28;

  return (
    <svg
      role="status"
      aria-label={label}
      width={dimension}
      height={dimension}
      viewBox={`0 0 ${dimension} ${dimension}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("ui-spinner", className)}
      {...props}
    >
      {/* Background circular track */}
      <circle
        cx={dimension / 2}
        cy={dimension / 2}
        r={radius}
        stroke={colors.track}
        strokeWidth={strokeWidth}
        opacity={variant === "current" ? 0.25 : 0.6}
      />
      {/* Animated spinning arc */}
      <circle
        cx={dimension / 2}
        cy={dimension / 2}
        r={radius}
        stroke={colors.head}
        strokeWidth={strokeWidth}
        strokeDasharray={`${dashLength} ${circumference}`}
        strokeLinecap="round"
      />
      <span className="sr-only">{label}</span>
    </svg>
  );
}

export default Spinner;
