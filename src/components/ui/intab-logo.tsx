// ============================================================
// InTab Logo Component — Modern Minimalist Vector Brandmark
// Precision geometric tab silhouette with 'in' monogram & accent beacon
// Native support for Dark & Light modes, responsive tokens, and SVG scaling
// ============================================================

import React, { useId } from "react";
import { cn } from "@/lib/utils";

export interface InTabLogoProps extends React.SVGAttributes<SVGSVGElement> {
  /** Size in pixels (width and height). Default: 28 */
  size?: number;
  /** Additional CSS class names */
  className?: string;
  /** Subtle ambient glow effect. Default: false */
  glow?: boolean;
  /** Explicit theme override or auto-detect based on html class. Default: "auto" */
  theme?: "auto" | "dark" | "light";
  /** Badge container variant or standalone monogram glyph. Default: "tab" */
  variant?: "tab" | "glyph";
}

export function InTabLogo({
  size = 28,
  className = "",
  glow = false,
  theme = "auto",
  variant = "tab",
  style,
  ...props
}: InTabLogoProps) {
  const uid = useId().replace(/:/g, "_");

  // Gradient & filter IDs
  const tabBgDarkId = `intab-tab-bg-dark-${uid}`;
  const tabBgLightId = `intab-tab-bg-light-${uid}`;
  const borderDarkId = `intab-border-dark-${uid}`;
  const borderLightId = `intab-border-light-${uid}`;
  const dotGlowDarkId = `intab-dot-glow-dark-${uid}`;

  // Theme-specific CSS classes
  const themeClass =
    theme === "dark"
      ? "intab-theme-dark"
      : theme === "light"
      ? "intab-theme-light"
      : "intab-theme-auto";

  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="InTab Logo"
      className={cn(
        "intab-logo select-none shrink-0 transition-transform duration-200",
        themeClass,
        glow && "intab-logo-glow",
        className
      )}
      style={{
        width: size,
        height: size,
        ...style,
      }}
      {...props}
    >
      <defs>
        {/* Dark Mode Tab Background Gradient */}
        <linearGradient id={tabBgDarkId} x1="24" y1="5.5" x2="24" y2="43" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1e293b" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#0f172a" stopOpacity="0.98" />
        </linearGradient>

        {/* Light Mode Tab Background Gradient */}
        <linearGradient id={tabBgLightId} x1="24" y1="5.5" x2="24" y2="43" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#f8fafc" />
        </linearGradient>

        {/* Dark Mode Subtle Rim Gradient */}
        <linearGradient id={borderDarkId} x1="12" y1="5.5" x2="36" y2="43" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.5" />
          <stop offset="45%" stopColor="#94a3b8" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.1" />
        </linearGradient>

        {/* Light Mode Subtle Rim Gradient */}
        <linearGradient id={borderLightId} x1="12" y1="5.5" x2="36" y2="43" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0284c7" stopOpacity="0.4" />
          <stop offset="50%" stopColor="#cbd5e1" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#0284c7" stopOpacity="0.2" />
        </linearGradient>

        {/* Dot Ambient Glow (Dark Mode) */}
        <filter id={dotGlowDarkId} x="10" y="14" width="12" height="12" filterUnits="userSpaceOnUse">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Outer Browser Tab Container (Rendered when variant is "tab") */}
      {variant === "tab" && (
        <g className="intab-logo-tab-group">
          {/* Tab Body Fill & Crisp White Border */}
          <path
            d="M 13 5.5 L 23 5.5 C 26 5.5 27 13.5 30 13.5 L 35 13.5 C 39.4183 13.5 43 17.0817 43 21.5 L 43 35 C 43 39.4183 39.4183 43 35 43 L 13 43 C 8.58172 43 5 39.4183 5 35 L 5 13.5 C 5 9.08172 8.58172 5.5 13 5.5 Z"
            className="intab-logo-tab-bg"
            stroke="#ffffff"
            strokeWidth="1.75"
          />
        </g>
      )}

      {/* Monogram: 'in' */}
      <g className="intab-logo-monogram">
        {/* Letter 'i' Dot (Glowing Accent Beacon) */}
        <circle
          cx="16"
          cy="19.5"
          r="2.4"
          className="intab-logo-dot"
        />

        {/* Letter 'i' Stem */}
        <path
          d="M 16 27 L 16 36.5"
          className="intab-logo-letter-i"
          fill="none"
          strokeWidth="4.8"
          strokeLinecap="round"
        />

        {/* Letter 'n' Arch & Stems */}
        <path
          d="M 24 36.5 L 24 27 C 24 24.8 25.8 23.2 28 23.2 C 30.2 23.2 32 24.8 32 27 L 32 36.5"
          className="intab-logo-letter-n"
          fill="none"
          strokeWidth="4.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

export default InTabLogo;
