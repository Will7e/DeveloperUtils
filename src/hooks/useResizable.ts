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
  maxSize = 85,
  storageKey,
}: UseResizableOptions) {
  const [size, setSize] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) return Number(saved);
    }
    return initialSize;
  });

  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
    },
    []
  );

  useEffect(() => {
    if (!isDragging) return;

    // Add a full-screen overlay to prevent iframes from stealing events
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      cursor: ${direction === "horizontal" ? "col-resize" : "row-resize"};
    `;
    document.body.appendChild(overlay);
    document.body.style.userSelect = "none";

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
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
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.body.removeChild(overlay);
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, direction, minSize, maxSize]);

  // Persist to localStorage
  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, String(size));
    }
  }, [size, storageKey]);

  return { size, setSize, containerRef, handleMouseDown, isDragging };
}
