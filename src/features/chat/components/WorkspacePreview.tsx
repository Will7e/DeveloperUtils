// ============================================================
// Workspace Preview — The App, Running, In The Workspace Panel
// ============================================================
// The dev server the harness started, docked as a tab of the right-hand
// panel and dressed like a browser, because a preview the user is asked
// to judge their app in has to behave like the place their app will
// actually be judged: a real viewport.
//
// What "like a browser" means here, and what deliberately does not:
//
//   • DEVICE MODES. Responsive fills the pane; Desktop/Tablet/Mobile render
//     the page at a fixed CSS width (1280/768/390) scaled to fit, so the
//     layout the page chooses at 390px is the layout a phone gets — not a
//     reflow of whatever width the panel happens to be. A ResizeObserver
//     keeps the scale honest while the user drags the pane divider.
//   • URL BAR + BACK/FORWARD. The bar shows where the frame is and accepts
//     edits: an absolute URL, a bare host, or a path resolved against the
//     preview origin. Back/forward walk a stack of the URLs the user has
//     navigated to (or typed). It is NOT full browser history: a link
//     clicked inside the frame is cross-origin and invisible from here, so
//     the stack only ever holds navigations this surface made itself. A
//     history that claims more than it can see would be a lie with buttons.
//   • RELOAD, re-keying the iframe (the dev server hot-reloads on its own;
//     this is for the cases it cannot see), and open-in-new-tab for the
//     full-window pass.
//
// Two things this surface still says that chrome cannot:
//
//   • WHICH REVISION IT IS SHOWING. A preview is the only evidence in this
//     product about the running app, and a preview up since before the last
//     edit is evidence about older code. The repo and the command ride in
//     the header; an archived (not-live) record says so, with its age.
//   • WHAT THE CONSOLE SAID. The runtime forwards the preview's errors to
//     the app (`preview-message`), which is the difference between "it
//     builds" and "it works" — listed underneath, where the person looking
//     at a broken page will see the exception that broke it.
// ============================================================

import React from "react";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Maximize2,
  Monitor,
  RotateCw,
  Smartphone,
  Tablet,
} from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { previewViewAgeMs, previewViewIsLive } from "../container/preview-bridge";
import { usePreview } from "./useWorkspace";

/** The viewport modes the device row offers */
export type PreviewViewportMode = "responsive" | "desktop" | "tablet" | "mobile";

/** Device widths, in CSS px, for the fixed emulation modes */
const VIEWPORT_WIDTHS: Record<Exclude<PreviewViewportMode, "responsive">, number> = {
  desktop: 1280,
  tablet: 768,
  mobile: 390,
};

interface WorkspacePreviewProps {
  /** The repo the viewed session belongs to ("owner/repo"), for the header */
  repoKey: string | null;
}

/** Coarse age for the archived-session note — prose precision, not a stopwatch */
function describeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d`;
}

/** Resolves a URL-bar edit to a URL, or null when it cannot be one */
function resolveUrlInput(raw: string, base: string | null): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  // A bare host ("localhost:4173", "example.com/x") gets the scheme it
  // obviously means; anything else is a path on the preview's own origin.
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?)/.test(value)) return `https://${value}`;
  if (base) {
    try {
      return new URL(value.startsWith("/") ? value : `/${value}`, base).toString();
    } catch {
      return null;
    }
  }
  return null;
}

