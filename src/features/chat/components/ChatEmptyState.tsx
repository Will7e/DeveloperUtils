// ============================================================
// Chat Empty State — The First Thing A New Chat Says
// ============================================================
// What it offers depends on what the chat CAN do, which is not a detail: three
// generic programming prompts on a chat attached to a repository look like the
// app has not noticed the repository. So the suggestions follow the context —
// repository, recent work, or neither — and the generic set is the fallback
// rather than the default.
//
// The "Pick up where you left off" list used to live here too, but the welcome
// screen only renders when the current chat is empty, so it hid recent work
// from exactly the moment it was most useful. It moved to the sidebar as the
// History section (see ChatSidebar), where it is always on screen.
//
// When no OpenRouter key is configured, a prominent CTA opens the connection
// settings instead of letting suggestions fail later.

import { ArrowRight, GitFork, KeyRound, MessageSquareText } from "lucide-react";
import { useChatStore } from "@/stores/chat.store";

/** Prompts that make sense with no project context at all */
const GENERAL_SUGGESTIONS = [
  "Explain the difference between debounce and throttle, with TypeScript examples.",
  "Write a regex that validates an email address, then explain each part.",
  "Refactor this callback-based function into async/await and handle errors properly.",
];

/**
 * Prompts that only make sense on a repository.
 *
 * Each names the tool it will reach for, because a suggestion that reads like a
 * chat prompt but runs `list_repo_files` is how a user learns the agent has hands.
 */
const REPO_SUGGESTIONS = [
  "Give me a tour of this repository: what it does, how it is laid out, and where a change like mine would go.",
  "Find the tests that cover the code most likely to break, and tell me how to run them.",
  "Read the working copy, then suggest the smallest change that fixes the most likely bug.",
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
  // Read straight from the store rather than threading two more props through
  // MessageList: this component only ever renders inside the chat page, and the
  // alternative is a prop list that grows with every context-aware suggestion.
  const repoContext = useChatStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId)?.repoContext
  );

  const repoName = repoContext ? `${repoContext.owner}/${repoContext.repo}` : null;
  const suggestions = repoName ? REPO_SUGGESTIONS : GENERAL_SUGGESTIONS;

  return (
    <div className="chat-empty">
      <div className="chat-empty-icon">
        {repoName ? <GitFork className="h-7 w-7" /> : <MessageSquareText className="h-7 w-7" />}
      </div>
      <h2 className="chat-empty-title">How can I help?</h2>
      <p className="chat-empty-subtitle">
        {repoName ? (
          <>
            Working on <span className="chat-empty-model">{repoName}</span>
            {repoContext?.branch ? ` · ${repoContext.branch}` : ""} — the agent can read
            this codebase.
          </>
        ) : (
          <>
            Chatting with <span className="chat-empty-model">{defaultModel}</span> — switch models
            anytime from the header.
          </>
        )}
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
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        {suggestions.map((s) => (
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

      {/* "Pick up where you left off" moved to the sidebar as its History
          section — the welcome screen only showed it when THIS chat was
          empty, so the person who needed it most (came back to the wrong
          thread) saw it least. The sidebar shows it always. */}
    </div>
  );
}
