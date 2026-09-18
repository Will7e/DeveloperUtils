import { useEffect, useRef } from "react";
import { Activity, Wifi, WifiOff } from "lucide-react";
import type { WsMessage } from "@/stores/api-tester.store";

interface WebSocketConsoleProps {
  wsMessages: WsMessage[];
  wsConnected: boolean;
  onClearLogs: () => void;
}

export function WebSocketConsole({
  wsMessages,
  wsConnected,
  onClearLogs,
}: WebSocketConsoleProps) {
  const wsConsoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (wsConsoleRef.current) {
      wsConsoleRef.current.scrollTop = wsConsoleRef.current.scrollHeight;
    }
  }, [wsMessages]);

  return (
    <div
      className="api-ws-console-container"
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        overflow: "hidden",
        padding: "12px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "8px",
          borderBottom: "1px solid var(--border-1)",
          paddingBottom: "6px",
        }}
      >
        <span
          style={{
            fontSize: "12px",
            fontWeight: 600,
            color: "var(--text-2)",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <Activity className="h-3.5 w-3.5 text-accent" />
          Connection Console Stream ({wsMessages.length} messages)
        </span>
        <div style={{ display: "flex", gap: "6px" }}>
          <button
            type="button"
            className="api-clear-btn"
            onClick={onClearLogs}
            disabled={wsMessages.length === 0}
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
          gap: "6px",
        }}
      >
        {wsMessages.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--text-3)",
              gap: "8px",
            }}
          >
            {wsConnected ? (
              <Wifi className="h-8 w-8 text-green opacity-40 animate-pulse" />
            ) : (
              <WifiOff className="h-8 w-8 opacity-25" />
            )}
            <span>
              {wsConnected
                ? "Connected! Send a message from the Request pane to start testing."
                : "Console is empty. Connect to a WebSocket endpoint to stream messages."}
            </span>
          </div>
        ) : (
          wsMessages.map((msg) => {
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
                  paddingBottom: "4px",
                }}
              >
                <span style={{ color: "var(--text-3)" }}>
                  [{new Date(msg.timestamp).toLocaleTimeString()}]
                </span>
                <span style={{ color: typeColor, fontWeight: 700 }}>
                  {typeLabel}
                </span>
                <span
                  style={{
                    color: "var(--text-1)",
                    flex: 1,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {msg.text}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
