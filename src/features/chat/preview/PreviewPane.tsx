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
  AlertTriangle,
  ChevronDown,
  Eraser,
  ExternalLink,
  Loader2,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  Smartphone,
  Terminal,
  Undo2,
  X,
} from "lucide-react";
import { usePreviewStore } from "./preview.store";
import type { PreviewConsoleEntry } from "./preview.store";
import { useChatStore } from "@/stores/chat.store";
import { undoLastWorkspaceMutation } from "../services/agent-actions";
import { runPreviewBuild } from "./preview-runtime";
import { setPreviewCss } from "./preview-bridge";
import { isHostedPreviewUrl } from "./host/preview-host-client";

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
  const html = usePreviewStore((s) => s.html);
  const url = usePreviewStore((s) => s.url);
  const entry = usePreviewStore((s) => s.entry);
  const diagnostics = usePreviewStore((s) => s.diagnostics);
  const consoleEntries = usePreviewStore((s) => s.console);
  const jsHash = usePreviewStore((s) => s.jsHash);
  const css = usePreviewStore((s) => s.css);
  const delivery = usePreviewStore((s) => s.delivery);
  const deliveryNotice = usePreviewStore((s) => s.deliveryNotice);
  const setRuntimeReady = usePreviewStore((s) => s.setRuntimeReady);
  // `buildId` is deliberately no longer the frame's key: it bumps on every
  // build, including CSS-only ones that must NOT reload the app.

  const [viewMode, setViewMode] = React.useState<"desktop" | "mobile">("desktop");
  const [drawerOpenUser, setDrawerOpen] = React.useState(false);
  /**
   * Live updates can be paused while the agent works. Watching an app
   * reload five times during one edit is worse than watching it once, and
   * a paused preview keeps whatever state the user was inspecting.
   */
  const [autoUpdate, setAutoUpdate] = React.useState(true);
  /**
   * The document the FRAME was mounted with, and the JS it was built from.
   *
   * The iframe is driven by `srcDoc` (or by `src` when the build was
   * published to a preview host), so replacing either reloads the frame.
   * Holding the document in state and only replacing it on an intentional
   * remount is what lets a CSS-only rebuild reach a running app without
   * restarting it.
   */
  const [frameDoc, setFrameDoc] = React.useState<string | null>(null);
  const [frameUrl, setFrameUrl] = React.useState<string | null>(null);
  const [frameKey, setFrameKey] = React.useState(0);
  const mountedJsHash = React.useRef<string | null>(null);
  /** The conversation the FRAME currently shows (see the remount rule) */
  const mountedFor = React.useRef<string | null>(null);

  // Effect-log undo: enabled while the active conversation's
  // workspace has at least one restorable agent mutation.
  const conversationId = usePreviewStore((s) => s.conversationId);
  const mutations = useChatStore((s) =>
    conversationId ? s.workspaces[conversationId]?.mutations : undefined
  );
  const canUndo = Boolean(mutations?.length);
  const workspace = useChatStore((s) =>
    conversationId ? s.workspaces[conversationId] : undefined
  );

  // Opening this pane is the user asking to SEE the app. A build that
  // never produced a document (idle) or that failed on a transient error
  // leaves the pane explaining a failure the user cannot act on — so one
  // rebuild is attempted per open. Guarded by a ref, because a build that
  // fails again would otherwise retry forever on every status change.
  const rebuiltFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!conversationId || !workspace) return;
    if (status === "ready" || status === "building" || status === "unsupported") return;
    if (rebuiltFor.current === conversationId) return;
    rebuiltFor.current = conversationId;
    void runPreviewBuild(workspace);
  }, [conversationId, workspace, status]);

  /**
   * Decides what a finished build does to the running frame:
   *
   *   • first build, or different JS  → remount (the app must reload)
   *   • same JS, different CSS       → inject the new stylesheet in place,
   *                                   so the app keeps its state
   *   • updates paused               → do nothing until asked
   *
   * Before this, every rebuild bumped the frame's key and restarted the
   * app — which is why the preview read as "it does not run in realtime":
   * it was reloading on every file the agent touched.
   */
  React.useEffect(() => {
    if (status !== "ready" || !html) return;
    if (!autoUpdate) return;

    // The URL decides HOW the document reaches the frame: a published build
    // navigates to its own origin, a fallback build is parsed in place. It
    // is read from the store per build, so starting the host mid-session is
    // picked up by the next rebuild instead of needing a page reload.
    const hostedUrl = isHostedPreviewUrl(url) ? url : null;

    const mounted = mountedJsHash.current;
    // A DIFFERENT CONVERSATION is a different document, even when the JS
    // hash matches — two chats can be on the same app. Comparing only the
    // hash meant that switching threads left the previous thread's app
    // mounted, which with a per-thread cache is now the common case rather
    // than an edge one.
    if (mountedFor.current !== conversationId) {
      mountedFor.current = conversationId;
      mountedJsHash.current = jsHash;
      setFrameDoc(html);
      setFrameUrl(hostedUrl);
      setFrameKey((k) => k + 1);
      return;
    }
    if (mounted === null) {
      mountedJsHash.current = jsHash;
      setFrameDoc(html);
      setFrameUrl(hostedUrl);
      setFrameKey((k) => k + 1);
      return;
    }
    if (mounted !== jsHash) {
      mountedJsHash.current = jsHash;
      setFrameDoc(html);
      setFrameUrl(hostedUrl);
      setFrameKey((k) => k + 1);
      return;
    }
    // Same JS: a stylesheet-only change. Swap it into the live document.
    void setPreviewCss(css);
  }, [status, html, jsHash, css, autoUpdate, url, conversationId]);

  // Closing the pane no longer releases the published document, and that is
  // deliberate: builds are cached PER CONVERSATION now, so reopening the pane
  // reuses the build it already has — releasing on unmount would leave that
  // cached URL pointing at a document the host had thrown away, and the frame
  // would come back as a 404. Each thread's rebuild releases its own
  // predecessor, and the host evicts the oldest previews past its limit, so
  // nothing accumulates.

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
        {/*
          * Which delivery path this build took, in the header rather than
          * buried in the console. It is the difference that matters: a SERVED
          * build is on its own origin, so storage, cookies and the app's
          * router work; a SANDBOXED one is the isolated fallback, where a
          * router has no path to match and state resets on every rebuild.
          * Reading "Sandboxed" here is a complete explanation of most
          * "the preview is broken" reports.
          */}
        <span
          className={`chat-preview-badge chat-preview-badge-${delivery === "hosted" ? "ready" : "idle"}`}
          title={
            deliveryNotice ??
            (delivery === "hosted"
              ? "Served from its own origin — storage, cookies, Web Locks and routing work."
              : "Runs as an inline sandboxed document.")
          }
        >
          {delivery === "hosted" ? "Served" : "Sandboxed"}
        </span>
        <div className="chat-preview-actions">
          <button
            type="button"
            className={`toolbar-icon-btn ${autoUpdate ? "" : "active"}`}
            onClick={() => {
              const next = !autoUpdate;
              setAutoUpdate(next);
              if (next && workspace) void runPreviewBuild(workspace);
            }}
            title={
              autoUpdate
                ? "Pause live updates (keeps the app's current state)"
                : "Resume live updates"
            }
            aria-label={autoUpdate ? "Pause live updates" : "Resume live updates"}
            aria-pressed={!autoUpdate}
          >
            {autoUpdate ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            className="toolbar-icon-btn"
            onClick={() => {
              // Forced: this button exists to be pressed when the frame is
              // wrong, and "wrong" includes a build that reported success.
              if (workspace) void runPreviewBuild(workspace, { force: true });
            }}
            disabled={!workspace || status === "building"}
            title="Rebuild now (always runs, even if nothing changed)"
            aria-label="Rebuild the preview now"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${status === "building" ? "spin" : ""}`} />
          </button>
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

      {/*
        * The fallback path, said out loud.
        *
        * A sandboxed preview is not "a broken app" — it is a document with
        * no origin, so the app's router has no path to match, storage resets
        * on every rebuild, and nothing the agent writes can change either.
        * A badge alone let that land as "the preview is broken", which is how
        * it was reported for three rounds while the pane reported success.
        */}
      {status === "ready" && delivery === "inline" && (
        <div className="chat-preview-warn" role="status">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          <span>
            <strong>Sandboxed preview.</strong> This build has no origin of its own, so
            in-app navigation and storage will not work.{" "}
            {deliveryNotice}
          </span>
        </div>
      )}

      <div className={`chat-preview-body ${viewMode === "mobile" ? "chat-preview-body-mobile" : ""}`}>
        {status === "ready" && (frameDoc ?? html) ? (
          <iframe
            key={frameKey}
            className="chat-preview-frame"
            // A HOSTED frame deliberately gets no `sandbox` attribute. Its
            // own origin is what makes storage, cookies and locks work, and
            // a parent `sandbox` without `allow-same-origin` strips that
            // origin away — recreating the exact problem the host exists to
            // solve. The host's own policy carries
            // `sandbox allow-same-origin`, so the preview keeps its origin
            // while top-level navigation stays denied.
            {...(frameUrl
              ? { src: frameUrl, allow: "geolocation; camera; microphone" }
              : {
                  sandbox: "allow-scripts allow-modals allow-forms allow-popups",
                  srcDoc: frameDoc ?? html ?? "",
                })}
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
