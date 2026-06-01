// ============================================================
// API Tester Component — Complete visual client-side REST client
// ============================================================

import React, { useState, useEffect } from "react";
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
  Play,
  RotateCcw,
  Activity
} from "lucide-react";
import { useApiTesterStore, HttpMethod, BodyType, HistoryItem } from "@/stores/api-tester.store";
import "./api-tester.css";

// Built-in presets for rapid testing
const PRESETS = [
  {
    name: "JSONPlaceholder GET Users",
    method: "GET" as HttpMethod,
    url: "https://jsonplaceholder.typicode.com/users",
    params: [],
    headers: [{ key: "Accept", value: "application/json" }],
    bodyType: "none" as BodyType,
    description: "Fetch a list of mock user profiles (Supports CORS)"
  },
  {
    name: "JSONPlaceholder POST Create",
    method: "POST" as HttpMethod,
    url: "https://jsonplaceholder.typicode.com/posts",
    params: [],
    headers: [
      { key: "Content-Type", value: "application/json" },
      { key: "Accept", value: "application/json" }
    ],
    bodyType: "json" as BodyType,
    bodyValue: JSON.stringify({
      title: "DevUtils Premium API Client",
      body: "Tested using modern browser client-side REST technology.",
      userId: 1
    }, null, 2),
    description: "Submit a new mock blog post (Supports CORS)"
  },
  {
    name: "HTTPBin GET IP",
    method: "GET" as HttpMethod,
    url: "https://httpbin.org/ip",
    params: [],
    headers: [],
    bodyType: "none" as BodyType,
    description: "Retrieve your public IP address (Supports CORS)"
  },
  {
    name: "HTTPBin POST Echo",
    method: "POST" as HttpMethod,
    url: "https://httpbin.org/post",
    params: [{ key: "source", value: "devutils" }],
    headers: [
      { key: "Content-Type", value: "application/json" }
    ],
    bodyType: "json" as BodyType,
    bodyValue: JSON.stringify({
      hello: "world",
      client: "devutils-api-tester",
      isPremium: true
    }, null, 2),
    description: "Echo back request headers, params, and body payload"
  },
  {
    name: "ReqRes List Users",
    method: "GET" as HttpMethod,
    url: "https://reqres.in/api/users",
    params: [{ key: "page", value: "2" }],
    headers: [],
    bodyType: "none" as BodyType,
    description: "Retrieve paginated user accounts (Supports CORS)"
  }
];

