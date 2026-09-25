// ============================================================
// Workspace Preview — The App, Running, Beside The Diff
// ============================================================
// The dev server the harness started, in an iframe, updating as the agent writes
// files (the file-write bridge feeds hot reload, so nothing here has to poll).
//
// Two things this panel says that a bare iframe cannot:
//
//   • WHICH REVISION IT IS SHOWING. A preview is the only evidence in this
//     product about the running app, and a preview that has been up since before
//     the last edit is evidence about older code. The revision rides in the
//     header rather than being implied.
//   • WHAT THE CONSOLE SAID. The runtime forwards the preview's errors to the
//     app (`preview-message`), which is the difference between "it builds" and
//     "it works" — so they are listed underneath, where the person looking at a
//     broken page will see the exception that broke it.
//
// A failure to START is shown here too, with the server's own output: "the
// preview did not start" without the reason sends the reader to guess, and a dev
// server always has a reason.
// ============================================================

import React from "react";
import { AlertTriangle, Archive, RefreshCw, X } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { previewViewAgeMs, previewViewIsLive } from "../container/preview-bridge";
import { usePreview } from "./useWorkspace";

interface WorkspacePreviewProps {
  open: boolean;
  onClose: () => void;
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

export function WorkspacePreview({ open, onClose, repoKey }: WorkspacePreviewProps) {
  const preview = usePreview();
  // Ticking only while an ARCHIVED record is on screen: its age is part of the
  // claim it makes (a failure from yesterday is a different reason to retry than
  // one from a minute ago), and a live preview's age is already on the clock
  // the strip keeps. A minute step is enough — this is prose, not a stopwatch.
  const archived = !previewViewIsLive();
  const [, setAgeTick] = React.useState(0);
  React.useEffect(() => {
    if (!open || !archived) return;
    const timer = window.setInterval(() => setAgeTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [open, archived]);
  // Bumped to reload the iframe on demand: the dev server hot-reloads on its own,
  // and this is for the cases it cannot see (a full-page state, a stuck socket).
  const [reloadKey, setReloadKey] = React.useState(0);

  if (!open) return null;

  const failed = preview.status === "failed";
  const running = preview.status === "running" && preview.url;
  const changedAt = previewViewAgeMs();
  const ageNote =
    archived && changedAt !== null ? ` — last activity ${describeAge(Date.now() - changedAt)} ago` : "";

  return (
    <aside className="chat-preview" aria-label="Live preview of the workspace">
      <header className="chat-preview-header">
        <span className="chat-preview-title">
          {running ? "Live preview" : failed ? "Preview failed" : "Preview"}
        </span>
        {/* Which repo's session this is: the records are per-repo, and a panel
            that does not say whose it is invites the exact misreading the
            sessions were built to end. */}
        {repoKey && <span className="chat-preview-repo">{repoKey}</span>}
        {preview.command && <span className="chat-preview-command">{preview.command}</span>}
        <span className="chat-preview-actions">
          {running && (
            <SimpleTooltip content="Reload the preview" side="bottom">
              <button
                type="button"
                className="chat-preview-action"
                onClick={() => setReloadKey((key) => key + 1)}
                aria-label="Reload the preview"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </SimpleTooltip>
          )}
          {/* Icon-only, so it needs a name as well as a tooltip: the tooltip is
              for a person with a pointer, the label is for everyone else. */}
          <SimpleTooltip content="Close the preview" side="bottom">
            <button
              type="button"
              className="chat-preview-action"
              onClick={onClose}
              aria-label="Close the preview"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </SimpleTooltip>
        </span>
      </header>

      {running ? (
        <iframe
          key={reloadKey}
          className="chat-preview-frame"
          src={preview.url ?? undefined}
          title="Workspace preview"
          // Same sandbox reasoning as the file preview: the page is the user's own
          // code running against their own dev server, and it has no business
          // reaching this app's storage or top-level frame.
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
        />
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
    </aside>
  );
}
