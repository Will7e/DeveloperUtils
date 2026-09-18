// ============================================================
// Spinner — Branded InTab loader across all callers
// ============================================================

import React from "react";
import {
  InTabLoader,
  DevUtilsLoader,
  type InTabLoaderProps,
  type InTabLoaderSize,
} from "./intab-loader";

export type SpinnerSize = InTabLoaderSize;
export type SpinnerVariant = "accent" | "muted" | "white" | "current";

export interface SpinnerProps extends Omit<InTabLoaderProps, "size"> {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
}

export function Spinner({ size = "md", ...props }: SpinnerProps) {
  return <InTabLoader size={size} {...props} />;
}

export { InTabLoader, DevUtilsLoader };
export default Spinner;
