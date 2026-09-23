// ============================================================
// Question Card — The Agent's Question, Answered In One Click
// ============================================================
// A turn parked on `ask_user` is waiting for the person reading it, so the
// card has to be where they are already looking: the end of the transcript,
// not a modal (a modal would steal focus from a turn they may want to keep
// reading) and not the composer (the answer is one of a few named choices,
// not a sentence they have to compose).
//
// The state comes from the conversation, not from local props, because a
// reload has to bring the same question back — the turn is still open and the
// answer still has to reach it. Clicking an option answers IMMEDIATELY: the
// recommended choice is one click, which is the whole reason the question is
// structured. Multi-select questions and free text go through the input,
// because those genuinely need a second gesture to say "that is all".

import React from "react";
import { HelpCircle } from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
import { answerQuestion } from "../services/chat-runner";
import type { AgentQuestion } from "../types";

/** True when the model labelled one option as its recommendation */
function hasRecommended(question: AgentQuestion): boolean {
  return question.options.some((o) => /recommend/i.test(o.label));
}

export function QuestionCard({ conversationId }: { conversationId: string }) {
  const question = useChatStore(
    (s) => s.conversations.find((c) => c.id === conversationId)?.pendingQuestion
  );
  const [picked, setPicked] = React.useState<string[]>([]);
  const [note, setNote] = React.useState("");

  React.useEffect(() => {
    setPicked([]);
    setNote("");
  }, [question?.callId]);

  if (!question) return null;

  const multi = question.multiSelect === true;

  const submit = (selected: string[], extra?: string) => {
    answerQuestion(conversationId, {
      selected,
      note: [extra, note].filter((v) => v && v.trim()).join(" ").trim() || undefined,
    });
  };

  const chooseOption = (label: string) => {
    if (!multi) {
      submit([label]);
      return;
    }
    setPicked((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
    );
  };

  return (
    <div className="chat-question" role="group" aria-label={`Question: ${question.header}`}>
      <div className="chat-question-head">
        <HelpCircle className="chat-question-icon h-3.5 w-3.5" aria-hidden="true" />
        <span className="chat-question-header">{question.header}</span>
        <span className="chat-question-status">waiting for you</span>
      </div>
      <p className="chat-question-text">{question.question}</p>

      <div className="chat-question-options">
        {question.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={`chat-question-option ${
              multi && picked.includes(option.label) ? "chat-question-option-picked" : ""
            }`}
            onClick={() => chooseOption(option.label)}
            aria-pressed={multi ? picked.includes(option.label) : undefined}
          >
            <span className="chat-question-option-label">{option.label}</span>
            {option.description && (
              <span className="chat-question-option-desc">{option.description}</span>
            )}
          </button>
        ))}
      </div>

      <div className="chat-question-answer">
        <input
          className="chat-question-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (note.trim() || picked.length > 0) submit(picked);
            }
          }}
          placeholder={multi ? "Or add a note for the choices above…" : "Or answer in your own words…"}
          aria-label="Answer in your own words"
        />
        <button
          type="button"
          className="chat-question-send"
          onClick={() => submit(picked)}
          disabled={multi ? picked.length === 0 && !note.trim() : !note.trim()}
        >
          Answer
        </button>
      </div>

      {/* The escape hatch that keeps a parked turn from being a dead end: a
          question the user does not want to decide still has to be able to
          unblock the work, and "use your judgement" is a decision. Offered
          only when the model did not already label a recommendation — when
          it did, that option IS this button. */}
      {!hasRecommended(question) && (
        <button
          type="button"
          className="chat-question-defer"
          onClick={() => submit([], "Use your recommendation — I don't have a preference.")}
        >
          Use your recommendation
        </button>
      )}
    </div>
  );
}
