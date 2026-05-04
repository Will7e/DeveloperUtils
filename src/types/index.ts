// ============================================================
// Core Type Definitions — DevUtils
// ============================================================

/** Supported programming languages */
export type Language = "javascript" | "typescript" | "python" | "html" | "json";

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
  soundEffects: boolean;
  executionTimeout: number; // milliseconds, default 10000
}

/** Output panel entry */
export interface OutputEntry {
  id: string;
  type: "stdout" | "stderr" | "info" | "success" | "error";
  content: string;
  timestamp: number;
}

/** Toast notification */
export interface Toast {
  id: string;
  message: string;
  type: "info" | "success" | "error";
  duration?: number;
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

  // Execution
  isRunning: boolean;
  executionResults: ExecutionResult[];
  outputEntries: OutputEntry[];
  executionStartTime: number | null;

  // UI
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  outputPanelOpen: boolean;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  editorSettings: EditorSettings;
  toasts: Toast[];
  outputFlash: "success" | "error" | null;
  formatterInputs: { json: string; xml: string };
  formatterType: "json" | "xml";

  // Actions
  createFile: (name: string, language: Language) => void;
  deleteFile: (id: string) => void;
  setActiveFile: (id: string) => void;
  updateFileContent: (id: string, content: string) => void;
  renameFile: (id: string, name: string) => void;

  addOutputEntry: (entry: Omit<OutputEntry, "id" | "timestamp">) => void;
  clearOutput: () => void;
  setIsRunning: (running: boolean) => void;
  addExecutionResult: (result: ExecutionResult) => void;
  setExecutionStartTime: (time: number | null) => void;
  cancelExecution: () => void;

  toggleSidebar: () => void;
  toggleSidebarCollapse: () => void;
  toggleOutputPanel: () => void;
  toggleSettings: () => void;
  toggleCommandPalette: () => void;
  updateEditorSettings: (settings: Partial<EditorSettings>) => void;

  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
  setOutputFlash: (flash: "success" | "error" | null) => void;
  setFormatterInput: (type: "json" | "xml", input: string) => void;
  setFormatterType: (type: "json" | "xml") => void;
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
