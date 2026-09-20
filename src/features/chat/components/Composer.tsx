// ============================================================
// Composer — Message Input with Send/Stop & Context Hint
// ============================================================
// Auto-growing textarea. Enter sends, Shift+Enter adds a newline.
// While this conversation streams, the send button becomes Stop
// (keeps partial output). When a stream is running in another
// conversation, the composer is disabled with a clear hint.

import React from "react";
import { ArrowUp, Square } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** True while THIS conversation is streaming */
  isStreaming: boolean;
  /** True when a stream is running in a different conversation */
  disabled?: boolean;
  /** Placeholder hint, e.g. active model */
  placeholder?: string;
  /** Optional external handle so the page can focus the input */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  disabled = false,
  placeholder,
  inputRef,
}: ComposerProps) {
  const innerRef = React.useRef<HTMLTextAreaElement>(null);

  const setRefs = React.useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (inputRef) inputRef.current = el;
    },
    [inputRef]
  );

  const grow = React.useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  // Auto-grow as the value changes and when window resizing reflows
  // the text into more/fewer lines.
  React.useEffect(() => {
    grow();
  }, [value, grow]);

  React.useEffect(() => {
    window.addEventListener("resize", grow);
    return () => window.removeEventListener("resize", grow);
  }, [grow]);

  const canSend = value.trim().length > 0 && !isStreaming && !disabled;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const placeholderText = disabled
    ? "Generating a response in another chat…"
    : placeholder ?? "Ask anything… (Enter to send, Shift+Enter for newline)";

  return (
    <div className="chat-composer-wrap">
      <div className={`chat-composer ${isStreaming ? "chat-composer-streaming" : ""}`}>
        <textarea
          ref={setRefs}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholderText}
          className="chat-composer-input"
          rows={1}
          disabled={disabled}
          aria-label="Chat message"
          aria-busy={isStreaming}
        />

        {isStreaming ? (
          <SimpleTooltip content="Stop generating" side="top">
            <button
              type="button"
              className="chat-composer-stop"
              onClick={onStop}
              aria-label="Stop generating"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          </SimpleTooltip>
        ) : (
          <SimpleTooltip content="Send message" shortcut="↵" side="top">
            <button
              type="button"
              className="chat-composer-send"
              onClick={onSend}
              disabled={!canSend}
              aria-label="Send message"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </SimpleTooltip>
        )}
      </div>

      <div className="chat-composer-footer">
        <span className="chat-composer-hint">
          {disabled
            ? "You can keep browsing — sending resumes when the other chat finishes."
            : "Responses may be inaccurate — verify important information."}
        </span>
      </div>
      <span className="chat-sr-only" aria-live="polite">
        {isStreaming ? "Assistant is responding" : ""}
      </span>
    </div>
  );
}
