// ============================================================
// PushApprovalModal — Human Gate for the Agent's GitHub Push
// ============================================================
// The single approval point of the whole agent flow. Shows every
// changed file as a unified diff with +/- stats, lets the user
// include or exclude files individually, toggle PR creation, and
// either approves (executes the GitHub write chain) or rejects
// (optionally with a note fed back to the agent). Excluding is not
// rejecting: held-back files keep their content and diff in the
// workspace and can be pushed later. Rendered from ChatPage whenever
// pendingPush is set.

import React from "react";
import {
  Check,
  FilePlus2,
  FileMinus2,
  FilePen,
  FlaskConical,
  GitPullRequest,
  Loader2,
  Minus,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { useChatStore } from "@/stores/chat.store";

export const PushApprovalModal = React.memo(function PushApprovalModal() {
  const pendingPush = useChatStore((s) => s.pendingPush);
  const resolvePushApproval = useChatStore((s) => s.resolvePushApproval);
  const clearPendingPush = useChatStore((s) => s.clearPendingPush);

  const [executing, setExecuting] = React.useState(false);
  const [openPatches, setOpenPatches] = React.useState<Set<string>>(new Set());
  const [excluded, setExcluded] = React.useState<Set<string>>(new Set());
  const [openPr, setOpenPr] = React.useState(true);
  const [rejectNote, setRejectNote] = React.useState("");
  const [showRejectNote, setShowRejectNote] = React.useState(false);

  const pendingCreatedAt = pendingPush?.createdAt;
  React.useEffect(() => {
    if (pendingCreatedAt !== undefined) {
      setOpenPatches(new Set());
      // Every gate starts fully selected: what the agent proposed is the
      // default, and unchecking is an explicit act of review.
      setExcluded(new Set());
      setShowRejectNote(false);
      setRejectNote("");
      setExecuting(false);
    }
  }, [pendingCreatedAt]);

  if (!pendingPush) return null;

  const togglePatch = (path: string) => {
    setOpenPatches((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleInclude = (path: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Stats follow the selection, not the proposal — a reviewer clearing
  // three files should not still be shown the size of the full diff.
  const included = pendingPush.changes.filter((c) => !excluded.has(c.path));
  const heldBack = pendingPush.changes.filter((c) => excluded.has(c.path));
  const additions = included.reduce((s, c) => s + c.additions, 0);
  const deletions = included.reduce((s, c) => s + c.deletions, 0);
  const allExcluded = included.length === 0;

  const handleApprove = () => {
    setExecuting(true);
    // The PR choice and the exclusions ride with the decision — a window
    // global would be read by a different module at an unpredictable time.
    resolvePushApproval(
      true,
      undefined,
      openPr,
      heldBack.map((c) => c.path)
    );
  };

  const handleReject = () => {
    // Resolve the awaiting runPushChanges promise FIRST — clearing
    // pendingPush before resolving would drop the gate resolver and
    // deadlock the agent tool loop on an unresolved promise.
    resolvePushApproval(false, rejectNote.trim() || undefined);
    clearPendingPush();
  };

  return (
    <div className="chat-modal-overlay" role="dialog" aria-modal="true" aria-label="Approve push">
      <div className="chat-approval-panel">
        <div className="chat-approval-header">
          <ShieldCheck className="h-4 w-4 chat-approval-shield" aria-hidden="true" />
          <div>
            <h2 className="chat-approval-title">Approve push to GitHub</h2>
            <p className="chat-approval-subtitle">
              {heldBack.length === 0
                ? `${pendingPush.changes.length} file${pendingPush.changes.length === 1 ? "" : "s"}`
                : `${included.length} of ${pendingPush.changes.length} files`}{" "}
              ·{" "}
              <span className="chat-approval-add">+{additions}</span>{" "}
              <span className="chat-approval-del">−{deletions}</span> · branch{" "}
              <code>{pendingPush.branchName}</code> → <code>{pendingPush.baseBranch}</code>
            </p>
          </div>
        </div>

        {(pendingPush.verification ?? []).length > 0 ? (
          <div className="chat-approval-evidence">
            <h3 className="chat-approval-evidence-title">
              <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
              What actually ran
            </h3>
            <ul className="chat-approval-evidence-list">
              {pendingPush.verification!.map((line, i) => (
                <li key={`verification-${i}`}>
                  <Check className="h-3 w-3" aria-hidden="true" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p className="chat-approval-evidence-note">
              Test suites, linters and build commands still cannot run in this workspace.
            </p>
          </div>
        ) : null}

        {(pendingPush.warnings ?? []).length > 0 ? (
          <div className="chat-approval-warnings" role="alert">
            {pendingPush.warnings!.map((w, i) => (
              <p key={`${w.kind}-${i}`} className="chat-approval-warning">
                <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{w.message}</span>
              </p>
            ))}
          </div>
        ) : null}

        <div className="chat-approval-files-bar">
          <span>
            {included.length} of {pendingPush.changes.length} selected
          </span>
          <span className="chat-approval-files-actions">
            <button
              type="button"
              className="chat-approval-mini-btn"
              onClick={() => setExcluded(new Set())}
              disabled={heldBack.length === 0}
            >
              Select all
            </button>
            <button
              type="button"
              className="chat-approval-mini-btn"
              onClick={() => setExcluded(new Set(pendingPush.changes.map((c) => c.path)))}
              disabled={allExcluded}
            >
              Clear all
            </button>
          </span>
        </div>

        <div className="chat-approval-files">
          {pendingPush.changes.map((c) => {
            const isOpen = openPatches.has(c.path);
            const isHeld = excluded.has(c.path);
            const StatusIcon = c.status === "added" ? FilePlus2 : c.status === "deleted" ? FileMinus2 : FilePen;
            return (
              <div
                key={c.path}
                className={`chat-approval-file${isHeld ? " chat-approval-file-held" : ""}`}
              >
                <div className="chat-approval-file-header">
                  <input
                    type="checkbox"
                    className="chat-approval-file-check"
                    checked={!isHeld}
                    onChange={() => toggleInclude(c.path)}
                    aria-label={
                      isHeld ? `Include ${c.path} in this commit` : `Hold back ${c.path} from this commit`
                    }
                  />
                  <button
                    type="button"
                    className="chat-approval-file-toggle"
                    onClick={() => togglePatch(c.path)}
                    aria-expanded={isOpen}
                  >
                    <StatusIcon
                      className={`h-3.5 w-3.5 chat-approval-file-icon-${c.status}`}
                      aria-hidden="true"
                    />
                    <span className="chat-approval-file-path" title={c.path}>
                      {c.path}
                    </span>
                    <span className="chat-approval-file-stats">
                      <span className="chat-approval-add">+{c.additions}</span>{" "}
                      <span className="chat-approval-del">−{c.deletions}</span>
                    </span>
                  </button>
                </div>
                {isOpen && (
                  <pre className="chat-approval-patch">
                    {c.patch.length > 8000 ? `${c.patch.slice(0, 8000)}\n…[truncated]` : c.patch}
                  </pre>
                )}
              </div>
            );
          })}
        </div>

        {heldBack.length > 0 ? (
          <p className="chat-approval-hold-note" role="status">
            <Minus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {heldBack.length === 1
                ? `1 file stays back — it is not committed and remains pending in the workspace, so nothing is lost and you can push it later.`
                : `${heldBack.length} files stay back — they are not committed and remain pending in the workspace, so nothing is lost and you can push them later.`}
            </span>
          </p>
        ) : null}

        <label className="chat-approval-pr-toggle">
          <input type="checkbox" checked={openPr} onChange={(e) => setOpenPr(e.target.checked)} />
          <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
          Open a pull request after pushing
        </label>

        {showRejectNote ? (
          <textarea
            className="chat-approval-note"
            placeholder="Optional note for the agent — what should it do differently?"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            rows={3}
            autoFocus
          />
        ) : null}

        <div className="chat-approval-actions">
          {showRejectNote ? (
            <button type="button" className="chat-approval-btn chat-approval-btn-reject" onClick={handleReject}>
              <X className="h-4 w-4" /> Reject &amp; send note
            </button>
          ) : (
            <button
              type="button"
              className="chat-approval-btn chat-approval-btn-soft"
              onClick={() => setShowRejectNote(true)}
            >
              <X className="h-4 w-4" /> Reject
            </button>
          )}
          <button
            type="button"
            className="chat-approval-btn chat-approval-btn-approve"
            onClick={handleApprove}
            disabled={executing || allExcluded}
            title={allExcluded ? "Select at least one file, or reject the push" : undefined}
          >
            {executing ? <Loader2 className="h-4 w-4 spin" /> : <Check className="h-4 w-4" />}
            {executing
              ? "Pushing…"
              : allExcluded
                ? "Nothing selected"
                : `Approve & push ${included.length} file${included.length === 1 ? "" : "s"}${
                    heldBack.length > 0 ? ` (${heldBack.length} held back)` : ""
                  }`}
          </button>
        </div>
      </div>
    </div>
  );
});
