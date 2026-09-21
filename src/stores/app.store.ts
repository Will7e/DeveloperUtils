// ============================================================
// Global State Store — Zustand with localStorage persistence
// ============================================================

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createEncryptedStorage } from "@/services/encrypted-storage.service";
import { compilerService } from "@/services/compiler.service";
import { formatDuration } from "@/lib/utils";
import type { AppState, Language, EditorFile, Workflow, DiffSession, DiffSettings, ComparatorSession, TabExecutionState, OutputEntry, ExecutionResult, RunHistoryEntry } from "@/types";
import { DEFAULT_EDITOR_SETTINGS, LANGUAGE_CONFIGS } from "@/config";
import { generateId } from "@/lib/utils";

/** Languages whose runtime must be initialized before first run */
const RUNTIME_LANGUAGES: Language[] = ["python", "typescript", "sql", "lua"];

const RUNTIME_LABELS: Partial<Record<Language, string>> = {
  python: "Loading Python runtime (Pyodide)...",
  typescript: "Loading TypeScript compiler...",
  sql: "Loading SQLite runtime (WASM)...",
  lua: "Loading Lua runtime (WASM)...",
};

/** Max stored runs per tab */
const RUN_HISTORY_LIMIT = 20;

/** Create an empty per-tab execution state */
function createTabExec(): TabExecutionState {
  return {
    isRunning: false,
    outputEntries: [],
    executionResults: [],
    executionStartTime: null,
    runHistory: [],
    stdin: "",
    restoredHistoryId: null,
  };
}

/** Ensure a tab has execution state, creating it lazily */
function ensureTabExec(state: AppState, fileId: string): TabExecutionState {
  return state.tabExec[fileId] ?? createTabExec();
}

/** Build the module sources map (all tabs except the runner) for cross-tab imports */
function buildModuleSources(state: AppState, runnerFileId: string): Record<string, string> {
  const runner = state.files.find((f) => f.id === runnerFileId);
  const runnerLang = runner?.language;
  const sources: Record<string, string> = {};
  for (const f of state.files) {
    if (f.id === runnerFileId) continue;
    // Only JS/TS siblings can be imported into a JS/TS program
    if (runnerLang === "javascript" || runnerLang === "typescript") {
      if (f.language !== "javascript" && f.language !== "typescript") continue;
    }
    sources[f.name] = f.content;
  }
  return sources;
}

/** Append an output entry to a specific tab's console */
function pushTabOutput(state: AppState, fileId: string, entry: Omit<OutputEntry, "id" | "timestamp">): Partial<AppState> {
  const exec = ensureTabExec(state, fileId);
  const newEntry: OutputEntry = { ...entry, id: generateId(), timestamp: Date.now() };
  return {
    tabExec: {
      ...state.tabExec,
      [fileId]: { ...exec, outputEntries: [...exec.outputEntries, newEntry] },
    },
  };
}

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
const initialComparatorSession: ComparatorSession = { id: generateId(), name: "List Compare", a: "", b: "", mode: "list" };
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
    strokeColor: "#0070f3",
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
    text: "InTab DrawFlow Studio",
    fontSize: 24,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    baseline: 20,
    containerId: null,
    originalText: "InTab DrawFlow Studio",
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
    text: "Draw diagrams, flowcharts, and architecture specs with DrawFlow.",
    fontSize: 14,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    baseline: 12,
    containerId: null,
    originalText: "Draw diagrams, flowcharts, and architecture specs with DrawFlow.",
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
    strokeColor: "#0070f3",
    backgroundColor: "#0070f314",
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
    strokeColor: "#0070f3",
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

