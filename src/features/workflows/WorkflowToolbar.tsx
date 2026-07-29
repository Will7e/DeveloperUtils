// ============================================================
// WorkflowToolbar — Clean top tab bar & actions for Workflows
// ============================================================

import { useCallback, useState } from "react";
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
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";

interface WorkflowToolbarProps {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}

export function WorkflowToolbar({ excalidrawAPI }: WorkflowToolbarProps) {
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
        source: "DeveloperUtils Workflow",
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
    addToast({ message: "Workflow exported as Excalidraw JSON", type: "success" });
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
              addToast({ message: "Workflow imported successfully", type: "success" });
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
            <TooltipContent>New Workflow Tab</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Right side actions */}
      <div className="flex items-center gap-1 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn" onClick={handleExportPNG}>
              <FileImage className="w-4 h-4 text-emerald-400" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Export PNG Image</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn" onClick={handleExportSVG}>
              <FileCode className="w-4 h-4 text-cyan-400" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Export Vector SVG</TooltipContent>
        </Tooltip>

        <div className="wf-toolbar-divider" />

        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn" onClick={handleExportJSON}>
              <Download className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Export Excalidraw JSON</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn" onClick={handleImportJSON}>
              <Upload className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Import JSON Canvas</TooltipContent>
        </Tooltip>

        <div className="wf-toolbar-divider" />

        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn text-rose-400 hover:bg-rose-500/10" onClick={handleClearCanvas}>
              <Trash2 className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Clear Canvas</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
