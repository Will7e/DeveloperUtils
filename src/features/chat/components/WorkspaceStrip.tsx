// ============================================================
// Workspace Strip — The Browser Workspace, Stated
// ============================================================
// One line, above the composer, saying what this page can actually execute and
// whether the app is running in it. It exists because the tier is INVISIBLE
// otherwise: the agent starts running the project's own commands in the tab the
// moment the page can host them, and a user watching a green "verified" chip has
// no way to know whether the tests ran in a WASM runtime beside them or in a
// daemon they paired last week. Those are different claims about the same diff.
//
// Three deliberate silences, because a strip that speaks on every page is a strip
// people stop reading:
//
//   • NO REPOSITORY — there is no project to run, so there is nothing to say.
//   • A PAGE THAT CANNOT HOST ONE — one subdued line, once, with the fix in its
//     tooltip. On this deployment that is the common case, and the honest reading
//     of it is "commands cannot run here", which the user needs only when they
//     wonder why a change is unverified.
//   • NOTHING RUNNING — the strip stays quiet until something boots or a dev
//     server starts. Booting itself is shown, because several seconds of it are
//     visible waiting otherwise.
// ============================================================

import React from "react";
import { AlertTriangle, Globe, Loader2, Play, RotateCw, Square } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { startPreviewForConversation, stopPreviewForConversation } from "../services/container-workspace";
import { useContainerStatus, usePreview, useWorkspaceCapability } from "./useWorkspace";

interface WorkspaceStripProps {
  conversationId: string | null;
  /** A repository is attached, so there is a project this could run */
  repoAttached: boolean;
  /** Shows/hides the preview panel in the chat surface */
  previewOpen: boolean;
  onTogglePreview: (open: boolean) => void;
}

