// ============================================================
// Composer — Message Input with Send/Stop & Context Hint
// ============================================================
// Auto-growing textarea. Enter sends, Shift+Enter adds a newline.
// While streaming, the send button becomes Stop (keeps partial
// output). Shows a one-way conversation-system-prompt badge.

import React from "react";
import { ArrowUp, Square } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  /** Placeholder hint, e.g. active model */
  placeholder?: string;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  disabled = false,
  placeholder,
}: ComposerProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to a max height
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !isStreaming && !disabled;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div className="chat-composer-wrap">
      <div className={`chat-composer ${isStreaming ? "chat-composer-streaming" : ""}`}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "Ask anything… (Enter to send, Shift+Enter for newline)"}
          className="chat-composer-input"
          rows={1}
          disabled={disabled && !isStreaming}
          aria-label="Chat message"
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
          Responses may be inaccurate — verify important information.
        </span>
      </div>
    </div>
  );
}
