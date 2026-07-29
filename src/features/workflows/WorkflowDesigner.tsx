// ============================================================
// WorkflowDesigner — Standard Excalidraw Integration
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
  const appTheme = useAppStore((s) => s.editorSettings.theme);

  const activeWorkflow = workflows.find((w) => w.id === activeWorkflowId);
  const isUpdatingSceneRef = useRef<boolean>(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const isDark = appTheme !== "light";

  // Sync scene elements when active tab changes
  useEffect(() => {
    if (!excalidrawAPI || !activeWorkflow) return;

    isUpdatingSceneRef.current = true;
    excalidrawAPI.updateScene({
      elements: activeWorkflow.elements || [],
      appState: {
        theme: isDark ? "dark" : "light",
        ...(activeWorkflow.appState || {}),
      } as any,
    });

    const timer = setTimeout(() => {
      isUpdatingSceneRef.current = false;
    }, 100);

    return () => clearTimeout(timer);
  }, [activeWorkflowId, excalidrawAPI, isDark]);

  // Debounced handler for canvas changes
  const handleChange = useCallback(
    (elements: readonly any[], appState: any) => {
      if (!activeWorkflowId || isUpdatingSceneRef.current) return;

      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        if (isUpdatingSceneRef.current) return;
        updateWorkflowExcalidraw(activeWorkflowId, [...elements], {
          gridSize: appState.gridSize,
          viewBackgroundColor: appState.viewBackgroundColor,
        });
      }, 300);
    },
    [activeWorkflowId, updateWorkflowExcalidraw]
  );

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg-0">
      <WorkflowToolbar excalidrawAPI={excalidrawAPI} />
      <div className="flex-1 w-full relative overflow-hidden">
        <Excalidraw
          key={activeWorkflowId}
          excalidrawAPI={(api) => setExcalidrawAPI(api)}
          onChange={handleChange}
          theme={isDark ? "dark" : "light"}
          initialData={{
            elements: activeWorkflow?.elements || [],
            appState: {
              theme: isDark ? "dark" : "light",
              ...(activeWorkflow?.appState || {}),
            } as any,
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
          <WelcomeScreen>
            <WelcomeScreen.Hints.MenuHint />
            <WelcomeScreen.Hints.ToolbarHint />
            <WelcomeScreen.Hints.HelpHint />
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Heading>
                DevUtils Workflow & Diagram Studio
              </WelcomeScreen.Center.Heading>
              <WelcomeScreen.Center.Menu>
                <WelcomeScreen.Center.MenuItemLoadScene />
                <WelcomeScreen.Center.MenuItemHelp />
              </WelcomeScreen.Center.Menu>
            </WelcomeScreen.Center>
          </WelcomeScreen>
        </Excalidraw>
      </div>
    </div>
  );
}

export default WorkflowDesigner;
