import React, { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryView } from "./LibraryView";
import { useResizable } from "@/hooks/useResizable";
import { useAppStore } from "@/stores/app.store";
import { cn } from "@/lib/utils";

export function LibraryTool() {
  const [searchParams, setSearchParams] = useSearchParams();
  const libraryTab = useAppStore((s) => s.libraryTab);
  const setLibraryTab = useAppStore((s) => s.setLibraryTab);
  const selectedId = useAppStore((s) => s.librarySelectedItemId);
  const setSelectedId = useAppStore((s) => s.setLibrarySelectedItemId);

  const { size: sidebarWidth, containerRef, handleMouseDown, isDragging } = useResizable({
    direction: "horizontal",
    initialSize: 280,
    storageKey: "library-sidebar-width",
    minSize: 220,
    maxSize: 420,
    unit: "px"
  });

  // Sync initial URL params to store
  useEffect(() => {
    const urlTab = searchParams.get("tab");
    if (urlTab === "servicenow" || urlTab === "excalidraw") {
      if (urlTab !== libraryTab) {
        setLibraryTab(urlTab);
      }
    }
    const urlApi = searchParams.get("api");
    if (urlApi && urlApi !== selectedId) {
      setSelectedId(urlApi);
    }
  }, []);

  // Sync store state back to URL params
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    let changed = false;

    if (libraryTab && params.get("tab") !== libraryTab) {
      params.set("tab", libraryTab);
      changed = true;
    }

    if (selectedId && libraryTab === "servicenow") {
      if (params.get("api") !== selectedId) {
        params.set("api", selectedId);
        changed = true;
      }
    } else if (params.has("api")) {
      params.delete("api");
      changed = true;
    }

    if (changed) {
      setSearchParams(params, { replace: true });
    }
  }, [libraryTab, selectedId]);

  return (
    <div 
      ref={containerRef}
      className={cn("lib-layout", isDragging && "lib-layout-dragging")}
    >
      {/* Sidebar */}
      <div className="lib-layout-sidebar" style={{ width: `${sidebarWidth}px` }}>
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
