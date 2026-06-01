// ============================================================
// API Tester Component — Premium REST Client
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { setupMonacoTheme } from "@/utils/monaco-theme";
import {
  Send,
  Plus,
  Trash2,
  History,
  Sparkles,
  Info,
  Globe,
  Clock,
  Database,
  AlertCircle,
  Copy,
  Check,
  Search,
  ChevronRight,
  Download,
  X,
  ShieldCheck,
  Activity,
  Terminal,
  Lock,
  Key,
  User,
  Eye,
  EyeOff,
  ChevronDown,
  FileJson,
  FolderUp,
  Folder,
  Code2,
  Settings,
  BookOpen,
  Shield,
  Zap,
  Wifi,
  WifiOff,
  Square,
} from "lucide-react";
import {
  useApiTesterStore,
  HttpMethod,
  BodyType,
  AuthType,
  HistoryItem,
} from "@/stores/api-tester.store";
import { useAppStore } from "@/stores/app.store";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { generateCodeSnippet, CODE_LANGUAGES } from "./code-generator";
import "./api-tester.css";

// ── Built-in Presets ─────────────────────────────────────────
const PRESETS = [
  {
    name: "GitHub API - Get User",
    method: "GET" as HttpMethod,
    url: "https://api.github.com/users/octocat",
    params: [],
    headers: [
      { key: "Accept", value: "application/vnd.github.v3+json" },
      { key: "User-Agent", value: "DevUtils-API-Tester" }
    ],
    bodyType: "none" as BodyType,
    description: "Fetch public profile details for a GitHub user.",
  },
  {
    name: "ReqRes - Mock Authentication",
    method: "POST" as HttpMethod,
    url: "https://reqres.in/api/login",
    params: [],
    headers: [
      { key: "Content-Type", value: "application/json" }
    ],
    bodyType: "json" as BodyType,
    bodyValue: JSON.stringify(
      {
        email: "eve.holt@reqres.in",
        password: "cityslicka"
      },
      null,
      2
    ),
    description: "Simulate a user login flow using ReqRes mock API.",
  },
  {
    name: "Postman Echo - Test Payload",
    method: "POST" as HttpMethod,
    url: "https://postman-echo.com/post",
    params: [
      { key: "environment", value: "production" }
    ],
    headers: [
      { key: "Content-Type", value: "application/json" },
      { key: "Authorization", value: "Bearer mock_token_123" }
    ],
    bodyType: "json" as BodyType,
    bodyValue: JSON.stringify(
      {
        event: "user_signup",
        properties: {
          plan: "pro",
          source: "api_tester"
        }
      },
      null,
      2
    ),
    description: "Echo service to test request headers, params, and body.",
  },
  {
    name: "JSONPlaceholder - Filter Data",
    method: "GET" as HttpMethod,
    url: "https://jsonplaceholder.typicode.com/posts",
    params: [
      { key: "userId", value: "1" }
    ],
    headers: [
      { key: "Accept", value: "application/json" }
    ],
    bodyType: "none" as BodyType,
    description: "Fetch and filter mock blog posts using query parameters.",
  },
  {
    name: "CoinGecko - Crypto Prices",
    method: "GET" as HttpMethod,
    url: "https://api.coingecko.com/api/v3/simple/price",
    params: [
      { key: "ids", value: "bitcoin,ethereum" },
      { key: "vs_currencies", value: "usd" }
    ],
    headers: [
      { key: "Accept", value: "application/json" }
    ],
    bodyType: "none" as BodyType,
    description: "Fetch real-time cryptocurrency prices from CoinGecko.",
  }
];

// ── Relative Timestamp Formatter ─────────────────────────────
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

// ── Method Dropdown Component ────────────────────────────────
const METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
];

