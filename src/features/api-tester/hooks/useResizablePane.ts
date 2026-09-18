import { useState, useRef, useCallback } from "react";

interface UseResizablePaneOptions {
  initialHeight?: number;
  minHeight?: number;
  maxHeight?: number;
}

export function useResizablePane({
  initialHeight = 280,
  minHeight = 120,
  maxHeight = 600,
}: UseResizablePaneOptions = {}) {
  const [paneHeight, setPaneHeight] = useState(initialHeight);
  const splitRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const [isDraggingActive, setIsDraggingActive] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      isDragging.current = true;
      setIsDraggingActive(true);
      dragStartY.current = e.clientY;
      dragStartHeight.current = paneHeight;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      const handleMove = (moveE: MouseEvent) => {
        if (!isDragging.current) return;
        const delta = moveE.clientY - dragStartY.current;
        const newHeight = Math.max(
          minHeight,
          Math.min(maxHeight, dragStartHeight.current + delta)
        );
        setPaneHeight(newHeight);
      };

      const handleUp = () => {
        isDragging.current = false;
        setIsDraggingActive(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [paneHeight, minHeight, maxHeight]
  );

  return {
    paneHeight,
    setPaneHeight,
    splitRef,
    isDraggingActive,
    handleResizeStart,
  };
}
