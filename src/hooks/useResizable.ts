import { useState, useCallback, useRef, useEffect } from "react";

interface UseResizableOptions {
  direction: "horizontal" | "vertical";
  initialSize: number;
  minSize?: number;
  maxSize?: number;
  storageKey?: string;
  unit?: "px" | "%";
}

export function useResizable({
  direction,
  initialSize,
  minSize = 15,
  maxSize = 85,
  storageKey,
  unit = "%",
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
      
      let val: number;
      if (unit === "%") {
        if (direction === "horizontal") {
          val = ((e.clientX - rect.left) / rect.width) * 100;
        } else {
          val = ((e.clientY - rect.top) / rect.height) * 100;
        }
      } else {
        if (direction === "horizontal") {
          val = e.clientX - rect.left;
        } else {
          val = e.clientY - rect.top;
        }
      }
      
      val = Math.max(minSize, Math.min(maxSize, val));
      setSize(val);
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
  }, [isDragging, direction, minSize, maxSize, unit]);

  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, String(size));
    }
  }, [size, storageKey]);

  return { size, setSize, containerRef, handleMouseDown, isDragging };
}
