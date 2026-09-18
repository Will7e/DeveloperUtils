import { useState, useMemo } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  Activity,
  Clock,
  Database,
  AlertCircle,
  Info,
  Send,
  Copy,
  Check,
  Download,
  Search,
  RotateCw,
} from "lucide-react";
import { LoadingState } from "@/components/ui/loading-state";
import { EditorLoadingFallback } from "@/components/ui/editor-loader";
import { useAppStore } from "@/stores/app.store";
import { useApiTesterStore, type TabState } from "@/stores/api-tester.store";
import { WebSocketConsole } from "./WebSocketConsole";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
import {
  formatBytes,
  getTimeClass,
  getLanguageFromContentType,
} from "../constants";

interface ResponsePaneProps {
  activeTab: TabState;
  currentThemeSetting: string;
  handleEditorMount: OnMount;
  onSend: () => void;
}

export function ResponsePane({
  activeTab,
  currentThemeSetting,
  handleEditorMount,
  onSend,
}: ResponsePaneProps) {
  const store = useApiTesterStore();
  const addToast = useAppStore((s) => s.addToast);

  const [responseTab, setResponseTab] = useState<
    "pretty" | "raw" | "preview" | "headers"
  >("pretty");
  const [headerSearch, setHeaderSearch] = useState("");
  const [copied, setCopied] = useState(false);

  const responseLang = activeTab?.response?.headers
    ? getLanguageFromContentType(activeTab.response.headers["content-type"])
    : "text";

  const responseBody = activeTab?.response?.body;
  const prettyBody = useMemo(() => {
    if (!responseBody) return "";
    if (responseLang === "json") {
      try {
        return JSON.stringify(JSON.parse(responseBody), null, 2);
      } catch {
        return responseBody;
      }
    }
    return responseBody;
  }, [responseBody, responseLang]);

  const handleCopyResponse = async () => {
    if (!activeTab.response?.body) return;
    try {
      await navigator.clipboard.writeText(activeTab.response.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      addToast({
        message: "Response copied to clipboard!",
        type: "success",
        duration: 2000,
      });
    } catch (err) {
      console.error("Failed to copy response: ", err);
      addToast({
        message: "Failed to copy response to clipboard.",
        type: "error",
        duration: 3000,
      });
    }
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

      let ext = "txt";
      if (responseLang === "json") ext = "json";
      else if (responseLang === "html") ext = "html";
      else if (responseLang === "xml") ext = "xml";
      else if (responseLang === "css") ext = "css";
      else if (responseLang === "javascript") ext = "js";

      a.download = `response-${activeTab.name
        .replace(/\s+/g, "_")
        .toLowerCase()}-${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Failed to download response", e);
    }
  };

  return (
    <div
      className="api-pane"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {activeTab.protocol === "websocket" ? (
        <WebSocketConsole
          wsMessages={activeTab.wsMessages || []}
          wsConnected={activeTab.wsConnected}
          onClearLogs={() => store.clearWsMessages()}
        />
      ) : (
        <>
          <div className="api-pane-header">
            <span className="api-pane-title">Response</span>
            {activeTab.sseActive && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  marginLeft: "12px",
                }}
              >
                <span
                  className="api-sse-pulse"
                  style={{
                    width: "8px",
                    height: "8px",
                    background: "var(--accent)",
                    borderRadius: "50%",
                    display: "inline-block",
                    boxShadow: "0 0 8px var(--accent)",
                  }}
                />
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "var(--accent)",
                  }}
                >
                  Streaming...
                </span>
                <button
                  type="button"
                  className="api-clear-btn"
                  onClick={() => store.stopActiveRequest(activeTab.id)}
                  style={{
                    padding: "2px 6px",
                    color: "var(--red)",
                    background: "var(--red-dim)",
                    borderRadius: "4px",
                  }}
                >
                  Stop
                </button>
              </div>
            )}
            {activeTab.response && (
              <div className="api-response-meta">
                <div
                  className={`status-pill ${
                    activeTab.response.status >= 200 &&
                    activeTab.response.status < 300
                      ? "status-pill-ok"
                      : "status-pill-err"
                  }`}
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
                      className={`meta-item-value ${getTimeClass(
                        activeTab.response.time
                      )}`}
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
              <LoadingState
                size="md"
                message="Connecting to server..."
                description="Sending HTTP request and awaiting response"
              />
            </div>
          )}

          {/* Error */}
          {activeTab.error && (
            <div style={{ overflowY: "auto", flex: 1 }}>
              <div className="api-error-card">
                <AlertCircle className="api-error-icon h-5 w-5" />
                <div className="api-error-info" style={{ flex: 1 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "12px",
                    }}
                  >
                    <span className="api-error-title">HTTP Request Failed</span>
                    <button
                      type="button"
                      onClick={onSend}
                      className="api-send-btn"
                      style={{
                        height: "28px",
                        padding: "0 10px",
                        fontSize: "12px",
                        gap: "6px",
                      }}
                    >
                      <RotateCw className="h-3 w-3" />
                      <span>Retry</span>
                    </button>
                  </div>
                  <p className="api-error-message">{activeTab.error}</p>
                </div>
              </div>

              <div style={{ padding: "0 16px 16px" }}>
                <div className="api-cors-panel">
                  <Info className="api-cors-icon h-5 w-5" />
                  <div className="api-cors-details">
                    <span className="api-cors-title">CORS Restriction Notice</span>
                    <p className="api-cors-desc">
                      Browser-based clients are subject to CORS restrictions. If
                      the server doesn't include an `Access-Control-Allow-Origin`
                      header, the request will be blocked.
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
                        Enable the <strong>CORS Proxy</strong> (click the Shield icon in the URL bar
                        to route requests through the built-in proxy).
                      </li>
                      <li>
                        Use the built-in <strong>Mock API Presets</strong> which
                        are CORS-enabled.
                      </li>
                      <li>
                        Enable CORS on your server (e.g. `Access-Control-Allow-Origin: *`).
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
              <span className="api-response-empty-title">Ready to Send</span>
              <p className="api-response-empty-desc">
                Configure your request above and press <strong>Send</strong> or{" "}
                <strong>⌘ Enter</strong> to execute.
              </p>
            </div>
          )}

          {/* Response Body */}
          {!activeTab.loading && !activeTab.error && activeTab.response && (
            <div className="api-tabs" style={{ flex: 1, overflow: "hidden" }}>
              <div className="api-tabs-list" style={{ padding: "0 16px" }}>
                <button
                  type="button"
                  className={`api-tab-trigger ${
                    responseTab === "pretty" ? "api-tab-trigger-active" : ""
                  }`}
                  onClick={() => setResponseTab("pretty")}
                >
                  Pretty
                  <span className="api-tab-count">{responseLang}</span>
                </button>
                <button
                  type="button"
                  className={`api-tab-trigger ${
                    responseTab === "raw" ? "api-tab-trigger-active" : ""
                  }`}
                  onClick={() => setResponseTab("raw")}
                >
                  Raw
                </button>
                {responseLang === "html" && (
                  <button
                    type="button"
                    className={`api-tab-trigger ${
                      responseTab === "preview" ? "api-tab-trigger-active" : ""
                    }`}
                    onClick={() => setResponseTab("preview")}
                  >
                    Preview
                  </button>
                )}
                <button
                  type="button"
                  className={`api-tab-trigger ${
                    responseTab === "headers" ? "api-tab-trigger-active" : ""
                  }`}
                  onClick={() => setResponseTab("headers")}
                >
                  Headers
                  <span className="api-tab-count">
                    {Object.keys(activeTab.response.headers || {}).length}
                  </span>
                </button>

                <div style={{ flex: 1 }} />

                {responseTab !== "headers" && (
                  <div
                    style={{ display: "flex", gap: "6px", alignItems: "center" }}
                  >
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
                    <EditorErrorBoundary fallbackMessage="Failed to render response preview.">
                      <Editor
                        className="api-monaco-wrapper"
                        loading={
                          <EditorLoadingFallback message="Loading response preview..." />
                        }
                        height="100%"
                        language={responseLang}
                        theme={
                          currentThemeSetting === "light"
                            ? "intab-light"
                            : "intab-dark"
                        }
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
                    </EditorErrorBoundary>
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
                    sandbox=""
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
                      <Search
                        className="h-3.5 w-3.5 text-text-3 mr-2"
                        style={{ flexShrink: 0 }}
                      />
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
                                  .includes(headerSearch.toLowerCase()) ||
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
  );
}
