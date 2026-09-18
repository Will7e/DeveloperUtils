// ============================================================
// InTab Logo Component — The Official "InTab" Metallic Tab Brandmark
// Direct pixel-perfect render of the user-provided metallic 3D tab image
// ============================================================

import React from "react";
import { cn } from "@/lib/utils";

export interface InTabLogoProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  size?: number;
  className?: string;
  glow?: boolean;
}

export function InTabLogo({
  size = 28,
  className = "",
  glow = true,
  alt = "InTab Logo",
  style,
  ...props
}: InTabLogoProps) {
  return (
    <img
      src="/logo.png"
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      className={cn("object-contain select-none transition-transform duration-200", className)}
      style={{
        width: size,
        height: size,
        filter: glow ? "drop-shadow(0 2px 6px rgba(0, 0, 0, 0.45))" : undefined,
        ...style,
      }}
      {...props}
    />
  );
}

export default InTabLogo;
