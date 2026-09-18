/**
 * Utility to calculate exact, pixel-accurate coordinates for the virtual cursor.
 * Measures real DOM element bounds via getBoundingClientRect() relative to the parent container.
 */

export interface CursorPosition {
  x: number;
  y: number;
  isPercent?: boolean;
}

/**
 * Calculates the exact center pixel position of a target element relative to its container.
 * Falls back to percentage coordinates if elements are not mounted yet.
 */
export function getTargetCenter(
  container: HTMLElement | null,
  target: string | HTMLElement | null,
  fallback: { x: number; y: number } = { x: 50, y: 50 }
): CursorPosition {
  if (!container) {
    return { ...fallback, isPercent: true };
  }

  const el =
    typeof target === "string" ? container.querySelector<HTMLElement>(target) : target;

  if (!el) {
    return { ...fallback, isPercent: true };
  }

  const contRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();

  if (contRect.width === 0 || contRect.height === 0) {
    return { ...fallback, isPercent: true };
  }

  // Exact center of the target element relative to the container
  const x = Math.round(elRect.left + elRect.width / 2 - contRect.left);
  const y = Math.round(elRect.top + elRect.height / 2 - contRect.top);

  return { x, y, isPercent: false };
}
