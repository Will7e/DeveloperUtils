import { useState, useRef } from "react";
import { Send, RefreshCw } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { renderHighlightedJson } from "./syntaxHighlight";
import { DemoControls, useAutopilot, type AutopilotStep } from "../autopilot";
import { requestHandoff } from "@/services/handoff.service";

const DEMO_QUOTES: Array<{ quote: string; author: string }> = [
  { quote: "The only limit to our realization of tomorrow is our doubts of today.", author: "Franklin D. Roosevelt" },
  { quote: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci" },
  { quote: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { quote: "Programs must be written for people to read.", author: "Harold Abelson" },
  { quote: "Talk is cheap. Show me the code.", author: "Linus Torvalds" },
];

const HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-cache, private",
  "x-powered-by": "Express",
  "access-control-allow-origin": "*",
};

export function ApiTesterPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [method, setMethod] = useState<"GET" | "POST">("GET");
  const [url, setUrl] = useState("https://api.example.com/quotes/random");
  const [activeTab, setActiveTab] = useState<"body" | "headers">("body");
  const [isLoading, setIsLoading] = useState(false);
  const [latency, setLatency] = useState(142);
  const [statusCode, setStatusCode] = useState(200);
  const [statusText, setStatusText] = useState("OK");
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

  // Fully local simulation — the dashboard must make zero network requests.
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

  const steps: AutopilotStep[] = [
    {
      target: '[data-action="send"]',
      fallback: { x: 92, y: 14 },
      action: `Send ${method}`,
      hover: "send",
      run: () => dispatchFetch(),
    },
    {
      target: ".dash-api-pre",
      fallback: { x: 60, y: 70 },
      action: "Inspect the JSON",
      transition: 650,
    },
    {
      target: '[data-tab="headers"]',
      fallback: { x: 35, y: 44 },
      action: "Response headers",
      hover: "tab-headers",
      run: () => setActiveTab("headers"),
    },
    {
      target: ".dash-headers-list",
      fallback: { x: 50, y: 68 },
      action: "Check caching",
      transition: 600,
    },
    {
      target: '[data-tab="body"]',
      fallback: { x: 12, y: 44 },
      action: "Back to the body",
      hover: "tab-body",
      run: () => setActiveTab("body"),
    },
    {
      target: ".dash-api-pre",
      fallback: { x: 55, y: 75 },
      action: `${statusCode} ${statusText}`,
      transition: 600,
    },
  ];

  const autopilot = useAutopilot(containerRef, steps, { stepMs: 1800 });

  return (
    <div
      ref={containerRef}
      className="dash-demo-box dash-demo-apitester"
      {...autopilot.containerProps}
    >
      <VirtualCursor {...autopilot.cursorProps} />

      <DemoControls
        autopilot={autopilot}
        openLabel="Open in API Tester"
        onOpen={() =>
          requestHandoff({
            target: "api-tester",
            label: url,
            request: { url, method },
          })
        }
      />

      {/* URL / Request Bar */}
      <div className="dash-api-address-bar">
        <select
          className={`dash-api-method-select ${method.toLowerCase()}`}
          value={method}
          onChange={(e) => setMethod(e.target.value as "GET" | "POST")}
          aria-label="HTTP method"
        >
          <option value="GET">GET</option>
          <option value="POST">POST</option>
        </select>

        <input
          type="text"
          className="dash-api-url-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
          placeholder="https://api..."
          aria-label="Request URL"
        />

        <button
          type="button"
          data-action="send"
          className={`dash-api-send-btn ${isLoading ? "loading" : ""} ${autopilot.hoverClass("send")}`}
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
        <span className="dash-api-meta-chip">Simulated locally</span>
      </div>

      {/* Response Body / Headers Tabs */}
      <div className="dash-api-viewer">
        <div className="dash-api-tabs">
          <button
            type="button"
            data-tab="body"
            className={`dash-api-tab ${activeTab === "body" ? "active" : ""} ${autopilot.hoverClass("tab-body")}`}
            onClick={() => setActiveTab("body")}
          >
            Response Body
          </button>
          <button
            type="button"
            data-tab="headers"
            className={`dash-api-tab ${activeTab === "headers" ? "active" : ""} ${autopilot.hoverClass("tab-headers")}`}
            onClick={() => setActiveTab("headers")}
          >
            Headers ({Object.keys(HEADERS).length})
          </button>
        </div>

        <div className="dash-api-content">
          {activeTab === "body" ? (
            <pre className="dash-api-pre">
              <code>{renderHighlightedJson(responseJson)}</code>
            </pre>
          ) : (
            <div className="dash-headers-list">
              {Object.entries(HEADERS).map(([key, val]) => (
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
