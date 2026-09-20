import { useEffect, useRef, useState } from "react";
import { Bot, KeyRound, Send } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { DemoControls, useAutopilot, type AutopilotStep } from "../autopilot";
import { requestHandoff } from "@/services/handoff.service";

const MODELS = [
  "claude-sonnet-4.5",
  "gpt-5.1",
  "gemini-3-pro",
  "llama-4-maverick",
];

const USER_PROMPT = "How do I query active incidents from a scoped app?";

const ANSWER =
  "GlideRecord is the scoped API for that. Create the record, add your filter, call query(), then walk the rows with next() and read values with getValue().";

export function ChatPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [modelIndex, setModelIndex] = useState(0);
  const [streamed, setStreamed] = useState(ANSWER);
  const [isStreaming, setIsStreaming] = useState(false);

  const model = MODELS[modelIndex % MODELS.length] ?? MODELS[0]!;

  const startStreaming = () => {
    setStreamed("");
    setIsStreaming(true);
  };

  // The interval lives in an effect, so it can never outlive the component.
  useEffect(() => {
    if (!isStreaming) return;
    let cursor = 0;
    const id = window.setInterval(() => {
      cursor += 3;
      setStreamed(ANSWER.slice(0, cursor));
      if (cursor >= ANSWER.length) {
        window.clearInterval(id);
        setIsStreaming(false);
      }
    }, 26);
    return () => window.clearInterval(id);
  }, [isStreaming]);

  const steps: AutopilotStep[] = [
    {
      target: '[data-action="model"]',
      fallback: { x: 26, y: 10 },
      action: "Switch model",
      transition: 460,
      hover: "model",
      run: () => setModelIndex((index) => index + 1),
    },
    {
      target: '[data-action="send"]',
      fallback: { x: 88, y: 88 },
      action: "Send the prompt",
      transition: 520,
      hover: "send",
      run: startStreaming,
    },
    {
      target: ".dash-chat-stream",
      fallback: { x: 45, y: 58 },
      action: "Tokens streaming in",
      transition: 620,
    },
    {
      target: ".dash-chat-key",
      fallback: { x: 70, y: 96 },
      action: "Key stays encrypted",
      transition: 600,
    },
  ];

  const autopilot = useAutopilot(containerRef, steps, { stepMs: 1900 });

  return (
    <div ref={containerRef} className="dash-demo-box dash-demo-chat" {...autopilot.containerProps}>
      <VirtualCursor {...autopilot.cursorProps} />

      <DemoControls
        autopilot={autopilot}
        openLabel="Open in AI Chat"
        onOpen={() =>
          requestHandoff({
            target: "chat",
            label: model,
            chat: { prompt: USER_PROMPT },
          })
        }
      />

      {/* Model + key bar */}
      <div className="dash-chat-bar">
        <button
          type="button"
          data-action="model"
          className={`dash-chat-model ${autopilot.hoverClass("model")}`}
          onClick={() => setModelIndex((index) => index + 1)}
          title="Pick any OpenRouter model"
        >
          <Bot className="h-3 w-3" />
          <span>{model}</span>
        </button>

        <span className="dash-chat-or-via">via OpenRouter</span>

        <span className="dash-chat-key" title="Your key never leaves the browser">
          <KeyRound className="h-2.5 w-2.5" />
          your key
        </span>
      </div>

      {/* Conversation */}
      <div className="dash-chat-thread">
        <div className="dash-chat-turn user">
          <span className="dash-chat-role">You</span>
          <p className="dash-chat-text">{USER_PROMPT}</p>
        </div>

        <div className="dash-chat-turn assistant">
          <span className="dash-chat-role">{model}</span>
          <p className="dash-chat-text dash-chat-stream">
            {streamed}
            {isStreaming && <span className="dash-chat-caret" aria-hidden="true" />}
          </p>
        </div>
      </div>

      {/* Composer + usage */}
      <div className="dash-chat-composer">
        <span className="dash-chat-input">Ask anything, or attach a skill…</span>
        <button
          type="button"
          data-action="send"
          className={`dash-chat-send ${autopilot.hoverClass("send")}`}
          onClick={startStreaming}
          title="Send (this demo streams locally)"
        >
          <Send className="h-3 w-3" />
        </button>
      </div>

      <div className="dash-chat-usage">
        <span>Context 3.2k / 200k</span>
        <span className="dash-chat-usage-divider">•</span>
        <span>≈ $0.004 this turn</span>
        <span className="dash-chat-usage-divider">•</span>
        <span>Streamed from OpenRouter</span>
      </div>
    </div>
  );
}
