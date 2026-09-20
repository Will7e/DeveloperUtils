import { useState, useEffect, useRef } from "react";
import { Send, RefreshCw } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { renderHighlightedJson } from "./syntaxHighlight";
import { getTargetCenter, type CursorPosition } from "../components/cursorUtils";

const DEMO_QUOTES: Array<{ quote: string; author: string }> = [
  { quote: "The only limit to our realization of tomorrow is our doubts of today.", author: "Franklin D. Roosevelt" },
  { quote: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci" },
  { quote: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { quote: "Programs must be written for people to read.", author: "Harold Abelson" },
  { quote: "Talk is cheap. Show me the code.", author: "Linus Torvalds" },
];

export function ApiTesterPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [method, setMethod] = useState<"GET" | "POST">("GET");
  const [url, setUrl] = useState("https://api.example.com/quotes/random");
  const [activeTab, setActiveTab] = useState<"body" | "headers">("body");
  const [isLoading, setIsLoading] = useState(false);
  const [latency, setLatency] = useState(142);
  const [statusCode, setStatusCode] = useState(200);
  const [statusText, setStatusText] = useState("OK");
  const [headersMap] = useState<Record<string, string>>({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache, private",
    "x-powered-by": "Express",
    "access-control-allow-origin": "*",
  });
  const [responseJson, setResponseJson] = useState<string>(
    JSON.stringify(
      {
        id: 1,
        quote: DEMO_QUOTES[0]!.quote,
        author: DEMO_QUOTES[0]!.author,
        network: "simulated locally — no request leaves your browser",
      },
      null,
      2
    )
  );
  const demoIndexRef = useRef(0);

  // Virtual Cursor Autopilot State
  const [cursorPos, setCursorPos] = useState<CursorPosition>({ x: 92, y: 14, isPercent: true });
  const [cursorClicking, setCursorClicking] = useState(false);
  const [cursorAction, setCursorAction] = useState<string>("Ready");
  const [cursorDuration, setCursorDuration] = useState<number>(500);
  const [virtualHover, setVirtualHover] = useState<string | null>(null);
  const [isUserActive, setIsUserActive] = useState(false);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Fully local simulation — the landing page must make zero network requests.
  const dispatchFetch = async () => {
    setIsLoading(true);
    const t0 = performance.now();
    const simulatedLatency = 90 + Math.round(Math.random() * 160);

    await new Promise((resolve) => setTimeout(resolve, simulatedLatency));

    const t1 = performance.now();
    const quote = DEMO_QUOTES[demoIndexRef.current % DEMO_QUOTES.length] ?? DEMO_QUOTES[0];
    demoIndexRef.current += 1;

    setLatency(Math.max(12, Math.round(t1 - t0)));
    setStatusCode(200);
    setStatusText("OK");
    setResponseJson(
      JSON.stringify(
        {
          id: demoIndexRef.current,
          quote: quote!.quote,
          author: quote!.author,
          network: "simulated locally — no request leaves your browser",
        },
        null,
        2
      )
    );
    setIsLoading(false);
  };

  const handleSend = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (isLoading) return;
    dispatchFetch();
  };

  // Autonomous Lifelike Cursor Motion Loop for API Tester
  useEffect(() => {
    if (isUserActive) return;

    let step = 0;
    const timeouts: NodeJS.Timeout[] = [];

    const cycle = () => {
      if (isUserActive) return;

      if (step === 0) {
        // Glide to Send button with pixel accuracy
        setCursorDuration(460);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-action="send"]', { x: 92, y: 14 })
        );
        setCursorAction("Send GET");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("send");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setCursorAction("Fetching...");
            dispatchFetch();
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 200)
            );
          }, 500)
        );
      } else if (step === 1) {
        // Drift down to response status & JSON
        setCursorDuration(650);
        setCursorPos(
          getTargetCenter(containerRef.current, ".dash-api-pre", { x: 60, y: 70 })
        );
        setCursorAction("Inspect JSON");
      } else if (step === 2) {
        // Glide to Headers tab with pixel accuracy
        setCursorDuration(500);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-tab="headers"]', { x: 35, y: 44 })
        );
        setCursorAction("View Headers");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("tab-headers");
          }, 320)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setActiveTab("headers");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 500)
        );
      } else if (step === 3) {
        // Drift across headers
        setCursorDuration(600);
        setCursorPos(
          getTargetCenter(containerRef.current, ".dash-headers-list", { x: 50, y: 68 })
        );
        setCursorAction("Checking Headers");
      } else if (step === 4) {
        // Glide back to Response Body tab with pixel accuracy
        setCursorDuration(480);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-tab="body"]', { x: 12, y: 44 })
        );
        setCursorAction("View Body");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("tab-body");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setActiveTab("body");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 480)
        );
      } else if (step === 5) {
        // Drift over JSON body
        setCursorDuration(600);
        setCursorPos(
          getTargetCenter(containerRef.current, ".dash-api-pre", { x: 55, y: 75 })
        );
        setCursorAction("200 OK");
      }

      step = (step + 1) % 6;
    };

    cycle();
    const interval = setInterval(cycle, 1800);

    return () => {
      clearInterval(interval);
      timeouts.forEach(clearTimeout);
      setVirtualHover(null);
    };
  }, [isUserActive, url, method]);

  const handleMouseEnter = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    setIsUserActive(true);
    setVirtualHover(null);
  };

  const handleMouseLeave = () => {
    idleTimerRef.current = setTimeout(() => {
      setIsUserActive(false);
    }, 2400);
  };

  return (
    <div
      ref={containerRef}
      className="dash-demo-box dash-demo-apitester"
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Animated Virtual Cursor */}
      <VirtualCursor
        x={cursorPos.x}
        y={cursorPos.y}
        isPercent={cursorPos.isPercent}
        isClicking={cursorClicking}
        visible={!isUserActive}
        actionText={cursorAction}
        transitionDuration={cursorDuration}
      />

      {/* URL / Request Bar */}
      <div className="dash-api-address-bar">
        <select
          className={`dash-api-method-select ${method.toLowerCase()}`}
          value={method}
          onChange={(e) => setMethod(e.target.value as "GET" | "POST")}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="GET">GET</option>
          <option value="POST">POST</option>
        </select>

        <input
          type="text"
          className="dash-api-url-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          spellCheck={false}
          placeholder="https://api..."
        />

        <button
          type="button"
          data-action="send"
          className={`dash-api-send-btn ${isLoading ? "loading" : ""} ${virtualHover === "send" ? "is-virtual-hover" : ""}`}
          onClick={handleSend}
          disabled={isLoading}
          title="Send HTTP request"
        >
          {isLoading ? (
            <RefreshCw className="h-3 w-3 animate-spin" />
          ) : (
            <>
              <Send className="h-3 w-3" />
              <span>Send</span>
            </>
          )}
        </button>
      </div>

      {/* Response Status Bar */}
      <div className="dash-api-status-bar">
        <div className="dash-api-status-group">
          <span className={`dash-api-status-chip ${statusCode >= 200 && statusCode < 300 ? "ok" : "err"}`}>
            <span className="dash-api-status-dot" />
            {statusCode} {statusText}
          </span>
          <span className="dash-api-meta-chip">{latency}ms</span>
          <span className="dash-api-meta-chip">
            {(new Blob([responseJson]).size / 1024).toFixed(1)} KB
          </span>
        </div>
      </div>

      {/* Response Body / Headers Tabs */}
      <div className="dash-api-viewer">
        <div className="dash-api-tabs">
          <button
            type="button"
            data-tab="body"
            className={`dash-api-tab ${activeTab === "body" ? "active" : ""} ${virtualHover === "tab-body" ? "is-virtual-hover" : ""}`}
            onClick={() => setActiveTab("body")}
          >
            Response Body
          </button>
          <button
            type="button"
            data-tab="headers"
            className={`dash-api-tab ${activeTab === "headers" ? "active" : ""} ${virtualHover === "tab-headers" ? "is-virtual-hover" : ""}`}
            onClick={() => setActiveTab("headers")}
          >
            Headers ({Object.keys(headersMap).length})
          </button>
        </div>

        <div className="dash-api-content">
          {activeTab === "body" ? (
            <pre className="dash-api-pre">
              <code>{renderHighlightedJson(responseJson)}</code>
            </pre>
          ) : (
            <div className="dash-headers-list">
              {Object.entries(headersMap).map(([key, val]) => (
                <div key={key} className="dash-header-row">
                  <span className="header-key">{key}:</span>
                  <span className="header-val">{val}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
