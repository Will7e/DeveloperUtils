// ============================================================
// Transcript Find — Jump Between The Messages That Match
// ============================================================
// A long agent conversation is a log you have to search, and until now the only
// way to find "what did it say about the poller" was to scroll. ⌘F (Ctrl+F) opens
// this bar, and Enter/Shift+Enter walk the matches from where you are.
//
// It deliberately does NOT highlight the matched substring inside the rendered
// markdown. Markdown output is a tree of React elements — code blocks, tables,
// inline spans — and injecting matches into it means either re-parsing the
// markdown around every hit or reaching into the DOM to wrap text nodes, both of
// which break the moment a match spans a formatting boundary. What it does
// instead is jump to the message and mark the message, which is the part the user
// actually needs: "take me to the place this was said".

import React from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

export interface TranscriptFindProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** How many messages match (0 when the query is empty) */
  count: number;
  /** 0-based index of the match being shown */
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function TranscriptFind({
  query,
  onQueryChange,
  count,
  index,
  onPrev,
  onNext,
  onClose,
}: TranscriptFindProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Focus on open, and keep the caret: the bar exists to be typed into, and it is
  // opened by a keystroke that must not land in the composer behind it.
  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="chat-find" role="search">
      <Search className="h-3.5 w-3.5 chat-find-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        className="chat-find-input"
        value={query}
        placeholder="Find in this conversation…"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            // Escape closes the bar and leaves the query: reopening ⌘F restores
            // the search rather than making the user retype it.
            onClose();
          }
        }}
        aria-label="Find in this conversation"
      />
      <span className="chat-find-count" aria-live="polite">
        {query.trim() === "" ? "" : count === 0 ? "No matches" : `${index + 1} of ${count}`}
      </span>
      <button
        type="button"
        className="chat-find-btn"
        onClick={onPrev}
        disabled={count === 0}
        aria-label="Previous match"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="chat-find-btn"
        onClick={onNext}
        disabled={count === 0}
        aria-label="Next match"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button type="button" className="chat-find-btn" onClick={onClose} aria-label="Close find">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
