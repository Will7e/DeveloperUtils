// ============================================================
// Global State Store — Zustand with localStorage persistence
// ============================================================

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AppState, Language, EditorFile, Workflow, WorkflowNodeData, WorkflowEdgeData } from "@/types";
import { DEFAULT_EDITOR_SETTINGS, LANGUAGE_CONFIGS } from "@/config";
import { generateId } from "@/lib/utils";

/** Create a default file for a language */
function createDefaultFile(language: Language): EditorFile {
  const config = LANGUAGE_CONFIGS[language];
  return {
    id: generateId(),
    name: `main${config.extension}`,
    language,
    content: config.defaultCode,
    isDirty: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// Create initial file
const initialFile = createDefaultFile("javascript");

const initialJsonFile = { id: generateId(), name: "Untitled.json", content: "" };
const initialXmlFile = { id: generateId(), name: "Untitled.xml", content: "" };
const initialComparatorSession = { id: generateId(), name: "List Compare", a: "", b: "" };

const initialWorkflow: Workflow = {
  id: generateId(),
  name: "My Workflow",
  nodes: [
    {
      id: "start-1",
      type: "startNode",
      position: { x: 250, y: 50 },
      data: { label: "Start", nodeType: "start", description: "Workflow begins here" },
    },
  ],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 0.75 },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Files
      files: [initialFile],
      activeFileId: initialFile.id,

      // Execution
      isRunning: false,
      executionResults: [],
      outputEntries: [],
      executionStartTime: null,

      // UI
      sidebarOpen: true,
      sidebarCollapsed: false,
      outputPanelOpen: true,
      settingsOpen: false,
      commandPaletteOpen: false,
      editorSettings: DEFAULT_EDITOR_SETTINGS,
      toasts: [],
      outputFlash: null,
      formatterFiles: { json: [initialJsonFile], xml: [initialXmlFile] },
      activeFormatterFileId: { json: initialJsonFile.id, xml: initialXmlFile.id },
      formatterType: "json",
      comparatorSessions: [initialComparatorSession],
      activeComparatorSessionId: initialComparatorSession.id,
      comparatorSettings: { caseSensitive: false, trimWhitespace: true, sortAlpha: true },
      librarySelectedItemId: null,
      librarySearchQuery: "",
      workflows: [initialWorkflow],
      activeWorkflowId: initialWorkflow.id,
      workflowSelectedNodeId: null,
      workflowSelectedEdgeId: null,

      // File actions
      createFile: (name: string, language: Language) => {
        const config = LANGUAGE_CONFIGS[language];
        const newFile: EditorFile = {
          id: generateId(),
          name: name || `untitled${config.extension}`,
          language,
          content: config.defaultCode,
          isDirty: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          files: [...state.files, newFile],
          activeFileId: newFile.id,
        }));
      },

      deleteFile: (id: string) => {
        const state = get();
        const remaining = state.files.filter((f) => f.id !== id);
        if (remaining.length === 0) {
          // Always keep at least one file
          const fallback = createDefaultFile("javascript");
          set({
            files: [fallback],
            activeFileId: fallback.id,
          });
        } else {
          set({
            files: remaining,
            activeFileId:
              state.activeFileId === id
                ? remaining[remaining.length - 1]!.id
                : state.activeFileId,
          });
        }
      },

      setActiveFile: (id: string) => {
        set({ activeFileId: id });
      },

      updateFileContent: (id: string, content: string) => {
        set((state) => ({
          files: state.files.map((f) =>
            f.id === id
              ? { ...f, content, isDirty: false, updatedAt: Date.now() }
              : f
          ),
        }));
      },

      renameFile: (id: string, name: string) => {
        set((state) => ({
          files: state.files.map((f) =>
            f.id === id ? { ...f, name, updatedAt: Date.now() } : f
          ),
        }));
      },

      // Output actions
      addOutputEntry: (entry) => {
        set((state) => ({
          outputEntries: [
            ...state.outputEntries,
            { ...entry, id: generateId(), timestamp: Date.now() },
          ],
        }));
      },

      clearOutput: () => {
        set({ outputEntries: [] });
      },

      setIsRunning: (running: boolean) => {
        set({ isRunning: running });
      },

      addExecutionResult: (result) => {
        set((state) => ({
          executionResults: [...state.executionResults, result],
        }));
      },

      setExecutionStartTime: (time: number | null) => {
        set({ executionStartTime: time });
      },

      cancelExecution: () => {
        set({
          isRunning: false,
          executionStartTime: null,
        });
      },

      // UI actions
      toggleSidebar: () => {
        set((state) => ({ sidebarOpen: !state.sidebarOpen }));
      },

      toggleSidebarCollapse: () => {
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
      },

      toggleOutputPanel: () => {
        set((state) => ({ outputPanelOpen: !state.outputPanelOpen }));
      },

      toggleSettings: () => {
        set((state) => ({ settingsOpen: !state.settingsOpen }));
      },

      toggleCommandPalette: () => {
        set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen }));
      },

      updateEditorSettings: (settings) => {
        set((state) => ({
          editorSettings: { ...state.editorSettings, ...settings },
        }));
      },

      // Toast actions
      addToast: (toast) => {
        const id = generateId();
        set((state) => ({
          toasts: [...state.toasts, { ...toast, id }],
        }));
        // Auto-remove after duration
        const duration = toast.duration ?? 3000;
        setTimeout(() => {
          set((state) => ({
            toasts: state.toasts.filter((t) => t.id !== id),
          }));
        }, duration);
      },

      removeToast: (id: string) => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      },
      
      createFormatterFile: (type, name) => {
        const id = generateId();
        const newFile = { id, name: name || `Untitled.${type}`, content: "" };
        set((state) => ({
          formatterFiles: {
            ...state.formatterFiles,
            [type]: [...state.formatterFiles[type], newFile]
          },
          activeFormatterFileId: {
            ...state.activeFormatterFileId,
            [type]: id
          }
        }));
      },

      deleteFormatterFile: (type, id) => {
        set((state) => {
          const remaining = state.formatterFiles[type].filter(f => f.id !== id);
          if (remaining.length === 0) {
            const newFile = { id: generateId(), name: `Untitled.${type}`, content: "" };
            return {
              formatterFiles: { ...state.formatterFiles, [type]: [newFile] },
              activeFormatterFileId: { ...state.activeFormatterFileId, [type]: newFile.id }
            };
          }
          return {
            formatterFiles: { ...state.formatterFiles, [type]: remaining },
            activeFormatterFileId: {
              ...state.activeFormatterFileId,
              [type]: state.activeFormatterFileId[type] === id ? remaining[remaining.length - 1]!.id : state.activeFormatterFileId[type]
            }
          };
        });
      },

      setActiveFormatterFile: (type, id) => {
        set((state) => ({
          activeFormatterFileId: { ...state.activeFormatterFileId, [type]: id }
        }));
      },

      updateFormatterFileContent: (type, id, content) => {
        set((state) => ({
          formatterFiles: {
            ...state.formatterFiles,
            [type]: state.formatterFiles[type].map(f => f.id === id ? { ...f, content } : f)
          }
        }));
      },

      renameFormatterFile: (type, id, name) => {
        set((state) => ({
          formatterFiles: {
            ...state.formatterFiles,
            [type]: state.formatterFiles[type].map(f => f.id === id ? { ...f, name } : f)
          }
        }));
      },
      
      setOutputFlash: (flash) => {
        set({ outputFlash: flash });
        if (flash) {
          setTimeout(() => {
            set({ outputFlash: null });
          }, 800);
        }
      },
      
      setFormatterType: (type) => {
        set({ formatterType: type });
      },

      createComparatorSession: (name) => {
        const id = generateId();
        const newSession = { id, name: name || "List Compare", a: "", b: "" };
        set((state) => ({
          comparatorSessions: [...state.comparatorSessions, newSession],
          activeComparatorSessionId: id
        }));
      },

      deleteComparatorSession: (id) => {
        set((state) => {
          const remaining = state.comparatorSessions.filter(s => s.id !== id);
          if (remaining.length === 0) {
            const newSession = { id: generateId(), name: "List Compare", a: "", b: "" };
            return {
              comparatorSessions: [newSession],
              activeComparatorSessionId: newSession.id
            };
          }
          return {
            comparatorSessions: remaining,
            activeComparatorSessionId:
              state.activeComparatorSessionId === id ? remaining[remaining.length - 1]!.id : state.activeComparatorSessionId
          };
        });
      },

      setActiveComparatorSession: (id) => {
        set({ activeComparatorSessionId: id });
      },

      updateComparatorSessionInput: (id, side, input) => {
        set((state) => ({
          comparatorSessions: state.comparatorSessions.map(s =>
            s.id === id ? { ...s, [side]: input } : s
          )
        }));
      },

      renameComparatorSession: (id, name) => {
        set((state) => ({
          comparatorSessions: state.comparatorSessions.map(s =>
            s.id === id ? { ...s, name } : s
          )
        }));
      },

      updateComparatorSettings: (settings) => {
        set((state) => ({
          comparatorSettings: { ...state.comparatorSettings, ...settings }
        }));
      },

      setLibrarySelectedItemId: (id) => {
        set({ librarySelectedItemId: id });
      },
      
      setLibrarySearchQuery: (query) => {
        set({ librarySearchQuery: query });
      },

      // Workflow actions
      createWorkflow: (name) => {
        const id = generateId();
        const newWorkflow: Workflow = {
          id,
          name: name || "Untitled Workflow",
          nodes: [
            {
              id: `start-${generateId()}`,
              type: "startNode",
              position: { x: 250, y: 50 },
              data: { label: "Start", nodeType: "start" as const, description: "Workflow begins here" },
            },
          ],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 0.75 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          workflows: [...state.workflows, newWorkflow],
          activeWorkflowId: id,
        }));
      },

      deleteWorkflow: (id) => {
        set((state) => {
          const remaining = state.workflows.filter((w) => w.id !== id);
          if (remaining.length === 0) {
            const newWorkflow: Workflow = {
              id: generateId(),
              name: "Untitled Workflow",
              nodes: [],
              edges: [],
              viewport: { x: 0, y: 0, zoom: 0.75 },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            return {
              workflows: [newWorkflow],
              activeWorkflowId: newWorkflow.id,
            };
          }
          return {
            workflows: remaining,
            activeWorkflowId:
              state.activeWorkflowId === id
                ? remaining[remaining.length - 1]!.id
                : state.activeWorkflowId,
          };
        });
      },

      setActiveWorkflow: (id) => {
        set({ activeWorkflowId: id });
      },

      renameWorkflow: (id, name) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === id ? { ...w, name, updatedAt: Date.now() } : w
          ),
        }));
      },

      updateWorkflowNodes: (workflowId: string, nodes: WorkflowNodeData[]) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === workflowId ? { ...w, nodes, updatedAt: Date.now() } : w
          ),
        }));
      },

      updateWorkflowEdges: (workflowId: string, edges: WorkflowEdgeData[]) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === workflowId ? { ...w, edges, updatedAt: Date.now() } : w
          ),
        }));
      },

      updateWorkflowViewport: (workflowId: string, viewport: { x: number; y: number; zoom: number }) => {
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === workflowId ? { ...w, viewport } : w
          ),
        }));
      },

      setWorkflowSelectedNodeId: (id) => {
        set({ workflowSelectedNodeId: id, workflowSelectedEdgeId: null });
      },

      setWorkflowSelectedEdgeId: (id) => {
        set({ workflowSelectedEdgeId: id, workflowSelectedNodeId: null });
      },
    }),
    {
      name: "devutils-app-state",
      // Only persist files, activeFileId, and editor settings — NOT runtime state
      partialize: (state) => ({
        files: state.files,
        activeFileId: state.activeFileId,
        sidebarCollapsed: state.sidebarCollapsed,
        outputPanelOpen: state.outputPanelOpen,
        editorSettings: state.editorSettings,
        formatterFiles: state.formatterFiles,
        activeFormatterFileId: state.activeFormatterFileId,
        formatterType: state.formatterType,
        comparatorSessions: state.comparatorSessions,
        activeComparatorSessionId: state.activeComparatorSessionId,
        comparatorSettings: state.comparatorSettings,
        librarySelectedItemId: state.librarySelectedItemId,
        librarySearchQuery: state.librarySearchQuery,
        workflows: state.workflows,
        activeWorkflowId: state.activeWorkflowId,
      }),
    }
  )
);
