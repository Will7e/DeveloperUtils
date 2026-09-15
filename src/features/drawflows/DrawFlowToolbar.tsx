// ============================================================
// DrawFlowToolbar — Standard DeveloperUtils Tabs & Actions
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
  Sparkles,
  GitFork,
  X,
  ChevronDown,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import { ExcalidrawLibraryModal } from "./ExcalidrawLibraryModal";

interface DrawFlowToolbarProps {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}

export function DrawFlowToolbar({ excalidrawAPI }: DrawFlowToolbarProps) {
  const [isLibraryModalOpen, setIsLibraryModalOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

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
    const files = excalidrawAPI.getFiles();

    const data = JSON.stringify(
      {
        type: "excalidraw",
        version: 2,
        source: "DeveloperUtils DrawFlow",
        elements,
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridSize: appState.gridSize,
          theme: appState.theme,
        },
        files,
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
    addToast({ message: "DrawFlow exported as .excalidraw", type: "success" });
  }, [activeWorkflow, excalidrawAPI, addToast]);

  const handleExportPNG = useCallback(async () => {
    if (!excalidrawAPI || !activeWorkflow) return;
    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    if (!elements || elements.length === 0) {
      addToast({ message: "Canvas is empty — draw something before exporting", type: "info" });
      return;
    }
    try {
      const blob = await exportToBlob({
        elements,
        appState: {
          ...appState,
          exportWithDarkMode: appState.theme === "dark",
        },
        files: excalidrawAPI.getFiles(),
        mimeType: "image/png",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${activeWorkflow.name.replace(/\s+/g, "_").toLowerCase()}.png`;
      link.click();
      URL.revokeObjectURL(url);
      addToast({ message: "Exported PNG image successfully", type: "success" });
    } catch (err) {
      console.error("Export PNG error:", err);
      addToast({ message: "Failed to export PNG", type: "error" });
    }
  }, [excalidrawAPI, activeWorkflow, addToast]);

  const handleExportSVG = useCallback(async () => {
    if (!excalidrawAPI || !activeWorkflow) return;
    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    if (!elements || elements.length === 0) {
      addToast({ message: "Canvas is empty — draw something before exporting", type: "info" });
      return;
    }
    try {
      const svg = await exportToSvg({
        elements,
        appState: {
          ...appState,
          exportWithDarkMode: appState.theme === "dark",
        },
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
      addToast({ message: "Exported SVG vector image successfully", type: "success" });
    } catch (err) {
      console.error("Export SVG error:", err);
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
          const content = ev.target?.result as string;
          const data = JSON.parse(content);
          const elements = data.elements || (Array.isArray(data) ? data : []);
          const appState = data.appState || {};
          const files = data.files || {};
          const name = data.name || file.name.replace(/\.(json|excalidraw)$/i, "");

          if (Array.isArray(elements)) {
            createWorkflow(name, elements, appState, files);
            if (excalidrawAPI) {
              excalidrawAPI.updateScene({ elements, appState });
              if (files && Object.keys(files).length > 0) {
                excalidrawAPI.addFiles(Object.values(files) as Parameters<typeof excalidrawAPI.addFiles>[0]);
              }
            }
            addToast({ message: `Imported "${name}" successfully`, type: "success" });
          } else {
            addToast({ message: "Invalid Excalidraw format: elements missing", type: "error" });
          }
        } catch (err) {
          console.error("Import error:", err);
          addToast({ message: "Invalid JSON file format", type: "error" });
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [createWorkflow, excalidrawAPI, addToast]);

  return (
    <>
      <div className="tabs-bar">
        {/* Left Side: Workflow Tabs */}
        <div className="tabs-list">
          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={workflows.map((w) => w.id)} strategy={horizontalListSortingStrategy}>
              {workflows.map((w) => (
                <SortableTab key={w.id} id={w.id}>
                  <button
                    className={cn("tab", w.id === activeWorkflowId && "tab-active")}
                    onClick={() => setActiveWorkflow(w.id)}
                    onDoubleClick={() => {
                      setRenamingId(w.id);
                      setRenameValue(w.name);
                    }}
                  >
                    <span className="tab-icon text-accent">
                      <GitFork className="w-3.5 h-3.5" />
                    </span>

                    {renamingId === w.id ? (
                      <input
                        type="text"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => {
                          if (renameValue.trim() && renameValue !== w.name) {
                            renameWorkflow(w.id, renameValue.trim());
                          }
                          setRenamingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            if (renameValue.trim() && renameValue !== w.name) {
                              renameWorkflow(w.id, renameValue.trim());
                            }
                            setRenamingId(null);
                          }
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                        className="tab-rename-input"
                      />
                    ) : (
                      <span className="tab-name">{w.name}</span>
                    )}

                    {workflows.length > 1 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="tab-close"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteWorkflow(w.id);
                            }}
                          >
                            <X className="w-3 h-3" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>Close Tab</TooltipContent>
                      </Tooltip>
                    )}
                  </button>
                </SortableTab>
              ))}
            </SortableContext>
          </DndContext>

          <Tooltip>
            <TooltipTrigger asChild>
              <button className="tab-new" onClick={handleAddWorkflow}>
                <Plus className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>New DrawFlow Tab</TooltipContent>
          </Tooltip>
        </div>

        {/* Right Side: Consolidated Action Buttons (No Overflow) */}
        <div className="tabs-toolbar">
          {/* Community Libraries Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-btn toolbar-btn-primary"
                onClick={() => setIsLibraryModalOpen(true)}
              >
                <Sparkles className="w-3.5 h-3.5 text-white" />
                <span>Community Libraries</span>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-white/20 text-white ml-0.5">
                  230+
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Browse & Download Official Excalidraw Shape Packs</TooltipContent>
          </Tooltip>

          <div className="tabs-toolbar-sep" />

          {/* Import Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="toolbar-btn" onClick={handleImportJSON}>
                <Upload className="w-3.5 h-3.5" />
                <span>Import</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Import .excalidraw or JSON diagram</TooltipContent>
          </Tooltip>

          {/* Consolidated Export Dropdown Menu */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button className="toolbar-btn">
                    <Download className="w-3.5 h-3.5 text-accent" />
                    <span>Export</span>
                    <ChevronDown className="w-3 h-3 opacity-50 ml-0.5" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Export Canvas (PNG, SVG, JSON)</TooltipContent>
            </Tooltip>

            <DropdownMenuContent align="end" className="w-56 p-1.5">
              <DropdownMenuLabel className="text-[10px] font-semibold tracking-wider text-text-3 uppercase px-2 py-1">
                Export Canvas
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="my-1" />

              <DropdownMenuItem onClick={handleExportPNG} className="cursor-pointer gap-2.5 px-2 py-2 rounded-md">
                <div className="w-7 h-7 rounded-md bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                  <FileImage className="w-4 h-4" />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-medium text-text-1">PNG Image</span>
                  <span className="text-[10px] text-text-3 truncate">Raster snapshot with dark mode</span>
                </div>
              </DropdownMenuItem>

              <DropdownMenuItem onClick={handleExportSVG} className="cursor-pointer gap-2.5 px-2 py-2 rounded-md">
                <div className="w-7 h-7 rounded-md bg-cyan-500/15 text-cyan-400 flex items-center justify-center shrink-0">
                  <FileCode className="w-4 h-4" />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-medium text-text-1">SVG Vector</span>
                  <span className="text-[10px] text-text-3 truncate">Scalable resolution-independent vector</span>
                </div>
              </DropdownMenuItem>

              <DropdownMenuItem onClick={handleExportJSON} className="cursor-pointer gap-2.5 px-2 py-2 rounded-md">
                <div className="w-7 h-7 rounded-md bg-sky-500/15 text-sky-400 flex items-center justify-center shrink-0">
                  <Download className="w-4 h-4" />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-medium text-text-1">Excalidraw JSON</span>
                  <span className="text-[10px] text-text-3 truncate">Editable DevUtils .excalidraw project</span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="tabs-toolbar-sep" />

          {/* Clear Canvas Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-btn hover:!text-red-400 hover:!border-red-500/30"
                onClick={handleClearCanvas}
              >
                <Trash2 className="w-3.5 h-3.5" />
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

export default DrawFlowToolbar;
