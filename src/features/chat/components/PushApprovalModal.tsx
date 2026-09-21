// ============================================================
// PushApprovalModal — Human Gate for the Agent's GitHub Push
// ============================================================
// The single approval point of the whole agent flow. Shows every
// changed file as a unified diff with +/- stats, lets the user
// toggle PR creation, and either approves (executes the GitHub
// write chain) or rejects (optionally with a note fed back to the
// agent). Rendered from ChatPage whenever pendingPush is set.

import React from "react";
import {
  Check,
  FilePlus2,
  FileMinus2,
  FilePen,
  GitPullRequest,
  Loader2,
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
  const [openPr, setOpenPr] = React.useState(true);
  const [rejectNote, setRejectNote] = React.useState("");
  const [showRejectNote, setShowRejectNote] = React.useState(false);

  const pendingCreatedAt = pendingPush?.createdAt;
  React.useEffect(() => {
    if (pendingCreatedAt !== undefined) {
      setOpenPatches(new Set());
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

  const handleApprove = () => {
    setExecuting(true);
    // The PR choice rides with the decision — a window global would be
    // read by a different module at an unpredictable time.
    resolvePushApproval(true, undefined, openPr);
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
              {pendingPush.stats.files} file{pendingPush.stats.files === 1 ? "" : "s"} ·{" "}
              <span className="chat-approval-add">+{pendingPush.stats.additions}</span>{" "}
              <span className="chat-approval-del">−{pendingPush.stats.deletions}</span> · branch{" "}
              <code>{pendingPush.branchName}</code> → <code>{pendingPush.baseBranch}</code>
            </p>
          </div>
        </div>

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

        <div className="chat-approval-files">
          {pendingPush.changes.map((c) => {
            const isOpen = openPatches.has(c.path);
            const StatusIcon = c.status === "added" ? FilePlus2 : c.status === "deleted" ? FileMinus2 : FilePen;
            return (
              <div key={c.path} className="chat-approval-file">
                <button
                  type="button"
                  className="chat-approval-file-header"
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
                {isOpen && (
                  <pre className="chat-approval-patch">
                    {c.patch.length > 8000 ? `${c.patch.slice(0, 8000)}\n…[truncated]` : c.patch}
                  </pre>
                )}
              </div>
            );
          })}
        </div>

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
            disabled={executing}
          >
            {executing ? <Loader2 className="h-4 w-4 spin" /> : <Check className="h-4 w-4" />}
            {executing ? "Pushing…" : "Approve & push"}
          </button>
        </div>
      </div>
    </div>
  );
});
