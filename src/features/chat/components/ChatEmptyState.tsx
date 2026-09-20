// ============================================================
// Chat Empty State — Geist-Styled Welcome
// ============================================================

import { MessageSquareText } from "lucide-react";

const SUGGESTIONS = [
  "Explain the difference between debounce and throttle, with TypeScript examples.",
  "Write a regex that validates an email address, then explain each part.",
  "Refactor this callback-based function into async/await and handle errors properly.",
];

export function ChatEmptyState({
  onSuggestion,
  defaultModel,
}: {
  onSuggestion: (text: string) => void;
  defaultModel: string;
}) {
  return (
    <div className="chat-empty">
      <div className="chat-empty-icon">
        <MessageSquareText className="h-7 w-7" />
      </div>
      <h2 className="chat-empty-title">How can I help?</h2>
      <p className="chat-empty-subtitle">
        Chatting with <span className="chat-empty-model">{defaultModel}</span> — switch models
        anytime from the header.
      </p>

      <div className="chat-empty-suggestions">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="chat-empty-suggestion"
            onClick={() => onSuggestion(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
