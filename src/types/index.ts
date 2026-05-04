// ============================================================
// Core Type Definitions — CodeForge
// ============================================================

/** Supported programming languages */
export type Language = "javascript" | "typescript" | "python" | "html";

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
}

/** Output panel entry */
export interface OutputEntry {
  id: string;
  type: "stdout" | "stderr" | "info" | "success" | "error";
  content: string;
  timestamp: number;
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

  // UI
  sidebarOpen: boolean;
  outputPanelOpen: boolean;
  settingsOpen: boolean;
  editorSettings: EditorSettings;

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

  toggleSidebar: () => void;
  toggleOutputPanel: () => void;
  toggleSettings: () => void;
  updateEditorSettings: (settings: Partial<EditorSettings>) => void;
}

// ============================================================
// Service Interfaces — designed for future backend swap
// ============================================================

/** Compiler service interface */
export interface ICompilerService {
  execute(code: string, language: Language): Promise<ExecutionResult>;
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
