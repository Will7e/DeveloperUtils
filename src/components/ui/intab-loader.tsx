// ============================================================
// InTabLoader — Signature branded loading animation
// Pulsing metallic logo + gradient InTab brand + sliding track
// ============================================================

import React from "react";
import { cn } from "@/lib/utils";
import { InTabLogo } from "./intab-logo";

export type InTabLoaderSize = "xs" | "sm" | "md" | "lg" | "xl";
export type DevUtilsLoaderSize = InTabLoaderSize;

export interface InTabLoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: InTabLoaderSize;
  title?: string;
  message?: string;
  description?: string;
  showText?: boolean;
  showBar?: boolean;
  brandText?: string;
  inline?: boolean;
  icon?: React.ReactNode;
  iconClassName?: string;
  barClassName?: string;
  label?: string;
}
export type DevUtilsLoaderProps = InTabLoaderProps;

const SIZE_CONFIG: Record<
  DevUtilsLoaderSize,
  {
    iconSize: number;
    textSizeClass: string;
    barWidth: number;
    barHeight: number;
    gapClass: string;
    barMarginTop: string;
  }
> = {
  xs: {
    iconSize: 13,
    textSizeClass: "text-[11px]",
    barWidth: 60,
    barHeight: 2,
    gapClass: "gap-1",
    barMarginTop: "mt-1.5",
  },
  sm: {
    iconSize: 16,
    textSizeClass: "text-[13px]",
    barWidth: 110,
    barHeight: 2,
    gapClass: "gap-1",
    barMarginTop: "mt-2.5",
  },
  md: {
    iconSize: 20,
    textSizeClass: "text-[16px]",
    barWidth: 160,
    barHeight: 2,
    gapClass: "gap-1.5",
    barMarginTop: "mt-3.5",
  },
  lg: {
    iconSize: 24,
    textSizeClass: "text-[18px]",
    barWidth: 190,
    barHeight: 2.5,
    gapClass: "gap-1.5",
    barMarginTop: "mt-4",
  },
  xl: {
    iconSize: 30,
    textSizeClass: "text-[22px]",
    barWidth: 230,
    barHeight: 3,
    gapClass: "gap-2",
    barMarginTop: "mt-5",
  },
};

export function InTabLoader({
  size = "md",
  title,
  message,
  description,
  showText,
  showBar,
  brandText = "Tab",
  inline = false,
  icon,
  iconClassName,
  barClassName,
  label = "Loading...",
  className,
  ...props
}: InTabLoaderProps) {
  const config = SIZE_CONFIG[size] || SIZE_CONFIG.md;

  // Defaults based on size
  const shouldShowText = showText !== undefined ? showText : size !== "xs";
  const shouldShowBar = showBar !== undefined ? showBar : size !== "xs" && !inline;

  const displayMessage = message || (title && !description ? title : undefined);
  const displayTitle = title && description ? title : undefined;
  const displayDescription = description;

  const logoIcon = icon || (
    <InTabLogo
      size={config.iconSize}
      className={cn("loader-icon select-none", iconClassName)}
      aria-hidden="true"
    />
  );

  // Micro inline mode (e.g. inside compact buttons or single-line status)
  if (inline || size === "xs") {
    return (
      <div
        role="status"
        aria-label={label}
        className={cn(
          "inline-flex items-center select-none font-sans",
          config.gapClass,
          className
        )}
        {...props}
      >
        {logoIcon}
        {shouldShowText && (
          <span className={cn("loader-text", config.textSizeClass)}>
            {brandText}
          </span>
        )}
        {displayMessage && (
          <span className="text-xs text-text-3 font-medium">
            {displayMessage}
          </span>
        )}
        <span className="sr-only">{label}</span>
      </div>
    );
  }

  // Standard branded loading block
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("intab-loader devutils-loader select-none", className)}
      {...props}
    >
      {/* Brand Header */}
      <div className={cn("loader-brand", config.gapClass)}>
        {logoIcon}
        {shouldShowText && (
          <span className={cn("loader-text", config.textSizeClass)}>
            {brandText}
          </span>
        )}
      </div>

      {/* Sliding Glowing Progress Bar */}
      {shouldShowBar && (
        <div
          className={cn("loader-bar-track", config.barMarginTop, barClassName)}
          style={{
            width: config.barWidth,
            height: config.barHeight,
          }}
        >
          <div className="loader-bar-fill" />
        </div>
      )}

      {/* Optional Status Text / Description */}
      {(displayTitle || displayMessage || displayDescription) && (
        <div className="flex flex-col items-center text-center mt-3 max-w-xs">
          {displayTitle && (
            <h3 className="text-sm font-semibold text-text-1 tracking-tight mb-0.5">
              {displayTitle}
            </h3>
          )}
          {displayMessage && (
            <span className="text-xs font-mono text-text-3 tracking-wide">
              {displayMessage}
            </span>
          )}
          {displayDescription && (
            <p className="text-xs text-text-2 leading-relaxed font-normal mt-1">
              {displayDescription}
            </p>
          )}
        </div>
      )}

      <span className="sr-only">{label}</span>
    </div>
  );
}

export const DevUtilsLoader = InTabLoader;
export default InTabLoader;
