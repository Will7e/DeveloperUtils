// ============================================================
// Mention Menu — the "@file" picker
// ============================================================
// Anchored above the composer, same visual language as the slash menu.
// It renders only the rows it is given: which paths match is the pure
// ranker's decision (lib/mentions.ts), and the composer owns the
// highlight index so keyboard and mouse agree on what Enter picks.
//
// The base directory is dimmed rather than the filename, because the
// filename is what the user is searching for and the one thing that must
// never be elided.

import React from "react";
import { FileCode2, CornerDownLeft } from "lucide-react";

interface MentionMenuProps {
  candidates: string[];
  highlightedIdx: number;
  /** The raw "@…" query, echoed so the user knows what is being matched */
  query: string;
  onSelect: (path: string) => void;
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dir: "", name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

export const MentionMenu = React.memo(function MentionMenu({
  candidates,
  highlightedIdx,
  query,
  onSelect,
}: MentionMenuProps) {
  if (candidates.length === 0) {
    return (
      <div className="chat-command-menu chat-command-menu-empty" role="status">
        <p className="chat-command-empty">
          No repository file matches <code>@{query}</code>
          {query.includes("(") ? "" : " — keep typing, or check the path"}.
        </p>
      </div>
    );
  }

  return (
    <div className="chat-command-menu" role="presentation">
      <div id="chat-mention-listbox" className="chat-command-list" role="listbox" aria-label="Repository files">
        {candidates.map((path, i) => {
          const { dir, name } = splitPath(path);
          const isHighlighted = i === highlightedIdx;
          return (
            <button
              key={path}
              type="button"
              id={`chat-mention-opt-${i}`}
              role="option"
              aria-selected={isHighlighted}
              className={`chat-command-item ${isHighlighted ? "chat-command-item-highlighted" : ""}`}
              // A mousedown that reaches the textarea would blur it and
              // tear the menu down before the click could land, so the
              // pick happens here and the event never propagates.
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(path);
              }}
              title={path}
            >
              <FileCode2 className="h-3.5 w-3.5 chat-mention-icon" aria-hidden="true" />
              <span className="chat-mention-path">
                <span className="chat-mention-dir">{dir}</span>
                <span className="chat-mention-name">{name}</span>
              </span>
              {isHighlighted && (
                <CornerDownLeft className="h-3 w-3 chat-command-item-hint" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});
