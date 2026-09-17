// ============================================================
// TopLoadingBar — Slim glowing progress bar for route and data transitions
// ============================================================

import React from "react";
import { cn } from "@/lib/utils";

export interface TopLoadingBarProps {
  className?: string;
}

export function TopLoadingBar({ className }: TopLoadingBarProps) {
  return (
    <div
      role="progressbar"
      aria-label="Loading page content"
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("route-top-loader", className)}
    />
  );
}

export default TopLoadingBar;
