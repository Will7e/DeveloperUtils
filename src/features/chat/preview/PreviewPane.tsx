// ============================================================
// PreviewPane — Realtime Workspace Preview in Chat
// ============================================================
// Right-hand resizable panel: renders the built workspace bundle in
// a sandboxed iframe, shows build status + esbuild diagnostics,
// and a console drawer fed by the preview bridge. Rebuilds are
// triggered by the chat runner after write_file tool results land.

import React from "react";
import {
  AlertCircle,
  ChevronDown,
  Eraser,
  ExternalLink,
  Loader2,
  Monitor,
  Smartphone,
  Terminal,
  Undo2,
  X,
} from "lucide-react";
import { usePreviewStore } from "./preview.store";
import type { PreviewConsoleEntry } from "./preview.store";
import { useChatStore } from "@/stores/chat.store";
import { undoLastWorkspaceMutation } from "../services/agent-actions";

interface PreviewPaneProps {
  onClose: () => void;
  /** Force-open state so a failed build auto-expands the drawer */
  drawerOpenOverride?: boolean;
}

export const PreviewPane = React.memo(function PreviewPane({
  onClose,
  drawerOpenOverride,
}: PreviewPaneProps) {
  const status = usePreviewStore((s) => s.status);
  const url = usePreviewStore((s) => s.url);
  const entry = usePreviewStore((s) => s.entry);
  const diagnostics = usePreviewStore((s) => s.diagnostics);
  const consoleEntries = usePreviewStore((s) => s.console);
  const buildId = usePreviewStore((s) => s.buildId);
  const setRuntimeReady = usePreviewStore((s) => s.setRuntimeReady);

  const [viewMode, setViewMode] = React.useState<"desktop" | "mobile">("desktop");
  const [drawerOpenUser, setDrawerOpen] = React.useState(false);

  // Effect-log undo: enabled while the active conversation's
  // workspace has at least one restorable agent mutation.
  const conversationId = usePreviewStore((s) => s.conversationId);
  const mutations = useChatStore((s) =>
    conversationId ? s.workspaces[conversationId]?.mutations : undefined
  );
  const canUndo = Boolean(mutations?.length);

  const consoleErrors = consoleEntries.filter((e) => e.level === "error").length;
  const shouldAutoOpen = status === "error" && diagnostics.length > 0;
  const drawerOpen = drawerOpenOverride === undefined ? drawerOpenUser || shouldAutoOpen : drawerOpenOverride;

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  void errorCount;

  return (
    <div className="chat-preview" role="complementary" aria-label="Live preview">
      <div className="chat-preview-header">
        <span className="chat-preview-title">
          {status === "building" && <Loader2 className="h-3.5 w-3.5 spin" aria-hidden="true" />}
          {status === "error" && <AlertCircle className="h-3.5 w-3.5 chat-preview-err-icon" aria-hidden="true" />}
          Live Preview
        </span>
        {entry && <span className="chat-preview-entry" title={entry}>{entry}</span>}
        <span className={`chat-preview-badge chat-preview-badge-${status}`}>
          {status === "building" ? "Building" : status === "ready" ? "Ready" : status === "error" ? "Error" : status}
        </span>
        <div className="chat-preview-actions">
          <button
            type="button"
            className="toolbar-icon-btn"
            onClick={() => {
              if (conversationId) void undoLastWorkspaceMutation(conversationId);
            }}
            disabled={!canUndo}
            title={canUndo ? "Undo last agent edit" : "No agent edits to undo"}
            aria-label="Undo last agent edit"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={`toolbar-icon-btn ${viewMode === "mobile" ? "active" : ""}`}
            onClick={() => setViewMode((v) => (v === "desktop" ? "mobile" : "desktop"))}
            title={viewMode === "desktop" ? "Switch to mobile" : "Switch to desktop"}
          >
            {viewMode === "desktop" ? <Smartphone className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            className="toolbar-icon-btn"
            onClick={() => setDrawerOpen((v) => !v)}
            title="Toggle console"
          >
            <Terminal className="h-3.5 w-3.5" />
            {consoleErrors > 0 && <span className="chat-preview-badge-count">{consoleErrors}</span>}
          </button>
          <button type="button" className="toolbar-icon-btn" onClick={onClose} title="Close preview">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className={`chat-preview-body ${viewMode === "mobile" ? "chat-preview-body-mobile" : ""}`}>
        {status === "ready" && url ? (
          <iframe
            key={buildId}
            className="chat-preview-frame"
            sandbox="allow-scripts allow-modals allow-forms allow-popups"
            src={url}
            title="Live preview"
            onLoad={() => setRuntimeReady(true)}
          />
        ) : status === "building" ? (
          <div className="chat-preview-placeholder">
            <Loader2 className="h-5 w-5 spin" aria-hidden="true" />
            <span>Bundling workspace…</span>
          </div>
        ) : (
          <div className="chat-preview-placeholder">
            <AlertCircle className="h-5 w-5" aria-hidden="true" />
            <span>
              {status === "idle"
                ? "Preview builds after the agent edits files."
                : status === "unsupported"
                  ? "WebAssembly is unavailable in this browser."
                  : "Build failed — see diagnostics below."}
            </span>
          </div>
        )}
      </div>

      {drawerOpen && (
        <div className="chat-preview-drawer">
          <div className="chat-preview-drawer-header">
            <span>Diagnostics &amp; Console</span>
            <div className="chat-preview-actions">
              <button
                type="button"
                className="toolbar-icon-btn"
                onClick={() => usePreviewStore.getState().clearConsole()}
                title="Clear console"
              >
                <Eraser className="h-3.5 w-3.5" />
              </button>
              {url && (
                <a className="toolbar-icon-btn" href={url} target="_blank" rel="noreferrer" title="Open in new tab">
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              <button type="button" className="toolbar-icon-btn" onClick={() => setDrawerOpen(false)} title="Collapse">
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {diagnostics.length > 0 && (
            <div className="chat-preview-diagnostics">
              {diagnostics.map((d, i) => (
                <div key={i} className="chat-preview-diag chat-preview-diag-err">
                  <span className="chat-preview-diag-file">
                    {d.file ? `${d.file}${d.line ? `:${d.line}` : ""}` : "build"}
                  </span>
                  <pre>{d.message}</pre>
                </div>
              ))}
            </div>
          )}
          <div className="chat-preview-console">
            {consoleEntries.length === 0 ? (
              <div className="chat-preview-note">Console output from the preview appears here.</div>
            ) : (
              consoleEntries.map((e) => <ConsoleLine key={e.id} entry={e} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
});

function ConsoleLine({ entry }: { entry: PreviewConsoleEntry }) {
  return (
    <div className={`chat-preview-line chat-preview-line-${entry.level}`}>
      <span className="chat-preview-line-time">
        {new Date(entry.at).toLocaleTimeString([], { hour12: false })}
      </span>
      <pre>{entry.text}</pre>
    </div>
  );
}

// The parent-side bridge listener and refreshPreview live in
// preview-bridge.ts (fast-refresh: this file exports only components).
