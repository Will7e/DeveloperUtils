// ============================================================
// Changes Sheet — The Changes Pane Below The Split Breakpoint
// ============================================================
// The same change set, the same diffs, the same verification badge, presented as
// a full-width sheet instead of the right-hand 45% of a phone-width window. Not a
// second implementation: the sheet renders `ChangesPane` itself, so there is one
// pane in the codebase and two ways to place it.
//
// It behaves as a dialog because at this width it covers the transcript entirely
// — Tab must not reach the composer behind it, and Escape has to close it. Reusing
// the shared dialog hook is what keeps those three behaviours from being
// re-derived (and got wrong) for yet another overlay.
//
// No backdrop tap-to-dismiss: reviewing a diff on a phone means scrolling, and a
// stray tap on the margin discarding the view is the kind of dismissal users
// cannot undo.

import React from "react";
import { useModalDialog } from "./useModalDialog";
import { ChangesPane, type WorkspacePanelTab } from "./ChangesPane";

export function ChangesSheet({
  conversationId,
  onClose,
  tab,
  onTabChange,
}: {
  conversationId: string | null;
  onClose: () => void;
  /** Which workspace-panel surface the sheet shows — same tabs as the pane */
  tab: WorkspacePanelTab;
  onTabChange: (tab: WorkspacePanelTab) => void;
}) {
  const panelRef = useModalDialog<HTMLDivElement>({ onDismiss: onClose });

  return (
    <div className="chat-changes-sheet-overlay">
      <div
        className="chat-changes-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Agent code changes"
        ref={panelRef}
        tabIndex={-1}
      >
        {/* `standalone`: this sheet covers the chat header, so the pane is the only
            surface that can state the verification status. In the split layout
            it is left to the header chip instead. */}
        <ChangesPane
          conversationId={conversationId}
          onClose={onClose}
          tab={tab}
          onTabChange={onTabChange}
          standalone
        />
      </div>
    </div>
  );
}