export function WorkspaceStrip({
  conversationId,
  repoAttached,
  previewOpen,
  onTogglePreview,
}: WorkspaceStripProps) {
  const capability = useWorkspaceCapability();
  const status = useContainerStatus();
  const preview = usePreview();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const start = React.useCallback(async () => {
    if (!conversationId) return;
    setBusy(true);
    setError(null);
    const result = await startPreviewForConversation(conversationId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onTogglePreview(true);
  }, [conversationId, onTogglePreview]);

  if (!repoAttached) return null;

  if (capability.state === "down") {
    return (
      <div className="chat-workspace chat-workspace-muted" role="note">
        <AlertTriangle className="h-3.5 w-3.5 chat-workspace-icon" aria-hidden="true" />
        <span className="chat-workspace-text">
          Commands cannot run in this tab on this page.
        </span>
        {/* Focusable rather than a bare `title`: this is the only place the
            reason is stated, and a hint only a mouse can reach is a hint half of
            the people who need it do not have. */}
        <SimpleTooltip
          content={capability.reason ?? "This page cannot host a browser workspace."}
          side="top"
        >
          <span className="chat-workspace-hint" tabIndex={0} role="note">
            why?
          </span>
        </SimpleTooltip>
      </div>
    );
  }

  const previewLine = describePreview(preview, busy, error, start, onTogglePreview, previewOpen);
  const workspaceLine = describeWorkspace(status);

  if (!previewLine && !workspaceLine) return null;

  return (
    <div className="chat-workspace" role="status" aria-live="polite">
      {workspaceLine}
      {previewLine}
    </div>
  );
}

/** The newest note, without `Array.prototype.at` (this project targets ES2020) */
function lastNote(notes: string[]): string | null {
  return notes.length > 0 ? notes[notes.length - 1]! : null;
}

/** The left half: what the workspace itself is doing */
function describeWorkspace(status: ReturnType<typeof useContainerStatus>): React.ReactNode {
  if (status.state === "booting") {
    return (
      <>
        <Loader2 className="h-3.5 w-3.5 chat-workspace-icon spin" aria-hidden="true" />
        <span className="chat-workspace-text">Starting the browser workspace…</span>
      </>
    );
  }
  if (status.state === "ready") {
    return (
      <>
        <Globe className="h-3.5 w-3.5 chat-workspace-icon" aria-hidden="true" />
        <span className="chat-workspace-text">
          Browser workspace ready
          {status.nodeVersion ? ` (Node ${status.nodeVersion})` : ""}
        </span>
        {status.mountedFiles > 0 && (
          <SimpleTooltip
            content="Files mounted for the revision the last command ran against"
            side="top"
          >
            <span className="chat-workspace-hint" tabIndex={0}>
              {status.mountedFiles} files
            </span>
          </SimpleTooltip>
        )}
      </>
    );
  }
  if (status.state === "failed") {
    return (
      <>
        <AlertTriangle className="h-3.5 w-3.5 chat-workspace-icon chat-workspace-icon-warn" aria-hidden="true" />
        <span className="chat-workspace-text">{status.reason ?? "The browser workspace would not start."}</span>
      </>
    );
  }
  return null;
}

/** The right half: the dev server and the console it produced */
function describePreview(
  preview: ReturnType<typeof usePreview>,
  busy: boolean,
  error: string | null,
  start: () => Promise<void>,
  onTogglePreview: (open: boolean) => void,
  previewOpen: boolean
): React.ReactNode {
  const issues = preview.issues.length;
  const issueChip =
    issues > 0 ? (
      <SimpleTooltip content="Runtime problems reported by the preview" side="top">
        <button
          type="button"
          className="chat-workspace-chip chat-workspace-chip-warn"
          onClick={() => onTogglePreview(true)}
          aria-label={`Show ${issues} runtime problem${issues === 1 ? "" : "s"} reported by the preview`}
        >
          {issues} console error{issues === 1 ? "" : "s"}
        </button>
      </SimpleTooltip>
    ) : null;

  if (preview.status === "starting" || busy) {
    return (
      <span className="chat-workspace-right">
        <Loader2 className="h-3.5 w-3.5 chat-workspace-icon spin" aria-hidden="true" />
        <span className="chat-workspace-text">Starting the dev server…</span>
      </span>
    );
  }

  if (preview.status === "running") {
    return (
      <span className="chat-workspace-right">
        <span className="chat-workspace-text">
          Preview live{preview.command ? ` (${preview.command})` : ""}
        </span>
        {issueChip}
        <button
          type="button"
          className="chat-workspace-action"
          onClick={() => onTogglePreview(!previewOpen)}
        >
          <Globe className="h-3 w-3" aria-hidden="true" />
          {previewOpen ? "Hide" : "Show"}
        </button>
        <SimpleTooltip
          content="Restart the dev server — needed after a dependency or config change"
          side="top"
        >
          <button type="button" className="chat-workspace-action" onClick={() => void start()}>
            <RotateCw className="h-3 w-3" aria-hidden="true" />
            Restart
          </button>
        </SimpleTooltip>
        <button type="button" className="chat-workspace-action" onClick={stopPreviewForConversation}>
          <Square className="h-3 w-3" aria-hidden="true" />
          Stop
        </button>
      </span>
    );
  }

  if (preview.status === "failed") {
    return (
      <span className="chat-workspace-right">
        <AlertTriangle
          className="h-3.5 w-3.5 chat-workspace-icon chat-workspace-icon-warn"
          aria-hidden="true"
        />
        <span className="chat-workspace-text" title={[...preview.notes, error ?? ""].join("\n")}>
          {error ?? lastNote(preview.notes) ?? "The dev server did not start."}
        </span>
        <button type="button" className="chat-workspace-action" onClick={() => void start()}>
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          Retry
        </button>
      </span>
    );
  }

  // Idle or stopped: the one thing worth offering unprompted, because a live
  // preview of the change is the reason this tier exists at all.
  return (
    <span className="chat-workspace-right">
      <button type="button" className="chat-workspace-action" onClick={() => void start()}>
        <Play className="h-3 w-3" aria-hidden="true" />
        Preview the app
      </button>
    </span>
  );
}
