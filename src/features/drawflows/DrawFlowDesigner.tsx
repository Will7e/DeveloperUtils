// ============================================================
// DrawFlowDesigner — Seamless Excalidraw Integration
// ============================================================

import { useCallback, useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Excalidraw, MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Library } from "lucide-react";

import { useAppStore } from "@/stores/app.store";
import { DrawFlowToolbar } from "./DrawFlowToolbar";
import { ExcalidrawLibraryModal } from "./ExcalidrawLibraryModal";
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

/**
 * Ensures workflow elements have high-contrast, theme-compatible colors
 * across both light and dark modes in Excalidraw's inversion engine.
 */
export function sanitizeWorkflowElements(elements: readonly unknown[] = []): unknown[] {
  return elements.map((rawEl) => {
    const el = rawEl as Record<string, unknown> | null;
    if (!el) return rawEl;
    let modified = false;
    const newEl = { ...el };

    if (el.strokeColor === "#f8fafc") {
      newEl.strokeColor = "#1e1e1e";
      modified = true;
    }
    if (el.id === "node-start" && el.backgroundColor === "#0369a122") {
      newEl.strokeColor = "#0284c7";
      newEl.backgroundColor = "#e0f2fe";
      modified = true;
    }
    if (el.id === "node-action" && el.backgroundColor === "#04785722") {
      newEl.strokeColor = "#059669";
      newEl.backgroundColor = "#dcfce7";
      modified = true;
    }
    if (el.id === "welcome-title" && el.strokeColor === "#38bdf8") {
      newEl.strokeColor = "#0284c7";
      modified = true;
    }
    if (el.id === "welcome-subtitle" && el.strokeColor === "#94a3b8") {
      newEl.strokeColor = "#64748b";
      modified = true;
    }
    if (el.id === "arrow-1" && el.strokeColor === "#38bdf8") {
      newEl.strokeColor = "#0284c7";
      modified = true;
    }

    return modified ? newEl : rawEl;
  });
}

