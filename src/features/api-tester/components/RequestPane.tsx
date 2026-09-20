import React, { useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import {
  Lock,
  Plus,
  Trash2,
  AlignLeft,
  ShieldCheck,
  FileCode2,
  FileJson,
  Send,
  Eye,
  EyeOff,
} from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EditorLoadingFallback } from "@/components/ui/editor-loader";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
import { AutocompleteInput } from "./AutocompleteInput";
import { RawTypeDropdown } from "./dropdowns/RawTypeDropdown";
import { HEADER_KEYS, HEADER_VALUES_MAP } from "../constants";
import {
  useApiTesterStore,
  type TabState,
  type BodyType,
  type AuthType,
} from "@/stores/api-tester.store";

interface RequestPaneProps {
  activeTab: TabState;
  requestTab: string;
  setRequestTab: (tab: string) => void;
  hasBody: boolean;
  requestPaneHeight: number;
  currentThemeSetting: string;
  handleEditorMount: OnMount;
  handleGraphqlEditorMount: OnMount;
  wsMessageText: string;
  setWsMessageText: (val: string) => void;
  hidden?: boolean;
}

export function RequestPane({
  activeTab,
  requestTab,
  setRequestTab,
  hasBody,
  requestPaneHeight,
  currentThemeSetting,
  handleEditorMount,
  handleGraphqlEditorMount,
  wsMessageText,
  setWsMessageText,
  hidden = false,
}: RequestPaneProps) {
  const store = useApiTesterStore();
  const [showPassword, setShowPassword] = useState(false);
  const [showBearerToken, setShowBearerToken] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  return (
    <div
      className="api-pane api-pane-request"
      style={{
        height: `${requestPaneHeight}px`,
        flexShrink: 0,
        display: hidden ? "none" : "flex",
      }}
    >
      <div className="api-tabs">
        <div className="api-tabs-list">
          {activeTab.protocol === "rest" && (
            <>
              <button
                type="button"
                className={`api-tab-trigger ${
                  requestTab === "params" ? "api-tab-trigger-active" : ""
                }`}
                onClick={() => setRequestTab("params")}
              >
                Params
                <span className="api-tab-count">
                  {activeTab.params.filter((p) => p.key.trim() !== "").length}
                </span>
              </button>
              <button
                type="button"
                className={`api-tab-trigger ${
                  requestTab === "headers" ? "api-tab-trigger-active" : ""
                }`}
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
                  className={`api-tab-trigger ${
                    requestTab === "body" ? "api-tab-trigger-active" : ""
                  }`}
                  onClick={() => setRequestTab("body")}
                >
                  Body
                </button>
              )}
              <button
                type="button"
                className={`api-tab-trigger ${
                  requestTab === "auth" ? "api-tab-trigger-active" : ""
                }`}
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
                className={`api-tab-trigger ${
                  requestTab === "graphql" ? "api-tab-trigger-active" : ""
                }`}
                onClick={() => setRequestTab("graphql")}
              >
                GraphQL
              </button>
              <button
                type="button"
                className={`api-tab-trigger ${
                  requestTab === "headers" ? "api-tab-trigger-active" : ""
                }`}
                onClick={() => setRequestTab("headers")}
              >
                Headers
                <span className="api-tab-count">
                  {activeTab.headers.filter((h) => h.key.trim() !== "").length}
                </span>
              </button>
              <button
                type="button"
                className={`api-tab-trigger ${
                  requestTab === "auth" ? "api-tab-trigger-active" : ""
                }`}
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
                className={`api-tab-trigger ${
                  requestTab === "ws-message" ? "api-tab-trigger-active" : ""
                }`}
                onClick={() => setRequestTab("ws-message")}
              >
                Message
              </button>
              <button
                type="button"
                className={`api-tab-trigger ${
                  requestTab === "params" ? "api-tab-trigger-active" : ""
                }`}
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
                  className={`api-body-radio ${
                    activeTab.bodyType === type ? "api-body-radio-active" : ""
                  }`}
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
              <div
                className="api-monaco-editor-wrapper"
                style={{ position: "relative" }}
              >
                <button
                  type="button"
                  className="api-editor-format-btn"
                  onClick={() => store.formatActiveTabJsonBody()}
                  title="Beautify/Format JSON string"
                >
                  <AlignLeft className="h-3 w-3 text-yellow" />
                  <span>Format</span>
                </button>
                <EditorErrorBoundary fallbackMessage="Failed to load body editor.">
                  <Editor
                    className="api-monaco-wrapper"
                    loading={
                      <EditorLoadingFallback message="Loading body editor..." />
                    }
                    height="100%"
                    language="json"
                    theme={
                      currentThemeSetting === "light"
                        ? "intab-light"
                        : "intab-dark"
                    }
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
                </EditorErrorBoundary>
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
                <EditorErrorBoundary fallbackMessage="Failed to load raw editor.">
                  <Editor
                    className="api-monaco-wrapper"
                    loading={
                      <EditorLoadingFallback message="Loading editor..." />
                    }
                    height="100%"
                    language={activeTab.rawType.split("/")[1] || "text"}
                    theme={
                      currentThemeSetting === "light"
                        ? "intab-light"
                        : "intab-dark"
                    }
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
                </EditorErrorBoundary>
              </div>
            )}
          </div>
        )}

        {/* GraphQL Tab */}
        {requestTab === "graphql" && activeTab.protocol === "graphql" && (
          <div
            className="api-tab-content api-graphql-container"
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100%",
              overflow: "hidden",
            }}
          >
            <PanelGroup orientation="horizontal">
              <Panel
                defaultSize={70}
                minSize={20}
                className="api-graphql-editor-pane"
                style={{ display: "flex", flexDirection: "column" }}
              >
                <div className="api-graphql-pane-header">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <FileCode2 className="h-3.5 w-3.5" />
                    <span>Query</span>
                  </div>
                </div>
                <div style={{ flex: 1, position: "relative" }}>
                  <EditorErrorBoundary fallbackMessage="Failed to load GraphQL query editor.">
                    <Editor
                      className="api-monaco-wrapper"
                      loading={
                        <EditorLoadingFallback message="Loading GraphQL query..." />
                      }
                      height="100%"
                      language="graphql"
                      theme={
                        currentThemeSetting === "light"
                          ? "intab-light"
                          : "intab-dark"
                      }
                      onMount={handleGraphqlEditorMount}
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
                  </EditorErrorBoundary>
                </div>
              </Panel>

              <PanelResizeHandle className="api-panel-resize-handle api-panel-resize-handle-horizontal" />

              <Panel
                defaultSize={30}
                minSize={10}
                className="api-graphql-editor-pane"
                style={{ display: "flex", flexDirection: "column" }}
              >
                <div className="api-graphql-pane-header">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <FileJson className="h-3.5 w-3.5" />
                    <span>Variables (JSON)</span>
                  </div>
                </div>
                <div style={{ flex: 1, position: "relative" }}>
                  <EditorErrorBoundary fallbackMessage="Failed to load GraphQL variables editor.">
                    <Editor
                      className="api-monaco-wrapper"
                      loading={
                        <EditorLoadingFallback message="Loading GraphQL variables..." />
                      }
                      height="100%"
                      language="json"
                      theme={
                        currentThemeSetting === "light"
                          ? "intab-light"
                          : "intab-dark"
                      }
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
                  </EditorErrorBoundary>
                </div>
              </Panel>
            </PanelGroup>
          </div>
        )}

        {/* WebSocket Message Tab */}
        {requestTab === "ws-message" && activeTab.protocol === "websocket" && (
          <div
            className="api-tab-content api-ws-message-container"
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100%",
              padding: "12px",
              gap: "8px",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "var(--text-3)",
                }}
              >
                WebSocket Message Payload
              </span>
              <span style={{ fontSize: "10px", color: "var(--text-3)" }}>
                Supports variables like {"{{variable}}"}
              </span>
            </div>
            <div
              style={{
                flex: 1,
                border: "1px solid var(--border-1)",
                borderRadius: "var(--radius-md)",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <EditorErrorBoundary fallbackMessage="Failed to load WebSocket payload editor.">
                <Editor
                  className="api-monaco-wrapper"
                  loading={
                    <EditorLoadingFallback message="Loading WebSocket payload..." />
                  }
                  height="100%"
                  language="json"
                  theme={
                    currentThemeSetting === "light"
                      ? "intab-light"
                      : "intab-dark"
                  }
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
              </EditorErrorBoundary>
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
                    className={`api-auth-type-btn ${
                      activeTab.authType === type
                        ? "api-auth-type-btn-active"
                        : ""
                    }`}
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
                    <div style={{ position: "relative", display: "flex", gap: "6px" }}>
                      <input
                        type={showBearerToken ? "text" : "password"}
                        className="api-auth-input"
                        placeholder="Enter bearer token"
                        value={activeTab.authConfig.bearerToken}
                        onChange={(e) =>
                          store.setAuthConfig({
                            bearerToken: e.target.value,
                          })
                        }
                      />
                      <SimpleTooltip content={showBearerToken ? "Hide token" : "Show token"}>
                        <button
                          type="button"
                          className="api-delete-row-btn"
                          onClick={() => setShowBearerToken(!showBearerToken)}
                          style={{ flexShrink: 0 }}
                        >
                          {showBearerToken ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </SimpleTooltip>
                    </div>
                    <span className="api-auth-hint">
                      Will be sent as: Authorization: Bearer &lt;token&gt;
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
                      <SimpleTooltip
                        content={showPassword ? "Hide password" : "Show password"}
                      >
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
                    <div style={{ position: "relative", display: "flex", gap: "6px" }}>
                      <input
                        type={showApiKey ? "text" : "password"}
                        className="api-auth-input"
                        placeholder="Enter API key value"
                        value={activeTab.authConfig.apiKeyValue}
                        onChange={(e) =>
                          store.setAuthConfig({
                            apiKeyValue: e.target.value,
                          })
                        }
                      />
                      <SimpleTooltip content={showApiKey ? "Hide key" : "Show key"}>
                        <button
                          type="button"
                          className="api-delete-row-btn"
                          onClick={() => setShowApiKey(!showApiKey)}
                          style={{ flexShrink: 0 }}
                        >
                          {showApiKey ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </SimpleTooltip>
                    </div>
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
  );
}
