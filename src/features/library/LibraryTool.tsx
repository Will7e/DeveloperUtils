import React from "react";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryView } from "./LibraryView";
import { useResizable } from "@/hooks/useResizable";
import { cn } from "@/lib/utils";

export function LibraryTool() {
  const { size: sidebarWidth, containerRef, handleMouseDown, isDragging } = useResizable({
    direction: "horizontal",
    initialSize: 280,
    storageKey: "library-sidebar-width",
    minSize: 220,
    maxSize: 420,
    unit: "px"
  });

  return (
    <div 
      ref={containerRef}
      className={cn("lib-layout", isDragging && "lib-layout-dragging")}
    >
      {/* Sidebar */}
      <div className="lib-layout-sidebar" style={{ width: sidebarWidth }}>
        <LibrarySidebar />
      </div>

      {/* Resize Handle */}
      <div 
        className={cn(
          "lib-resize-handle",
          isDragging && "lib-resize-handle-active"
        )}
        onMouseDown={handleMouseDown}
      >
        <div className="lib-resize-handle-line" />
      </div>

      {/* Content */}
      <div className="lib-layout-content">
        <LibraryView />
      </div>
    </div>
  );
}
