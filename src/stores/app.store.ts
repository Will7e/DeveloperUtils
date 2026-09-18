// ============================================================
// Global State Store — Zustand with localStorage persistence
// ============================================================

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AppState, Language, EditorFile, Workflow, DiffSession, DiffSettings } from "@/types";
import { DEFAULT_EDITOR_SETTINGS, LANGUAGE_CONFIGS } from "@/config";
import { generateId } from "@/lib/utils";

/** Move an element in an array from one index to another (immutable) */
function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const result = [...arr];
  const removed = result.splice(from, 1);
  if (removed.length > 0) {
    result.splice(to, 0, removed[0]!);
  }
  return result;
}

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
const initialDiffSession: DiffSession = { id: generateId(), name: "Diff Check", original: "", modified: "", language: "plaintext", autoDetect: true };
const initialDiffSettings: DiffSettings = { renderSideBySide: true, ignoreTrimWhitespace: true, enableSplitViewResizing: true, autoFormatOnPaste: true, wordWrap: false };

const createDefaultWorkflowElements = (): unknown[] => [
  {
    type: "text",
    version: 1,
    versionNonce: 1001,
    isDeleted: false,
    id: "welcome-title",
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: 280,
    y: 140,
    strokeColor: "#0284c7",
    backgroundColor: "transparent",
    width: 320,
    height: 36,
    seed: 10001,
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    text: "DevUtils DrawFlow Studio",
    fontSize: 24,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    baseline: 20,
    containerId: null,
    originalText: "DevUtils DrawFlow Studio",
    lineHeight: 1.25,
  },
  {
    type: "text",
    version: 1,
    versionNonce: 1002,
    isDeleted: false,
    id: "welcome-subtitle",
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: 280,
    y: 185,
    strokeColor: "#64748b",
    backgroundColor: "transparent",
    width: 440,
    height: 24,
    seed: 10002,
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    text: "Draw diagrams, flowcharts, and architecture specs with Excalidraw.",
    fontSize: 14,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    baseline: 12,
    containerId: null,
    originalText: "Draw diagrams, flowcharts, and architecture specs with Excalidraw.",
    lineHeight: 1.25,
  },
  {
    type: "rectangle",
    version: 1,
    versionNonce: 2001,
    isDeleted: false,
    id: "node-start",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: 280,
    y: 250,
    strokeColor: "#0284c7",
    backgroundColor: "#e0f2fe",
    width: 160,
    height: 60,
    seed: 20001,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  },
  {
    type: "text",
    version: 1,
    versionNonce: 2002,
    isDeleted: false,
    id: "node-start-text",
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: 315,
    y: 270,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    width: 90,
    height: 20,
    seed: 20002,
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    text: "Start Process",
    fontSize: 16,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    baseline: 14,
    containerId: null,
    originalText: "Start Process",
    lineHeight: 1.25,
  },
  {
    type: "arrow",
    version: 1,
    versionNonce: 3001,
    isDeleted: false,
    id: "arrow-1",
    fillStyle: "hachure",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: 440,
    y: 280,
    strokeColor: "#0284c7",
    backgroundColor: "transparent",
    width: 80,
    height: 0,
    seed: 30001,
    groupIds: [],
    frameId: null,
    roundness: { type: 2 },
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    points: [
      [0, 0],
      [80, 0],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "triangle",
  },
  {
    type: "rectangle",
    version: 1,
    versionNonce: 4001,
    isDeleted: false,
    id: "node-action",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: 520,
    y: 250,
    strokeColor: "#059669",
    backgroundColor: "#dcfce7",
    width: 180,
    height: 60,
    seed: 40001,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  },
  {
    type: "text",
    version: 1,
    versionNonce: 4002,
    isDeleted: false,
    id: "node-action-text",
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: 540,
    y: 270,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    width: 140,
    height: 20,
    seed: 40002,
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    text: "Execute ServiceNow",
    fontSize: 16,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    baseline: 14,
    containerId: null,
    originalText: "Execute ServiceNow",
    lineHeight: 1.25,
  },
];

const initialWorkflow: Workflow = {
  id: generateId(),
  name: "My Workflow",
  elements: createDefaultWorkflowElements(),
  appState: {},
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
      sidebarOpen: false,
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
      diffSessions: [initialDiffSession],
      activeDiffSessionId: initialDiffSession.id,
      diffSettings: initialDiffSettings,
      librarySelectedItemId: null,
      librarySearchQuery: "",
      libraryTab: "servicenow",
      libraryExcalidrawCategory: "all",
      workflows: [initialWorkflow],
      activeWorkflowId: initialWorkflow.id,

      // File actions
      createFile: (name: string, language: Language, content?: string) => {
        const config = LANGUAGE_CONFIGS[language];
        const newFile: EditorFile = {
          id: generateId(),
          name: name || `untitled${config.extension}`,
          language,
          content: content !== undefined ? content : config.defaultCode,
          isDirty: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          files: [...state.files, newFile],
          activeFileId: newFile.id,
        }));
      },

      duplicateFile: (id: string) => {
        const file = get().files.find((f) => f.id === id);
        if (!file) return;
        const newId = generateId();
        const lastDot = file.name.lastIndexOf(".");
        const copyName =
          lastDot !== -1
            ? `${file.name.slice(0, lastDot)} (Copy)${file.name.slice(lastDot)}`
            : `${file.name} (Copy)`;
        const newFile: EditorFile = {
          ...file,
          id: newId,
          name: copyName,
          isDirty: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const index = get().files.findIndex((f) => f.id === id);
        const newFiles = [...get().files];
        newFiles.splice(index + 1, 0, newFile);
        set({
          files: newFiles,
          activeFileId: newId,
        });
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

      closeOtherFiles: (id: string) => {
        set((state) => ({
          files: state.files.filter((f) => f.id === id),
          activeFileId: id,
        }));
      },

      closeFilesToRight: (id: string) => {
        set((state) => {
          const idx = state.files.findIndex((f) => f.id === id);
          if (idx === -1) return state;
          const remaining = state.files.slice(0, idx + 1);
          const activeExists = remaining.some((f) => f.id === state.activeFileId);
          return {
            files: remaining,
            activeFileId: activeExists ? state.activeFileId : id,
          };
        });
      },

      closeAllFiles: () => {
        const fallback = createDefaultFile("javascript");
        set({
          files: [fallback],
          activeFileId: fallback.id,
        });
      },

      setActiveFile: (id: string) => {
        set({ activeFileId: id });
      },

      reorderFiles: (fromIndex: number, toIndex: number) => {
        set((state) => ({
          files: arrayMove(state.files, fromIndex, toIndex),
        }));
      },

      updateFileContent: (id: string, content: string) => {
        set((state) => ({
          files: state.files.map((f) =>
            f.id === id
              ? { ...f, content, isDirty: true, updatedAt: Date.now() }
              : f
          ),
        }));
      },

      saveFile: (id: string) => {
        set((state) => ({
          files: state.files.map((f) =>
            f.id === id ? { ...f, isDirty: false, updatedAt: Date.now() } : f
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

      setOutputPanelOpen: (open) => {
        set({ outputPanelOpen: open });
      },

      toggleSettings: () => {
        set((state) => ({ settingsOpen: !state.settingsOpen }));
      },

      toggleCommandPalette: () => {
        set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen }));
      },

      openCommandPalette: () => {
        set({ commandPaletteOpen: true });
      },

      closeCommandPalette: () => {
        set({ commandPaletteOpen: false });
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

      duplicateFormatterFile: (type, id) => {
        const file = get().formatterFiles[type].find((f) => f.id === id);
        if (!file) return;
        const newId = generateId();
        const lastDot = file.name.lastIndexOf(".");
        const copyName =
          lastDot !== -1
            ? `${file.name.slice(0, lastDot)} (Copy)${file.name.slice(lastDot)}`
            : `${file.name} (Copy)`;
        const newFile = { ...file, id: newId, name: copyName };
        const index = get().formatterFiles[type].findIndex((f) => f.id === id);
        const newFiles = [...get().formatterFiles[type]];
        newFiles.splice(index + 1, 0, newFile);
        set((state) => ({
          formatterFiles: { ...state.formatterFiles, [type]: newFiles },
          activeFormatterFileId: { ...state.activeFormatterFileId, [type]: newId },
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

      closeOtherFormatterFiles: (type, id) => {
        set((state) => ({
          formatterFiles: {
            ...state.formatterFiles,
            [type]: state.formatterFiles[type].filter((f) => f.id === id),
          },
          activeFormatterFileId: {
            ...state.activeFormatterFileId,
            [type]: id,
          },
        }));
      },

      closeFormatterFilesToRight: (type, id) => {
        set((state) => {
          const list = state.formatterFiles[type];
          const idx = list.findIndex((f) => f.id === id);
          if (idx === -1) return state;
          const remaining = list.slice(0, idx + 1);
          const activeExists = remaining.some((f) => f.id === state.activeFormatterFileId[type]);
          return {
            formatterFiles: { ...state.formatterFiles, [type]: remaining },
            activeFormatterFileId: {
              ...state.activeFormatterFileId,
              [type]: activeExists ? state.activeFormatterFileId[type] : id,
            },
          };
        });
      },

      closeAllFormatterFiles: (type) => {
        const newFile = { id: generateId(), name: `Untitled.${type}`, content: "" };
        set((state) => ({
          formatterFiles: { ...state.formatterFiles, [type]: [newFile] },
          activeFormatterFileId: { ...state.activeFormatterFileId, [type]: newFile.id },
        }));
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

      reorderFormatterFiles: (type, fromIndex, toIndex) => {
        set((state) => ({
          formatterFiles: {
            ...state.formatterFiles,
            [type]: arrayMove(state.formatterFiles[type], fromIndex, toIndex),
          },
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

      duplicateComparatorSession: (id) => {
        const session = get().comparatorSessions.find((s) => s.id === id);
        if (!session) return;
        const newId = generateId();
        const newSession = {
          ...session,
          id: newId,
          name: `${session.name} (Copy)`,
        };
        const index = get().comparatorSessions.findIndex((s) => s.id === id);
        const newSessions = [...get().comparatorSessions];
        newSessions.splice(index + 1, 0, newSession);
        set({
          comparatorSessions: newSessions,
          activeComparatorSessionId: newId,
        });
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

      closeOtherComparatorSessions: (id) => {
        set((state) => ({
          comparatorSessions: state.comparatorSessions.filter((s) => s.id === id),
          activeComparatorSessionId: id,
        }));
      },

      closeComparatorSessionsToRight: (id) => {
        set((state) => {
          const idx = state.comparatorSessions.findIndex((s) => s.id === id);
          if (idx === -1) return state;
          const remaining = state.comparatorSessions.slice(0, idx + 1);
          const activeExists = remaining.some((s) => s.id === state.activeComparatorSessionId);
          return {
            comparatorSessions: remaining,
            activeComparatorSessionId: activeExists ? state.activeComparatorSessionId : id,
          };
        });
      },

      closeAllComparatorSessions: () => {
        const newSession = { id: generateId(), name: "List Compare", a: "", b: "" };
        set({
          comparatorSessions: [newSession],
          activeComparatorSessionId: newSession.id,
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

      reorderComparatorSessions: (fromIndex, toIndex) => {
        set((state) => ({
          comparatorSessions: arrayMove(state.comparatorSessions, fromIndex, toIndex),
        }));
      },

      updateComparatorSettings: (settings) => {
        set((state) => ({
          comparatorSettings: { ...state.comparatorSettings, ...settings }
        }));
      },

      // Diff checker actions
      createDiffSession: (name) => {
        const id = generateId();
        const newSession: DiffSession = { id, name: name || "Diff Check", original: "", modified: "", language: "plaintext", autoDetect: true };
        set((state) => ({
          diffSessions: [...state.diffSessions, newSession],
          activeDiffSessionId: id
        }));
      },

      duplicateDiffSession: (id) => {
        const session = get().diffSessions.find((s) => s.id === id);
        if (!session) return;
        const newId = generateId();
        const newSession: DiffSession = {
          ...session,
          id: newId,
          name: `${session.name} (Copy)`,
        };
        const index = get().diffSessions.findIndex((s) => s.id === id);
        const newSessions = [...get().diffSessions];
        newSessions.splice(index + 1, 0, newSession);
        set({
          diffSessions: newSessions,
          activeDiffSessionId: newId,
        });
      },

      deleteDiffSession: (id) => {
        set((state) => {
          const remaining = state.diffSessions.filter(s => s.id !== id);
          if (remaining.length === 0) {
            const newSession: DiffSession = { id: generateId(), name: "Diff Check", original: "", modified: "", language: "plaintext", autoDetect: true };
            return {
              diffSessions: [newSession],
              activeDiffSessionId: newSession.id
            };
          }
          return {
            diffSessions: remaining,
            activeDiffSessionId:
              state.activeDiffSessionId === id ? remaining[remaining.length - 1]!.id : state.activeDiffSessionId
          };
        });
      },

      closeOtherDiffSessions: (id) => {
        set((state) => ({
          diffSessions: state.diffSessions.filter((s) => s.id === id),
          activeDiffSessionId: id,
        }));
      },

      closeDiffSessionsToRight: (id) => {
        set((state) => {
          const idx = state.diffSessions.findIndex((s) => s.id === id);
          if (idx === -1) return state;
          const remaining = state.diffSessions.slice(0, idx + 1);
          const activeExists = remaining.some((s) => s.id === state.activeDiffSessionId);
          return {
            diffSessions: remaining,
            activeDiffSessionId: activeExists ? state.activeDiffSessionId : id,
          };
        });
      },

      closeAllDiffSessions: () => {
        const newSession: DiffSession = {
          id: generateId(),
          name: "Diff Check",
          original: "",
          modified: "",
          language: "plaintext",
          autoDetect: true,
        };
        set({
          diffSessions: [newSession],
          activeDiffSessionId: newSession.id,
        });
      },

      setActiveDiffSession: (id) => {
        set({ activeDiffSessionId: id });
      },

      updateDiffSessionInput: (id, side, input) => {
        set((state) => ({
          diffSessions: state.diffSessions.map(s =>
            s.id === id ? { ...s, [side]: input } : s
          )
        }));
      },

      updateDiffSessionLanguage: (id, language, autoDetect) => {
        set((state) => ({
          diffSessions: state.diffSessions.map(s =>
            s.id === id ? { ...s, language, ...(autoDetect !== undefined ? { autoDetect } : {}) } : s
          )
        }));
      },

      renameDiffSession: (id, name) => {
        set((state) => ({
          diffSessions: state.diffSessions.map(s =>
            s.id === id ? { ...s, name } : s
          )
        }));
      },

      reorderDiffSessions: (fromIndex, toIndex) => {
        set((state) => ({
          diffSessions: arrayMove(state.diffSessions, fromIndex, toIndex),
        }));
      },

      updateDiffSettings: (settings) => {
        set((state) => ({
          diffSettings: { ...state.diffSettings, ...settings }
        }));
      },

      setLibrarySelectedItemId: (id) => {
        set({ librarySelectedItemId: id });
      },

      setLibrarySearchQuery: (query) => {
        set({ librarySearchQuery: query });
      },

      setLibraryTab: (tab) => {
        set({ libraryTab: tab, librarySelectedItemId: null, librarySearchQuery: "" });
      },

      setLibraryExcalidrawCategory: (category) => {
        set({ libraryExcalidrawCategory: category });
      },

      // Workflow actions
      createWorkflow: (name?: string, elements?: unknown[], appState?: Record<string, unknown>, files?: Record<string, unknown>) => {
        const id = generateId();
        const state = get();
        const { theme: _staleTheme, ...cleanAppState } = appState || {};
        const newWorkflow: Workflow = {
          id,
          name: name || `DrawFlow ${state.workflows.length + 1}`,
          elements: elements || [],
          appState: cleanAppState,
          files: files || {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          workflows: [...state.workflows, newWorkflow],
          activeWorkflowId: id,
        }));
        return id;
      },

      duplicateWorkflow: (id: string) => {
        const wf = get().workflows.find((w) => w.id === id);
        if (!wf) return;
        const newId = generateId();
        const newWorkflow: Workflow = {
          ...wf,
          id: newId,
          name: `${wf.name} (Copy)`,
          elements: wf.elements ? JSON.parse(JSON.stringify(wf.elements)) : [],
          appState: wf.appState ? { ...wf.appState } : {},
          files: wf.files ? { ...wf.files } : undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const index = get().workflows.findIndex((w) => w.id === id);
        const newWorkflows = [...get().workflows];
        newWorkflows.splice(index + 1, 0, newWorkflow);
        set({
          workflows: newWorkflows,
          activeWorkflowId: newId,
        });
      },

      deleteWorkflow: (id) => {
        set((state) => {
          const remaining = state.workflows.filter((w) => w.id !== id);
          if (remaining.length === 0) {
            const newWorkflow: Workflow = {
              id: generateId(),
              name: "My DrawFlow",
              elements: createDefaultWorkflowElements(),
              appState: {},
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

      closeOtherWorkflows: (id: string) => {
        set((state) => ({
          workflows: state.workflows.filter((w) => w.id === id),
          activeWorkflowId: id,
        }));
      },

      closeWorkflowsToRight: (id: string) => {
        set((state) => {
          const idx = state.workflows.findIndex((w) => w.id === id);
          if (idx === -1) return state;
          const remaining = state.workflows.slice(0, idx + 1);
          const activeExists = remaining.some((w) => w.id === state.activeWorkflowId);
          return {
            workflows: remaining,
            activeWorkflowId: activeExists ? state.activeWorkflowId : id,
          };
        });
      },

      closeAllWorkflows: () => {
        const newWorkflow: Workflow = {
          id: generateId(),
          name: "My DrawFlow",
          elements: createDefaultWorkflowElements(),
          appState: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set({
          workflows: [newWorkflow],
          activeWorkflowId: newWorkflow.id,
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

      reorderWorkflows: (fromIndex, toIndex) => {
        set((state) => ({
          workflows: arrayMove(state.workflows, fromIndex, toIndex),
        }));
      },

      updateWorkflowExcalidraw: (workflowId: string, elements: unknown[], appState?: Record<string, unknown>, files?: Record<string, unknown>) => {
        const { theme: _staleTheme, ...cleanAppState } = appState || {};
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === workflowId ? { ...w, elements, appState: cleanAppState, files, updatedAt: Date.now() } : w
          ),
        }));
      },

      excalidrawLibraryItems: [],
      updateExcalidrawLibraryItems: (items: unknown[]) => {
        set({ excalidrawLibraryItems: items });
      },
      excalidrawAddedLibraryIds: [],
      addExcalidrawAddedLibraryId: (id: string) => {
        set((state) => ({
          excalidrawAddedLibraryIds: state.excalidrawAddedLibraryIds?.includes(id)
            ? state.excalidrawAddedLibraryIds
            : [...(state.excalidrawAddedLibraryIds || []), id],
        }));
      },
      removeExcalidrawAddedLibraryId: (id: string) => {
        set((state) => ({
          excalidrawAddedLibraryIds: (state.excalidrawAddedLibraryIds || []).filter((libId) => libId !== id),
        }));
      },
      clearExcalidrawAddedLibraryIds: () => {
        set({ excalidrawAddedLibraryIds: [] });
      },
    }),
    {
      name: "devutils-app-state",
      onRehydrateStorage: () => (state) => {
        if (state && state.workflows && Array.isArray(state.workflows)) {
          state.workflows = state.workflows.map((w) => ({
            ...w,
            elements: Array.isArray(w.elements)
              ? w.elements.map((rawEl: unknown) => {
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
              })
              : w.elements,
          }));
        }
      },
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
        diffSessions: state.diffSessions,
        activeDiffSessionId: state.activeDiffSessionId,
        diffSettings: state.diffSettings,
        librarySelectedItemId: state.librarySelectedItemId,
        librarySearchQuery: state.librarySearchQuery,
        libraryExcalidrawCategory: state.libraryExcalidrawCategory,
        workflows: state.workflows,
        activeWorkflowId: state.activeWorkflowId,
        excalidrawLibraryItems: state.excalidrawLibraryItems,
        excalidrawAddedLibraryIds: state.excalidrawAddedLibraryIds,
      }),
    }
  )
);