export function WorkspacePreview({ repoKey }: WorkspacePreviewProps) {
  const preview = usePreview();
  // Ticking only while an ARCHIVED record is on screen: its age is part of the
  // claim it makes (a failure from yesterday is a different reason to retry than
  // one from a minute ago). A minute step is enough — this is prose, not a stopwatch.
  const archived = !previewViewIsLive();
  const [, setAgeTick] = React.useState(0);
  React.useEffect(() => {
    if (!archived) return;
    const timer = window.setInterval(() => setAgeTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [archived]);

  // The URL stack this surface has navigated to itself (typed, or resolved
  // from an edit): index 0 is the dev server's root. Back/forward move a
  // cursor over it; a NEW server url (a restart) is a new origin and resets
  // the stack — entries pointing at a dead origin are not history, they are
  // errors waiting to be displayed.
  const [history, setHistory] = React.useState<string[]>([]);
  const [cursor, setCursor] = React.useState(-1);
  const [draftUrl, setDraftUrl] = React.useState("");
  const [editingUrl, setEditingUrl] = React.useState(false);
  // Bumped to reload the iframe on demand.
  const [reloadKey, setReloadKey] = React.useState(0);
  const [viewport, setViewport] = React.useState<PreviewViewportMode>("responsive");

  const url = preview.status === "running" ? preview.url ?? null : null;
  React.useEffect(() => {
    setHistory(url ? [url] : []);
    setCursor(url ? 0 : -1);
    setDraftUrl(url ?? "");
    setEditingUrl(false);
  }, [url]);

  const currentUrl = history[cursor] ?? url ?? null;
  const canBack = cursor > 0;
  const canForward = cursor >= 0 && cursor < history.length - 1;
  // The frame renders the cursor's URL — remounting on it (via key) is what
  // makes back/forward real for a cross-origin frame we cannot script.
  const frameSrc = currentUrl ?? undefined;

  const pushUrl = (next: string) => {
    setHistory((prev) => [...prev.slice(0, cursor + 1), next]);
    setCursor((c) => c + 1);
  };

  const submitUrl = (event: React.FormEvent) => {
    event.preventDefault();
    const next = resolveUrlInput(draftUrl, currentUrl);
    if (!next) return;
    setEditingUrl(false);
    if (next !== currentUrl) pushUrl(next);
  };

  // ── Device-mode scaling ──
  // A fixed-width page must render AT that width, then be scaled to the pane —
  // constraining the iframe's width instead would make the page reflow and
  // answer a question the user did not ask. The scale is the pane's current
  // width over the device width, re-read while the divider is dragged.
  const viewportOuterRef = React.useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = React.useState(1);
  const fixedWidth = viewport === "responsive" ? null : VIEWPORT_WIDTHS[viewport];
  React.useEffect(() => {
    if (fixedWidth === null) {
      setScale(1);
      return;
    }
    const outer = viewportOuterRef.current;
    if (!outer) return;
    const update = () => {
      const width = outer.clientWidth;
      if (width > 0) setScale(Math.min(1, width / fixedWidth));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [fixedWidth]);

  const failed = preview.status === "failed";
  const running = preview.status === "running" && Boolean(preview.url);
  const changedAt = previewViewAgeMs();
  const ageNote =
    archived && changedAt !== null ? ` — last activity ${describeAge(Date.now() - changedAt)} ago` : "";

  return (
    <div className="chat-preview" aria-label="Live preview of the workspace">
      <header className="chat-preview-header">
        <span className="chat-preview-title">
          {running ? "Live preview" : failed ? "Preview failed" : "Preview"}
        </span>
        {/* Which repo's session this is: the records are per-repo, and a panel
            that does not say whose it is invites the exact misreading the
            sessions were built to end. */}
        {repoKey && <span className="chat-preview-repo">{repoKey}</span>}
        {preview.command && <span className="chat-preview-command">{preview.command}</span>}
      </header>

      {running ? (
        <>
          {/* ── Browser chrome, one compact row: back / forward / reload ·
              URL · viewport · open. The device picker is icon-only and lives
              here rather than in its own row: three stacked bars cost the
              preview a third of its height before the page rendered at all. ── */}
          <div className="chat-preview-chrome">
            <div className="chat-preview-nav">
              <SimpleTooltip content={canBack ? "Back" : "Nothing to go back to"} side="bottom">
                <button
                  type="button"
                  className="chat-preview-action"
                  onClick={() => setCursor((c) => Math.max(0, c - 1))}
                  disabled={!canBack}
                  aria-label="Back"
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </SimpleTooltip>
              <SimpleTooltip content={canForward ? "Forward" : "Nothing to go forward to"} side="bottom">
                <button
                  type="button"
                  className="chat-preview-action"
                  onClick={() => setCursor((c) => Math.min(history.length - 1, c + 1))}
                  disabled={!canForward}
                  aria-label="Forward"
                >
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </SimpleTooltip>
              <SimpleTooltip content="Reload the preview" side="bottom">
                <button
                  type="button"
                  className="chat-preview-action"
                  onClick={() => setReloadKey((key) => key + 1)}
                  aria-label="Reload the preview"
                >
                  <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </SimpleTooltip>
            </div>
            {/* The address bar: shows where the frame is, and takes edits —
                an absolute URL, a bare host, or a path on the preview origin. */}
            <form className="chat-preview-urlbox" onSubmit={submitUrl} role="search">
              <input
                className="chat-preview-url"
                value={editingUrl ? draftUrl : currentUrl ?? ""}
                onChange={(event) => {
                  setEditingUrl(true);
                  setDraftUrl(event.target.value);
                }}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={() => setEditingUrl(false)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setEditingUrl(false);
                    setDraftUrl(currentUrl ?? "");
                    event.currentTarget.blur();
                  }
                }}
                spellCheck={false}
                autoComplete="off"
                aria-label="Preview URL"
                placeholder="Preview URL"
              />
            </form>
            {/* Device modes as a compact icon segment — the labels were the
                widest thing on the bar, and each icon already has a tooltip
                and an aria-label saying what it picks. */}
            <div className="chat-preview-devicebar" role="group" aria-label="Viewport size">
              <SimpleTooltip content="Responsive — fill the pane" side="bottom">
                <button
                  type="button"
                  className={`chat-preview-device ${viewport === "responsive" ? "chat-preview-device-active" : ""}`}
                  onClick={() => setViewport("responsive")}
                  aria-pressed={viewport === "responsive"}
                  aria-label="Responsive — fill the pane"
                >
                  <Maximize2 className="h-3 w-3" aria-hidden="true" />
                </button>
              </SimpleTooltip>
              <SimpleTooltip content="Desktop — 1280px, scaled to fit" side="bottom">
                <button
                  type="button"
                  className={`chat-preview-device ${viewport === "desktop" ? "chat-preview-device-active" : ""}`}
                  onClick={() => setViewport("desktop")}
                  aria-pressed={viewport === "desktop"}
                  aria-label="Desktop — 1280px, scaled to fit"
                >
                  <Monitor className="h-3 w-3" aria-hidden="true" />
                </button>
              </SimpleTooltip>
              <SimpleTooltip content="Tablet — 768px, scaled to fit" side="bottom">
                <button
                  type="button"
                  className={`chat-preview-device ${viewport === "tablet" ? "chat-preview-device-active" : ""}`}
                  onClick={() => setViewport("tablet")}
                  aria-pressed={viewport === "tablet"}
                  aria-label="Tablet — 768px, scaled to fit"
                >
                  <Tablet className="h-3 w-3" aria-hidden="true" />
                </button>
              </SimpleTooltip>
              <SimpleTooltip content="Mobile — 390px, scaled to fit" side="bottom">
                <button
                  type="button"
                  className={`chat-preview-device ${viewport === "mobile" ? "chat-preview-device-active" : ""}`}
                  onClick={() => setViewport("mobile")}
                  aria-pressed={viewport === "mobile"}
                  aria-label="Mobile — 390px, scaled to fit"
                >
                  <Smartphone className="h-3 w-3" aria-hidden="true" />
                </button>
              </SimpleTooltip>
            </div>
            {currentUrl && (
              <SimpleTooltip content="Open the preview in a new tab" side="bottom">
                <a
                  className="chat-preview-action"
                  href={currentUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open the preview in a new tab"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </SimpleTooltip>
            )}
          </div>

          {/* The page itself, at the width the mode chose. The iframe keeps the
              `chat-preview-frame` class: the agent's preview-control channel
              finds the frame by that selector, so renaming it would silently
              break `snapshot` and friends. */}
          <div className="chat-preview-viewport-outer" ref={viewportOuterRef}>
            <div
              className={`chat-preview-viewport ${fixedWidth === null ? "chat-preview-viewport-fill" : ""}`}
              style={
                fixedWidth === null
                  ? undefined
                  : {
                      width: fixedWidth,
                      transform: `scale(${scale})`,
                      height: `${100 / scale}%`,
                    }
              }
            >
              <iframe
                key={`${reloadKey}-${frameSrc ?? "none"}`}
                className="chat-preview-frame"
                src={frameSrc}
                title="Workspace preview"
                // Same sandbox reasoning as the file preview: the page is the user's own
                // code running against their own dev server, and it has no business
                // reaching this app's storage or top-level frame.
                sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
              />
            </div>
          </div>
        </>
      ) : (
        <div className="chat-preview-body">
          {failed ? (
            <>
              <p className="chat-preview-line chat-preview-line-warn">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                {preview.notes[0] ?? "The dev server did not start."}
              </p>
              {preview.notes.slice(1).map((note, index) => (
                <pre key={index} className="chat-preview-output">
                  {note}
                </pre>
              ))}
            </>
          ) : (
            <p className="chat-preview-line">
              {preview.status === "starting"
                ? "Starting the dev server…"
                : "No preview is running. Start one from the workspace line above the composer."}
            </p>
          )}
        </div>
      )}

      {/* An archived session shown while another repo's server is live: the
          panel says so — and how stale the record is — or a "running" record
          reads as if it were the live server, the one misreading the per-repo
          sessions exist to end. */}
      {!running && !previewViewIsLive() && (
        <div className="chat-preview-archived" role="note">
          <Archive className="h-3 w-3" aria-hidden="true" />
          <span>
            Archived session{ageNote} — another repo's preview is live in this
            tab. Start this repo's from the workspace strip to make it live.
          </span>
        </div>
      )}

      {preview.issues.length > 0 && (
        <div className="chat-preview-console" role="log" aria-label="Preview console">
          {preview.issues.slice(-6).map((issue, index) => (
            <p key={`${issue.at}-${index}`} className="chat-preview-issue">
              <span className="chat-preview-issue-kind">{issue.kind}</span>
              <span className="chat-preview-issue-text">{issue.message.split("\n")[0]}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
