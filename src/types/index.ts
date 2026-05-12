// ============================================================
// Core Type Definitions — DevUtils
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
  formatterFiles: { json: FormatterFile[]; xml: FormatterFile[] };
  activeFormatterFileId: { json: string; xml: string };
  formatterType: "json" | "xml";
  comparatorSessions: ComparatorSession[];
  activeComparatorSessionId: string;
  comparatorSettings: { caseSensitive: boolean; trimWhitespace: boolean; sortAlpha: boolean };
  librarySelectedItemId: string | null;
  librarySearchQuery: string;

  // Workflow UI
  workflowMinimapVisible: boolean;
  workflowPaletteCollapsed: boolean;
  workflowPropertiesCollapsed: boolean;

  // Actions
  createFile: (name: string, language: Language) => void;
  deleteFile: (id: string) => void;
  setActiveFile: (id: string) => void;
  updateFileContent: (id: string, content: string) => void;
  saveFile: (id: string) => void;
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
  
  // Formatter actions
  createFormatterFile: (type: "json" | "xml", name?: string) => void;
  deleteFormatterFile: (type: "json" | "xml", id: string) => void;
  setActiveFormatterFile: (type: "json" | "xml", id: string) => void;
  updateFormatterFileContent: (type: "json" | "xml", id: string, content: string) => void;
  renameFormatterFile: (type: "json" | "xml", id: string, name: string) => void;
  setFormatterType: (type: "json" | "xml") => void;

  // Comparator actions
  createComparatorSession: (name?: string) => void;
  deleteComparatorSession: (id: string) => void;
  setActiveComparatorSession: (id: string) => void;
  updateComparatorSessionInput: (id: string, side: "a" | "b", input: string) => void;
  renameComparatorSession: (id: string, name: string) => void;
  updateComparatorSettings: (settings: Partial<AppState["comparatorSettings"]>) => void;
  
  setLibrarySelectedItemId: (id: string | null) => void;
  setLibrarySearchQuery: (query: string) => void;

  // Workflow actions
  workflows: Workflow[];
  activeWorkflowId: string;
  workflowSelectedNodeId: string | null;
  workflowSelectedEdgeId: string | null;
  createWorkflow: (name?: string) => void;
  deleteWorkflow: (id: string) => void;
  setActiveWorkflow: (id: string) => void;
  renameWorkflow: (id: string, name: string) => void;
  updateWorkflowNodes: (workflowId: string, nodes: WorkflowNodeData[]) => void;
  updateWorkflowEdges: (workflowId: string, edges: WorkflowEdgeData[]) => void;
  updateWorkflowViewport: (workflowId: string, viewport: { x: number; y: number; zoom: number }) => void;
  setWorkflowSelectedNodeId: (id: string | null) => void;
  setWorkflowSelectedEdgeId: (id: string | null) => void;
  toggleWorkflowMinimap: () => void;
  setWorkflowPaletteCollapsed: (collapsed: boolean) => void;
  setWorkflowPropertiesCollapsed: (collapsed: boolean) => void;
}

// ============================================================
// Workflow Types
// ============================================================

export type WorkflowNodeType = 'start' | 'end' | 'process' | 'decision' | 'data' | 'integration';

export interface WorkflowNodeData {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    description?: string;
    nodeType: WorkflowNodeType;
    color?: string;
    icon?: string;
    properties?: Record<string, string>;
  };
  measured?: { width: number; height: number };
  style?: Record<string, any>;
  width?: number;
  height?: number;
}

export interface WorkflowEdgeData {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  animated?: boolean;
  type?: string;
  data?: { 
    color?: string;
    edgeStyle?: "smoothstep" | "straight" | "bezier";
    lineStyle?: "solid" | "animated" | "dashed";
  };
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNodeData[];
  edges: WorkflowEdgeData[];
  viewport: { x: number; y: number; zoom: number };
  createdAt: number;
  updatedAt: number;
}

export interface ServiceNowMethod {
  name: string;
  description: string;
  parameters: string[];
  example: string;
}

export interface ServiceNowAPI {
  name: string;
  type: string;
  description: string;
  methods: ServiceNowMethod[];
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
