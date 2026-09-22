// ============================================================
// Core Type Definitions — InTab
// ============================================================

/** Supported programming languages */
export type Language = "javascript" | "typescript" | "python" | "html" | "sql" | "lua";

/** Language metadata for UI and engine selection */
export interface LanguageConfig {
  id: Language;
  label: string;
  icon: string;
  monacoLanguage: string;
  extension: string;
  defaultCode: string;
}

/** Execution result from a compiler/runner */
export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  timestamp: number;
  language?: Language;
  fileName?: string;
  /** Source code that produced this result (kept for history diffs) */
  sourceCode?: string;
}

/** A stored past run in a tab's run history */
export interface RunHistoryEntry {
  id: string;
  result: ExecutionResult;
  ranAt: number;
}

/** Options for code execution */
export interface ExecutionOptions {
  timeout?: number; // ms, default 10000
  /** Streaming stdout/stderr callbacks — fired line-by-line while running */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Stdin content piped to the program (Python scripts etc.) */
  stdin?: string;
  /** Sources of sibling tabs so JS/TS can import across tabs */
  moduleSources?: Record<string, string>;
}

/** A single file/tab in the editor */
export interface EditorFile {
  id: string;
  name: string;
  language: Language;
  content: string;
  isDirty: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A single file in the formatter tool */
export interface FormatterFile {
  id: string;
  name: string;
  content: string;
}

/** A single session in the comparator tool */
export interface ComparatorSession {
  id: string;
  name: string;
  a: string;
  b: string;
  mode?: "list" | "json" | "env";
}

/** A single session in the diff checker tool */
export interface DiffSession {
  id: string;
  name: string;
  original: string;
  modified: string;
  language: string;
  autoDetect?: boolean;
}

/** Diff checker settings */
export interface DiffSettings {
  renderSideBySide: boolean;
  ignoreTrimWhitespace: boolean;
  enableSplitViewResizing: boolean;
  autoFormatOnPaste?: boolean;
  wordWrap?: boolean;
}

/** Editor settings */
export interface EditorSettings {
  theme: "dark" | "light";
  fontSize: number;
  tabSize: number;
  wordWrap: "on" | "off";
  minimap: boolean;
  lineNumbers: "on" | "off" | "relative";
  fontFamily: string;
  cursorStyle: "line" | "block" | "underline";
  bracketPairColorization: boolean;
  formatOnPaste: boolean;
  formatOnType: boolean;
  executionTimeout: number; // milliseconds, default 10000
  /** Auto-collapse the main sidebar after idle (no pointer/keyboard activity) */
  sidebarAutoCollapse: boolean;
  /** Idle delay in milliseconds before auto-collapse kicks in */
  sidebarAutoCollapseDelay: number;
}

/** Output panel entry */
export interface OutputEntry {
  id: string;
  type: "stdout" | "stderr" | "info" | "success" | "error";
  content: string;
  timestamp: number;
}

/** Per-tab console & run state (each editor tab owns its own console) */
export interface TabExecutionState {
  isRunning: boolean;
  outputEntries: OutputEntry[];
  executionResults: ExecutionResult[];
  executionStartTime: number | null;
  /** Last N completed runs, restorable to the console */
  runHistory: RunHistoryEntry[];
  /** Stdin fed to the next run of this tab */
  stdin: string;
  /** Console currently showing a restored historical run instead of live output */
  restoredHistoryId: string | null;
}

/** Toast notification — Geist Toast (vercel.com/geist/toast) */
export interface Toast {
  id: string;
  title?: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
  /** Auto-dismiss delay in ms; omit for the 3s default, Infinity to preserve */
  duration?: number;
  /** Optional inline action button (e.g. "Undo") */
  action?: { label: string; onClick: () => void };
  /** Keep the toast on screen until manually dismissed */
  preserve?: boolean;
  /**
   * Render the message as a fixed-width report: newlines are honored
   * and the text is monospaced, so pre-aligned columns line up (used
   * by the /context breakdown and /status).
   */
  multiline?: boolean;
}

/** Command palette action */
export interface CommandAction {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  action: () => void;
}

/** Application state for the store */
export interface AppState {
  // Files
  files: EditorFile[];
  activeFileId: string | null;

  // Execution — per-tab console state; isRunning = any tab currently running
  isRunning: boolean;
  tabExec: Record<string, TabExecutionState>;

