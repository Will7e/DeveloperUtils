// ============================================================
// Chat Empty State — Geist-Styled Welcome
// ============================================================
// When no OpenRouter key is configured, a prominent CTA opens the
// connection settings instead of letting suggestions fail later.

import { KeyRound, MessageSquareText, Sparkles } from "lucide-react";

const SUGGESTIONS = [
  "Explain the difference between debounce and throttle, with TypeScript examples.",
  "Write a regex that validates an email address, then explain each part.",
  "Refactor this callback-based function into async/await and handle errors properly.",
];

interface ChatEmptyStateProps {
  onSuggestion: (text: string) => void;
  /** Display name of the active model */
  defaultModel: string;
  /** OpenRouter key present — hides the connect CTA */
  hasApiKey: boolean;
  onOpenSettings: () => void;
}

export function ChatEmptyState({
  onSuggestion,
  defaultModel,
  hasApiKey,
  onOpenSettings,
}: ChatEmptyStateProps) {
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
        {!hasApiKey && (
          <button
            type="button"
            className="chat-empty-key-cta"
            onClick={onOpenSettings}
          >
            <KeyRound className="h-3.5 w-3.5" />
            Connect OpenRouter to start chatting
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
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
