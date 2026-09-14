// ============================================================
// DrawFlowDesigner — Standard Excalidraw Integration
// ============================================================

import { useCallback, useState, useEffect, useRef } from "react";
import { Excalidraw, MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useAppStore } from "@/stores/app.store";
import { DrawFlowToolbar } from "./DrawFlowToolbar";

type ExcalidrawProps = React.ComponentProps<typeof Excalidraw>;
type ExcalidrawOnChange = NonNullable<ExcalidrawProps["onChange"]>;
type ExcalidrawOnLibraryChange = NonNullable<ExcalidrawProps["onLibraryChange"]>;
type UnwrapInitialData<T> = T extends (...args: never[]) => infer R
  ? UnwrapInitialData<R>
  : T extends Promise<infer U>
  ? UnwrapInitialData<U>
  : NonNullable<T>;
type ExcalidrawInitialData = UnwrapInitialData<ExcalidrawProps["initialData"]>;

export function DrawFlowDesigner() {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);

  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const updateWorkflowExcalidraw = useAppStore((s) => s.updateWorkflowExcalidraw);
  const excalidrawLibraryItems = useAppStore((s) => s.excalidrawLibraryItems);
  const updateExcalidrawLibraryItems = useAppStore((s) => s.updateExcalidrawLibraryItems);
  const appTheme = useAppStore((s) => s.editorSettings.theme);

  const activeWorkflow = workflows.find((w) => w.id === activeWorkflowId);
  const isUpdatingSceneRef = useRef<boolean>(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const isDark = appTheme !== "light";

  // Sync scene elements when active tab changes
  useEffect(() => {
    if (!activeWorkflow || !excalidrawAPI) return;

    isUpdatingSceneRef.current = true;
    excalidrawAPI.updateScene({
      elements: (activeWorkflow.elements || []) as Parameters<NonNullable<typeof excalidrawAPI>["updateScene"]>[0]["elements"],
      appState: {
        theme: isDark ? "dark" : "light",
        openSidebar: activeWorkflow.appState?.openSidebar ?? null,
        ...(activeWorkflow.appState || {}),
      } as unknown as Parameters<NonNullable<typeof excalidrawAPI>["updateScene"]>[0]["appState"],
    });

    const timer = setTimeout(() => {
      isUpdatingSceneRef.current = false;
    }, 100);

    return () => clearTimeout(timer);
  }, [activeWorkflowId, activeWorkflow, excalidrawAPI, isDark]);

  // Debounced handler for canvas changes (elements, appState, files)
  const handleChange: ExcalidrawOnChange = useCallback(
    (elements, appState, files) => {
      if (!activeWorkflowId || isUpdatingSceneRef.current) return;

      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        if (isUpdatingSceneRef.current) return;

        const savedAppState = {
          theme: isDark ? "dark" : "light",
          openSidebar: appState.openSidebar || null,
          viewBackgroundColor: appState.viewBackgroundColor,
          gridSize: appState.gridSize,
          zoom: appState.zoom,
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          currentItemStrokeColor: appState.currentItemStrokeColor,
          currentItemBackgroundColor: appState.currentItemBackgroundColor,
          currentItemFillStyle: appState.currentItemFillStyle,
          currentItemStrokeWidth: appState.currentItemStrokeWidth,
          currentItemStrokeStyle: appState.currentItemStrokeStyle,
          currentItemRoughness: appState.currentItemRoughness,
          currentItemOpacity: appState.currentItemOpacity,
          currentItemFontFamily: appState.currentItemFontFamily,
          currentItemFontSize: appState.currentItemFontSize,
          currentItemTextAlign: appState.currentItemTextAlign,
        };

        updateWorkflowExcalidraw(activeWorkflowId, [...elements], savedAppState, files);
      }, 250);
    },
    [activeWorkflowId, updateWorkflowExcalidraw, isDark]
  );

  // Handle library changes and persist globally
  const handleLibraryChange: ExcalidrawOnLibraryChange = useCallback(
    (libraryItems) => {
      updateExcalidrawLibraryItems([...libraryItems]);
    },
    [updateExcalidrawLibraryItems]
  );

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg-0">
      <DrawFlowToolbar excalidrawAPI={excalidrawAPI} />
      <div className="flex-1 w-full relative overflow-hidden">
        <Excalidraw
          key={activeWorkflowId}
          excalidrawAPI={(api) => setExcalidrawAPI(api)}
          onChange={handleChange}
          onLibraryChange={handleLibraryChange}
          theme={isDark ? "dark" : "light"}
          initialData={{
            elements: (activeWorkflow?.elements || []) as ExcalidrawInitialData["elements"],
            appState: {
              theme: isDark ? "dark" : "light",
              openSidebar: activeWorkflow?.appState?.openSidebar ?? null,
              ...(activeWorkflow?.appState || {}),
            } as unknown as Parameters<NonNullable<typeof excalidrawAPI>["updateScene"]>[0]["appState"],
            files: (activeWorkflow?.files || {}) as ExcalidrawInitialData["files"],
            libraryItems: (excalidrawLibraryItems || []) as ExcalidrawInitialData["libraryItems"],
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
                DevUtils DrawFlow Studio
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

export default DrawFlowDesigner;