  // UI
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  outputPanelOpen: boolean;
  /** Split-console mode: show another tab's console side-by-side */
  splitConsoleFileId: string | null;
  splitConsoleOpen: boolean;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  editorSettings: EditorSettings;
  toasts: Toast[];
  outputFlash: "success" | "error" | null;
  formatterFiles: { json: FormatterFile[]; xml: FormatterFile[] };
  activeFormatterFileId: { json: string; xml: string };
  formatterType: "json" | "xml";
  comparatorSessions: ComparatorSession[];
  activeComparatorSessionId: string;
  comparatorSettings: { caseSensitive: boolean; trimWhitespace: boolean; sortAlpha: boolean };
  diffSessions: DiffSession[];
  activeDiffSessionId: string;
  diffSettings: DiffSettings;
  librarySelectedItemId: string | null;
  librarySearchQuery: string;
  libraryTab: "servicenow" | "drawflow" | "excalidraw";
  libraryDrawFlowCategory: string;
  libraryExcalidrawCategory?: string;

  // Actions
  createFile: (name: string, language: Language, content?: string) => void;
  duplicateFile: (id: string) => void;
  deleteFile: (id: string) => void;
  closeOtherFiles: (id: string) => void;
  closeFilesToRight: (id: string) => void;
  closeAllFiles: () => void;
  setActiveFile: (id: string) => void;
  reorderFiles: (fromIndex: number, toIndex: number) => void;
  updateFileContent: (id: string, content: string) => void;
  saveFile: (id: string) => void;
  renameFile: (id: string, name: string) => void;

  /** Run a file in its own console (per-tab execution) */
  runFile: (fileId: string) => Promise<void>;
  /** Cancel a tab's run, or all running tabs when no id is given */
  cancelRun: (fileId?: string) => Promise<void>;
  /** Clear a single tab's console */
  clearTabOutput: (fileId: string) => void;
  /** Append a streaming output chunk to a tab's live console */
  appendStreamOutput: (fileId: string, type: "stdout" | "stderr", chunk: string) => void;
  /** Set a tab's stdin for its next run */
  setTabStdin: (fileId: string, stdin: string) => void;
  /** Restore a historical run's output into a tab's console view */
  restoreRunHistory: (fileId: string, historyId: string | null) => void;
  /** Toggle / set the split-console comparison pane */
  toggleSplitConsole: () => void;
  setSplitConsoleFile: (fileId: string | null) => void;

  toggleSidebar: () => void;
  toggleSidebarCollapse: () => void;
  toggleOutputPanel: () => void;
  setOutputPanelOpen: (open: boolean) => void;
  toggleSettings: () => void;
  toggleCommandPalette: () => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  updateEditorSettings: (settings: Partial<EditorSettings>) => void;

  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
  setOutputFlash: (flash: "success" | "error" | null) => void;
  
  // Formatter actions
  createFormatterFile: (type: "json" | "xml", name?: string) => void;
  duplicateFormatterFile: (type: "json" | "xml", id: string) => void;
  deleteFormatterFile: (type: "json" | "xml", id: string) => void;
  closeOtherFormatterFiles: (type: "json" | "xml", id: string) => void;
  closeFormatterFilesToRight: (type: "json" | "xml", id: string) => void;
  closeAllFormatterFiles: (type: "json" | "xml") => void;
  setActiveFormatterFile: (type: "json" | "xml", id: string) => void;
  updateFormatterFileContent: (type: "json" | "xml", id: string, content: string) => void;
  renameFormatterFile: (type: "json" | "xml", id: string, name: string) => void;
  reorderFormatterFiles: (type: "json" | "xml", fromIndex: number, toIndex: number) => void;
  setFormatterType: (type: "json" | "xml") => void;

  // Comparator actions
  createComparatorSession: (name?: string, mode?: "list" | "json" | "env") => void;
  duplicateComparatorSession: (id: string) => void;
  deleteComparatorSession: (id: string) => void;
  closeOtherComparatorSessions: (id: string) => void;
  closeComparatorSessionsToRight: (id: string) => void;
  closeAllComparatorSessions: () => void;
  setActiveComparatorSession: (id: string) => void;
  updateComparatorSessionInput: (id: string, side: "a" | "b", input: string) => void;
  updateComparatorSessionMode: (id: string, mode: "list" | "json" | "env") => void;
  swapComparatorSessionInputs: (id: string) => void;
  renameComparatorSession: (id: string, name: string) => void;
  reorderComparatorSessions: (fromIndex: number, toIndex: number) => void;
  updateComparatorSettings: (settings: Partial<AppState["comparatorSettings"]>) => void;