function MethodDropdown({
  value,
  onChange,
}: {
  value: HttpMethod;
  onChange: (val: HttpMethod) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const methodSelectClass = `api-method-select api-method-select-${value.toLowerCase()}`;

  return (
    <div className="api-method-dropdown-container" ref={dropdownRef}>
      <button
        type="button"
        className={methodSelectClass}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{value}</span>
        <ChevronDown
          className={`h-3 w-3 opacity-70 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {isOpen && (
        <div className="api-method-dropdown-menu">
          {METHODS.map((m) => (
            <button
              key={m}
              type="button"
              className={`api-method-option api-method-option-${m.toLowerCase()} ${
                m === value ? "api-method-option-active" : ""
              }`}
              onClick={() => {
                onChange(m);
                setIsOpen(false);
              }}
            >
              {m}
              {m === value && <Check className="h-3 w-3 ml-auto opacity-70" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const RAW_TYPES = [
  { value: "text/plain", label: "Text" },
  { value: "application/json", label: "JSON" },
  { value: "application/xml", label: "XML" },
  { value: "text/html", label: "HTML" },
  { value: "text/javascript", label: "JavaScript" },
];

function RawTypeDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (val: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const activeLabel = RAW_TYPES.find((t) => t.value === value)?.label || "Text";

  return (
    <div className="api-raw-dropdown-container" ref={dropdownRef}>
      <button
        type="button"
        className="api-raw-select"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{activeLabel}</span>
        <ChevronDown
          className={`h-3 w-3 opacity-70 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {isOpen && (
        <div className="api-raw-dropdown-menu">
          {RAW_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`api-raw-option ${
                t.value === value ? "api-raw-option-active" : ""
              }`}
              onClick={() => {
                onChange(t.value);
                setIsOpen(false);
              }}
            >
              {t.label}
              {t.value === value && <Check className="h-3 w-3 ml-auto opacity-70" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Autocomplete Input Component ─────────────────────────────
const HEADER_KEYS = [
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Cache-Control",
  "Content-Type",
  "User-Agent",
  "X-API-Key",
];

const COMMON_MIME_TYPES = [
  "application/json",
  "application/xml",
  "application/x-www-form-urlencoded",
  "text/plain",
  "text/html",
  "multipart/form-data",
];

const HEADER_VALUES_MAP: Record<string, string[]> = {
  "accept": COMMON_MIME_TYPES,
  "content-type": COMMON_MIME_TYPES,
  "authorization": ["Bearer ", "Basic ", "Digest ", "OAuth "],
  "cache-control": [
    "no-cache",
    "no-store",
    "no-cache, no-store, must-revalidate",
    "max-age=3600",
    "public",
    "private",
  ],
  "accept-encoding": ["gzip", "deflate", "br", "gzip, deflate, br"],
  "accept-language": ["en-US,en;q=0.9", "en-GB,en;q=0.8", "fr-FR,fr;q=0.9", "es-ES,es;q=0.9"],
};

function AutocompleteInput({
  value,
  onChange,
  placeholder,
  options,
  className,
}: {
  value: string;
  onChange: (val: string) => void;
  placeholder: string;
  options: string[];
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredOptions = searchTerm
    ? options.filter((o) => o.toLowerCase().includes(searchTerm.toLowerCase()))
    : options;

  return (
    <div className="api-autocomplete-container" ref={containerRef}>
      <input
        type="text"
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setSearchTerm(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => {
          setSearchTerm("");
          setIsOpen(true);
        }}
      />
      {isOpen && filteredOptions.length > 0 && (
        <div className="api-autocomplete-menu">
          {filteredOptions.map((opt) => (
            <button
              key={opt}
              type="button"
              className="api-autocomplete-option"
              onClick={() => {
                onChange(opt);
                setIsOpen(false);
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Custom Hook for Local Storage ────────────────────────────
function useLocalStorageState<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);

  return [value, setValue];
}

// ── Main Component ───────────────────────────────────────────
export function ApiTester() {
  const store = useApiTesterStore();
  const addToast = useAppStore((s) => s.addToast);
  const currentThemeSetting = useAppStore((s) => s.editorSettings.theme);
  
  useEffect(() => {
    store.init();
  }, [store]);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    setupMonacoTheme(monaco);
    const theme = useAppStore.getState().editorSettings.theme;
    monaco.editor.setTheme(theme === "light" ? "devutils-light" : "devutils-dark");
  }, []);

  const tabs = store.tabs || [];
  const activeTab = tabs.find((t) => t.id === store.activeTabId) || tabs[0];

  if (!activeTab) {
    return (
      <div className="api-tester-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ textAlign: 'center' }}>
          <Activity className="h-8 w-8 text-accent mx-auto mb-4" />
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Updating State...</h2>
          <p style={{ color: 'var(--text-2)' }}>The state structure has changed. Please refresh the page.</p>
        </div>
      </div>
    );
  }

  // Tab states
  const [requestTab, setRequestTab] = useState<string>("params");
  const [wsMessageText, setWsMessageText] = useState('{\n  "type": "ping"\n}');
  const wsConsoleRef = useRef<HTMLDivElement>(null);
  const [responseTab, setResponseTab] = useState<
    "pretty" | "raw" | "preview" | "headers"
  >("pretty");
  const [headerSearch, setHeaderSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showImportCurl, setShowImportCurl] = useState(false);
  const [showEnvVarsModal, setShowEnvVarsModal] = useState(false);
  const [settingsEnvId, setSettingsEnvId] = useState<string>("global");
  const [showEnvDropdown, setShowEnvDropdown] = useState(false);
  const envDropdownRef = useRef<HTMLDivElement>(null);
  const [curlImportValue, setCurlImportValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<boolean>(false);
  
  // Code Snippet State
  const [showCodeSnippet, setShowCodeSnippet] = useState(false);
  const [snippetLang, setSnippetLang] = useState("curl");
  const [snippetCopied, setSnippetCopied] = useState(false);
  
  // Export Modal State
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportSelectedTabs, setExportSelectedTabs] = useState<string[]>([]);

  // Sidebar accordion
  const [presetsOpen, setPresetsOpen] = useLocalStorageState("devutils_api_sidebar_presets", false);
  const [historyOpen, setHistoryOpen] = useLocalStorageState("devutils_api_sidebar_history", false);
  const [collectionsOpen, setCollectionsOpen] = useLocalStorageState("devutils_api_sidebar_collections", false);

  // File import
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tab rename
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState("");
  const editTabInputRef = useRef<HTMLInputElement>(null);

  const handleImportFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    const requests: any[] = [];
    let folderName = "Imported Files";
    let skippedCount = 0;
    
    // Check if webkitRelativePath exists to extract folder name
    if (files[0] && files[0].webkitRelativePath) {
      const parts = files[0].webkitRelativePath.split("/");
      if (parts.length > 1 && parts[0]) {
        folderName = parts[0];
      }
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      if (!file.name.endsWith(".json")) {
        skippedCount++;
        continue;
      }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (parsed && parsed.method && parsed.url) {
          requests.push(parsed);
        } else {
          skippedCount++;
        }
      } catch (err) {
        console.error("Failed to parse", file.name);
        skippedCount++;
      }
    }
    
    if (requests.length > 0) {
      store.importCollection(folderName, requests);
      if (skippedCount > 0) {
        addToast({ message: `Imported ${requests.length} requests. Skipped ${skippedCount} invalid files.`, type: "info", duration: 4000 });
      } else {
        addToast({ message: `Successfully imported ${requests.length} requests.`, type: "success", duration: 2500 });
      }
    } else if (skippedCount > 0) {
      addToast({ message: `Failed to import. Skipped ${skippedCount} files due to invalid JSON or missing fields.`, type: "error", duration: 4000 });
    }
    
    if (e.target) e.target.value = ""; // reset
  };

  // Resizable panes
  const [requestPaneHeight, setRequestPaneHeight] = useState(280);
  const splitRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  // Relative time ticker
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  // ── Keyboard Shortcut: Cmd+Enter to Send ───────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!activeTab.loading && activeTab.url.trim()) {
          store.sendRequest();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab.loading, activeTab.url, store]);

  // ── Close env dropdown on outside click ─────────────────────
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (envDropdownRef.current && !envDropdownRef.current.contains(event.target as Node)) {
        setShowEnvDropdown(false);
      }
    }
    if (showEnvDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showEnvDropdown]);

  const hasBody = activeTab.method !== "GET" && activeTab.method !== "HEAD";

  // ── Reset requestTab when body becomes unavailable ──────────
  useEffect(() => {
    if (!hasBody && requestTab === "body") {
      setRequestTab("params");
    }
  }, [hasBody, requestTab]);

  // ── Focus tab rename input when editing ─────────────────────
  useEffect(() => {
    if (editingTabId && editTabInputRef.current) {
      editTabInputRef.current.focus();
      editTabInputRef.current.select();
    }
  }, [editingTabId]);

  // ── Auto-scroll WebSocket console to bottom ──────────────────
  useEffect(() => {
    if (wsConsoleRef.current) {
      wsConsoleRef.current.scrollTop = wsConsoleRef.current.scrollHeight;
    }
  }, [activeTab?.wsMessages]);

  // ── Auto-switch request tab based on protocol ───────────────
  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.protocol === "graphql") {
      setRequestTab("graphql");
    } else if (activeTab.protocol === "websocket") {
      setRequestTab("ws-message");
    } else {
      setRequestTab("params");
    }
  }, [activeTab?.protocol, activeTab?.id]);

  // ── Resize Handlers ────────────────────────────────────────
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      isDragging.current = true;
      dragStartY.current = e.clientY;
      dragStartHeight.current = requestPaneHeight;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      const handleMove = (moveE: MouseEvent) => {
        if (!isDragging.current) return;
        const delta = moveE.clientY - dragStartY.current;
        const newHeight = Math.max(
          120,
          Math.min(600, dragStartHeight.current + delta)
        );
        setRequestPaneHeight(newHeight);
      };

      const handleUp = () => {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [requestPaneHeight]
  );

  // ── Trigger API Execution ──────────────────────────────────
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTab.url.trim()) return;
    if (activeTab.protocol === "websocket") {
      if (activeTab.wsConnected) {
        store.disconnectWs();
      } else {
        store.connectWs();
      }
    } else {
      await store.sendRequest();
    }
  };

  // ── Copy Handlers ──────────────────────────────────────────
  const handleCopyResponse = () => {
    if (!activeTab.response?.body) return;
    navigator.clipboard.writeText(activeTab.response.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyCurl = () => {
    const curl = store.generateCurl();
    navigator.clipboard.writeText(curl);
    setCurlCopied(true);
    setTimeout(() => setCurlCopied(false), 2000);
  };

  const handleDownloadResponse = () => {
    if (!activeTab.response?.body) return;
    try {
      const blob = new Blob([activeTab.response.body], {
        type: activeTab.response.headers?.["content-type"] || "text/plain",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      
      // Determine file extension
      let ext = "txt";
      if (responseLang === "json") ext = "json";
      else if (responseLang === "html") ext = "html";
      else if (responseLang === "xml") ext = "xml";
      else if (responseLang === "css") ext = "css";
      else if (responseLang === "javascript") ext = "js";

      a.download = `response-${activeTab.name.replace(/\s+/g, "_").toLowerCase()}-${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Failed to download response", e);
    }
  };

  // ── Helpers ────────────────────────────────────────────────
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const getLanguageFromContentType = (contentType?: string): string => {
    if (!contentType) return "text";
    const type = contentType.toLowerCase();
    if (type.includes("json")) return "json";
    if (type.includes("html")) return "html";
    if (type.includes("xml")) return "xml";
    if (type.includes("css")) return "css";
    if (type.includes("javascript")) return "javascript";
    return "text";
  };

  const responseLang = activeTab.response
    ? getLanguageFromContentType(activeTab.response.headers?.["content-type"])
    : "text";

  const prettyBody = React.useMemo(() => {
    if (!activeTab.response?.body) return "";
    if (responseLang === "json") {
      try {
        return JSON.stringify(JSON.parse(activeTab.response.body), null, 2);
      } catch {
        return activeTab.response.body;
      }
    }
    return activeTab.response.body;
  }, [activeTab.response?.body, responseLang]);

  const getTimeClass = (ms: number): string => {
    if (ms < 200) return "meta-time-fast";
    if (ms < 1000) return "meta-time-medium";
    return "meta-time-slow";
  };


  return (
    <div className="api-tester-container">
      {/* ── Left Sidebar ───────────────────────────────────── */}
      <aside className="api-sidebar">
        <div className="api-sidebar-header">
          <Globe className="h-4 w-4 text-accent" />
          <span>API Client</span>
        </div>

        <input 
          type="file" 
          ref={fileInputRef} 
          style={{ display: "none" }} 
          multiple 
          accept=".json" 
          onChange={handleImportFiles} 
        />
        <input 
          type="file" 
          ref={folderInputRef} 
          style={{ display: "none" }} 
          {...({ webkitdirectory: "", directory: "" } as any)} 
          onChange={handleImportFiles} 
        />

        <div className="api-sidebar-content">
          {/* Presets Section */}
          <div className="api-sidebar-section">
            <div
              className="api-sidebar-section-header"
              onClick={() => setPresetsOpen(!presetsOpen)}
            >
              <div className="api-sidebar-section-left">
                <ChevronRight
                  className={`h-3 w-3 api-sidebar-section-chevron ${presetsOpen ? "api-sidebar-section-chevron-open" : ""}`}
                />
                <span className="api-sidebar-section-title">
                  Mock API Presets
                </span>
              </div>
              <Sparkles className="h-3 w-3 text-yellow" />
            </div>
            <div
              className={`api-sidebar-section-body ${presetsOpen ? "api-sidebar-section-body-open" : ""}`}
            >
              <div className="api-sidebar-section-body-inner">
                {PRESETS.map((preset, index) => (
                  <button
                    key={index}
                    className="api-preset-card"
                    onClick={() => store.loadPreset(preset)}
                    title={preset.description}
                  >
                    <span
                      className={`api-badge api-badge-${preset.method.toLowerCase()}`}
                    >
                      {preset.method}
                    </span>
                    <div className="api-item-info">
                      <span className="api-item-url">{preset.name}</span>
                      <span className="api-item-meta">{preset.url}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Collections Section */}
          <div className="api-sidebar-section">
            <div
              className="api-sidebar-section-header"
              onClick={() => setCollectionsOpen(!collectionsOpen)}
            >
              <div className="api-sidebar-section-left">
                <ChevronRight
                  className={`h-3 w-3 api-sidebar-section-chevron ${collectionsOpen ? "api-sidebar-section-chevron-open" : ""}`}
                />
                <span className="api-sidebar-section-title">
                  Collections
                </span>
              </div>
              <div style={{ display: "flex", gap: "4px" }}>
                <SimpleTooltip content="Import JSON File(s)">
                  <button 
                    className="api-clear-btn" 
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    style={{ padding: "2px 4px" }}
                  >
                    <FileJson className="h-3 w-3" />
                  </button>
                </SimpleTooltip>
                <SimpleTooltip content="Import Folder">
                  <button 
                    className="api-clear-btn" 
                    onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click(); }}
                    style={{ padding: "2px 4px" }}
                  >
                    <FolderUp className="h-3 w-3" />
                  </button>
                </SimpleTooltip>
              </div>
            </div>
            
            <div
              className={`api-sidebar-section-body ${collectionsOpen ? "api-sidebar-section-body-open" : ""}`}
            >
              <div className="api-sidebar-section-body-inner" style={{ maxHeight: "300px", overflowY: "auto" }}>
                {store.collections && store.collections.length === 0 ? (
                  <div className="api-history-empty" style={{ margin: "0 8px" }}>
                    <Folder className="h-5 w-5 opacity-30" />
                    <span className="api-history-empty-title">
                      No Collections
                    </span>
                    <p className="api-history-empty-desc">
                      Import exported requests or folders here.
                    </p>
                  </div>
                ) : (
                  store.collections?.map((col) => (
                    <div key={col.id} className="api-collection-group" style={{ padding: "0 8px" }}>
                      <div className="api-collection-header">
                        <Folder className="h-3 w-3 text-accent" />
                        <span className="api-collection-name" title={col.name}>{col.name}</span>
                        <button className="api-collection-remove" onClick={() => store.removeCollection(col.id)} title="Remove Collection">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      {col.requests.map((req, idx) => (
                        <button
                          key={idx}
                          className="api-history-card"
                          onClick={() => store.loadImportedRequest(req)}
                          title={req.name || req.url}
                        >
                          <span className={`api-badge api-badge-${req.method.toLowerCase()}`}>
                            {req.method}
                          </span>
                          <div className="api-item-info">
                            <span className="api-item-url">{req.name || req.url}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* History Section */}
          <div className="api-sidebar-section" style={{ flex: 1 }}>
            <div
              className="api-sidebar-section-header"
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              <div className="api-sidebar-section-left">
                <ChevronRight
                  className={`h-3 w-3 api-sidebar-section-chevron ${historyOpen ? "api-sidebar-section-chevron-open" : ""}`}
                />
                <span className="api-sidebar-section-title">
                  Request History
                </span>
              </div>
              {store.history.length > 0 && (
                <button
                  className="api-clear-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.clearHistory();
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <div
              className={`api-sidebar-section-body ${historyOpen ? "api-sidebar-section-body-open" : ""}`}
              style={{ flex: 1 }}
            >
              <div
                className="api-sidebar-section-body-inner"
                style={{ maxHeight: "400px", overflowY: "auto" }}
              >
                {store.history.length === 0 ? (
                  <div className="api-history-empty">
                    <History className="h-5 w-5 opacity-30" />
                    <span className="api-history-empty-title">
                      No History Yet
                    </span>
                    <p className="api-history-empty-desc">
                      Sent requests will appear here for quick replay.
                    </p>
                  </div>
                ) : (
                  store.history.map((item) => (
                    <button
                      key={item.id}
                      className="api-history-card"
                      onClick={() => store.loadHistoryItem(item)}
                    >
                      <span
                        className={`api-badge api-badge-${item.method.toLowerCase()}`}
                      >
                        {item.method}
                      </span>
                      <div className="api-item-info">
                        <span className="api-item-url">{item.url}</span>
                        <span className="api-item-meta">
                          {item.error ? (
                            <span className="api-item-status-err">Error</span>
                          ) : (
                            <span className="api-item-status-ok">
                              {item.status}
                            </span>
                          )}
                          {item.time && (
                            <span className="api-item-time-label">
                              {item.time}ms
                            </span>
                          )}
                          <span className="api-item-time-label">
                            {formatRelativeTime(item.timestamp)}
                          </span>
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
        
        {/* ── Sidebar Footer ─────────────────────────────────────── */}
        <div className="api-sidebar-footer">
          <button 
            className="api-sidebar-footer-btn" 
            title="API Tester Settings"
            onClick={() => setShowEnvVarsModal(true)}
          >
            <Settings className="h-4 w-4" />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      {/* ── Main Panel ─────────────────────────────────────── */}
      <main className="api-main">
        {/* Tab Bar UI */}
        <div className="api-tab-bar">
          <div className="api-tabs-scroll-container">
            {tabs.map(tab => (
              <div 
                key={tab.id} 
                className={`api-tab-item ${tab.id === store.activeTabId ? 'api-tab-item-active' : ''}`}
                onClick={() => store.setActiveTab(tab.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingTabId(tab.id);
                  setEditingTabName(tab.name);
                }}
              >
                <span className={`api-badge api-badge-${tab.method.toLowerCase()}`} style={{ fontSize: '8px', width: 'auto', padding: '1px 4px' }}>
                  {tab.method}
                </span>
                {editingTabId === tab.id ? (
                  <input
                    ref={editTabInputRef}
                    type="text"
                    className="api-tab-rename-input"
                    value={editingTabName}
                    onChange={(e) => setEditingTabName(e.target.value)}
                    onBlur={() => {
                      if (editingTabName.trim()) {
                        store.renameTab(tab.id, editingTabName.trim());
                      }
                      setEditingTabId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (editingTabName.trim()) {
                          store.renameTab(tab.id, editingTabName.trim());
                        }
                        setEditingTabId(null);
                      } else if (e.key === "Escape") {
                        setEditingTabId(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="api-tab-title">{tab.name}</span>
                )}
                {tabs.length > 1 && (
                  <button 
                    className="api-tab-close" 
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      store.removeTab(tab.id); 
                    }}
                    title="Close Tab"
                  >
                    &times;
                  </button>
                )}
              </div>
            ))}
            <SimpleTooltip content="New Tab">
              <button className="api-tab-add" onClick={() => store.addTab()}>
                <Plus className="h-3 w-3" />
              </button>
            </SimpleTooltip>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ position: 'relative' }} ref={envDropdownRef}>
              <button 
                onClick={() => setShowEnvDropdown(!showEnvDropdown)}
                style={{ 
                  padding: '4px 8px', 
                  background: 'var(--bg-1)', 
                  border: '1px solid var(--border-2)', 
                  borderRadius: '6px', 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '6px',
                  cursor: 'pointer',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  transition: 'all 0.15s ease'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.borderColor = 'var(--border-3)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-1)'; e.currentTarget.style.borderColor = 'var(--border-2)' }}
              >
                <Globe className="h-3.5 w-3.5" style={{ color: 'var(--text-2)' }} />
                <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-1)' }}>
                  {store.activeEnvironmentId ? store.environments.find(e => e.id === store.activeEnvironmentId)?.name || 'Global Environment' : 'Global Environment'}
                </span>
                <ChevronDown className="h-3.5 w-3.5" style={{ color: 'var(--text-3)' }} />
              </button>

              {showEnvDropdown && (
                <div style={{ 
                  position: 'absolute', 
                  top: '100%', 
                  right: 0, 
                  marginTop: '8px', 
                  background: 'var(--bg-1)', 
                  border: '1px solid var(--border-1)', 
                  borderRadius: '8px', 
                  padding: '6px', 
                  boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)', 
                  zIndex: 50,
                  minWidth: '180px'
                }}>
                  <button 
                    style={{ 
                      width: '100%', 
                      textAlign: 'left', 
                      padding: '8px 12px', 
                      background: store.activeEnvironmentId === null ? 'var(--bg-hover)' : 'transparent', 
                      border: 'none', 
                      borderRadius: '4px', 
                      fontSize: '13px', 
                      fontWeight: 500, 
                      color: 'var(--text-1)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between'
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      store.setActiveEnvironment(null);
                      setShowEnvDropdown(false);
                    }}
                    onMouseEnter={(e) => { if(store.activeEnvironmentId !== null) e.currentTarget.style.background = 'var(--bg-hover)' }}
                    onMouseLeave={(e) => { if(store.activeEnvironmentId !== null) e.currentTarget.style.background = 'transparent' }}
                  >
                    <span>Global Only</span>
                    {store.activeEnvironmentId === null && <Check className="h-3 w-3 text-accent" />}
                  </button>
                  {store.environments.map(env => (
                    <button 
                      key={env.id}
                      style={{ 
                        width: '100%', 
                        textAlign: 'left', 
                        padding: '8px 12px', 
                        background: store.activeEnvironmentId === env.id ? 'var(--bg-hover)' : 'transparent', 
                        border: 'none', 
                        borderRadius: '4px', 
                        fontSize: '13px', 
                        fontWeight: 500, 
                        color: 'var(--text-1)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        store.setActiveEnvironment(env.id);
                        setShowEnvDropdown(false);
                      }}
                      onMouseEnter={(e) => { if(store.activeEnvironmentId !== env.id) e.currentTarget.style.background = 'var(--bg-hover)' }}
                      onMouseLeave={(e) => { if(store.activeEnvironmentId !== env.id) e.currentTarget.style.background = 'transparent' }}
                    >
                      <span>{env.name}</span>
                      {store.activeEnvironmentId === env.id && <Check className="h-3 w-3 text-accent" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            
            <SimpleTooltip content="Export all tabs to a ZIP file">
              <button 
                className="api-tab-export" 
                onClick={() => {
                  setExportSelectedTabs(store.tabs.map(t => t.id));
                  setShowExportModal(true);
                }}
              >
                <Download className="h-3.5 w-3.5" />
                <span>Export</span>
              </button>
            </SimpleTooltip>
          </div>
        </div>

        {/* Protocol Selector Bar */}
        <div className="api-protocol-bar">
          {(
            [
              ["rest", "HTTP / REST"],
              ["graphql", "GraphQL"],
              ["websocket", "WebSocket Client"],
            ] as const
          ).map(([proto, label]) => (
            <button
              key={proto}
              type="button"
              className={`api-protocol-tab-btn ${activeTab.protocol === proto ? "active" : ""}`}
              onClick={() => store.setProtocol(proto)}
            >
              {proto === "websocket" ? (
                <Wifi className="h-3.5 w-3.5" />
              ) : proto === "graphql" ? (
                <Activity className="h-3.5 w-3.5" />
              ) : (
                <Globe className="h-3.5 w-3.5" />
              )}
              <span>{label}</span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {activeTab.sseActive && (
            <div className="api-sse-pulse-badge">
              <Zap className="h-3 w-3 text-accent animate-pulse" />
              <span>SSE Stream Active</span>
            </div>
          )}
        </div>

        {/* URL Bar */}
        <form onSubmit={handleSend} className="api-url-bar">
          {activeTab.protocol !== "websocket" && (
            <MethodDropdown
              value={activeTab.method}
              onChange={(val) => store.setMethod(val)}
            />
          )}
          {activeTab.protocol === "websocket" && (
            <div className="api-method-select api-method-select-ws" style={{ cursor: "default" }}>
              <span>WS</span>
            </div>
          )}

          <div className="api-url-input-container">
            <input
              type="text"
              className="api-url-input"
              value={activeTab.url}
              onChange={(e) => store.setUrl(e.target.value)}
              placeholder={
                activeTab.protocol === "websocket"
                  ? "Enter WebSocket URL (e.g. wss://echo.websocket.org)"
                  : activeTab.protocol === "graphql"
                  ? "Enter GraphQL Endpoint URL"
                  : "Enter request URL (e.g. https://api.github.com/users)"
              }
              required
            />
            {activeTab.protocol !== "websocket" && (
              <SimpleTooltip content={activeTab.useProxy ? "CORS Proxy: ENABLED (Routing via corsproxy.io)" : "CORS Proxy: DISABLED (Direct browser request)"}>
                <button
                  type="button"
                  className={`api-proxy-toggle-btn ${activeTab.useProxy ? "api-proxy-toggle-btn-active" : ""}`}
                  onClick={() => store.toggleProxy()}
                  style={{
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    padding: "4px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: activeTab.useProxy ? "var(--accent)" : "var(--text-3)",
                    transition: "color 0.2s"
                  }}
                >
                  <Shield className="h-4 w-4" />
                </button>
              </SimpleTooltip>
            )}
          </div>

          <div className="api-url-actions">
            {activeTab.protocol !== "websocket" && (
              <>
                <button
                  type="button"
                  className="api-curl-btn"
                  onClick={() => {
                    setShowImportCurl(!showImportCurl);
                    setShowCodeSnippet(false);
                    setImportError(null);
                    setCurlImportValue("");
                  }}
                  title="Import request from cURL command"
                  style={{
                    borderColor: showImportCurl ? "var(--accent)" : "",
                    background: showImportCurl ? "var(--accent-glow)" : "",
                    color: showImportCurl ? "var(--accent)" : "",
                  }}
                >
                  <Terminal className="h-3.5 w-3.5" />
                  <span>Import</span>
                </button>

                <button
                  type="button"
                  className="api-curl-btn"
                  onClick={() => {
                    setShowCodeSnippet(!showCodeSnippet);
                    setShowImportCurl(false);
                  }}
                  title="Generate code snippet"
                  style={{
                    borderColor: showCodeSnippet ? "var(--accent)" : "",
                    background: showCodeSnippet ? "var(--accent-glow)" : "",
                    color: showCodeSnippet ? "var(--accent)" : "",
                  }}
                >
                  <Code2 className="h-3.5 w-3.5" />
                  <span>Code</span>
                </button>
              </>
            )}

            {activeTab.protocol === "websocket" ? (
              <button
                type="submit"
                className={`api-send-btn ${activeTab.wsConnected ? "api-send-btn-ws-connected" : ""}`}
                disabled={activeTab.loading || !activeTab.url.trim()}
              >
                {activeTab.loading ? (
                  <span
                    className="api-spinner"
                    style={{
                      width: "14px",
                      height: "14px",
                      borderWidth: "2px",
                    }}
                  />
                ) : activeTab.wsConnected ? (
                  <WifiOff className="h-4 w-4" />
                ) : (
                  <Wifi className="h-4 w-4" />
                )}
                <span>{activeTab.loading ? "Connecting..." : activeTab.wsConnected ? "Disconnect" : "Connect"}</span>
              </button>
            ) : (
              <button
                type="submit"
                className="api-send-btn"
                disabled={activeTab.loading || !activeTab.url.trim()}
              >
                {activeTab.loading ? (
                  <span
                    className="api-spinner"
                    style={{
                      width: "14px",
                      height: "14px",
                      borderWidth: "2px",
                    }}
                  />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span>{activeTab.loading ? "Sending..." : "Send"}</span>
                <span className="api-send-shortcut">⌘↵</span>
              </button>
            )}
          </div>
        </form>

        {/* cURL Import Drawer */}
        <div className="api-import-curl-wrapper" data-open={showImportCurl}>
          <div className="api-import-curl-wrapper-inner">
            <div className="api-import-curl-panel">
              <div className="api-import-curl-header">
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <Terminal className="h-4 w-4 text-accent" />
                  <span className="api-import-curl-title">Import Request from cURL</span>
                </div>
                <button 
                  type="button" 
                  className="api-import-close-btn"
                  onClick={() => {
                    setShowImportCurl(false);
                    setImportError(null);
                    setCurlImportValue("");
                  }}
                  title="Close"
                >
                  &times;
                </button>
              </div>
              <textarea
                className="api-import-curl-textarea"
              placeholder="Paste raw cURL command (e.g. curl -X POST 'https://api.example.com' -H 'Content-Type: application/json' -d '{&quot;status&quot;: &quot;ok&quot;}')"
              value={curlImportValue}
              onChange={(e) => {
                setCurlImportValue(e.target.value);
                setImportError(null);
              }}
            />
            <div className="api-import-curl-actions">
              {importError && <span className="api-import-curl-error">{importError}</span>}
              {importSuccess && <span className="api-import-curl-success">Request imported successfully!</span>}
              <div style={{ flex: 1 }} />
              <button
                type="button"
                className="api-clear-btn"
                onClick={() => {
                  setCurlImportValue("");
                  setImportError(null);
                }}
                style={{ padding: "6px 12px" }}
              >
                Clear
              </button>
              <button
                type="button"
                className="api-import-submit-btn"
                onClick={() => {
                  if (!curlImportValue.trim()) {
                    setImportError("Please paste a valid cURL command.");
                    return;
                  }
                  const success = store.importFromCurl(curlImportValue);
                  if (success) {
                    setImportSuccess(true);
                    setImportError(null);
                    setTimeout(() => {
                      setImportSuccess(false);
                      setShowImportCurl(false);
                      setCurlImportValue("");
                    }, 1200);
                  } else {
                    setImportError("Failed to parse cURL. Ensure command begins with 'curl' and contains a valid URL.");
                  }
                }}
              >
                Import Request
              </button>
            </div>
            </div>
          </div>
        </div>

        {/* Code Snippet Drawer */}
        <div className="api-import-curl-wrapper" data-open={showCodeSnippet}>
          <div className="api-import-curl-wrapper-inner">
            <div className="api-import-curl-panel" style={{ height: "400px", display: "flex", flexDirection: "column" }}>
              <div className="api-import-curl-header">
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <Code2 className="h-4 w-4 text-accent" />
                  <span className="api-import-curl-title">Generate Code Snippet</span>
                </div>
                <button 
                  type="button" 
                  className="api-import-close-btn"
                  onClick={() => setShowCodeSnippet(false)}
                  title="Close"
                >
                  &times;
                </button>
              </div>
              <div style={{ padding: "0 12px", display: "flex", gap: "8px", borderBottom: "1px solid var(--border)", overflowX: "auto" }}>
                {CODE_LANGUAGES.map((lang) => (
                  <button
                    key={lang.id}
                    className={`api-tab-trigger ${snippetLang === lang.id ? "api-tab-trigger-active" : ""}`}
                    onClick={() => setSnippetLang(lang.id)}
                    style={{ padding: "8px 12px" }}
                  >
                    {lang.name}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
                {showCodeSnippet && (
                  <Editor
                    height="100%"
                    language={CODE_LANGUAGES.find(l => l.id === snippetLang)?.language || "text"}
                    theme={currentThemeSetting === "light" ? "devutils-light" : "devutils-dark"}
                    onMount={handleEditorMount}
                    value={generateCodeSnippet(activeTab, store.generateCurl(), snippetLang, store.envVars, store.activeEnvironmentId ? store.environments.find(e => e.id === store.activeEnvironmentId)?.variables || [] : [])}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 14,
                      fontFamily: "var(--font-mono), monospace",
                      lineNumbers: "off",
                      scrollBeyondLastLine: false,
                      readOnly: true,
                      wordWrap: "on",
                    }}
                  />
                )}
              </div>
              <div className="api-import-curl-actions" style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  className="api-import-submit-btn"
                  onClick={() => {
                    const code = generateCodeSnippet(activeTab, store.generateCurl(), snippetLang, store.envVars, store.activeEnvironmentId ? store.environments.find(e => e.id === store.activeEnvironmentId)?.variables || [] : []);
                    navigator.clipboard.writeText(code);
                    setSnippetCopied(true);
                    setTimeout(() => setSnippetCopied(false), 2000);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: "6px" }}
                >
                  {snippetCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {snippetCopied ? "Copied!" : "Copy Code"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Split Panes */}
        <div className="api-split-panes" ref={splitRef}>
          {/* ── Request Pane ──────────────────────────────── */}
          <div
            className="api-pane api-pane-request"
            style={{ height: `${requestPaneHeight}px`, flexShrink: 0 }}
          >
            <div className="api-tabs">
              <div className="api-tabs-list">
                {activeTab.protocol === "rest" && (
                  <>
                    <button
                      type="button"
                      className={`api-tab-trigger ${requestTab === "params" ? "api-tab-trigger-active" : ""}`}
                      onClick={() => setRequestTab("params")}
                    >
                      Params
                      <span className="api-tab-count">
                        {activeTab.params.filter((p) => p.key.trim() !== "").length}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`api-tab-trigger ${requestTab === "headers" ? "api-tab-trigger-active" : ""}`}
                      onClick={() => setRequestTab("headers")}
                    >
                      Headers
                      <span className="api-tab-count">
                        {activeTab.headers.filter((h) => h.key.trim() !== "").length}
                      </span>
                    </button>
                    {hasBody && (
                      <button
                        type="button"
                        className={`api-tab-trigger ${requestTab === "body" ? "api-tab-trigger-active" : ""}`}
                        onClick={() => setRequestTab("body")}
                      >
                        Body
                      </button>
                    )}
                    <button
                      type="button"
                      className={`api-tab-trigger ${requestTab === "auth" ? "api-tab-trigger-active" : ""}`}
                      onClick={() => setRequestTab("auth")}
                    >
                      <Lock
                        className="h-3 w-3"
                        style={{
                          display: "inline",
                          marginRight: "4px",
                          verticalAlign: "-1px",
                        }}
                      />
                      Auth
                    </button>
                  </>
                )}

                {activeTab.protocol === "graphql" && (
                  <>
                    <button
                      type="button"
                      className={`api-tab-trigger ${requestTab === "graphql" ? "api-tab-trigger-active" : ""}`}
                      onClick={() => setRequestTab("graphql")}
                    >
                      GraphQL
                    </button>
                    <button
                      type="button"
                      className={`api-tab-trigger ${requestTab === "headers" ? "api-tab-trigger-active" : ""}`}
                      onClick={() => setRequestTab("headers")}
                    >
                      Headers
                      <span className="api-tab-count">
                        {activeTab.headers.filter((h) => h.key.trim() !== "").length}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`api-tab-trigger ${requestTab === "auth" ? "api-tab-trigger-active" : ""}`}
                      onClick={() => setRequestTab("auth")}
                    >
                      <Lock
                        className="h-3 w-3"
                        style={{
                          display: "inline",
                          marginRight: "4px",
                          verticalAlign: "-1px",
                        }}
                      />
                      Auth
                    </button>
                  </>
                )}

                {activeTab.protocol === "websocket" && (
                  <>
                    <button
                      type="button"
                      className={`api-tab-trigger ${requestTab === "ws-message" ? "api-tab-trigger-active" : ""}`}
                      onClick={() => setRequestTab("ws-message")}
                    >
                      Message
                    </button>
                    <button
                      type="button"
                      className={`api-tab-trigger ${requestTab === "params" ? "api-tab-trigger-active" : ""}`}
                      onClick={() => setRequestTab("params")}
                    >
                      Query Params
                      <span className="api-tab-count">
                        {activeTab.params.filter((p) => p.key.trim() !== "").length}
                      </span>
                    </button>
                  </>
                )}
              </div>

              {/* Params Tab */}
              {requestTab === "params" && (
                <div className="api-tab-content">
                  <div className="api-kv-editor">
                    {activeTab.params.map((row) => (
                      <div key={row.id} className="api-kv-row">
                        <input
                          type="checkbox"
                          className="api-checkbox"
                          checked={row.enabled}
                          onChange={(e) =>
                            store.updateParam(row.id, {
                              enabled: e.target.checked,
                            })
                          }
                        />
                        <input
                          type="text"
                          className="api-kv-input"
                          placeholder="Parameter name"
                          value={row.key}
                          onChange={(e) =>
                            store.updateParam(row.id, { key: e.target.value })
                          }
                        />
                        <input
                          type="text"
                          className="api-kv-input"
                          placeholder="Value"
                          value={row.value}
                          onChange={(e) =>
                            store.updateParam(row.id, {
                              value: e.target.value,
                            })
                          }
                        />
                        <SimpleTooltip content="Delete parameter">
                          <button
                            type="button"
                            className="api-delete-row-btn"
                            onClick={() => store.removeParam(row.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </SimpleTooltip>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="api-add-row-btn"
                      onClick={store.addParam}
                    >
                      <Plus className="h-3.5 w-3.5" /> Add Parameter
                    </button>
                  </div>
                </div>
              )}

              {/* Headers Tab */}
              {requestTab === "headers" && (
                <div className="api-tab-content">
                  <div className="api-kv-editor">
                    {activeTab.headers.map((row) => (
                      <div key={row.id} className="api-kv-row">
                        <input
                          type="checkbox"
                          className="api-checkbox"
                          checked={row.enabled}
                          onChange={(e) =>
                            store.updateHeader(row.id, {
                              enabled: e.target.checked,
                            })
                          }
                        />
                        <AutocompleteInput
                          className="api-kv-input api-kv-key"
                          placeholder="Header Name"
                          value={row.key}
                          onChange={(val) =>
                            store.updateHeader(row.id, { key: val })
                          }
                          options={HEADER_KEYS}
                        />
                        <AutocompleteInput
                          className="api-kv-input api-kv-value"
                          placeholder="Value"
                          value={row.value}
                          onChange={(val) =>
                            store.updateHeader(row.id, { value: val })
                          }
                          options={HEADER_VALUES_MAP[row.key.toLowerCase()] || []}
                        />
                        <SimpleTooltip content="Delete header">
                          <button
                            type="button"
                            className="api-delete-row-btn"
                            onClick={() => store.removeHeader(row.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </SimpleTooltip>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="api-add-row-btn"
                      onClick={store.addHeader}
                    >
                      <Plus className="h-3.5 w-3.5" /> Add Header
                    </button>
                  </div>
                </div>
              )}

              {/* Body Tab */}
              {requestTab === "body" && hasBody && activeTab.protocol === "rest" && (
                <div className="api-tab-content">
                  <div className="api-body-toggles">
                    {(
                      [
                        ["none", "None"],
                        ["json", "JSON"],
                        ["form-data", "Form Data"],
                        ["raw", "Raw"],
                      ] as [BodyType, string][]
                    ).map(([type, label]) => (
                      <button
                        key={type}
                        type="button"
                        className={`api-body-radio ${activeTab.bodyType === type ? "api-body-radio-active" : ""}`}
                        onClick={() => store.setBodyType(type)}
                      >
                        {label}
                      </button>
                    ))}
                    {activeTab.bodyType === "raw" && (
                      <RawTypeDropdown
                        value={activeTab.rawType}
                        onChange={(val) => store.setRawType(val)}
                      />
                    )}
                  </div>

                  {activeTab.bodyType === "none" && (
                    <div className="api-auth-empty">
                      <ShieldCheck className="h-4 w-4 opacity-50" />
                      <span>No request body will be sent.</span>
                    </div>
                  )}

                  {activeTab.bodyType === "json" && (
                    <div className="api-monaco-editor-wrapper" style={{ position: "relative" }}>
                      <button
                        type="button"
                        className="api-editor-format-btn"
                        onClick={() => store.formatActiveTabJsonBody()}
                        title="Beautify/Format JSON string"
                      >
                        <Sparkles className="h-3 w-3 text-yellow" />
                        <span>Format</span>
                      </button>
                      <Editor
                        height="100%"
                        language="json"
                        theme={currentThemeSetting === "light" ? "devutils-light" : "devutils-dark"}
                        onMount={handleEditorMount}
                        value={activeTab.bodyValue}
                        onChange={(val) => store.setBodyValue(val || "")}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 12,
                          lineNumbers: "on",
                          tabSize: 2,
                          scrollBeyondLastLine: false,
                        }}
                      />
                    </div>
                  )}

                  {activeTab.bodyType === "form-data" && (
                    <div className="api-kv-editor">
                      {activeTab.formParams.map((row) => (
                        <div key={row.id} className="api-kv-row">
                          <input
                            type="checkbox"
                            className="api-checkbox"
                            checked={row.enabled}
                            onChange={(e) =>
                              store.updateFormParam(row.id, {
                                enabled: e.target.checked,
                              })
                            }
                          />
                          <input
                            type="text"
                            className="api-kv-input"
                            placeholder="Key"
                            value={row.key}
                            onChange={(e) =>
                              store.updateFormParam(row.id, {
                                key: e.target.value,
                              })
                            }
                          />
                          <input
                            type="text"
                            className="api-kv-input"
                            placeholder="Value"
                            value={row.value}
                            onChange={(e) =>
                              store.updateFormParam(row.id, {
                                value: e.target.value,
                              })
                            }
                          />
                          <button
                            type="button"
                            className="api-delete-row-btn"
                            onClick={() => store.removeFormParam(row.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="api-add-row-btn"
                        onClick={store.addFormParam}
                      >
                        <Plus className="h-3.5 w-3.5" /> Add Row
                      </button>
                    </div>
                  )}

                  {activeTab.bodyType === "raw" && (
                    <div className="api-monaco-editor-wrapper">
                      <Editor
                        height="100%"
                        language={activeTab.rawType.split("/")[1] || "text"}
                        theme={currentThemeSetting === "light" ? "devutils-light" : "devutils-dark"}
                        onMount={handleEditorMount}
                        value={activeTab.bodyValue}
                        onChange={(val) => store.setBodyValue(val || "")}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 12,
                          lineNumbers: "on",
                          scrollBeyondLastLine: false,
                        }}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* GraphQL Tab */}
              {requestTab === "graphql" && activeTab.protocol === "graphql" && (
                <div className="api-tab-content api-graphql-container" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
                  <div className="api-graphql-toolbar" style={{ display: "flex", justifyContent: "flex-end", padding: "4px 8px", borderBottom: "1px solid var(--border-1)", gap: "8px" }}>
                    <button
                      type="button"
                      className="api-editor-format-btn"
                      onClick={() => {
                        try {
                          let query = activeTab.graphqlQuery;
                          query = query.replace(/\s+/g, ' ');
                          let indent = 0;
                          let formatted = "";
                          for (let i = 0; i < query.length; i++) {
                            const char = query[i];
                            if (char === '{') {
                              indent += 2;
                              formatted += ' {\n' + ' '.repeat(indent);
                            } else if (char === '}') {
                              indent = Math.max(0, indent - 2);
                              formatted += '\n' + ' '.repeat(indent) + '}\n' + ' '.repeat(indent);
                            } else if (char === ',') {
                              formatted += ',\n' + ' '.repeat(indent);
                            } else {
                              formatted += char;
                            }
                          }
                          formatted = formatted.replace(/\n\s*\n/g, '\n').replace(/ +/g, ' ').replace(/\{ \n/g, '{\n').trim();
                          store.setGraphqlQuery(formatted);
                        } catch (e) {
                          console.error("Failed to format GraphQL query", e);
                        }
                      }}
                      title="Format GraphQL query"
                    >
                      <Sparkles className="h-3 w-3 text-yellow" />
                      <span>Format Query</span>
                    </button>
                  </div>
                  <div className="api-graphql-editors" style={{ display: "flex", flex: 1, minHeight: 0 }}>
                    <div className="api-graphql-editor-pane" style={{ flex: 2, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border-1)" }}>
                      <div className="api-graphql-pane-header" style={{ padding: "4px 8px", fontSize: "11px", fontWeight: 600, color: "var(--text-3)", background: "var(--bg-2)" }}>Query</div>
                      <div style={{ flex: 1, position: "relative" }}>
                        <Editor
                          height="100%"
                          language="graphql"
                          theme={currentThemeSetting === "light" ? "devutils-light" : "devutils-dark"}
                          onMount={handleEditorMount}
                          value={activeTab.graphqlQuery || ""}
                          onChange={(val) => store.setGraphqlQuery(val || "")}
                          options={{
                            minimap: { enabled: false },
                            fontSize: 12,
                            lineNumbers: "on",
                            tabSize: 2,
                            scrollBeyondLastLine: false,
                          }}
                        />
                      </div>
                    </div>
                    <div className="api-graphql-editor-pane" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                      <div className="api-graphql-pane-header" style={{ padding: "4px 8px", fontSize: "11px", fontWeight: 600, color: "var(--text-3)", background: "var(--bg-2)" }}>Variables (JSON)</div>
                      <div style={{ flex: 1, position: "relative" }}>
                        <Editor
                          height="100%"
                          language="json"
                          theme={currentThemeSetting === "light" ? "devutils-light" : "devutils-dark"}
                          onMount={handleEditorMount}
                          value={activeTab.graphqlVariables || ""}
                          onChange={(val) => store.setGraphqlVariables(val || "")}
                          options={{
                            minimap: { enabled: false },
                            fontSize: 12,
                            lineNumbers: "on",
                            tabSize: 2,
                            scrollBeyondLastLine: false,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* WebSocket Message Tab */}
              {requestTab === "ws-message" && activeTab.protocol === "websocket" && (
                <div className="api-tab-content api-ws-message-container" style={{ display: "flex", flexDirection: "column", height: "100%", padding: "12px", gap: "8px", boxSizing: "border-box" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-3)" }}>WebSocket Message Payload</span>
                    <span style={{ fontSize: "10px", color: "var(--text-3)" }}>Supports variables like {"{{variable}}"}</span>
                  </div>
                  <div style={{ flex: 1, border: "1px solid var(--border-1)", borderRadius: "var(--radius-md)", overflow: "hidden", position: "relative" }}>
                    <Editor
                      height="100%"
                      language="json"
                      theme={currentThemeSetting === "light" ? "devutils-light" : "devutils-dark"}
                      onMount={handleEditorMount}
                      value={wsMessageText}
                      onChange={(val) => setWsMessageText(val || "")}
                      options={{
                        minimap: { enabled: false },
                        fontSize: 12,
                        lineNumbers: "on",
                        scrollBeyondLastLine: false,
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      className="api-send-btn"
                      disabled={!activeTab.wsConnected || !wsMessageText.trim()}
                      onClick={() => {
                        store.sendWsMessage(wsMessageText);
                      }}
                      style={{ height: "36px", padding: "0 16px" }}
                    >
                      <Send className="h-3.5 w-3.5" />
                      <span>Send Message</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Auth Tab */}
              {requestTab === "auth" && activeTab.protocol !== "websocket" && (
                <div className="api-tab-content">
                  <div className="api-auth-section">
                    <div className="api-auth-type-selector">
                      {(
                        [
                          ["none", "No Auth"],
                          ["bearer", "Bearer Token"],
                          ["basic", "Basic Auth"],
                          ["api-key", "API Key"],
                        ] as [AuthType, string][]
                      ).map(([type, label]) => (
                        <button
                          key={type}
                          type="button"
                          className={`api-auth-type-btn ${activeTab.authType === type ? "api-auth-type-btn-active" : ""}`}
                          onClick={() => store.setAuthType(type)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {activeTab.authType === "none" && (
                      <div className="api-auth-empty">
                        <ShieldCheck className="h-4 w-4 opacity-50" />
                        <span>
                          No authentication will be applied to this request.
                        </span>
                      </div>
                    )}

                    {activeTab.authType === "bearer" && (
                      <div className="api-auth-fields">
                        <div className="api-auth-field">
                          <label className="api-auth-label">Token</label>
                          <input
                            type="text"
                            className="api-auth-input"
                            placeholder="Enter bearer token"
                            value={activeTab.authConfig.bearerToken}
                            onChange={(e) =>
                              store.setAuthConfig({
                                bearerToken: e.target.value,
                              })
                            }
                          />
                          <span className="api-auth-hint">
                            Will be sent as: Authorization: Bearer
                            &lt;token&gt;
                          </span>
                        </div>
                      </div>
                    )}

                    {activeTab.authType === "basic" && (
                      <div className="api-auth-fields">
                        <div className="api-auth-field">
                          <label className="api-auth-label">Username</label>
                          <div style={{ position: "relative" }}>
                            <input
                              type="text"
                              className="api-auth-input"
                              placeholder="Username"
                              value={activeTab.authConfig.basicUsername}
                              onChange={(e) =>
                                store.setAuthConfig({
                                  basicUsername: e.target.value,
                                })
                              }
                            />
                          </div>
                        </div>
                        <div className="api-auth-field">
                          <label className="api-auth-label">Password</label>
                          <div
                            style={{
                              position: "relative",
                              display: "flex",
                              gap: "6px",
                            }}
                          >
                            <input
                              type={showPassword ? "text" : "password"}
                              className="api-auth-input"
                              placeholder="Password"
                              value={activeTab.authConfig.basicPassword}
                              onChange={(e) =>
                                store.setAuthConfig({
                                  basicPassword: e.target.value,
                                })
                              }
                            />
                            <SimpleTooltip content={showPassword ? "Hide password" : "Show password"}>
                              <button
                                type="button"
                                className="api-delete-row-btn"
                                onClick={() => setShowPassword(!showPassword)}
                                style={{ flexShrink: 0 }}
                              >
                                {showPassword ? (
                                  <EyeOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Eye className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </SimpleTooltip>
                          </div>
                          <span className="api-auth-hint">
                            Will be Base64-encoded as: Authorization: Basic
                            &lt;encoded&gt;
                          </span>
                        </div>
                      </div>
                    )}

                    {activeTab.authType === "api-key" && (
                      <div className="api-auth-fields">
                        <div className="api-auth-field">
                          <label className="api-auth-label">Key Name</label>
                          <input
                            type="text"
                            className="api-auth-input"
                            placeholder="e.g. X-API-Key"
                            value={activeTab.authConfig.apiKeyName}
                            onChange={(e) =>
                              store.setAuthConfig({
                                apiKeyName: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div className="api-auth-field">
                          <label className="api-auth-label">Value</label>
                          <input
                            type="text"
                            className="api-auth-input"
                            placeholder="Enter API key value"
                            value={activeTab.authConfig.apiKeyValue}
                            onChange={(e) =>
                              store.setAuthConfig({
                                apiKeyValue: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div className="api-auth-field">
                          <label className="api-auth-label">Add to</label>
                          <select
                            className="api-auth-select"
                            value={activeTab.authConfig.apiKeyPlacement}
                            onChange={(e) =>
                              store.setAuthConfig({
                                apiKeyPlacement: e.target.value as
                                  | "header"
                                  | "query",
                              })
                            }
                          >
                            <option value="header">Header</option>
                            <option value="query">Query Parameter</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Resizable Divider ──────────────────────────── */}
          <div
            className={`api-resize-handle ${isDragging.current ? "api-resize-handle-active" : ""}`}
            onMouseDown={handleResizeStart}
          />

          {/* ── Response Pane ─────────────────────────────── */}
          <div className="api-pane" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {activeTab.protocol === "websocket" ? (
              /* WebSocket Console Stream */
              <div className="api-ws-console-container" style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", padding: "12px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", borderBottom: "1px solid var(--border-1)", paddingBottom: "6px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-2)", display: "flex", alignItems: "center", gap: "6px" }}>
                    <Activity className="h-3.5 w-3.5 text-accent" />
                    Connection Console Stream ({(activeTab.wsMessages || []).length} messages)
                  </span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      type="button"
                      className="api-clear-btn"
                      onClick={() => store.clearWsMessages()}
                      disabled={(activeTab.wsMessages || []).length === 0}
                    >
                      Clear Logs
                    </button>
                  </div>
                </div>
                
                <div 
                  className="api-ws-messages-list" 
                  ref={wsConsoleRef}
                  style={{ 
                    flex: 1, 
                    overflowY: "auto", 
                    background: "var(--bg-2)", 
                    borderRadius: "var(--radius-md)", 
                    border: "1px solid var(--border-1)",
                    padding: "10px",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: "11px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px"
                  }}
                >
                  {(activeTab.wsMessages || []).length === 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-3)", gap: "8px" }}>
                      {activeTab.wsConnected ? (
                        <Wifi className="h-8 w-8 text-green opacity-40 animate-pulse" />
                      ) : (
                        <WifiOff className="h-8 w-8 opacity-25" />
                      )}
                      <span>
                        {activeTab.wsConnected
                          ? "Connected! Send a message from the Request pane to start testing."
                          : "Console is empty. Connect to a WebSocket endpoint to stream messages."}
                      </span>
                    </div>
                  ) : (
                    (activeTab.wsMessages || []).map((msg) => {
                      let typeColor = "var(--text-3)";
                      let typeLabel = "INFO";
                      if (msg.type === "send") {
                        typeColor = "var(--blue)";
                        typeLabel = "SENT";
                      } else if (msg.type === "receive") {
                        typeColor = "var(--green)";
                        typeLabel = "RECV";
                      } else if (msg.type === "error") {
                        typeColor = "var(--red)";
                        typeLabel = "ERR ";
                      }
                      
                      return (
                        <div 
                          key={msg.id} 
                          className={`api-ws-message-row api-ws-message-${msg.type}`}
                          style={{ 
                            display: "flex", 
                            gap: "8px", 
                            borderBottom: "1px dashed var(--border-2)", 
                            paddingBottom: "4px" 
                          }}
                        >
                          <span style={{ color: "var(--text-3)" }}>[{new Date(msg.timestamp).toLocaleTimeString()}]</span>
                          <span style={{ color: typeColor, fontWeight: 700 }}>{typeLabel}</span>
                          <span style={{ color: "var(--text-1)", flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{msg.text}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ) : (
              /* REST & GraphQL Normal Response */
              <>
                <div className="api-pane-header">
                  <span className="api-pane-title">Response</span>
                  {activeTab.sseActive && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '12px' }}>
                      <span className="api-sse-pulse" style={{ width: '8px', height: '8px', background: 'var(--accent)', borderRadius: '50%', display: 'inline-block', boxShadow: '0 0 8px var(--accent)' }}></span>
                      <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--accent)' }}>Streaming...</span>
                      <button
                        type="button"
                        className="api-clear-btn"
                        onClick={() => store.stopActiveRequest(activeTab.id)}
                        style={{ padding: '2px 6px', color: 'var(--red)', background: 'var(--red-dim)', borderRadius: '4px' }}
                      >
                        Stop
                      </button>
                    </div>
                  )}
                  {activeTab.response && (
                    <div className="api-response-meta">
                      <div
                        className={`status-pill ${activeTab.response.status >= 200 && activeTab.response.status < 300 ? "status-pill-ok" : "status-pill-err"}`}
                      >
                        <Activity className="h-3 w-3" />
                        <span>
                          {activeTab.response.status} {activeTab.response.statusText}
                        </span>
                      </div>
                      <div className="meta-item">
                        <Clock className="h-3 w-3 opacity-60" />
                        <span>
                          <span
                            className={`meta-item-value ${getTimeClass(activeTab.response.time)}`}
                          >
                            {activeTab.response.time} ms
                          </span>
                        </span>
                      </div>
                      <div className="meta-item">
                        <Database className="h-3 w-3 opacity-60" />
                        <span>
                          <span className="meta-item-value">
                            {formatBytes(activeTab.response.size)}
                          </span>
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Loading */}
                {activeTab.loading && (
                  <div className="api-loading-state">
                    <div className="api-spinner" />
                    <span className="api-loading-text">
                      Connecting to server...
                    </span>
                  </div>
                )}

                {/* Error */}
                {activeTab.error && (
                  <div style={{ overflowY: "auto", flex: 1 }}>
                    <div className="api-error-card">
                      <AlertCircle className="api-error-icon h-5 w-5" />
                      <div className="api-error-info">
                        <span className="api-error-title">
                          HTTP Request Failed
                        </span>
                        <p className="api-error-message">{activeTab.error}</p>
                      </div>
                    </div>

                    <div style={{ padding: "0 16px 16px" }}>
                      <div className="api-cors-panel">
                        <Info className="api-cors-icon h-5 w-5" />
                        <div className="api-cors-details">
                          <span className="api-cors-title">
                            CORS Restriction Notice
                          </span>
                          <p className="api-cors-desc">
                            Browser-based clients are subject to CORS restrictions.
                            If the server doesn't include an
                            `Access-Control-Allow-Origin` header, the request will
                            be blocked.
                          </p>
                          <p
                            className="api-cors-desc"
                            style={{ marginTop: "6px", fontWeight: 600 }}
                          >
                            How to resolve:
                          </p>
                          <ul
                            style={{
                              paddingLeft: "16px",
                              fontSize: "11px",
                              color: "var(--text-2)",
                              display: "flex",
                              flexDirection: "column",
                              gap: "3px",
                              marginTop: "4px",
                            }}
                          >
                            <li>
                              Use a CORS proxy (enable the Shield icon in the URL bar to route via corsproxy.io).
                            </li>
                            <li>
                              Use the built-in <strong>Mock API Presets</strong>{" "}
                              which are CORS-enabled.
                            </li>
                            <li>
                              Enable CORS on your server (e.g.
                              `Access-Control-Allow-Origin: *`).
                            </li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Empty State */}
                {!activeTab.loading && !activeTab.error && !activeTab.response && (
                  <div className="api-response-empty">
                    <Send className="h-8 w-8 api-response-empty-icon text-accent" />
                    <span className="api-response-empty-title">
                      Ready to Send
                    </span>
                    <p className="api-response-empty-desc">
                      Configure your request above and press{" "}
                      <strong>Send</strong> or <strong>⌘ Enter</strong> to
                      execute.
                    </p>
                  </div>
                )}

                {/* Response Body */}
                {!activeTab.loading && !activeTab.error && activeTab.response && (
              <div
                className="api-tabs"
                style={{ flex: 1, overflow: "hidden" }}
              >
                <div
                  className="api-tabs-list"
                  style={{ padding: "0 16px" }}
                >
                  <button
                    type="button"
                    className={`api-tab-trigger ${responseTab === "pretty" ? "api-tab-trigger-active" : ""}`}
                    onClick={() => setResponseTab("pretty")}
                  >
                    Pretty
                    <span className="api-tab-count">{responseLang}</span>
                  </button>
                  <button
                    type="button"
                    className={`api-tab-trigger ${responseTab === "raw" ? "api-tab-trigger-active" : ""}`}
                    onClick={() => setResponseTab("raw")}
                  >
                    Raw
                  </button>
                  {responseLang === "html" && (
                    <button
                      type="button"
                      className={`api-tab-trigger ${responseTab === "preview" ? "api-tab-trigger-active" : ""}`}
                      onClick={() => setResponseTab("preview")}
                    >
                      Preview
                    </button>
                  )}
                  <button
                    type="button"
                    className={`api-tab-trigger ${responseTab === "headers" ? "api-tab-trigger-active" : ""}`}
                    onClick={() => setResponseTab("headers")}
                  >
                    Headers
                    <span className="api-tab-count">
                      {Object.keys(activeTab.response.headers || {}).length}
                    </span>
                  </button>

                  <div style={{ flex: 1 }} />

                  {responseTab !== "headers" && (
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      <button
                        type="button"
                        className="api-copy-btn"
                        onClick={handleDownloadResponse}
                        title="Download raw response payload as a file"
                      >
                        <Download className="h-3 w-3 opacity-80" />
                        <span>Download</span>
                      </button>
                      <button
                        type="button"
                        className="api-copy-btn"
                        onClick={handleCopyResponse}
                      >
                        {copied ? (
                          <>
                            <Check className="h-3 w-3 text-green" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" /> Copy
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>

                <div
                  className="api-tab-content"
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    padding: "12px 16px",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  {/* Pretty View */}
                  {responseTab === "pretty" && (
                    <div className="api-response-monaco-wrapper">
                      <Editor
                        height="100%"
                        language={responseLang}
                        theme={currentThemeSetting === "light" ? "devutils-light" : "devutils-dark"}
                        onMount={handleEditorMount}
                        value={prettyBody}
                        options={{
                          readOnly: true,
                          minimap: { enabled: false },
                          fontSize: 12,
                          lineNumbers: "on",
                          scrollBeyondLastLine: false,
                          wordWrap: "on",
                        }}
                      />
                    </div>
                  )}

                  {/* Raw Text */}
                  {responseTab === "raw" && (
                    <textarea
                      className="api-response-raw-text"
                      value={activeTab.response.body}
                      readOnly
                    />
                  )}

                  {/* HTML Preview */}
                  {responseTab === "preview" && responseLang === "html" && (
                    <iframe
                      className="api-response-preview-iframe"
                      srcDoc={activeTab.response.body}
                      title="HTML Response Preview"
                      sandbox="allow-scripts"
                    />
                  )}

                  {/* Response Headers */}
                  {responseTab === "headers" && (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                        flex: 1,
                        overflow: "hidden",
                      }}
                    >
                      <div className="api-search-input-container">
                        <Search className="h-3.5 w-3.5 text-text-3 mr-2" style={{ flexShrink: 0 }} />
                        <input
                          type="text"
                          className="api-search-input"
                          placeholder="Search headers..."
                          value={headerSearch}
                          onChange={(e) => setHeaderSearch(e.target.value)}
                        />
                      </div>
                      <div
                        style={{
                          flex: 1,
                          overflowY: "auto",
                          border: "1px solid var(--border-1)",
                          borderRadius: "var(--radius-md)",
                        }}
                      >
                        <table className="api-headers-table">
                          <thead>
                            <tr>
                              <th
                                className="api-headers-th"
                                style={{ width: "35%" }}
                              >
                                Name
                              </th>
                              <th className="api-headers-th">Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(activeTab.response.headers || {})
                              .filter(
                                ([key, val]) =>
                                  key
                                    .toLowerCase()
                                    .includes(
                                      headerSearch.toLowerCase()
                                    ) ||
                                  val
                                    .toLowerCase()
                                    .includes(headerSearch.toLowerCase())
                              )
                              .map(([key, val]) => (
                                <tr key={key} className="api-headers-row">
                                  <td className="api-headers-td api-headers-key">
                                    {key}
                                  </td>
                                  <td className="api-headers-td api-headers-val">
                                    {val}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
        {/* Export Modal */}
        {showExportModal && (
          <div className="api-modal-overlay">
            <div className="api-modal-content">
              <div className="api-modal-header">
                <h3 className="api-modal-title">Export Tabs</h3>
                <button className="api-modal-close" onClick={() => setShowExportModal(false)}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="api-modal-body">
                <p className="api-modal-desc">Select the tabs you want to export. They will be downloaded as a ZIP folder containing JSON files.</p>
                
                <div className="api-export-actions">
                  <button 
                    className="api-export-action-btn"
                    onClick={() => setExportSelectedTabs(store.tabs.map(t => t.id))}
                  >
                    Select All
                  </button>
                  <button 
                    className="api-export-action-btn"
                    onClick={() => setExportSelectedTabs([])}
                  >
                    Deselect All
                  </button>
                </div>

                <div className="api-export-tab-list">
                  {store.tabs.map(tab => (
                    <label key={tab.id} className="api-export-tab-item">
                      <input 
                        type="checkbox" 
                        className="api-checkbox"
                        checked={exportSelectedTabs.includes(tab.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setExportSelectedTabs([...exportSelectedTabs, tab.id]);
                          } else {
                            setExportSelectedTabs(exportSelectedTabs.filter(id => id !== tab.id));
                          }
                        }}
                      />
                      <span className={`api-badge api-badge-${tab.method.toLowerCase()}`} style={{ fontSize: '9px', width: 'auto', padding: '2px 4px' }}>
                        {tab.method}
                      </span>
                      <span className="api-export-tab-name">{tab.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="api-modal-footer">
                <button className="api-btn-secondary" onClick={() => setShowExportModal(false)}>Cancel</button>
                <button 
                  className="api-send-btn" 
                  disabled={exportSelectedTabs.length === 0}
                  onClick={async () => {
                    await store.exportTabsAsZip(exportSelectedTabs);
                    setShowExportModal(false);
                  }}
                  style={{ height: "32px", padding: "0 16px" }}
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Export {exportSelectedTabs.length} Tabs</span>
                </button>
              </div>
            </div>
          </div>
        )}

      {/* ── Settings Modal ─────────────────────────────────────── */}
      {showEnvVarsModal && (
        <div className="api-modal-overlay">
          <div className="api-modal-content" style={{ maxWidth: '850px', width: '95vw', height: '600px', flexDirection: 'row', overflow: 'hidden', padding: 0 }}>
            
            {/* Ultra-Premium Sidebar */}
            <div style={{ width: '240px', background: 'var(--bg-0)', borderRight: '1px solid var(--border-1)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '24px 24px 16px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--text-1)', letterSpacing: '-0.4px' }}>Settings</h3>
              </div>
              <div style={{ padding: '8px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <h4 style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-3)', padding: '8px 12px', margin: 0, fontWeight: 600, letterSpacing: '0.5px' }}>Environments</h4>
                <button 
                  onClick={() => setSettingsEnvId('global')}
                  style={{ 
                    width: '100%', 
                    display: 'flex', 
                    alignItems: 'center', 
                    padding: '8px 14px', 
                    background: settingsEnvId === 'global' ? 'var(--bg-2)' : 'transparent', 
                    color: settingsEnvId === 'global' ? 'var(--text-1)' : 'var(--text-2)', 
                    border: 'none', 
                    borderRadius: '8px', 
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: settingsEnvId === 'global' ? 600 : 500,
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={(e) => { if (settingsEnvId !== 'global') e.currentTarget.style.background = 'var(--bg-1)' }}
                  onMouseLeave={(e) => { if (settingsEnvId !== 'global') e.currentTarget.style.background = 'transparent' }}
                >
                  <Globe className="h-4 w-4" style={{ marginRight: '10px', opacity: settingsEnvId === 'global' ? 1 : 0.6 }} />
                  Global Variables
                </button>
                {store.environments.map(env => (
                  <button 
                    key={env.id}
                    onClick={() => setSettingsEnvId(env.id)}
                    style={{ 
                      width: '100%', 
                      display: 'flex', 
                      alignItems: 'center', 
                      padding: '8px 14px', 
                      background: settingsEnvId === env.id ? 'var(--bg-2)' : 'transparent', 
                      color: settingsEnvId === env.id ? 'var(--text-1)' : 'var(--text-2)', 
                      border: 'none', 
                      borderRadius: '8px', 
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: settingsEnvId === env.id ? 600 : 500,
                      transition: 'all 0.15s ease'
                    }}
                    onMouseEnter={(e) => { if (settingsEnvId !== env.id) e.currentTarget.style.background = 'var(--bg-1)' }}
                    onMouseLeave={(e) => { if (settingsEnvId !== env.id) e.currentTarget.style.background = 'transparent' }}
                  >
                    <Database className="h-4 w-4" style={{ marginRight: '10px', opacity: settingsEnvId === env.id ? 1 : 0.6 }} />
                    {env.name}
                  </button>
                ))}
                
                <button 
                  onClick={() => {
                    const envCount = store.environments.length + 1;
                    const newId = store.addEnvironment(`Environment ${envCount}`);
                    setSettingsEnvId(newId);
                  }}
                  style={{ 
                    width: '100%', 
                    display: 'flex', 
                    alignItems: 'center', 
                    padding: '8px 14px', 
                    background: 'transparent', 
                    color: 'var(--text-3)', 
                    border: 'none', 
                    borderRadius: '8px', 
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 500,
                    marginTop: '8px',
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-1)'; e.currentTarget.style.background = 'var(--bg-1)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-3)'; e.currentTarget.style.background = 'transparent' }}
                >
                  <Plus className="h-4 w-4" style={{ marginRight: '10px' }} />
                  Add Environment
                </button>
              </div>
              <div style={{ padding: '16px' }}>
                 <button 
                  style={{ 
                    width: '100%', 
                    justifyContent: 'center', 
                    padding: '8px', 
                    borderRadius: '6px',
                    background: 'var(--bg-1)',
                    border: '1px solid var(--border-1)',
                    color: 'var(--text-1)',
                    fontSize: '12px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.borderColor = 'var(--border-2)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-1)'; e.currentTarget.style.borderColor = 'var(--border-1)' }}
                  onClick={() => setShowEnvVarsModal(false)}
                >
                  Close Settings
                </button>
              </div>
            </div>
            
            {/* Ultra-Premium Content Area */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-1)' }}>
              {true && (
                <>
                  {/* Header */}
                  <div style={{ padding: '32px 36px 24px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', background: 'var(--bg-1)' }}>
                    <div>
                      {settingsEnvId === 'global' ? (
                        <>
                          <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 600, color: 'var(--text-1)', letterSpacing: '-0.5px' }}>Global Variables</h2>
                          <p style={{ margin: '8px 0 0', fontSize: '14px', color: 'var(--text-3)' }}>Define key-value pairs to reuse across your API requests.</p>
                        </>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          <input 
                            type="text" 
                            value={store.environments.find(e => e.id === settingsEnvId)?.name || ''}
                            onChange={(e) => store.updateEnvironment(settingsEnvId, e.target.value)}
                            style={{ 
                              margin: 0, 
                              fontSize: '22px', 
                              fontWeight: 600, 
                              color: 'var(--text-1)', 
                              letterSpacing: '-0.5px',
                              background: 'transparent',
                              border: 'none',
                              borderBottom: '1px solid var(--border-2)',
                              outline: 'none',
                              padding: '0 0 4px 0'
                            }}
                          />
                          <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-3)' }}>Environment-specific variables override Global variables.</p>
                        </div>
                      )}
                    </div>
                    {settingsEnvId !== 'global' && (
                      <button 
                        onClick={() => {
                          store.removeEnvironment(settingsEnvId);
                          setSettingsEnvId('global');
                        }}
                        style={{ 
                          padding: '6px 12px', 
                          background: 'var(--red-dim)', 
                          border: '1px solid var(--red)', 
                          borderRadius: '6px', 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: '6px',
                          cursor: 'pointer',
                          color: 'var(--red)'
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        <span style={{ fontSize: '12px', fontWeight: 500 }}>Delete</span>
                      </button>
                    )}
                  </div>

                  {/* Body */}
                  <div style={{ flex: 1, padding: '0 36px 36px', overflowY: 'auto' }}>
                    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border-1)', borderRadius: '12px', overflow: 'hidden' }}>
                      <div className="api-kv-editor" style={{ gap: 0 }}>
                        {(settingsEnvId === 'global' ? store.envVars : store.environments.find(e => e.id === settingsEnvId)?.variables || []).map((v, i) => (
                          <div key={v.id} className="api-kv-row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-1)', borderRadius: 0, gap: '12px', background: 'transparent' }}>
                            <button
                              onClick={() => {
                                const sourceVars = settingsEnvId === 'global' ? store.envVars : store.environments.find(e => e.id === settingsEnvId)?.variables || [];
                                const newVars = sourceVars.map((v, idx) => idx === i ? { ...v, enabled: !v.enabled } : v);
                                if (settingsEnvId === 'global') store.setEnvVars(newVars);
                                else store.setEnvironmentVars(settingsEnvId, newVars);
                              }}
                              style={{
                                width: '18px',
                                height: '18px',
                                minWidth: '18px',
                                borderRadius: '4px',
                                border: v.enabled ? 'none' : '1px solid var(--border-2)',
                                background: v.enabled ? 'var(--accent)' : 'transparent',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                padding: 0,
                                transition: 'all 0.1s'
                              }}
                              title={v.enabled ? "Disable Variable" : "Enable Variable"}
                            >
                              {v.enabled && <Check className="h-3 w-3 text-white" />}
                            </button>
                            <input
                              type="text"
                              className="api-kv-input"
                              placeholder="Variable Name"
                              value={v.key}
                              style={{ fontWeight: 500, color: 'var(--accent)', background: 'transparent', border: '1px solid transparent', padding: '4px 8px', boxShadow: 'none', transition: 'all 0.15s ease' }}
                              onFocus={(e) => { e.currentTarget.style.background = 'var(--bg-2)'; e.currentTarget.style.borderColor = 'var(--border-2)'; }}
                              onBlur={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}
                              onChange={(e) => {
                              const sourceVars = settingsEnvId === 'global' ? store.envVars : store.environments.find(e => e.id === settingsEnvId)?.variables || [];
                                const newVars = sourceVars.map((v, idx) => idx === i ? { ...v, key: e.target.value } : v);
                                if (settingsEnvId === 'global') store.setEnvVars(newVars);
                                else store.setEnvironmentVars(settingsEnvId, newVars);
                              }}
                            />
                            
                            <div style={{ width: '1px', alignSelf: 'stretch', background: 'var(--border-2)', margin: '0 4px' }} />
                            
                            <input
                              type="text"
                              className="api-kv-input"
                              placeholder="Value"
                              value={v.value}
                              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', background: 'transparent', border: '1px solid transparent', padding: '4px 8px', boxShadow: 'none', transition: 'all 0.15s ease' }}
                              onFocus={(e) => { e.currentTarget.style.background = 'var(--bg-2)'; e.currentTarget.style.borderColor = 'var(--border-2)'; }}
                              onBlur={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}
                              onChange={(e) => {
                                const sourceVars = settingsEnvId === 'global' ? store.envVars : store.environments.find(e => e.id === settingsEnvId)?.variables || [];
                                const newVars = sourceVars.map((v, idx) => idx === i ? { ...v, value: e.target.value } : v);
                                if (settingsEnvId === 'global') store.setEnvVars(newVars);
                                else store.setEnvironmentVars(settingsEnvId, newVars);
                              }}
                            />
                            <button
                              className="api-kv-remove"
                              style={{ width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '6px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-3)' }}
                              onClick={() => {
                                const sourceVars = settingsEnvId === 'global' ? store.envVars : store.environments.find(e => e.id === settingsEnvId)?.variables || [];
                                if (sourceVars.length > 1) {
                                  const newVars = sourceVars.filter((_, idx) => idx !== i);
                                  if (settingsEnvId === 'global') store.setEnvVars(newVars);
                                  else store.setEnvironmentVars(settingsEnvId, newVars);
                                } else {
                                  const newVars = [...sourceVars];
                                  if (newVars[i]) {
                                    newVars[i].key = "";
                                    newVars[i].value = "";
                                  }
                                  if (settingsEnvId === 'global') store.setEnvVars(newVars);
                                  else store.setEnvironmentVars(settingsEnvId, newVars);
                                }
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--red)'; e.currentTarget.style.background = 'var(--red-dim)' }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-3)'; e.currentTarget.style.background = 'transparent' }}
                              title="Remove Variable"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>

                          </div>
                        ))}
                        
                        <div style={{ padding: '8px 12px', background: 'var(--bg-1)' }}>
                          <button
                            onClick={() => {
                              const sourceVars = settingsEnvId === 'global' ? store.envVars : store.environments.find(e => e.id === settingsEnvId)?.variables || [];
                              const newVars = [...sourceVars, { id: Math.random().toString(36).substring(2, 9), key: "", value: "", enabled: true }];
                              if (settingsEnvId === 'global') store.setEnvVars(newVars);
                              else store.setEnvironmentVars(settingsEnvId, newVars);
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              padding: '6px 12px',
                              background: 'transparent',
                              border: 'none',
                              borderRadius: '6px',
                              color: 'var(--text-3)',
                              fontSize: '12px',
                              fontWeight: 500,
                              cursor: 'pointer',
                              transition: 'all 0.15s ease'
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-1)'; e.currentTarget.style.background = 'var(--bg-1)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-3)'; e.currentTarget.style.background = 'transparent' }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add Variable
                          </button>
                        </div>
                      </div>
                    </div>
                    
                    <div style={{ marginTop: '24px', padding: '16px 20px', background: 'var(--bg-2)', borderRadius: '12px', border: '1px solid var(--border-1)', display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
                      <div style={{ color: 'var(--text-2)', marginTop: '2px', background: 'var(--bg-1)', padding: '6px', borderRadius: '8px', border: '1px solid var(--border-1)' }}>
                        <BookOpen className="h-4 w-4" />
                      </div>
                      <div>
                        <h5 style={{ margin: '0 0 4px 0', fontSize: '13px', fontWeight: 600, color: 'var(--text-1)' }}>How to use Environment Variables</h5>
                        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-2)', lineHeight: 1.5 }}>
                          Type <code style={{ background: 'var(--bg-1)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border-1)', color: 'var(--text-1)', fontSize: '12px' }}>&#123;&#123;variable_name&#125;&#125;</code> anywhere in the URL, Headers, Params, or JSON body. The placeholder will be automatically substituted when the request is sent.
                        </p>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      </main>
    </div>
  );
}
