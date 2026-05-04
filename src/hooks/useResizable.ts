import { useState, useCallback, useRef, useEffect } from "react";

interface UseResizableOptions {
  direction: "horizontal" | "vertical";
  initialSize: number;   // percentage (0-100)
  minSize?: number;      // percentage
  maxSize?: number;      // percentage
  storageKey?: string;
}

export function useResizable({
  direction,
  initialSize,
  minSize = 15,
  maxSize = 70,
  storageKey,
}: UseResizableOptions) {
  const [size, setSize] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) return Number(saved);
    }
    return initialSize;
  });

  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging.current || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        let pct: number;
        if (direction === "horizontal") {
          pct = ((e.clientX - rect.left) / rect.width) * 100;
        } else {
          pct = ((e.clientY - rect.top) / rect.height) * 100;
        }
        pct = Math.max(minSize, Math.min(maxSize, pct));
        setSize(pct);
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [direction, minSize, maxSize]
  );

  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, String(size));
    }
  }, [size, storageKey]);

  return { size, setSize, containerRef, handleMouseDown, isDragging };
}
