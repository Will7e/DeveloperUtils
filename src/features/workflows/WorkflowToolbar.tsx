// ============================================================
// WorkflowToolbar — Top toolbar for workflow actions
// ============================================================

import { useCallback } from "react";
import {
  Download,
  Upload,
  Plus,
  Trash2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Map,
  MapPinOff,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";

interface WorkflowToolbarProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  onClearCanvas: () => void;
  showMinimap: boolean;
  onToggleMinimap: () => void;
}

export function WorkflowToolbar({
  onZoomIn,
  onZoomOut,
  onFitView,
  onClearCanvas,
  showMinimap,
  onToggleMinimap,
}: WorkflowToolbarProps) {
  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const createWorkflow = useAppStore((s) => s.createWorkflow);
  const deleteWorkflow = useAppStore((s) => s.deleteWorkflow);
  const setActiveWorkflow = useAppStore((s) => s.setActiveWorkflow);
  const renameWorkflow = useAppStore((s) => s.renameWorkflow);
  const updateWorkflowNodes = useAppStore((s) => s.updateWorkflowNodes);
  const updateWorkflowEdges = useAppStore((s) => s.updateWorkflowEdges);
  const addToast = useAppStore((s) => s.addToast);

  const activeWorkflow = workflows.find((w) => w.id === activeWorkflowId);

  const handleExportJSON = useCallback(() => {
    if (!activeWorkflow) return;
    const data = JSON.stringify(
      {
        name: activeWorkflow.name,
        nodes: activeWorkflow.nodes,
        edges: activeWorkflow.edges,
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    );
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeWorkflow.name.replace(/\s+/g, "_").toLowerCase()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    addToast({ message: "Workflow exported as JSON", type: "success" });
  }, [activeWorkflow, addToast]);

  const handleImportJSON = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          if (data.nodes && data.edges) {
            createWorkflow(data.name || "Imported Workflow");
            // Wait for state update, then set nodes/edges
            setTimeout(() => {
              const state = useAppStore.getState();
              const newId = state.activeWorkflowId;
              updateWorkflowNodes(newId, data.nodes);
              updateWorkflowEdges(newId, data.edges);
              addToast({ message: "Workflow imported successfully", type: "success" });
            }, 50);
          }
        } catch {
          addToast({ message: "Invalid JSON file", type: "error" });
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [createWorkflow, updateWorkflowNodes, updateWorkflowEdges, addToast]);

  return (
    <div className="wf-toolbar">
      <div className="wf-toolbar-left">
        {/* Workflow Tabs */}
        <div className="wf-toolbar-tabs">
          {workflows.map((w) => (
            <button
              key={w.id}
              className={`wf-toolbar-tab ${w.id === activeWorkflowId ? "wf-toolbar-tab-active" : ""}`}
              onClick={() => setActiveWorkflow(w.id)}
              onDoubleClick={() => {
                const name = prompt("Rename workflow:", w.name);
                if (name?.trim()) renameWorkflow(w.id, name.trim());
              }}
            >
              <span className="wf-toolbar-tab-name">{w.name}</span>
              {workflows.length > 1 && (
                <button
                  className="wf-toolbar-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteWorkflow(w.id);
                  }}
                >
                  ×
                </button>
              )}
            </button>
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="wf-toolbar-tab-add" onClick={() => createWorkflow()}>
                <Plus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>New Workflow</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="wf-toolbar-right">
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn" onClick={onZoomIn}>
              <ZoomIn className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Zoom In</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn" onClick={onZoomOut}>
              <ZoomOut className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Zoom Out</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn" onClick={onFitView}>
              <Maximize2 className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Fit View</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={`wf-toolbar-btn ${showMinimap ? 'wf-toolbar-btn-active' : ''}`}
              onClick={onToggleMinimap}
            >
              {showMinimap ? <Map className="h-4 w-4" /> : <MapPinOff className="h-4 w-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{showMinimap ? 'Hide Minimap' : 'Show Minimap'}</TooltipContent>
        </Tooltip>

        <div className="wf-toolbar-sep" />

        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn" onClick={handleImportJSON}>
              <Upload className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Import JSON</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn" onClick={handleExportJSON}>
              <Download className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Export JSON</TooltipContent>
        </Tooltip>

        <div className="wf-toolbar-sep" />

        <Tooltip>
          <TooltipTrigger asChild>
            <button className="wf-toolbar-btn wf-toolbar-btn-danger" onClick={onClearCanvas}>
              <Trash2 className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Clear Canvas</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
