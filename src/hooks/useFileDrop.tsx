// ============================================================
// useFileDrop — Shared drag & drop for tool surfaces
// ============================================================
// Attach the returned handlers to any container element to accept
// dropped files. The hook tracks nested dragenter/dragleave pairs
// with a depth counter so hovering children never flickers the
// overlay off. Pair with <DropOverlay> (./DropOverlay.tsx) for the
// visual affordance.

import { useCallback, useRef, useState } from "react";

export interface UseFileDropResult {
  /** True while files are dragged over the element */
  isOver: boolean;
  /** Spread onto the container element */
  dropHandlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

export function useFileDrop(
  onFiles: (files: File[]) => void,
  disabled = false
): UseFileDropResult {
  const [isOver, setIsOver] = useState(false);
  const depthRef = useRef(0);

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      depthRef.current += 1;
      setIsOver(true);
    },
    [disabled]
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      // Required on every dragover tick for the drop to be allowed
      e.preventDefault();
    },
    [disabled]
  );

  const onDragLeave = useCallback(() => {
    if (disabled) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setIsOver(false);
  }, [disabled]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      depthRef.current = 0;
      setIsOver(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files);
    },
    [disabled, onFiles]
  );

  return {
    isOver,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
