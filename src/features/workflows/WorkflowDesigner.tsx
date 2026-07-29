// ============================================================
// WorkflowDesigner — Excalidraw Canvas Integration
// ============================================================

import { useCallback, useState, useEffect, useRef } from "react";
import { Excalidraw, MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useAppStore } from "@/stores/app.store";
import { WorkflowToolbar } from "./WorkflowToolbar";

export function WorkflowDesigner() {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);

  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const updateWorkflowExcalidraw = useAppStore((s) => s.updateWorkflowExcalidraw);

  const activeWorkflow = workflows.find((w) => w.id === activeWorkflowId);
  const lastSyncedId = useRef<string | null>(null);
  const saveTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync scene when active tab switches
  useEffect(() => {
    if (excalidrawAPI && activeWorkflow && activeWorkflowId !== lastSyncedId.current) {
      excalidrawAPI.updateScene({
        elements: activeWorkflow.elements || [],
        appState: (activeWorkflow.appState || {
          viewBackgroundColor: "#0f172a",
        }) as any,
      });
      lastSyncedId.current = activeWorkflowId;
    }
  }, [activeWorkflow, activeWorkflowId, excalidrawAPI]);

  // Debounced auto-save scene elements to Zustand store
  const handleChange = useCallback(
    (elements: readonly any[], appState: any) => {
      if (!activeWorkflowId) return;
      clearTimeout(saveTimeout.current);
      saveTimeout.current = setTimeout(() => {
        updateWorkflowExcalidraw(activeWorkflowId, [...elements], {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridSize: appState.gridSize,
          theme: appState.theme,
        });
      }, 300);
    },
    [activeWorkflowId, updateWorkflowExcalidraw]
  );

  return (
    <div className="wf-layout flex flex-col h-full w-full bg-bg-0">
      <WorkflowToolbar excalidrawAPI={excalidrawAPI} />
      <div className="wf-body flex-1 w-full h-[calc(100vh-4rem)] relative">
        <Excalidraw
          excalidrawAPI={(api) => setExcalidrawAPI(api)}
          onChange={handleChange}
          theme="dark"
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: true,
              clearCanvas: true,
              loadScene: true,
              saveToActiveFile: false,
              toggleTheme: true,
            },
          }}
        >
          <WelcomeScreen>
            <WelcomeScreen.Hints.MenuHint />
            <WelcomeScreen.Hints.ToolbarHint />
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Heading>
                DevUtils Workflow Designer
              </WelcomeScreen.Center.Heading>
              <WelcomeScreen.Center.Menu>
                <WelcomeScreen.Center.MenuItemHelp />
              </WelcomeScreen.Center.Menu>
            </WelcomeScreen.Center>
          </WelcomeScreen>
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </div>
    </div>
  );
}

export default WorkflowDesigner;