export function DrawFlowDesigner() {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [isLibraryModalOpen, setIsLibraryModalOpen] = useState<boolean>(false);
  const excalidrawContainerRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const updateWorkflowExcalidraw = useAppStore((s) => s.updateWorkflowExcalidraw);
  const excalidrawLibraryItems = useAppStore((s) => s.excalidrawLibraryItems);
  const updateExcalidrawLibraryItems = useAppStore((s) => s.updateExcalidrawLibraryItems);
  const addExcalidrawAddedLibraryId = useAppStore((s) => s.addExcalidrawAddedLibraryId);
  const clearExcalidrawAddedLibraryIds = useAppStore((s) => s.clearExcalidrawAddedLibraryIds);
  const addToast = useAppStore((s) => s.addToast);
  const appTheme = useAppStore((s) => s.editorSettings.theme);
  const updateEditorSettings = useAppStore((s) => s.updateEditorSettings);

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
        const { theme: _staleTheme, ...cleanAppState } = targetWorkflow.appState || {};
        const sanitizedElements = sanitizeWorkflowElements(targetWorkflow.elements || []);
        excalidrawAPI.updateScene({
          elements: sanitizedElements as Parameters<typeof excalidrawAPI.updateScene>[0]["elements"],
          appState: {
            ...cleanAppState,
            theme: isDark ? "dark" : "light",
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

  // Auto-heal any legacy elements in the current active canvas on initial load / API ready
  useEffect(() => {
    if (!excalidrawAPI) return;
    const sceneElements = excalidrawAPI.getSceneElements();
    const needsHealing = sceneElements.some(
      (el) =>
        el.strokeColor === "#f8fafc" ||
        (el.id === "node-start" && el.backgroundColor === "#0369a122") ||
        (el.id === "node-action" && el.backgroundColor === "#04785722") ||
        (el.id === "welcome-title" && el.strokeColor === "#38bdf8") ||
        (el.id === "welcome-subtitle" && el.strokeColor === "#94a3b8") ||
        (el.id === "arrow-1" && el.strokeColor === "#38bdf8")
    );
    if (needsHealing) {
      const healed = sanitizeWorkflowElements(sceneElements);
      excalidrawAPI.updateScene({
        elements: healed as Parameters<typeof excalidrawAPI.updateScene>[0]["elements"],
      });
      if (activeWorkflowId) {
        updateWorkflowExcalidraw(activeWorkflowId, [...healed]);
      }
    }
  }, [excalidrawAPI, activeWorkflowId, updateWorkflowExcalidraw]);

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
        addExcalidrawAddedLibraryId(target.id);
        loadLibraryToExcalidraw(target.source, excalidrawAPI, target.id).then((count) => {
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
    [activeWorkflowId, updateWorkflowExcalidraw]
  );

  // Handle library changes and persist globally
  // When library is fully cleared (reset), also clear the "added" IDs so the modal stays in sync
  const handleLibraryChange: ExcalidrawOnLibraryChange = useCallback(
    (libraryItems) => {
      updateExcalidrawLibraryItems([...libraryItems]);
      if (libraryItems.length === 0) {
        clearExcalidrawAddedLibraryIds();
      }
    },
    [updateExcalidrawLibraryItems, clearExcalidrawAddedLibraryIds]
  );

  // Intercept clicks on Excalidraw's "Browse libraries" button and enhance its styling & badge
  useEffect(() => {
    const container = excalidrawContainerRef.current;
    if (!container) return;

    // Capture-phase click interceptor: stops default navigation to external Excalidraw site and opens our modal
    const handleInterceptClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement)?.closest(".library-menu-browse-button");
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        setIsLibraryModalOpen(true);
      }
    };

    const enhanceBrowseButton = (btn: HTMLElement) => {
      if (btn.dataset.devutilsEnhanced === "true") return;
      btn.dataset.devutilsEnhanced = "true";
      btn.setAttribute("title", "Browse & install from 230+ community shape packs");
      btn.innerHTML = `
        <span class="inline-flex items-center justify-center gap-1.5 font-semibold text-xs tracking-wide">
          <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
            <path d="M20 3v4"/>
            <path d="M22 5h-4"/>
            <path d="M4 17v2"/>
            <path d="M5 18H3"/>
          </svg>
          <span>Browse libraries</span>
          <span class="devutils-lib-badge">230+</span>
        </span>
      `;
    };

    // Check for existing button immediately
    const existingBtn = container.querySelector<HTMLElement>(".library-menu-browse-button");
    if (existingBtn) {
      enhanceBrowseButton(existingBtn);
    }

    // Observe DOM changes for when the library sidebar is opened or updated
    const observer = new MutationObserver(() => {
      const btn = container.querySelector<HTMLElement>(".library-menu-browse-button");
      if (btn && btn.dataset.devutilsEnhanced !== "true") {
        enhanceBrowseButton(btn);
      }
    });

    observer.observe(container, { childList: true, subtree: true });
    container.addEventListener("click", handleInterceptClick, true);

    return () => {
      container.removeEventListener("click", handleInterceptClick, true);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg-0">
      <DrawFlowToolbar excalidrawAPI={excalidrawAPI} />
      <div ref={excalidrawContainerRef} className="flex-1 w-full relative overflow-hidden">
        <Excalidraw
          excalidrawAPI={(api) => setExcalidrawAPI(api)}
          onChange={handleChange}
          onLibraryChange={handleLibraryChange}
          theme={isDark ? "dark" : "light"}
          initialData={{
            elements: sanitizeWorkflowElements(activeWorkflow?.elements || []) as ExcalidrawInitialData["elements"],
            appState: {
              ...(activeWorkflow?.appState || {}),
              openSidebar: activeWorkflow?.appState?.openSidebar ?? null,
              theme: isDark ? "dark" : "light",
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
            <MainMenu.Item
              icon={<Library className="w-4 h-4 text-accent" />}
              onSelect={() => setIsLibraryModalOpen(true)}
            >
              Community Libraries
              <MainMenu.Item.Badge>230+</MainMenu.Item.Badge>
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ToggleTheme
              onSelect={(newTheme) => {
                updateEditorSettings({ theme: newTheme === "dark" ? "dark" : "light" });
              }}
            />
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

      {/* Community Library Catalog Modal */}
      <ExcalidrawLibraryModal
        isOpen={isLibraryModalOpen}
        onClose={() => setIsLibraryModalOpen(false)}
        excalidrawAPI={excalidrawAPI}
      />
    </div>
  );
}

export default DrawFlowDesigner;
