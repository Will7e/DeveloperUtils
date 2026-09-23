// ============================================================
// HttpApprovalModal — Human Gate for the Agent's External Writes
// ============================================================
// The agent can POST, PUT, PATCH and DELETE to any endpoint the user's
// browser can reach. Without a gate, "file a ticket for this bug" and
// "delete every record in that table" leave the machine the same way: the
// reply says "done" and there is nothing to review afterwards, because the
// change is in someone else's system.
//
// So the request is shown before it is sent — method and URL, the model's
// own one-line reason, headers with credential-shaped values masked, and the
// body — and the agent's tool call blocks on the answer. Rejecting carries
// the user's note back into the turn, which is the input the model should
// adapt to; nothing is ever sent on an unresolved dialog (the store's
// clearPendingHttp resolves it as a refusal).
//
// Deliberately NOT merged with PushApprovalModal: they gate different
// actions and a shared "pending" slot would let one dialog answer the
// other's promise.
//
// Rendered from ChatPage whenever pendingHttp is set.

import React from "react";
import { Check, Globe, TriangleAlert, X } from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
import { redactHeaders } from "../services/app-actions";

export const HttpApprovalModal = React.memo(function HttpApprovalModal() {
  const pendingHttp = useChatStore((s) => s.pendingHttp);
  const resolveHttpApproval = useChatStore((s) => s.resolveHttpApproval);
  const clearPendingHttp = useChatStore((s) => s.clearPendingHttp);

  const [note, setNote] = React.useState("");
  const [showNote, setShowNote] = React.useState(false);

  const pendingCreatedAt = pendingHttp?.createdAt;
  React.useEffect(() => {
    if (pendingCreatedAt !== undefined) {
      setNote("");
      setShowNote(false);
    }
  }, [pendingCreatedAt]);

  if (!pendingHttp) return null;

  // Masked for DISPLAY only — the request that goes out carries the real
  // header, because the agent sent it for a reason. What must not happen is
  // a bearer token rendered into a dialog and then into a screenshot.
  const shownHeaders = redactHeaders(pendingHttp.headers);
  const headerEntries = Object.entries(shownHeaders);
  const hasBody = typeof pendingHttp.body === "string" && pendingHttp.body.length > 0;

  // The approval unblocks the awaiting tool call, which then sends the
  // request. Nothing to wait for here: the dialog's job ends with the
  // decision, and the transcript row shows the result when it arrives.
  const handleApprove = () => {
    resolveHttpApproval(true);
    clearPendingHttp();
  };

  const handleReject = () => {
    // Resolve FIRST, then clear: clearing alone would drop the gate resolver
    // and leave the awaiting http_write tool hanging.
    resolveHttpApproval(false, note.trim() || undefined);
    clearPendingHttp();
  };

  return (
    <div className="chat-modal-overlay" role="dialog" aria-modal="true" aria-label="Approve external request">
      <div className="chat-approval-panel">
        <div className="chat-approval-header">
          <Globe className="h-4 w-4 chat-approval-shield" aria-hidden="true" />
          <div>
            <h2 className="chat-approval-title">Approve request to an external service</h2>
            <p className="chat-approval-subtitle">
              <strong>{pendingHttp.method}</strong> <code>{pendingHttp.url}</code>
            </p>
          </div>
        </div>

        {pendingHttp.why ? (
          <p className="chat-approval-hold-note" role="status">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              The agent says this is for: <em>{pendingHttp.why}</em>
            </span>
          </p>
        ) : null}

        <div className="chat-approval-evidence">
          <h3 className="chat-approval-evidence-title">Headers</h3>
          {headerEntries.length === 0 ? (
            <p className="chat-approval-subtitle">None.</p>
          ) : (
            <ul className="chat-approval-evidence-list">
              {headerEntries.map(([key, value]) => (
                <li key={key}>
                  <code>
                    {key}: {value}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </div>

        {hasBody ? (
          <div className="chat-approval-evidence">
            <h3 className="chat-approval-evidence-title">Body</h3>
            <pre className="chat-approval-patch">
              {pendingHttp.body!.length > 8000
                ? `${pendingHttp.body!.slice(0, 8000)}\n…[truncated]`
                : pendingHttp.body}
            </pre>
          </div>
        ) : null}

        <p className="chat-approval-hold-note" role="status">
          <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
          <span>
            This request can change data in someone else&apos;s system. Nothing has been sent yet, and
            nothing will be if you reject — your note goes back to the agent as guidance.
          </span>
        </p>

        {showNote ? (
          <textarea
            className="chat-approval-note"
            placeholder="Optional note for the agent — what should it do instead?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            autoFocus
          />
        ) : null}

        <div className="chat-approval-actions">
          {showNote ? (
            <button type="button" className="chat-approval-btn chat-approval-btn-reject" onClick={handleReject}>
              <X className="h-4 w-4" /> Reject &amp; send note
            </button>
          ) : (
            <button
              type="button"
              className="chat-approval-btn chat-approval-btn-soft"
              onClick={() => setShowNote(true)}
            >
              <X className="h-4 w-4" /> Reject
            </button>
          )}
          <button
            type="button"
            className="chat-approval-btn chat-approval-btn-approve"
            onClick={handleApprove}
          >
            <Check className="h-4 w-4" />
            {`Approve & send ${pendingHttp.method}`}
          </button>
        </div>
      </div>
    </div>
  );
});