  // Diff checker actions
  createDiffSession: (name?: string) => void;
  duplicateDiffSession: (id: string) => void;
  deleteDiffSession: (id: string) => void;
  closeOtherDiffSessions: (id: string) => void;
  closeDiffSessionsToRight: (id: string) => void;
  closeAllDiffSessions: () => void;
  setActiveDiffSession: (id: string) => void;
  updateDiffSessionInput: (id: string, side: "original" | "modified", input: string) => void;
  updateDiffSessionLanguage: (id: string, language: string, autoDetect?: boolean) => void;
  renameDiffSession: (id: string, name: string) => void;
  reorderDiffSessions: (fromIndex: number, toIndex: number) => void;
  updateDiffSettings: (settings: Partial<DiffSettings>) => void;
  
  setLibrarySelectedItemId: (id: string | null) => void;
  setLibrarySearchQuery: (query: string) => void;
  setLibraryTab: (tab: "servicenow" | "drawflow" | "excalidraw") => void;
  setLibraryDrawFlowCategory: (category: string) => void;
  setLibraryExcalidrawCategory: (category: string) => void;

  // Workflow UI & State (DrawFlow)
  workflows: Workflow[];
  activeWorkflowId: string;
  drawflowLibraryItems?: unknown[];
  drawflowAddedLibraryIds?: string[];
  excalidrawLibraryItems?: unknown[];
  excalidrawAddedLibraryIds?: string[];
  createWorkflow: (name?: string, elements?: unknown[], appState?: Record<string, unknown>, files?: Record<string, unknown>) => string;
  duplicateWorkflow: (id: string) => void;
  deleteWorkflow: (id: string) => void;
  closeOtherWorkflows: (id: string) => void;
  closeWorkflowsToRight: (id: string) => void;
  closeAllWorkflows: () => void;
  setActiveWorkflow: (id: string) => void;
  renameWorkflow: (id: string, name: string) => void;
  reorderWorkflows: (fromIndex: number, toIndex: number) => void;
  updateWorkflowDrawFlow: (workflowId: string, elements: unknown[], appState?: Record<string, unknown>, files?: Record<string, unknown>) => void;
  updateWorkflowExcalidraw: (workflowId: string, elements: unknown[], appState?: Record<string, unknown>, files?: Record<string, unknown>) => void;
  updateDrawFlowLibraryItems: (libraryItems: unknown[]) => void;
  updateExcalidrawLibraryItems: (libraryItems: unknown[]) => void;
  addDrawFlowAddedLibraryId: (id: string) => void;
  addExcalidrawAddedLibraryId: (id: string) => void;
  removeDrawFlowAddedLibraryId: (id: string) => void;
  removeExcalidrawAddedLibraryId: (id: string) => void;
  clearDrawFlowAddedLibraryIds: () => void;
  clearExcalidrawAddedLibraryIds: () => void;
}

// ============================================================
// Workflow Types (DrawFlow)
// ============================================================

export interface Workflow {
  id: string;
  name: string;
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ServiceNowMethod {
  name: string;
  description: string;
  parameters: string[];
  example: string;
  returnType?: string;
  returnDescription?: string;
  scope?: "global" | "scoped" | "both";
  deprecated?: boolean;
  deprecationNotice?: string;
  sinceRelease?: string;
}

export interface ServiceNowAPI {
  name: string;
  type: string;
  description: string;
  methods: ServiceNowMethod[];
  officialDocsUrl?: string;
  package?: string;
}

export interface ServiceNowLibrary {
  version: string;
  last_updated: string;
  source: string;
  apis: ServiceNowAPI[];
}

// ============================================================
// Service Interfaces — designed for future backend swap
// ============================================================

/** Options for code execution */
export interface ExecutionOptions {
  timeout?: number; // ms, default 10000
  onStdout?: (chunk: string) => void; // streaming output callback
}

/** Compiler service interface */
export interface ICompilerService {
  execute(code: string, language: Language, options?: ExecutionOptions): Promise<ExecutionResult>;
  cancel(): Promise<void>;
  isReady(language: Language): Promise<boolean>;
  initialize(language: Language): Promise<void>;
}

/** Storage service interface (browser-local today, cloud tomorrow) */
export interface IStorageService {
  saveFile(file: EditorFile): Promise<void>;
  loadFile(id: string): Promise<EditorFile | null>;
  listFiles(): Promise<EditorFile[]>;
  deleteFile(id: string): Promise<void>;
}

/** Auth service interface (stub for future) */
export interface IAuthService {
  isAuthenticated(): boolean;
  login(credentials: { email: string; password: string }): Promise<void>;
  logout(): Promise<void>;
  getUser(): { id: string; email: string; name: string } | null;
}

/** API service interface (stub for future) */
export interface IAPIService {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, data: unknown): Promise<T>;
  put<T>(url: string, data: unknown): Promise<T>;
  delete(url: string): Promise<void>;
}
