// ============================================================
// DrawFlowToolbar — Clean top tab bar & actions for DrawFlows
// ============================================================

import { useCallback, useState, useRef, useEffect } from "react";
import { DndContext, closestCenter, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { SortableTab } from "@/components/ui/SortableTab";
import {
  Download,
  Upload,
  Plus,
  Trash2,
  FileImage,
  FileCode,
  Library,
  Sparkles,
  ChevronDown,
  FileJson,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import { ExcalidrawLibraryModal } from "./ExcalidrawLibraryModal";

interface DrawFlowToolbarProps {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}

export function DrawFlowToolbar({ excalidrawAPI }: DrawFlowToolbarProps) {
  const [isLibraryModalOpen, setIsLibraryModalOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const createWorkflow = useAppStore((s) => s.createWorkflow);
  const deleteWorkflow = useAppStore((s) => s.deleteWorkflow);
  const setActiveWorkflow = useAppStore((s) => s.setActiveWorkflow);
  const renameWorkflow = useAppStore((s) => s.renameWorkflow);
  const updateWorkflowExcalidraw = useAppStore((s) => s.updateWorkflowExcalidraw);
  const addToast = useAppStore((s) => s.addToast);
  const reorderWorkflows = useAppStore((s) => s.reorderWorkflows);

  const activeWorkflow = workflows.find((w) => w.id === activeWorkflowId);

  // Close export dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(event.target as Node)) {
        setIsExportOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleClearCanvas = useCallback(() => {
    if (!excalidrawAPI) return;
    excalidrawAPI.resetScene();
    if (activeWorkflowId) {
      updateWorkflowExcalidraw(activeWorkflowId, []);
    }
    addToast({ message: "Canvas cleared", type: "info" });
  }, [excalidrawAPI, activeWorkflowId, updateWorkflowExcalidraw, addToast]);

  const handleExportJSON = useCallback(() => {
    if (!activeWorkflow || !excalidrawAPI) return;
    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();

    const data = JSON.stringify(
      {
        type: "excalidraw",
        version: 2,
        source: "DeveloperUtils DrawFlow",
        elements,
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridSize: appState.gridSize,
        },
        name: activeWorkflow.name,
      },
      null,
      2
    );

    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeWorkflow.name.replace(/\s+/g, "_").toLowerCase()}.excalidraw`;
    link.click();
    URL.revokeObjectURL(url);
    addToast({ message: "DrawFlow exported as JSON", type: "success" });
  }, [activeWorkflow, excalidrawAPI, addToast]);

  const handleExportPNG = useCallback(async () => {
    if (!excalidrawAPI || !activeWorkflow) return;
    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    if (elements.length === 0) {
      addToast({ message: "Canvas is empty", type: "error" });
      return;
    }
    try {
      const blob = await exportToBlob({
        elements,
        appState,
        files: excalidrawAPI.getFiles(),
        mimeType: "image/png",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${activeWorkflow.name.replace(/\s+/g, "_").toLowerCase()}.png`;
      link.click();
      URL.revokeObjectURL(url);
      addToast({ message: "Exported PNG image", type: "success" });
    } catch {
      addToast({ message: "Failed to export PNG", type: "error" });
    }
  }, [excalidrawAPI, activeWorkflow, addToast]);

  const handleExportSVG = useCallback(async () => {
    if (!excalidrawAPI || !activeWorkflow) return;
    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    if (elements.length === 0) {
      addToast({ message: "Canvas is empty", type: "error" });
      return;
    }
    try {
      const svg = await exportToSvg({
        elements,
        appState,
        files: excalidrawAPI.getFiles(),
      });
      const svgString = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([svgString], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${activeWorkflow.name.replace(/\s+/g, "_").toLowerCase()}.svg`;
      link.click();
      URL.revokeObjectURL(url);
      addToast({ message: "Exported SVG vector image", type: "success" });
    } catch {
      addToast({ message: "Failed to export SVG", type: "error" });
    }
  }, [excalidrawAPI, activeWorkflow, addToast]);

  const handleImportJSON = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.excalidraw";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          const elements = data.elements || (Array.isArray(data) ? data : []);
          if (Array.isArray(elements)) {
            createWorkflow(data.name || file.name.replace(/\.(json|excalidraw)$/i, ""));
            setTimeout(() => {
              const state = useAppStore.getState();
              const newId = state.activeWorkflowId;
              updateWorkflowExcalidraw(newId, elements, data.appState);
              if (excalidrawAPI) {
                excalidrawAPI.updateScene({ elements, appState: data.appState });
              }
              addToast({ message: "DrawFlow imported successfully", type: "success" });
            }, 50);
          }
        } catch {
          addToast({ message: "Invalid JSON file format", type: "error" });
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [createWorkflow, updateWorkflowExcalidraw, excalidrawAPI, addToast]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = workflows.findIndex((w) => w.id === active.id);
    const newIndex = workflows.findIndex((w) => w.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      reorderWorkflows(oldIndex, newIndex);
    }
  }, [workflows, reorderWorkflows]);

  const handleAddWorkflow = useCallback(() => {
    createWorkflow();
  }, [createWorkflow]);

  return (
    <>
      <div className="wf-toolbar border-b border-border/40 bg-bg-1/90 backdrop-blur-md px-3 py-1.5 flex items-center justify-between gap-3 shrink-0">
        <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto">
          {/* Workflow Tabs */}
          <div className="wf-toolbar-tabs flex items-center gap-1">
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={workflows.map((w) => w.id)} strategy={horizontalListSortingStrategy}>
                {workflows.map((w) => (
                  <SortableTab key={w.id} id={w.id}>
                    <button
                      className={`wf-toolbar-tab ${w.id === activeWorkflowId ? "wf-toolbar-tab-active" : ""}`}
                      onClick={() => setActiveWorkflow(w.id)}
                      onDoubleClick={() => {
                        setRenamingId(w.id);
                        setRenameValue(w.name);
                      }}
                    >
                      {renamingId === w.id ? (
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => {
                            if (renameValue.trim()) renameWorkflow(w.id, renameValue.trim());
                            setRenamingId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              if (renameValue.trim()) renameWorkflow(w.id, renameValue.trim());
                              setRenamingId(null);
                            }
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          autoFocus
                          className="wf-tab-rename-input"
                        />
                      ) : (
                        <span className="wf-tab-name">{w.name}</span>
                      )}
                      {workflows.length > 1 && (
                        <span
                          className="wf-tab-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteWorkflow(w.id);
                          }}
                        >
                          ×
                        </span>
                      )}
                    </button>
                  </SortableTab>
                ))}
              </SortableContext>
            </DndContext>

            <Tooltip>
              <TooltipTrigger asChild>
                <button className="wf-toolbar-btn wf-add-tab-btn" onClick={handleAddWorkflow}>
                  <Plus className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>New DrawFlow Tab</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Right side actions */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          {/* Community Libraries Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  padding: "6px 12px",
                  borderRadius: "8px",
                  backgroundColor: "rgba(14, 165, 233, 0.12)",
                  color: "var(--accent)",
                  border: "1px solid rgba(14, 165, 233, 0.3)",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
                onClick={() => {
                  setIsLibraryModalOpen(true);
                  if (excalidrawAPI) {
                    try {
                      excalidrawAPI.updateScene({
                        appState: {
                          openSidebar: { name: "library", tab: "libraries" },
                        } as any,
                      });
                    } catch {
                      // Fallback
                    }
                  }
                }}
              >
                <Sparkles style={{ width: 14, height: 14, color: "var(--accent)" }} />
                <span>Community Libraries</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Browse & Download Official Excalidraw Shapes</TooltipContent>
          </Tooltip>

          <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border-1)", margin: "0 2px" }} />

          {/* Import Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                style={{
                  fontSize: "12px",
                  fontWeight: 500,
                  padding: "6px 12px",
                  borderRadius: "8px",
                  backgroundColor: "var(--bg-2)",
                  color: "var(--text-1)",
                  border: "1px solid var(--border-1)",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
                onClick={handleImportJSON}
              >
                <Upload style={{ width: 14, height: 14, color: "var(--text-2)" }} />
                <span>Import</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Import .excalidraw or JSON file</TooltipContent>
          </Tooltip>

          <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border-1)", margin: "0 2px" }} />

          {/* Export Group (PNG, SVG, JSON) */}
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    padding: "5px 10px",
                    borderRadius: "6px",
                    backgroundColor: "rgba(16, 185, 129, 0.12)",
                    color: "#10b981",
                    border: "1px solid rgba(16, 185, 129, 0.3)",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                  onClick={handleExportPNG}
                >
                  <FileImage style={{ width: 13, height: 13 }} />
                  <span>PNG</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Export PNG Image</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    padding: "5px 10px",
                    borderRadius: "6px",
                    backgroundColor: "rgba(6, 182, 212, 0.12)",
                    color: "#06b6d4",
                    border: "1px solid rgba(6, 182, 212, 0.3)",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                  onClick={handleExportSVG}
                >
                  <FileCode style={{ width: 13, height: 13 }} />
                  <span>SVG</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Export Vector SVG</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    padding: "5px 10px",
                    borderRadius: "6px",
                    backgroundColor: "rgba(14, 165, 233, 0.12)",
                    color: "#0ea5e9",
                    border: "1px solid rgba(14, 165, 233, 0.3)",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                  onClick={handleExportJSON}
                >
                  <Download style={{ width: 13, height: 13 }} />
                  <span>JSON</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Export .excalidraw JSON</TooltipContent>
            </Tooltip>
          </div>

          <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border-1)", margin: "0 2px" }} />

          {/* Clear Canvas Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                style={{
                  padding: "6px",
                  borderRadius: "8px",
                  color: "var(--text-3)",
                  backgroundColor: "transparent",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.15s ease",
                }}
                onClick={handleClearCanvas}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "#f43f5e";
                  e.currentTarget.style.backgroundColor = "rgba(244, 63, 94, 0.1)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-3)";
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <Trash2 style={{ width: 16, height: 16 }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Clear Canvas</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Library Catalog Modal */}
      <ExcalidrawLibraryModal
        isOpen={isLibraryModalOpen}
        onClose={() => setIsLibraryModalOpen(false)}
        excalidrawAPI={excalidrawAPI}
      />
    </>
  );
}
