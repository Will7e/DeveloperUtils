// ============================================================
// Global State Store — Zustand
// ============================================================

import { create } from "zustand";
import type { AppState, Language, EditorFile } from "@/types";
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

export const useAppStore = create<AppState>((set, get) => ({
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
  outputPanelOpen: true,
  settingsOpen: false,
  commandPaletteOpen: false,
  editorSettings: DEFAULT_EDITOR_SETTINGS,
  toasts: [],
  outputFlash: null,

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
          ? { ...f, content, isDirty: true, updatedAt: Date.now() }
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

  // UI actions
  toggleSidebar: () => {
    set((state) => ({ sidebarOpen: !state.sidebarOpen }));
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

  setOutputFlash: (flash) => {
    set({ outputFlash: flash });
    if (flash) {
      setTimeout(() => {
        set({ outputFlash: null });
      }, 800);
    }
  },
}));
