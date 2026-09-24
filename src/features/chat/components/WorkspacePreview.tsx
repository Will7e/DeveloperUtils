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
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { usePreview } from "./useWorkspace";

interface WorkspacePreviewProps {
  open: boolean;
  onClose: () => void;
}

export function WorkspacePreview({ open, onClose }: WorkspacePreviewProps) {
  const preview = usePreview();
  // Bumped to reload the iframe on demand: the dev server hot-reloads on its own,
  // and this is for the cases it cannot see (a full-page state, a stuck socket).
  const [reloadKey, setReloadKey] = React.useState(0);

  if (!open) return null;

  const failed = preview.status === "failed";
  const running = preview.status === "running" && preview.url;

  return (
    <aside className="chat-preview" aria-label="Live preview of the workspace">
      <header className="chat-preview-header">
        <span className="chat-preview-title">
          {running ? "Live preview" : failed ? "Preview failed" : "Preview"}
        </span>
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
