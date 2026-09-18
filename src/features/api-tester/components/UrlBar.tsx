import React, { useMemo } from "react";
import {
  Send,
  Shield,
  Terminal,
  Code2,
  Zap,
  Square,
  Wifi,
  WifiOff,
} from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ProtocolDropdown } from "./dropdowns/ProtocolDropdown";
import { MethodDropdown } from "./dropdowns/MethodDropdown";
import { useApiTesterStore, substituteEnvVars, type TabState } from "@/stores/api-tester.store";

interface UrlBarProps {
  activeTab: TabState;
  isMac: boolean;
  showImportCurl: boolean;
  showCodeSnippet: boolean;
  onToggleImportCurl: () => void;
  onToggleCodeSnippet: () => void;
}

export function UrlBar({
  activeTab,
  isMac,
  showImportCurl,
  showCodeSnippet,
  onToggleImportCurl,
  onToggleCodeSnippet,
}: UrlBarProps) {
  const store = useApiTesterStore();

  const environments = store.environments;
  const activeEnvironmentId = store.activeEnvironmentId;
  const activeEnvVars = useMemo(() => {
    if (!activeEnvironmentId) return [];
    return environments.find((e) => e.id === activeEnvironmentId)?.variables || [];
  }, [activeEnvironmentId, environments]);

  const hasEnvVars = /(?:\{\{|%7B%7B)[^}%]+(?:%7D%7D|\}\})/i.test(activeTab.url);
  const resolvedUrl = useMemo(() => {
    if (!hasEnvVars) return "";
    return substituteEnvVars(activeTab.url, store.envVars, activeEnvVars);
  }, [hasEnvVars, activeTab.url, store.envVars, activeEnvVars]);
  const activeEnvName = activeEnvironmentId
    ? environments.find((e) => e.id === activeEnvironmentId)?.name || "Active Environment"
    : "Global Environment";

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

  return (
    <form onSubmit={handleSend} className="api-url-bar">
      <div className="api-omnibox">
        <ProtocolDropdown
          value={activeTab.protocol}
          onChange={(val) => store.setProtocol(val)}
        />

        <div className="api-omnibox-divider" />

        {activeTab.protocol !== "websocket" && (
          <>
            <MethodDropdown
              value={activeTab.method}
              onChange={(val) => store.setMethod(val)}
            />
            <div className="api-omnibox-divider" />
          </>
        )}
        {activeTab.protocol === "websocket" && (
          <>
            <div
              className="api-method-select api-method-select-ws"
              style={{ cursor: "default" }}
            >
              <span>WS</span>
            </div>
            <div className="api-omnibox-divider" />
          </>
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
            title={
              hasEnvVars && resolvedUrl && resolvedUrl !== activeTab.url
                ? `Resolved (${activeEnvName}): ${resolvedUrl}`
                : undefined
            }
            required
          />

          {hasEnvVars && resolvedUrl && resolvedUrl !== activeTab.url && (
            <SimpleTooltip content={`Resolved (${activeEnvName}): ${resolvedUrl}`}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  fontSize: "11px",
                  padding: "2px 7px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border-1)",
                  borderRadius: "4px",
                  color: "var(--accent)",
                  whiteSpace: "nowrap",
                  cursor: "default",
                  maxWidth: "200px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  userSelect: "none",
                  flexShrink: 0,
                }}
              >
                <span style={{ opacity: 0.7 }}>Resolved:</span>
                <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {resolvedUrl.replace(/^https?:\/\//, "")}
                </span>
              </div>
            </SimpleTooltip>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
            {activeTab.protocol !== "websocket" && (
              <>
                <SimpleTooltip content="Import request from cURL command">
                  <button
                    type="button"
                    className={`api-proxy-toggle-btn ${
                      showImportCurl ? "api-proxy-toggle-btn-active" : ""
                    }`}
                    onClick={onToggleImportCurl}
                  >
                    <Terminal className="h-4 w-4" />
                  </button>
                </SimpleTooltip>

                <SimpleTooltip content="Generate code snippet">
                  <button
                    type="button"
                    className={`api-proxy-toggle-btn ${
                      showCodeSnippet ? "api-proxy-toggle-btn-active" : ""
                    }`}
                    onClick={onToggleCodeSnippet}
                  >
                    <Code2 className="h-4 w-4" />
                  </button>
                </SimpleTooltip>

                <div
                  style={{
                    width: "1px",
                    height: "16px",
                    background: "var(--border-1)",
                    margin: "0 4px",
                  }}
                />
              </>
            )}
            {activeTab.protocol !== "websocket" && (
              <SimpleTooltip
                content={
                  activeTab.useProxy
                    ? "CORS Proxy: ENABLED (Bypasses CORS restrictions)"
                    : "CORS Proxy: DISABLED (Direct browser request)"
                }
              >
                <button
                  type="button"
                  className={`api-proxy-toggle-btn ${
                    activeTab.useProxy ? "api-proxy-toggle-btn-active" : ""
                  }`}
                  onClick={() => store.toggleProxy()}
                  style={{
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    padding: "4px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: activeTab.useProxy
                      ? "var(--accent)"
                      : "var(--text-3)",
                    transition: "color 0.2s",
                  }}
                >
                  <Shield className="h-4 w-4" />
                </button>
              </SimpleTooltip>
            )}
          </div>
        </div>
      </div>

      <div className="api-url-actions">
        {activeTab.sseActive && (
          <div className="api-sse-pulse-badge" style={{ marginRight: "8px" }}>
            <Zap className="h-3 w-3 text-accent animate-pulse" />
            <span>SSE Stream Active</span>
          </div>
        )}

        {activeTab.protocol === "websocket" ? (
          <button
            type="button"
            className={`api-send-btn ${
              activeTab.wsConnected ? "api-send-btn-ws-connected" : ""
            } ${activeTab.loading ? "api-send-btn-loading" : ""}`}
            disabled={!activeTab.loading && !activeTab.url.trim()}
            onClick={(e) => {
              if (activeTab.loading || activeTab.wsConnected) {
                e.preventDefault();
                store.disconnectWs();
              } else {
                e.currentTarget.form?.requestSubmit();
              }
            }}
          >
            {activeTab.loading ? (
              <>
                <Square className="h-4 w-4 text-red animate-pulse" />
                <span>Cancel</span>
              </>
            ) : activeTab.wsConnected ? (
              <>
                <WifiOff className="h-4 w-4" />
                <span>Disconnect</span>
              </>
            ) : (
              <>
                <Wifi className="h-4 w-4" />
                <span>Connect</span>
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            className={`api-send-btn ${
              activeTab.loading || activeTab.sseActive
                ? "api-send-btn-loading"
                : ""
            }`}
            disabled={
              !activeTab.loading && !activeTab.sseActive && !activeTab.url.trim()
            }
            onClick={(e) => {
              if (activeTab.loading || activeTab.sseActive) {
                e.preventDefault();
                store.stopActiveRequest(activeTab.id);
              } else {
                e.currentTarget.form?.requestSubmit();
              }
            }}
          >
            {activeTab.loading || activeTab.sseActive ? (
              <>
                <Square className="h-4 w-4 text-red animate-pulse" />
                <span>Cancel</span>
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                <span>Send</span>
                <span className="api-send-shortcut">
                  {isMac ? "⌘↵" : "Ctrl+Enter"}
                </span>
              </>
            )}
          </button>
        )}
      </div>
    </form>
  );
}
