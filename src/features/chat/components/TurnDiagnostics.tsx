// ============================================================
// Turn Diagnostics — What The Harness Noticed About This Turn
// ============================================================
// A muted line under the turn it describes, opening into the taxonomy's own words
// for what happened and the mechanism that addresses it. Deliberately quiet: this
// is the harness talking about its own turn, not a failure of the user's work, and
// a red badge under every third reply would train people to ignore the one that
// matters.
//
// Two presentation rules that come from the derivation rather than from taste:
//
//   • The label is the taxonomy's, via lib/turn-diagnostics, so the chip and the
//     console diagnostics report name the same thing the same way.
//   • Severity is DERIVED (efficiency notes never read as warnings), so this file
//     chooses a colour, not a meaning.

import React from "react";
import { ChevronDown, Info, TriangleAlert } from "lucide-react";
import { diagnosticsLabel, type TurnDiagnostic } from "../lib/turn-diagnostics";

export function TurnDiagnostics({ diagnostic }: { diagnostic: TurnDiagnostic }) {
  const [open, setOpen] = React.useState(false);
  const hasWarning = diagnostic.notes.some((note) => note.severity === "warning");
  const Icon = hasWarning ? TriangleAlert : Info;

  return (
    <div className={`chat-diag ${hasWarning ? "chat-diag-warn" : ""}`}>
      <button
        type="button"
        className="chat-diag-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${diagnosticsLabel(diagnostic.notes)} — turn ${diagnostic.turn}. Show details.`}
      >
        <Icon className="h-3 w-3 chat-diag-icon" aria-hidden="true" />
        <span className="chat-diag-label">{diagnosticsLabel(diagnostic.notes)}</span>
        <ChevronDown className="h-3 w-3 chat-diag-chevron" aria-hidden="true" />
      </button>

      {open && (
        <ul className="chat-diag-list">
          {diagnostic.notes.map((note) => (
            <li key={note.kind} className="chat-diag-note">
              <span className="chat-diag-note-label">{note.label}</span>
              <span className="chat-diag-note-detail">{note.detail}</span>
              {/* The fix, in the harness's own words: the point of naming a
                  failure at all is to say which mechanism answers it. */}
              <span className="chat-diag-note-fix">{note.fix}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
