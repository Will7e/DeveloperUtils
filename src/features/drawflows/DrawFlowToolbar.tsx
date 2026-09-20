// ============================================================
// DrawFlowToolbar — Standard InTab Tabs & Actions
// ============================================================

import { useCallback, useMemo } from "react";
import { WorkspaceTabBar, type TabItem } from "@/components/ui/WorkspaceTabBar";
import {
  Download,
  Upload,
  Trash2,
  FileImage,
  FileCode,
  GitFork,
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
import { useAppStore } from "@/stores/app.store";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";

interface DrawFlowToolbarProps {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}

export function DrawFlowToolbar({ excalidrawAPI }: DrawFlowToolbarProps) {

  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const createWorkflow = useAppStore((s) => s.createWorkflow);
  const duplicateWorkflow = useAppStore((s) => s.duplicateWorkflow);
  const deleteWorkflow = useAppStore((s) => s.deleteWorkflow);
  const closeOtherWorkflows = useAppStore((s) => s.closeOtherWorkflows);
  const closeWorkflowsToRight = useAppStore((s) => s.closeWorkflowsToRight);
  const closeAllWorkflows = useAppStore((s) => s.closeAllWorkflows);
  const setActiveWorkflow = useAppStore((s) => s.setActiveWorkflow);
  const renameWorkflow = useAppStore((s) => s.renameWorkflow);
  const updateWorkflowDrawFlow = useAppStore((s) => s.updateWorkflowDrawFlow || s.updateWorkflowExcalidraw);
  const addToast = useAppStore((s) => s.addToast);
  const reorderWorkflows = useAppStore((s) => s.reorderWorkflows);

  const activeWorkflow = workflows.find((w) => w.id === activeWorkflowId);

  const handleAddWorkflow = useCallback(() => {
    createWorkflow();
  }, [createWorkflow]);

  const handleClearCanvas = useCallback(() => {
    if (!excalidrawAPI) return;
    excalidrawAPI.resetScene();
    if (activeWorkflowId) {
      updateWorkflowDrawFlow(activeWorkflowId, []);
    }
    addToast({ message: "Canvas cleared", type: "info" });
  }, [excalidrawAPI, activeWorkflowId, updateWorkflowDrawFlow, addToast]);

  const handleExportJSON = useCallback(() => {
    if (!activeWorkflow || !excalidrawAPI) return;
    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    const files = excalidrawAPI.getFiles();

    const data = JSON.stringify(
      {
        type: "drawflow",
        version: 2,
        source: "InTab DrawFlow",
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
    link.download = `${activeWorkflow.name.replace(/\s+/g, "_").toLowerCase()}.drawflow`;
    link.click();
    URL.revokeObjectURL(url);
    addToast({ message: "DrawFlow exported as .drawflow", type: "success" });
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
      addToast({ message: "Exported high-res PNG image", type: "success" });
    } catch {
      addToast({ message: "Failed to export PNG", type: "error" });
    }
  }, [activeWorkflow, excalidrawAPI, addToast]);

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
      const serializer = new XMLSerializer();
      const svgStr = serializer.serializeToString(svg);
      const blob = new Blob([svgStr], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${activeWorkflow.name.replace(/\s+/g, "_").toLowerCase()}.svg`;
      link.click();
      URL.revokeObjectURL(url);
      addToast({ message: "Exported scalable SVG vector", type: "success" });
    } catch {
      addToast({ message: "Failed to export SVG", type: "error" });
    }
  }, [activeWorkflow, excalidrawAPI, addToast]);

  const handleImportJSON = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.drawflow,.excalidraw";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const elements = data.elements || (Array.isArray(data) ? data : []);
        const appState = data.appState || {};
        const files = data.files || {};
        const name = file.name.replace(/\.(json|drawflow|excalidraw)$/, "");

        createWorkflow(name, elements, appState, files);
        addToast({ message: `Imported "${name}" successfully`, type: "success" });
      } catch {
        addToast({ message: "Failed to parse diagram file — ensure it's valid JSON", type: "error" });
      }
    };
    input.click();
  }, [createWorkflow, addToast]);

  // Standardized Workspace Tabs
  const tabs: TabItem[] = useMemo(
    () =>
      workflows.map((w) => ({
        id: w.id,
        name: w.name,
        icon: (
          <span className="tab-icon text-accent">
            <GitFork className="w-3.5 h-3.5" />
          </span>
        ),
        closable: workflows.length > 1,
      })),
    [workflows]
  );

  const handleCopyTabContent = useCallback(
    (id: string) => {
      const wf = workflows.find((w) => w.id === id);
      if (wf) {
        const data = JSON.stringify(
          {
            type: "drawflow",
            version: 2,
            source: "InTab DrawFlow",
            elements: wf.elements || [],
            appState: wf.appState || {},
            name: wf.name,
          },
          null,
          2
        );
        navigator.clipboard.writeText(data);
        addToast({ message: `Copied ${wf.name} JSON to clipboard`, type: "success", duration: 1500 });
      }
    },
    [workflows, addToast]
  );

  const handleCopyTabName = useCallback(
    (id: string) => {
      const wf = workflows.find((w) => w.id === id);
      if (wf) {
        navigator.clipboard.writeText(wf.name);
        addToast({ message: "DrawFlow name copied", type: "info", duration: 1500 });
      }
    },
    [workflows, addToast]
  );

  return (
    <>
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId={activeWorkflowId || (workflows[0]?.id ?? "")}
        onSelectTab={setActiveWorkflow}
        onCloseTab={deleteWorkflow}
        onNewTab={handleAddWorkflow}
        onRenameTab={(id, newName) => renameWorkflow(id, newName)}
        onReorderTabs={(_activeId, _overId, oldIndex, newIndex) =>
          reorderWorkflows(oldIndex, newIndex)
        }
        onDuplicateTab={duplicateWorkflow}
        onCloseOthers={closeOtherWorkflows}
        onCloseToRight={closeWorkflowsToRight}
        onCloseAll={closeAllWorkflows}
        onCopyContent={handleCopyTabContent}
        onCopyName={handleCopyTabName}
        newTabTooltip="New DrawFlow Tab"
        rightContent={
          <>
            {/* Import Button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={handleImportJSON}
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Import</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Import .drawflow, .excalidraw or JSON diagram</TooltipContent>
            </Tooltip>

            {/* Consolidated Export Dropdown Menu */}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className="toolbar-btn">
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
                  <div className="w-7 h-7 rounded-md bg-[var(--blue-dim)] text-[var(--ds-blue-700)] flex items-center justify-center shrink-0">
                    <Download className="w-4 h-4" />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-medium text-text-1">DrawFlow JSON</span>
                    <span className="text-[10px] text-text-3 truncate">Editable InTab .drawflow project</span>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="tabs-toolbar-sep" />

            {/* Clear Canvas Button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="toolbar-btn hover:!text-[var(--ds-red-800)] hover:!border-[var(--ds-red-800)]/30"
                  onClick={handleClearCanvas}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Clear Canvas</TooltipContent>
            </Tooltip>
          </>
        }
      />
    </>
  );
}

export default DrawFlowToolbar;