export function ApiTester() {
  const store = useApiTesterStore();

  // Tab states
  const [requestTab, setRequestTab] = useState<"params" | "headers" | "body">("params");
  const [responseTab, setResponseTab] = useState<"pretty" | "raw" | "preview" | "headers">("pretty");
  const [headerSearch, setHeaderSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [showCorsHelp, setShowCorsHelp] = useState(false);

  // Trigger API execution
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store.url.trim()) return;
    await store.sendRequest();
  };

  // Copy body response to clipboard
  const handleCopyResponse = () => {
    if (!store.response?.body) return;
    navigator.clipboard.writeText(store.response.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Formats large response sizes nicely
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  // Safe JSON formatting check
  const getLanguageFromContentType = (contentType?: string): string => {
    if (!contentType) return "text";
    const type = contentType.toLowerCase();
    if (type.includes("application/json") || type.includes("json")) return "json";
    if (type.includes("text/html") || type.includes("html")) return "html";
    if (type.includes("application/xml") || type.includes("xml")) return "xml";
    if (type.includes("text/css") || type.includes("css")) return "css";
    if (type.includes("javascript") || type.includes("js")) return "javascript";
    return "text";
  };

  const responseLang = store.response
    ? getLanguageFromContentType(store.response.headers["content-type"])
    : "text";

  // Pretty print response body if JSON
  const getPrettyBody = (): string => {
    if (!store.response?.body) return "";
    if (responseLang === "json") {
      try {
        return JSON.stringify(JSON.parse(store.response.body), null, 2);
      } catch {
        return store.response.body;
      }
    }
    return store.response.body;
  };

  return (
    <div className="api-tester-container">
      {/* ── Left Sidebar (Presets & History) ───────────────── */}
      <aside className="api-sidebar">
        <div className="api-sidebar-header">
          <Globe className="h-4 w-4 text-accent" />
          <span>API Hub</span>
        </div>

        <div className="api-sidebar-content">
          {/* Presets Section */}
          <div className="api-sidebar-section">
            <div className="api-sidebar-title-row">
              <span className="api-sidebar-section-title">Mock API Presets</span>
              <Sparkles className="h-3 w-3 text-yellow" />
            </div>
            <div className="api-preset-list">
              {PRESETS.map((preset, index) => (
                <button
                  key={index}
                  className="api-preset-card"
                  onClick={() => store.loadPreset(preset)}
                  title={preset.description}
                >
                  <span className={`api-badge api-badge-${preset.method.toLowerCase()}`}>
                    {preset.method}
                  </span>
                  <div className="api-item-info">
                    <span className="api-item-url" style={{ fontSize: "11px", fontWeight: 600 }}>
                      {preset.name}
                    </span>
                    <span className="api-item-meta" style={{ fontSize: "9px" }}>
                      {preset.url}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* History Section */}
          <div className="api-sidebar-section" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <div className="api-sidebar-title-row">
              <span className="api-sidebar-section-title">Request History</span>
              {store.history.length > 0 && (
                <button className="api-clear-btn" onClick={store.clearHistory}>
                  Clear
                </button>
              )}
            </div>

            <div className="api-history-list" style={{ overflowY: "auto", flex: 1, maxHeight: "360px" }}>
              {store.history.length === 0 ? (
                <div className="api-history-empty">
                  <History className="h-6 w-6 opacity-30" />
                  <span className="api-history-empty-title">No History Yet</span>
                  <p className="api-history-empty-desc">
                    Your sent HTTP API requests will appear here for one-click retesting.
                  </p>
                </div>
              ) : (
                store.history.map((item) => (
                  <button
                    key={item.id}
                    className="api-history-card"
                    onClick={() => store.loadHistoryItem(item)}
                  >
                    <span className={`api-badge api-badge-${item.method.toLowerCase()}`}>
                      {item.method}
                    </span>
                    <div className="api-item-info">
                      <span className="api-item-url">{item.url}</span>
                      <span className="api-item-meta">
                        {item.error ? (
                          <span className="api-item-status-err">CORS / Network Error</span>
                        ) : (
                          <span className="api-item-status-ok">Status {item.status}</span>
                        )}
                        <span>{item.time ? `${item.time}ms` : ""}</span>
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* ── Main Panel View ────────────────────────────────── */}
      <main className="api-main">
        {/* Method & URL Input Header bar */}
        <form onSubmit={handleSend} className="api-url-bar">
          <select
            className="api-method-select"
            value={store.method}
            onChange={(e) => store.setMethod(e.target.value as HttpMethod)}
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="DELETE">DELETE</option>
            <option value="PATCH">PATCH</option>
            <option value="HEAD">HEAD</option>
            <option value="OPTIONS">OPTIONS</option>
          </select>

          <div className="api-url-input-container">
            <input
              type="text"
              className="api-url-input"
              value={store.url}
              onChange={(e) => store.setUrl(e.target.value)}
              placeholder="Enter request URL (e.g. https://api.github.com/users)"
              required
            />
          </div>

          <button
            type="submit"
            className="api-send-btn"
            disabled={store.loading || !store.url.trim()}
          >
            {store.loading ? (
              <span className="api-spinner" style={{ width: "14px", height: "14px", borderWidth: "2px" }} />
            ) : (
              <Send className="h-4 w-4" />
            )}
            <span>{store.loading ? "Sending..." : "Send"}</span>
          </button>
        </form>

        <div className="api-split-panes">
          {/* ── Request Configuration Section (Top Pane) ─────── */}
          <div className="api-pane" style={{ borderBottom: "1px solid var(--border-1)", maxHeight: "40%" }}>
            <div className="api-tabs">
              <div className="api-tabs-list">
                <button
                  type="button"
                  className={`api-tab-trigger ${requestTab === "params" ? "api-tab-trigger-active" : ""}`}
                  onClick={() => setRequestTab("params")}
                >
                  Params ({store.params.filter(p => p.key.trim() !== "").length})
                </button>
                <button
                  type="button"
                  className={`api-tab-trigger ${requestTab === "headers" ? "api-tab-trigger-active" : ""}`}
                  onClick={() => setRequestTab("headers")}
                >
                  Headers ({store.headers.filter(h => h.key.trim() !== "").length})
                </button>
                {store.method !== "GET" && store.method !== "HEAD" && (
                  <button
                    type="button"
                    className={`api-tab-trigger ${requestTab === "body" ? "api-tab-trigger-active" : ""}`}
                    onClick={() => setRequestTab("body")}
                  >
                    Body
                  </button>
                )}
              </div>

              {/* Params Tab content */}
              {requestTab === "params" && (
                <div className="api-tab-content">
                  <div className="api-kv-editor">
                    {store.params.map((row) => (
                      <div key={row.id} className="api-kv-row">
                        <input
                          type="checkbox"
                          className="api-checkbox"
                          checked={row.enabled}
                          onChange={(e) => store.updateParam(row.id, { enabled: e.target.checked })}
                        />
                        <input
                          type="text"
                          className="api-kv-input"
                          placeholder="Parameter Name"
                          value={row.key}
                          onChange={(e) => store.updateParam(row.id, { key: e.target.value })}
                        />
                        <input
                          type="text"
                          className="api-kv-input"
                          placeholder="Value"
                          value={row.value}
                          onChange={(e) => store.updateParam(row.id, { value: e.target.value })}
                        />
                        <button
                          type="button"
                          className="api-delete-row-btn"
                          onClick={() => store.removeParam(row.id)}
                          title="Delete Parameter"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <button type="button" className="api-add-row-btn" onClick={store.addParam}>
                      <Plus className="h-3.5 w-3.5" /> Add Param
                    </button>
                  </div>
                </div>
              )}

              {/* Headers Tab content */}
              {requestTab === "headers" && (
                <div className="api-tab-content">
                  <div className="api-kv-editor">
                    {store.headers.map((row) => (
                      <div key={row.id} className="api-kv-row">
                        <input
                          type="checkbox"
                          className="api-checkbox"
                          checked={row.enabled}
                          onChange={(e) => store.updateHeader(row.id, { enabled: e.target.checked })}
                        />
                        <input
                          type="text"
                          className="api-kv-input"
                          placeholder="Header Name (e.g. Authorization)"
                          value={row.key}
                          onChange={(e) => store.updateHeader(row.id, { key: e.target.value })}
                          list="header-keys-suggestions"
                        />
                        <input
                          type="text"
                          className="api-kv-input"
                          placeholder="Value"
                          value={row.value}
                          onChange={(e) => store.updateHeader(row.id, { value: e.target.value })}
                          list="header-values-suggestions"
                        />
                        <button
                          type="button"
                          className="api-delete-row-btn"
                          onClick={() => store.removeHeader(row.id)}
                          title="Delete Header"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <button type="button" className="api-add-row-btn" onClick={store.addHeader}>
                      <Plus className="h-3.5 w-3.5" /> Add Header
                    </button>
                  </div>

                  {/* Header suggestions datalists */}
                  <datalist id="header-keys-suggestions">
                    <option value="Content-Type" />
                    <option value="Authorization" />
                    <option value="Accept" />
                    <option value="User-Agent" />
                    <option value="Cache-Control" />
                    <option value="Host" />
                  </datalist>
                  <datalist id="header-values-suggestions">
                    <option value="application/json" />
                    <option value="application/xml" />
                    <option value="text/plain" />
                    <option value="text/html" />
                    <option value="multipart/form-data" />
                    <option value="Bearer " />
                  </datalist>
                </div>
              )}

              {/* Body Tab content */}
              {requestTab === "body" && store.method !== "GET" && store.method !== "HEAD" && (
                <div className="api-tab-content">
                  <div className="api-body-toggles">
                    <label className="api-body-radio">
                      <input
                        type="radio"
                        name="bodyType"
                        checked={store.bodyType === "none"}
                        onChange={() => store.setBodyType("none")}
                      />
                      None
                    </label>
                    <label className="api-body-radio">
                      <input
                        type="radio"
                        name="bodyType"
                        checked={store.bodyType === "json"}
                        onChange={() => store.setBodyType("json")}
                      />
                      JSON
                    </label>
                    <label className="api-body-radio">
                      <input
                        type="radio"
                        name="bodyType"
                        checked={store.bodyType === "form-data"}
                        onChange={() => store.setBodyType("form-data")}
                      />
                      Form Data
                    </label>
                    <label className="api-body-radio">
                      <input
                        type="radio"
                        name="bodyType"
                        checked={store.bodyType === "raw"}
                        onChange={() => store.setBodyType("raw")}
                      />
                      Raw Content
                    </label>

                    {store.bodyType === "raw" && (
                      <select
                        className="api-raw-select"
                        value={store.rawType}
                        onChange={(e) => store.setRawType(e.target.value)}
                      >
                        <option value="text/plain">Text (text/plain)</option>
                        <option value="application/xml">XML (application/xml)</option>
                        <option value="text/html">HTML (text/html)</option>
                        <option value="text/javascript">JavaScript (text/javascript)</option>
                      </select>
                    )}
                  </div>

                  {store.bodyType === "none" && (
                    <div className="api-history-empty" style={{ padding: "16px", minHeight: "100px" }}>
                      <ShieldCheck className="h-5 w-5 opacity-40 text-accent" />
                      <span style={{ fontSize: "12px", color: "var(--text-2)", fontWeight: 500 }}>
                        No payload body will be sent with this request.
                      </span>
                    </div>
                  )}

                  {store.bodyType === "json" && (
                    <div className="api-monaco-editor-wrapper">
                      <Editor
                        height="200px"
                        language="json"
                        theme="vs-dark"
                        value={store.bodyValue}
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

                  {store.bodyType === "form-data" && (
                    <div className="api-kv-editor">
                      {store.formParams.map((row) => (
                        <div key={row.id} className="api-kv-row">
                          <input
                            type="checkbox"
                            className="api-checkbox"
                            checked={row.enabled}
                            onChange={(e) => store.updateFormParam(row.id, { enabled: e.target.checked })}
                          />
                          <input
                            type="text"
                            className="api-kv-input"
                            placeholder="Key"
                            value={row.key}
                            onChange={(e) => store.updateFormParam(row.id, { key: e.target.value })}
                          />
                          <input
                            type="text"
                            className="api-kv-input"
                            placeholder="Value"
                            value={row.value}
                            onChange={(e) => store.updateFormParam(row.id, { value: e.target.value })}
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
                      <button type="button" className="api-add-row-btn" onClick={store.addFormParam}>
                        <Plus className="h-3.5 w-3.5" /> Add Row
                      </button>
                    </div>
                  )}

                  {store.bodyType === "raw" && (
                    <div className="api-monaco-editor-wrapper">
                      <Editor
                        height="200px"
                        language={store.rawType.split("/")[1] || "text"}
                        theme="vs-dark"
                        value={store.bodyValue}
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
            </div>
          </div>

          {/* ── Response Section (Bottom Pane) ────────────────── */}
          <div className="api-pane" style={{ flex: 1, borderTop: "1px solid var(--border-1)" }}>
            <div className="api-pane-header">
              <span className="api-pane-title">Response</span>

              {store.response && (
                <div className="api-response-meta">
                  <div className={`status-pill ${store.response.status >= 200 && store.response.status < 300 ? "status-pill-ok" : "status-pill-err"}`}>
                    <Activity className="h-3.5 w-3.5" />
                    <span>{store.response.status} {store.response.statusText}</span>
                  </div>
                  <div className="meta-item">
                    <Clock className="h-3.5 w-3.5 opacity-60" />
                    <span>Time: <span className="meta-item-value">{store.response.time} ms</span></span>
                  </div>
                  <div className="meta-item">
                    <Database className="h-3.5 w-3.5 opacity-60" />
                    <span>Size: <span className="meta-item-value">{formatBytes(store.response.size)}</span></span>
                  </div>
                </div>
              )}
            </div>

            {/* Loading Spinner */}
            {store.loading && (
              <div className="api-loading-state">
                <div className="api-spinner" />
                <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-2)" }}>
                  Connecting to server and transmitting packet payload...
                </span>
              </div>
            )}

            {/* Error view with CORS panel details */}
            {store.error && (
              <div style={{ overflowY: "auto", flex: 1 }}>
                <div className="api-error-card">
                  <AlertCircle className="api-error-icon h-5 w-5" />
                  <div className="api-error-info">
                    <span className="api-error-title">HTTP Request Failed</span>
                    <p className="api-error-message">{store.error}</p>
                  </div>
                </div>

                <div style={{ padding: "0 16px 16px" }}>
                  <div className="api-cors-panel">
                    <Info className="api-cors-icon h-5 w-5" />
                    <div className="api-cors-details">
                      <span className="api-cors-title">Cross-Origin Resource Sharing (CORS) Warning</span>
                      <p className="api-cors-desc">
                        Standard browser-based HTTP clients are subject to CORS restrictions. If the target server
                        does not explicitly include an `Access-Control-Allow-Origin` header permitting this origin,
                        the browser will block the network socket completion.
                      </p>
                      <p className="api-cors-desc" style={{ marginTop: "6px", fontWeight: 600 }}>
                        How to resolve this:
                      </p>
                      <ul style={{ paddingLeft: "16px", fontSize: "11px", color: "var(--text-2)", display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
                        <li>1. Use one of our built-in <strong>Mock API Presets</strong> which are fully CORS-enabled.</li>
                        <li>2. Enable CORS on your backend server for development (e.g. `Access-Control-Allow-Origin: *`).</li>
                        <li>3. Install a browser extension such as "Allow CORS: Access-Control-Allow-Origin" for quick local testing.</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Empty state placeholder */}
            {!store.loading && !store.error && !store.response && (
              <div className="api-response-empty">
                <Send className="h-8 w-8 opacity-30 text-accent" />
                <span className="api-response-empty-title">Ready for Transmission</span>
                <p className="api-response-empty-desc">
                  Input a query URL target, configure custom headers or parameters, and click <strong>Send</strong>.
                </p>
              </div>
            )}

            {/* Response Visualization Body */}
            {!store.loading && !store.error && store.response && (
              <div className="api-tabs" style={{ flex: 1, overflow: "hidden" }}>
                <div className="api-tabs-list" style={{ padding: "0 16px" }}>
                  <button
                    type="button"
                    className={`api-tab-trigger ${responseTab === "pretty" ? "api-tab-trigger-active" : ""}`}
                    onClick={() => setResponseTab("pretty")}
                  >
                    Pretty ({responseLang})
                  </button>
                  <button
                    type="button"
                    className={`api-tab-trigger ${responseTab === "raw" ? "api-tab-trigger-active" : ""}`}
                    onClick={() => setResponseTab("raw")}
                  >
                    Raw Text
                  </button>
                  {responseLang === "html" && (
                    <button
                      type="button"
                      className={`api-tab-trigger ${responseTab === "preview" ? "api-tab-trigger-active" : ""}`}
                      onClick={() => setResponseTab("preview")}
                    >
                      Preview HTML
                    </button>
                  )}
                  <button
                    type="button"
                    className={`api-tab-trigger ${responseTab === "headers" ? "api-tab-trigger-active" : ""}`}
                    onClick={() => setResponseTab("headers")}
                  >
                    Headers ({Object.keys(store.response.headers).length})
                  </button>

                  <div style={{ flex: 1 }} />

                  {responseTab !== "headers" && (
                    <button
                      type="button"
                      className="api-add-row-btn"
                      onClick={handleCopyResponse}
                      style={{ fontSize: "11px", alignSelf: "center", height: "26px", display: "flex", alignItems: "center", padding: "0 8px" }}
                    >
                      {copied ? (
                        <>
                          <Check className="h-3 w-3 text-green" /> Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" /> Copy Output
                        </>
                      )}
                    </button>
                  )}
                </div>

                <div className="api-tab-content" style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
                  {/* Pretty Code highlight */}
                  {responseTab === "pretty" && (
                    <div className="api-response-monaco-wrapper">
                      <Editor
                        height="340px"
                        language={responseLang}
                        theme="vs-dark"
                        value={getPrettyBody()}
                        options={{
                          readOnly: true,
                          minimap: { enabled: false },
                          fontSize: 12,
                          lineNumbers: "on",
                          scrollBeyondLastLine: false,
                          wordWrap: "on"
                        }}
                      />
                    </div>
                  )}

                  {/* Raw plain text rendering */}
                  {responseTab === "raw" && (
                    <textarea
                      className="api-response-raw-text"
                      value={store.response.body}
                      readOnly
                    />
                  )}

                  {/* Preview HTML Frame sandbox */}
                  {responseTab === "preview" && responseLang === "html" && (
                    <iframe
                      className="api-response-preview-iframe"
                      srcDoc={store.response.body}
                      title="HTML Response Live Preview"
                      sandbox="allow-scripts"
                    />
                  )}

                  {/* Response headers filterable list */}
                  {responseTab === "headers" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      <div className="api-url-input-container" style={{ height: "32px", padding: "0 8px" }}>
                        <Search className="h-3.5 w-3.5 text-text-3 mr-2" />
                        <input
                          type="text"
                          className="api-url-input"
                          style={{ fontSize: "12px", fontFamily: "var(--font-sans)" }}
                          placeholder="Search Response Headers..."
                          value={headerSearch}
                          onChange={(e) => setHeaderSearch(e.target.value)}
                        />
                      </div>
                      <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid var(--border-1)", borderRadius: "var(--radius-md)" }}>
                        <table className="api-headers-table">
                          <thead>
                            <tr>
                              <th className="api-headers-th" style={{ width: "35%" }}>Name</th>
                              <th className="api-headers-th">Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(store.response.headers)
                              .filter(([key, val]) =>
                                key.toLowerCase().includes(headerSearch.toLowerCase()) ||
                                val.toLowerCase().includes(headerSearch.toLowerCase())
                              )
                              .map(([key, val]) => (
                                <tr key={key} className="api-headers-row">
                                  <td className="api-headers-td api-headers-key">{key}</td>
                                  <td className="api-headers-td api-headers-val">{val}</td>
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
