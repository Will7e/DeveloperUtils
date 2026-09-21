// ============================================================
// useSkeletonVisibility — Flash Guard for Skeleton Placeholders
// ============================================================
// Prevents the two classic skeleton problems on fast loads:
//  - Delay: the skeleton does not appear until `delayMs` have
//    elapsed in the pending state (fast loads never show it).
//  - Minimum display: once shown, it stays at least `minMs` so a
//    skeleton that flashes for 50ms does not read as a glitch.
//
// Returns true only while the skeleton should be mounted.

import { useEffect, useRef, useState } from "react";

export function useSkeletonVisibility(
  pending: boolean,
  { delayMs = 250, minMs = 400 }: { delayMs?: number; minMs?: number } = {}
): boolean {
  const [visible, setVisible] = useState(false);

  // Timestamps of when pending started/stopped for this run
  const startedAtRef = useRef(0);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pending) {
      startedAtRef.current = Date.now();
      showTimerRef.current = setTimeout(() => {
        setVisible(true);
      }, delayMs);
    } else if (startedAtRef.current !== 0) {
      const elapsed = Date.now() - startedAtRef.current;
      startedAtRef.current = 0;

      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }

      if (visible) {
        // Skeleton was shown — honor the minimum display window
        const remaining = Math.max(0, minMs - elapsed);
        hideTimerRef.current = setTimeout(() => {
          setVisible(false);
          hideTimerRef.current = null;
        }, remaining);
      }
      // Hidden before the delay: skeleton never appeared — nothing to do
    }

    return () => {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, delayMs, minMs]);

  return visible;
}
