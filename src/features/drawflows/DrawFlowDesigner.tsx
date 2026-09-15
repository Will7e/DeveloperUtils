// ============================================================
// DrawFlowDesigner — Seamless Excalidraw Integration
// ============================================================

import { useCallback, useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Excalidraw, MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useAppStore } from "@/stores/app.store";
import { DrawFlowToolbar } from "./DrawFlowToolbar";
import {
  getExcalidrawLibraries,
  loadLibraryToExcalidraw,
} from "@/utils/excalidrawLibrary";

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
  const [searchParams, setSearchParams] = useSearchParams();

  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const updateWorkflowExcalidraw = useAppStore((s) => s.updateWorkflowExcalidraw);
  const excalidrawLibraryItems = useAppStore((s) => s.excalidrawLibraryItems);
  const updateExcalidrawLibraryItems = useAppStore((s) => s.updateExcalidrawLibraryItems);
  const addToast = useAppStore((s) => s.addToast);
  const appTheme = useAppStore((s) => s.editorSettings.theme);

  const activeWorkflow = workflows.find((w) => w.id === activeWorkflowId) || workflows[0];
  const isUpdatingSceneRef = useRef<boolean>(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prevWorkflowIdRef = useRef<string>(activeWorkflowId);

  const pendingSaveRef = useRef<{
    workflowId: string;
    elements: readonly unknown[];
    appState: Record<string, unknown>;
    files: Record<string, unknown> | undefined;
  } | null>(null);

  const isDark = appTheme !== "light";

  // Flush any pending unsaved canvas changes
  const flushPendingSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    if (pendingSaveRef.current) {
      const { workflowId, elements, appState, files } = pendingSaveRef.current;
      updateWorkflowExcalidraw(workflowId, [...elements], appState, files);
      pendingSaveRef.current = null;
    }
  }, [updateWorkflowExcalidraw]);

  // Handle active workflow switching smoothly without remounting the entire canvas
  useEffect(() => {
    if (!excalidrawAPI) return;

    if (prevWorkflowIdRef.current !== activeWorkflowId) {
      // Flush changes for the previous tab before loading the new one
      flushPendingSave();

      const targetWorkflow = workflows.find((w) => w.id === activeWorkflowId);
      if (targetWorkflow) {
        isUpdatingSceneRef.current = true;
        excalidrawAPI.updateScene({
          elements: (targetWorkflow.elements || []) as Parameters<typeof excalidrawAPI.updateScene>[0]["elements"],
          appState: {
            theme: isDark ? "dark" : "light",
            ...(targetWorkflow.appState || {}),
          } as unknown as Parameters<typeof excalidrawAPI.updateScene>[0]["appState"],
        });

        if (targetWorkflow.files && Object.keys(targetWorkflow.files).length > 0) {
          excalidrawAPI.addFiles(Object.values(targetWorkflow.files) as Parameters<typeof excalidrawAPI.addFiles>[0]);
        }

        setTimeout(() => {
          isUpdatingSceneRef.current = false;
        }, 120);
      }
      prevWorkflowIdRef.current = activeWorkflowId;
    }
  }, [activeWorkflowId, workflows, excalidrawAPI, isDark, flushPendingSave]);

  // Sync canvas theme when global app theme changes
  useEffect(() => {
    if (!excalidrawAPI) return;
    excalidrawAPI.updateScene({
      appState: {
        theme: isDark ? "dark" : "light",
      } as unknown as Parameters<typeof excalidrawAPI.updateScene>[0]["appState"],
    });
  }, [isDark, excalidrawAPI]);

  // Handle cross-navigation library auto-import (e.g. from /library?importLib=id)
  useEffect(() => {
    const importLibId = searchParams.get("importLib");
    if (!importLibId || !excalidrawAPI) return;

    getExcalidrawLibraries().then((allLibs) => {
      const target = allLibs.find((lib) => lib.id === importLibId);
      if (target) {
        loadLibraryToExcalidraw(target.source, excalidrawAPI).then((count) => {
          addToast({ message: `Imported "${target.name}" (${count} shapes) to Excalidraw Library!`, type: "success" });
        }).catch(() => {
          addToast({ message: `Failed to load "${target.name}"`, type: "error" });
        });
      }
      // Remove query param to prevent repeated loads
      setSearchParams((params) => {
        params.delete("importLib");
        return params;
      }, { replace: true });
    });
  }, [searchParams, excalidrawAPI, addToast, setSearchParams]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      flushPendingSave();
    };
  }, [flushPendingSave]);

  // Debounced handler for canvas changes (elements, appState, files)
  const handleChange: ExcalidrawOnChange = useCallback(
    (elements, appState, files) => {
      if (!activeWorkflowId || isUpdatingSceneRef.current) return;

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

      pendingSaveRef.current = {
        workflowId: activeWorkflowId,
        elements,
        appState: savedAppState,
        files: files ? { ...files } : undefined,
      };

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        if (isUpdatingSceneRef.current) return;
        if (pendingSaveRef.current) {
          const { workflowId, elements: els, appState: st, files: fls } = pendingSaveRef.current;
          updateWorkflowExcalidraw(workflowId, [...els], st, fls);
          pendingSaveRef.current = null;
        }
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
