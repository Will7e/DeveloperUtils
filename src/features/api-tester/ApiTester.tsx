// ============================================================
// API Tester Component — Premium REST Client
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
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
  ShieldCheck,
  Activity,
  Terminal,
  Lock,
  Key,
  User,
  Eye,
  EyeOff,
  ChevronDown,
  Download,
} from "lucide-react";
import {
  useApiTesterStore,
  HttpMethod,
  BodyType,
  AuthType,
  HistoryItem,
} from "@/stores/api-tester.store";
import { SimpleTooltip } from "@/components/ui/tooltip";
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
  "Content-Type",
  "Authorization",
  "Accept",
  "User-Agent",
  "Cache-Control",
  "X-API-Key",
];

const HEADER_VALUES = [
  "application/json",
  "application/xml",
  "text/plain",
  "text/html",
  "multipart/form-data",
  "Bearer ",
];

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

// ── Main Component ───────────────────────────────────────────
export function ApiTester() {
  const store = useApiTesterStore();
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
  const [requestTab, setRequestTab] = useState<
    "params" | "headers" | "body" | "auth"
  >("params");
  const [responseTab, setResponseTab] = useState<
    "pretty" | "raw" | "preview" | "headers"
  >("pretty");
  const [headerSearch, setHeaderSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showImportCurl, setShowImportCurl] = useState(false);
  const [curlImportValue, setCurlImportValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  // Sidebar accordion
  const [presetsOpen, setPresetsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);

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
    await store.sendRequest();
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
        type: activeTab.response.headers["content-type"] || "text/plain",
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
    ? getLanguageFromContentType(activeTab.response.headers["content-type"])
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

  const methodSelectClass = `api-method-select api-method-select-${activeTab.method.toLowerCase()}`;

  const hasBody = activeTab.method !== "GET" && activeTab.method !== "HEAD";

  return (
    <div className="api-tester-container">
      {/* ── Left Sidebar ───────────────────────────────────── */}
      <aside className="api-sidebar">
        <div className="api-sidebar-header">
          <Globe className="h-4 w-4 text-accent" />
          <span>API Client</span>
        </div>

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
      </aside>

      {/* ── Main Panel ─────────────────────────────────────── */}
      <main className="api-main">
        {/* Tab Bar UI */}
        <div className="api-tab-bar">
          {tabs.map(tab => (
            <div 
              key={tab.id} 
              className={`api-tab-item ${tab.id === store.activeTabId ? 'api-tab-item-active' : ''}`}
              onClick={() => store.setActiveTab(tab.id)}
            >
              <span className={`api-badge api-badge-${tab.method.toLowerCase()}`} style={{ fontSize: '8px', width: 'auto', padding: '1px 4px' }}>
                {tab.method}
              </span>
              <span className="api-tab-title">{tab.name}</span>
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

        {/* URL Bar */}
        <form onSubmit={handleSend} className="api-url-bar">
          <MethodDropdown
            value={activeTab.method}
            onChange={(val) => store.setMethod(val)}
          />

          <div className="api-url-input-container">
            <input
              type="text"
              className="api-url-input"
              value={activeTab.url}
              onChange={(e) => store.setUrl(e.target.value)}
              placeholder="Enter request URL (e.g. https://api.github.com/users)"
              required
            />
          </div>

          <div className="api-url-actions">
            <button
              type="button"
              className="api-curl-btn"
              onClick={() => {
                setShowImportCurl(!showImportCurl);
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
              onClick={handleCopyCurl}
              title="Copy as cURL command"
            >
              {curlCopied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-green" /> Copied
                </>
              ) : (
                <>
                  <Terminal className="h-3.5 w-3.5" /> cURL
                </>
              )}
            </button>

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

        {/* Split Panes */}
        <div className="api-split-panes" ref={splitRef}>
          {/* ── Request Pane ──────────────────────────────── */}
          <div
            className="api-pane api-pane-request"
            style={{ height: `${requestPaneHeight}px`, flexShrink: 0 }}
          >
            <div className="api-tabs">
              <div className="api-tabs-list">
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
                          options={
                            row.key.toLowerCase() === "content-type"
                              ? HEADER_VALUES
                              : row.key.toLowerCase() === "authorization"
                                ? ["Bearer ", "Basic "]
                                : []
                          }
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
              {requestTab === "body" && hasBody && (
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
                        theme="vs-dark"
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
                        theme="vs-dark"
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

              {/* Auth Tab */}
              {requestTab === "auth" && (
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
          <div className="api-pane" style={{ flex: 1 }}>
            <div className="api-pane-header">
              <span className="api-pane-title">Response</span>
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
                          Use the built-in <strong>Mock API Presets</strong>{" "}
                          which are CORS-enabled.
                        </li>
                        <li>
                          Enable CORS on your server (e.g.
                          `Access-Control-Allow-Origin: *`).
                        </li>
                        <li>
                          Use a browser extension like "Allow CORS" for local
                          testing.
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
                      {Object.keys(activeTab.response.headers).length}
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
                        theme="vs-dark"
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
                            {Object.entries(activeTab.response.headers)
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
          </div>
        </div>
      </main>
    </div>
  );
}
