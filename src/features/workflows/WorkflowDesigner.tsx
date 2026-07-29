// ============================================================
// WorkflowDesigner — Excalidraw Canvas Integration
// Dynamic Light/Dark Theme Synchronization
// ============================================================

import { useCallback, useState, useEffect, useRef } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useAppStore } from "@/stores/app.store";
import { WorkflowToolbar } from "./WorkflowToolbar";

export function WorkflowDesigner() {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);

  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const updateWorkflowExcalidraw = useAppStore((s) => s.updateWorkflowExcalidraw);
  const appTheme = useAppStore((s) => s.editorSettings.theme);

  const activeWorkflow = workflows.find((w) => w.id === activeWorkflowId);
  const isUpdatingSceneRef = useRef<boolean>(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const isDark = appTheme !== "light";

  // Dynamic theme sync helper (synced with DevUtils website theme)
  const syncSceneToApi = useCallback(
    (api: ExcalidrawImperativeAPI, workflowId: string) => {
      const targetWorkflow = useAppStore.getState().workflows.find((w) => w.id === workflowId);
      if (!targetWorkflow) return;

      isUpdatingSceneRef.current = true;
      const currentIsDark = useAppStore.getState().editorSettings.theme !== "light";

      api.updateScene({
        elements: targetWorkflow.elements || [],
        appState: {
          viewBackgroundColor: "#ffffff",
          theme: currentIsDark ? "dark" : "light",
        } as any,
      });

      const timer = setTimeout(() => {
        isUpdatingSceneRef.current = false;
      }, 150);

      return () => clearTimeout(timer);
    },
    []
  );

  // Sync scene when excalidrawAPI is ready, active tab changes, or app theme toggles
  useEffect(() => {
    if (excalidrawAPI && activeWorkflowId) {
      syncSceneToApi(excalidrawAPI, activeWorkflowId);
    }
  }, [activeWorkflowId, excalidrawAPI, appTheme, syncSceneToApi]);

  // Debounced handler for canvas changes (saves to store 500ms after drawing stops)
  const handleChange = useCallback(
    (elements: readonly any[], appState: any) => {
      if (!activeWorkflowId || isUpdatingSceneRef.current) return;

      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        if (isUpdatingSceneRef.current) return;
        const currentIsDark = useAppStore.getState().editorSettings.theme !== "light";

        updateWorkflowExcalidraw(activeWorkflowId, [...elements], {
          viewBackgroundColor: "#ffffff",
          gridSize: appState.gridSize,
          theme: currentIsDark ? "dark" : "light",
        });
      }, 500);
    },
    [activeWorkflowId, updateWorkflowExcalidraw]
  );

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg-0">
      <WorkflowToolbar excalidrawAPI={excalidrawAPI} />
      <div className="flex-1 w-full relative overflow-hidden">
        <Excalidraw
          excalidrawAPI={(api) => {
            setExcalidrawAPI(api);
            if (activeWorkflowId) {
              syncSceneToApi(api, activeWorkflowId);
            }
          }}
          onChange={handleChange}
          theme={isDark ? "dark" : "light"}
          initialData={{
            elements: activeWorkflow?.elements || [],
            appState: {
              viewBackgroundColor: "#ffffff",
              theme: isDark ? "dark" : "light",
            } as any,
          }}
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: true,
              clearCanvas: true,
              loadScene: true,
              saveToActiveFile: false,
              toggleTheme: false,
            },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </div>
    </div>
  );
}

export default WorkflowDesigner;