// Migrate legacy storage key if needed
try {
  if (typeof window !== "undefined" && window.localStorage) {
    const legacy = window.localStorage.getItem("devutils-app-state");
    if (legacy && !window.localStorage.getItem("intab-app-state")) {
      window.localStorage.setItem("intab-app-state", legacy);
    }
  }
} catch {
  // Ignore localStorage errors
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Files
      files: [initialFile],
      activeFileId: initialFile.id,

      // Execution — per-tab console state; isRunning = any tab running
      isRunning: false,
      tabExec: {},

      // UI
      sidebarOpen: false,
      sidebarCollapsed: false,
      outputPanelOpen: true,
      splitConsoleOpen: false,
      splitConsoleFileId: null,
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
      libraryDrawFlowCategory: "all",
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
        const sourceExec = get().tabExec[id];
        set((state) => ({
          files: newFiles,
          activeFileId: newId,
          tabExec: sourceExec
            ? {
                ...state.tabExec,
                // Fresh console for the copy, history preserved on the original
                [newId]: {
                  ...createTabExec(),
                  executionResults: sourceExec.executionResults,
                },
              }
            : state.tabExec,
        }));
      },

      deleteFile: (id: string) => {
        const state = get();
        const remaining = state.files.filter((f) => f.id !== id);
        const { [id]: _ignored, ...remainingTabExec } = state.tabExec;
        void _ignored;
        if (remaining.length === 0) {
          // Always keep at least one file
          const fallback = createDefaultFile("javascript");
          set({
            files: [fallback],
            activeFileId: fallback.id,
            tabExec: {},
          });
        } else {
          set({
            files: remaining,
            activeFileId:
              state.activeFileId === id
                ? remaining[remaining.length - 1]!.id
                : state.activeFileId,
            tabExec: remainingTabExec,
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

      // ── Per-tab execution ─────────────────────────────────
      runFile: async (fileId: string) => {
        const file = get().files.find((f) => f.id === fileId);
        if (!file || get().tabExec[fileId]?.isRunning) return;
        if (file.language === "html") return; // HTML is previewed, not run

        // Ensure the console panel is visible when running
        if (!get().outputPanelOpen) {
          get().toggleOutputPanel();
        }

        const startedAt = Date.now();
        set((state) => ({
          isRunning: true,
          tabExec: {
            ...state.tabExec,
            [fileId]: {
              ...ensureTabExec(state, fileId),
              isRunning: true,
              outputEntries: [],
              restoredHistoryId: null,
              executionStartTime: startedAt,
            },
          },
        }));

        set((state) => ({ ...pushTabOutput(state, fileId, { type: "info", content: `Running ${file.name}...` }) }));

        get().addToast({ message: `Running ${file.name}...`, type: "info", duration: 2000 });

        // Snapshot the exact code being run (kept on the result for history diffs)
        const sourceCode = file.content;

        try {
          // Initialize the WASM / compiler runtime on first use
          if (RUNTIME_LANGUAGES.includes(file.language)) {
            const ready = await compilerService.isReady(file.language);
            if (!ready) {
              set((state) => ({
                ...pushTabOutput(state, fileId, {
                  type: "info",
                  content: RUNTIME_LABELS[file.language] ?? "Loading runtime...",
                }),
              }));
              await compilerService.initialize(file.language);
            }
          }

          const result = await compilerService.execute(file.content, file.language, {
            timeout: get().editorSettings.executionTimeout,
            stdin: ensureTabExec(get() as AppState, fileId).stdin,
            moduleSources: buildModuleSources(get() as AppState, fileId),
            onStdout: (chunk) => get().appendStreamOutput(fileId, "stdout", chunk),
            onStderr: (chunk) => get().appendStreamOutput(fileId, "stderr", chunk),
          });

          const finalResult: ExecutionResult = { ...result, sourceCode };

          set((state) => {
            const exec = ensureTabExec(state, fileId);
            const isSuccess = finalResult.exitCode === 0;
            const entries: OutputEntry[] = [];
            const mk = (type: OutputEntry["type"], content: string): OutputEntry =>
              ({ id: generateId(), timestamp: Date.now(), type, content });
            // Only append full-run output when nothing was streamed live
            const streamed = exec.outputEntries.some((e) => e.type === "stdout" || e.type === "stderr");
            if (!streamed) {
              if (finalResult.stdout) entries.push(mk("stdout", finalResult.stdout));
              if (finalResult.stderr) entries.push(mk("stderr", finalResult.stderr));
            } else if (finalResult.stderr && !exec.outputEntries.some((e) => e.type === "stderr")) {
              entries.push(mk("stderr", finalResult.stderr));
            }
            entries.push(
              mk(
                isSuccess ? "success" : "error",
                isSuccess
                  ? `Completed in ${formatDuration(finalResult.duration)}`
                  : `Exit code ${finalResult.exitCode} (${formatDuration(finalResult.duration)})`
              )
            );
            const historyEntry: RunHistoryEntry = {
              id: generateId(),
              result: finalResult,
              ranAt: startedAt,
            };
            return {
              isRunning: false,
              tabExec: {
                ...state.tabExec,
                [fileId]: {
                  ...exec,
                  isRunning: false,
                  executionStartTime: null,
                  // Capped like runHistory — executionResults (incl.
                  // full sourceCode snapshots) are persisted, so an
                  // unbounded array would bloat storage over time.
                  executionResults: [...exec.executionResults, finalResult].slice(-RUN_HISTORY_LIMIT),
                  runHistory: [...exec.runHistory, historyEntry].slice(-RUN_HISTORY_LIMIT),
                  outputEntries: [...exec.outputEntries, ...entries],
                },
              },
            };
          });

          get().setOutputFlash(finalResult.exitCode === 0 ? "success" : "error");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => {
            const exec = ensureTabExec(state, fileId);
            return {
              // Reset the per-tab exec state so the tab doesn't stay
              // stuck in "Running" forever after a failed run (e.g. a
              // runtime init failure). Without this, runFile would
              // early-return on every future click until page reload.
              isRunning: false,
              tabExec: {
                ...state.tabExec,
                [fileId]: {
                  ...exec,
                  isRunning: false,
                  executionStartTime: null,
                  outputEntries: [
                    ...exec.outputEntries,
                    { id: generateId(), timestamp: Date.now(), type: "error" as const, content: `Error: ${message}` },
                  ],
                },
              },
            };
          });
          get().setOutputFlash("error");
        }
      },

      cancelRun: async (fileId?: string) => {
        await compilerService.cancel();
        set((state) => {
          const runningIds = Object.entries(state.tabExec)
            .filter(([, exec]) => exec.isRunning)
            .map(([id]) => id);
          const targets = fileId ? [fileId] : runningIds;
          if (targets.length === 0) return { isRunning: false };
          const nextTabExec = { ...state.tabExec };
          for (const id of targets) {
            const exec = nextTabExec[id];
            if (!exec || !exec.isRunning) continue;
            nextTabExec[id] = {
              ...exec,
              isRunning: false,
              executionStartTime: null,
              outputEntries: [
                ...exec.outputEntries,
                { id: generateId(), timestamp: Date.now(), type: "error", content: "⛔ Execution cancelled by user" },
              ],
            };
          }
          return {
            tabExec: nextTabExec,
            isRunning: Object.values(nextTabExec).some((exec) => exec.isRunning),
          };
        });
        get().setOutputFlash("error");
        get().addToast({ message: "Execution cancelled", type: "error", duration: 2000 });
      },

      clearTabOutput: (fileId: string) => {
        set((state) => {
          const exec = state.tabExec[fileId];
          if (!exec) return state;
          return {
            tabExec: { ...state.tabExec, [fileId]: { ...exec, outputEntries: [], restoredHistoryId: null } },
          };
        });
      },

      appendStreamOutput: (fileId, type, chunk) => {
        set((state) => {
          const exec = ensureTabExec(state, fileId);
          const last = exec.outputEntries[exec.outputEntries.length - 1];
          // Coalesce consecutive chunks of the same kind into one growing entry
          if (last && last.type === type && Date.now() - last.timestamp < 500) {
            return {
              tabExec: {
                ...state.tabExec,
                [fileId]: {
                  ...exec,
                  restoredHistoryId: null,
                  outputEntries: [
                    ...exec.outputEntries.slice(0, -1),
                    { ...last, content: last.content + "\n" + chunk },
                  ],
                },
              },
            };
          }
          return {
            tabExec: {
              ...state.tabExec,
              [fileId]: {
                ...exec,
                restoredHistoryId: null,
                outputEntries: [
                  ...exec.outputEntries,
                  { id: generateId(), timestamp: Date.now(), type, content: chunk },
                ],
              },
            },
          };
        });
      },

      setTabStdin: (fileId, stdin) => {
        set((state) => {
          const exec = ensureTabExec(state, fileId);
          if (exec.stdin === stdin) return state;
          return {
            tabExec: { ...state.tabExec, [fileId]: { ...exec, stdin } },
          };
        });
      },

      restoreRunHistory: (fileId, historyId) => {
        set((state) => {
          const exec = ensureTabExec(state, fileId);
          if (historyId === null) {
            return {
              tabExec: { ...state.tabExec, [fileId]: { ...exec, restoredHistoryId: null } },
            };
          }
          const entry = exec.runHistory.find((h) => h.id === historyId);
          if (!entry) return state;
          const entries: OutputEntry[] = [];
          if (entry.result.stdout) {
            entries.push({ id: generateId(), timestamp: entry.ranAt, type: "stdout", content: entry.result.stdout });
          }
          if (entry.result.stderr) {
            entries.push({ id: generateId(), timestamp: entry.ranAt, type: "stderr", content: entry.result.stderr });
          }
          entries.push({
            id: generateId(),
            timestamp: entry.ranAt,
            type: entry.result.exitCode === 0 ? "success" : "error",
            content:
              entry.result.exitCode === 0
                ? `History · ${formatDuration(entry.result.duration)}`
                : `History · Exit code ${entry.result.exitCode} (${formatDuration(entry.result.duration)})`,
          });
          return {
            tabExec: {
              ...state.tabExec,
              [fileId]: { ...exec, restoredHistoryId: historyId, outputEntries: entries },
            },
          };
        });
      },

      toggleSplitConsole: () => {
        set((state) => ({
          splitConsoleOpen: !state.splitConsoleOpen,
          splitConsoleFileId: state.splitConsoleOpen ? null : state.splitConsoleFileId,
        }));
      },

      setSplitConsoleFile: (fileId) => {
        set({
          splitConsoleFileId: fileId,
          splitConsoleOpen: fileId !== null,
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
        if (settings.theme && typeof window !== "undefined" && window.localStorage) {
          try {
            localStorage.setItem("intab_theme", settings.theme);
            if (settings.theme === "light") {
              document.documentElement.classList.add("light");
            } else {
              document.documentElement.classList.remove("light");
            }
          } catch {
            // Ignore storage write error
          }
        }
        set((state) => ({
          editorSettings: { ...state.editorSettings, ...settings },
        }));
      },

      // Toast actions — dismissal timers live in ToastContainer so hover
      // can pause/resume them; the store only tracks presence.
      addToast: (toast) => {
        const id = generateId();
        set((state) => ({
          toasts: [...state.toasts, { ...toast, id }],
        }));
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

      createComparatorSession: (name, mode = "list") => {
        const id = generateId();
        const defaultNames: Record<string, string> = {
          list: "List Compare",
          json: "JSON Compare",
          env: ".env Compare",
        };
        const newSession: ComparatorSession = {
          id,
          name: name || defaultNames[mode] || "Compare",
          a: "",
          b: "",
          mode,
        };
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
            const newSession: ComparatorSession = { id: generateId(), name: "List Compare", a: "", b: "", mode: "list" };
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
        const newSession: ComparatorSession = { id: generateId(), name: "List Compare", a: "", b: "", mode: "list" };
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

      updateComparatorSessionMode: (id, mode) => {
        set((state) => ({
          comparatorSessions: state.comparatorSessions.map(s =>
            s.id === id ? { ...s, mode } : s
          )
        }));
      },

      swapComparatorSessionInputs: (id) => {
        set((state) => ({
          comparatorSessions: state.comparatorSessions.map(s =>
            s.id === id ? { ...s, a: s.b, b: s.a } : s
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

      setLibraryDrawFlowCategory: (category) => {
        set({ libraryDrawFlowCategory: category, libraryExcalidrawCategory: category });
      },

      setLibraryExcalidrawCategory: (category) => {
        set({ libraryDrawFlowCategory: category, libraryExcalidrawCategory: category });
      },

      // Workflow actions
      createWorkflow: (name?: string, elements?: unknown[], appState?: Record<string, unknown>, files?: Record<string, unknown>) => {
        const id = generateId();
        const state = get();
        const cleanAppState = { ...(appState || {}) };
        delete cleanAppState.theme;
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

      updateWorkflowDrawFlow: (workflowId: string, elements: unknown[], appState?: Record<string, unknown>, files?: Record<string, unknown>) => {
        const cleanAppState = { ...(appState || {}) };
        delete cleanAppState.theme;
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === workflowId ? { ...w, elements, appState: cleanAppState, files, updatedAt: Date.now() } : w
          ),
        }));
      },
      updateWorkflowExcalidraw: (workflowId: string, elements: unknown[], appState?: Record<string, unknown>, files?: Record<string, unknown>) => {
        const cleanAppState = { ...(appState || {}) };
        delete cleanAppState.theme;
        set((state) => ({
          workflows: state.workflows.map((w) =>
            w.id === workflowId ? { ...w, elements, appState: cleanAppState, files, updatedAt: Date.now() } : w
          ),
        }));
      },

      drawflowLibraryItems: [],
      excalidrawLibraryItems: [],
      updateDrawFlowLibraryItems: (items: unknown[]) => {
        set({ drawflowLibraryItems: items, excalidrawLibraryItems: items });
      },
      updateExcalidrawLibraryItems: (items: unknown[]) => {
        set({ drawflowLibraryItems: items, excalidrawLibraryItems: items });
      },

      drawflowAddedLibraryIds: [],
      excalidrawAddedLibraryIds: [],
      addDrawFlowAddedLibraryId: (id: string) => {
        set((state) => {
          const list = state.drawflowAddedLibraryIds || state.excalidrawAddedLibraryIds || [];
          const updated = list.includes(id) ? list : [...list, id];
          return {
            drawflowAddedLibraryIds: updated,
            excalidrawAddedLibraryIds: updated,
          };
        });
      },
      addExcalidrawAddedLibraryId: (id: string) => {
        set((state) => {
          const list = state.drawflowAddedLibraryIds || state.excalidrawAddedLibraryIds || [];
          const updated = list.includes(id) ? list : [...list, id];
          return {
            drawflowAddedLibraryIds: updated,
            excalidrawAddedLibraryIds: updated,
          };
        });
      },
      removeDrawFlowAddedLibraryId: (id: string) => {
        set((state) => {
          const list = state.drawflowAddedLibraryIds || state.excalidrawAddedLibraryIds || [];
          const filtered = list.filter((libId) => libId !== id);
          return {
            drawflowAddedLibraryIds: filtered,
            excalidrawAddedLibraryIds: filtered,
          };
        });
      },
      removeExcalidrawAddedLibraryId: (id: string) => {
        set((state) => {
          const list = state.drawflowAddedLibraryIds || state.excalidrawAddedLibraryIds || [];
          const filtered = list.filter((libId) => libId !== id);
          return {
            drawflowAddedLibraryIds: filtered,
            excalidrawAddedLibraryIds: filtered,
          };
        });
      },
      clearDrawFlowAddedLibraryIds: () => {
        set({ drawflowAddedLibraryIds: [], excalidrawAddedLibraryIds: [] });
      },
      clearExcalidrawAddedLibraryIds: () => {
        set({ drawflowAddedLibraryIds: [], excalidrawAddedLibraryIds: [] });
      },
    }),
    {
      name: "intab-app-state",
      storage: createJSONStorage(() => createEncryptedStorage()),
      onRehydrateStorage: () => (state) => {
        if (state?.editorSettings?.theme && typeof window !== "undefined" && window.localStorage) {
          try {
            localStorage.setItem("intab_theme", state.editorSettings.theme);
          } catch {
            // Ignore storage write error
          }
        }
        // Migration: legacy single-console outputEntries → per-tab console
        if (state && Array.isArray((state as { outputEntries?: unknown }).outputEntries)) {
          void (state as { outputEntries?: unknown }).outputEntries;
          const legacy = (state as unknown as { outputEntries: OutputEntry[]; executionResults?: ExecutionResult[] }).outputEntries;
          const legacyResults = (state as unknown as { executionResults?: ExecutionResult[] }).executionResults ?? [];
          if (legacy.length > 0 || legacyResults.length > 0) {
            const tabExec: Record<string, TabExecutionState> = {};
            if (state.activeFileId) {
              tabExec[state.activeFileId] = {
                ...createTabExec(),
                outputEntries: legacy,
                executionResults: legacyResults,
              };
            }
            useAppStore.setState({ tabExec });
          }
        }
        // Safety: normalize every persisted tabExec entry — backfill new
        // fields added in later versions and never restore a "running"
        // flag across reloads.
        if (state && state.tabExec && Object.keys(state.tabExec).length > 0) {
          const fixed: Record<string, TabExecutionState> = {};
          let changed = false;
          for (const [id, e] of Object.entries(state.tabExec)) {
            const needsBackfill = !e.runHistory || !("stdin" in e) || !("restoredHistoryId" in e);
            const wasRunning = e.isRunning || e.executionStartTime;
            if (needsBackfill || wasRunning) {
              fixed[id] = {
                ...createTabExec(),
                ...e,
                isRunning: false,
                executionStartTime: null,
                runHistory: e.runHistory ?? [],
                stdin: e.stdin ?? "",
                restoredHistoryId: null,
              };
              changed = true;
            } else {
              fixed[id] = e;
            }
          }
          if (changed) useAppStore.setState({ tabExec: fixed });
        }
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
                  newEl.strokeColor = "#171717";
                  modified = true;
                }
                if (el.id === "node-start" && (el.backgroundColor === "#0369a122" || el.backgroundColor === "#e0f2fe")) {
                  newEl.strokeColor = "#0070f3";
                  newEl.backgroundColor = "#0070f314";
                  modified = true;
                }
                if (el.id === "node-action" && (el.backgroundColor === "#04785722" || el.backgroundColor === "#dcfce7")) {
                  newEl.strokeColor = "#00df8f";
                  newEl.backgroundColor = "#00df8f14";
                  modified = true;
                }
                if (el.id === "welcome-title" && (el.strokeColor === "#38bdf8" || el.strokeColor === "#0284c7")) {
                  newEl.strokeColor = "#0070f3";
                  modified = true;
                }
                if (el.id === "welcome-subtitle" && (el.strokeColor === "#94a3b8" || el.strokeColor === "#64748b")) {
                  newEl.strokeColor = "#888888";
                  modified = true;
                }
                if (el.id === "arrow-1" && (el.strokeColor === "#38bdf8" || el.strokeColor === "#0284c7")) {
                  newEl.strokeColor = "#0070f3";
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
        tabExec: state.tabExec,
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
        libraryDrawFlowCategory: state.libraryDrawFlowCategory,
        libraryExcalidrawCategory: state.libraryExcalidrawCategory,
        workflows: state.workflows,
        activeWorkflowId: state.activeWorkflowId,
        drawflowLibraryItems: state.drawflowLibraryItems,
        drawflowAddedLibraryIds: state.drawflowAddedLibraryIds,
        excalidrawLibraryItems: state.excalidrawLibraryItems,
        excalidrawAddedLibraryIds: state.excalidrawAddedLibraryIds,
      }),
    }
  )
);
