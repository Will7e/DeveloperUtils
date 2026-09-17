// ============================================================
// Spinner — Deprecated circular spinner replaced with DevUtilsLoader
// Replaces circular spinners with the official DevUtils loader across all callers
// ============================================================

import React from "react";
import {
  DevUtilsLoader,
  type DevUtilsLoaderProps,
  type DevUtilsLoaderSize,
} from "./devutils-loader";

export type SpinnerSize = DevUtilsLoaderSize;
export type SpinnerVariant = "accent" | "muted" | "white" | "current";

export interface SpinnerProps extends Omit<DevUtilsLoaderProps, "size"> {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
}

export function Spinner({ size = "md", ...props }: SpinnerProps) {
  return <DevUtilsLoader size={size} {...props} />;
}

export { DevUtilsLoader };
export default Spinner;
