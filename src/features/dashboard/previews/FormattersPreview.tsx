import { useState, useRef } from "react";
import { AlignLeft, Minimize2, Copy, Check, AlertCircle } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { renderHighlightedJson } from "./syntaxHighlight";
import { DemoControls, useAutopilot, type AutopilotStep } from "../autopilot";
import { requestHandoff } from "@/services/handoff.service";

const SAMPLE_JSON = `{\n  "service": "InTab Suite",\n  "version": "2.4.0",\n  "clientSide": true,\n  "features": ["compiler", "apitester", "drawflow", "formatters"]\n}`;

export function FormattersPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<string>(SAMPLE_JSON);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [byteSavings, setByteSavings] = useState<number>(0);

  const formatJson = (source: string) => {
    try {
      const parsed = JSON.parse(source);
      setContent(JSON.stringify(parsed, null, 2));
      setError(null);
      setByteSavings(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  const minifyJson = (source: string) => {
    try {
      const parsed = JSON.parse(source);
      const originalLen = source.length;
      const minified = JSON.stringify(parsed);
      const savings = Math.max(0, Math.round(((originalLen - minified.length) / originalLen) * 100));
      setContent(minified);
      setError(null);
      setByteSavings(savings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  const handlePrettify = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    formatJson(content);
  };

  const handleMinify = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    minifyJson(content);
  };

  const handleCopy = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    void navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const steps: AutopilotStep[] = [
    {
      target: '[data-action="minify"]',
      fallback: { x: 28, y: 12 },
      action: "Minify",
      hover: "minify",
      run: () => minifyJson(content),
    },
    {
      target: ".dash-code-editor-wrap",
      fallback: { x: 55, y: 48 },
      action: "One line now",
      transition: 600,
    },
    {
      target: '[data-action="prettify"]',
      fallback: { x: 10, y: 12 },
      action: "Prettify",
      hover: "prettify",
      run: () => formatJson(content),
    },
    {
      target: '[data-action="copy"]',
      fallback: { x: 94, y: 12 },
      action: "Copy output",
      hover: "copy",
      run: () => {
        void navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
    },
    {
      target: ".dash-fmt-footer",
      fallback: { x: 35, y: 88 },
      action: error ? "Invalid input" : "Valid JSON",
      transition: 600,
    },
  ];

  const autopilot = useAutopilot(containerRef, steps, { stepMs: 1850 });

  return (
    <div
      ref={containerRef}
      className="dash-demo-box dash-demo-formatters"
      {...autopilot.containerProps}
    >
      <VirtualCursor {...autopilot.cursorProps} />

      <DemoControls
        autopilot={autopilot}
        openLabel="Open in Formatters"
        onOpen={() =>
          requestHandoff({
            target: "formatters",
            label: "demo.json",
            formatter: { type: "json", content, name: "demo.json" },
          })
        }
      />

      {/* Mini Controls Bar */}
      <div className="dash-demo-bar">
        <div className="dash-fmt-actions">
          <div className="dash-fmt-pill-group">
            <button
              data-action="prettify"
              type="button"
              className={`dash-fmt-pill-btn ${autopilot.hoverClass("prettify")}`}
              onClick={handlePrettify}
              title="Parse and format JSON"
            >
              <AlignLeft className="h-2.5 w-2.5" />
              <span>Prettify</span>
            </button>
            <button
              data-action="minify"
              type="button"
              className={`dash-fmt-pill-btn ${autopilot.hoverClass("minify")}`}
              onClick={handleMinify}
              title="Minify JSON into single line"
            >
              <Minimize2 className="h-2.5 w-2.5" />
              <span>Minify</span>
            </button>
          </div>
        </div>

        <div className="dash-demo-actions">
          <button
            data-action="copy"
            type="button"
            className={`dash-demo-icon-btn ${autopilot.hoverClass("copy")}`}
            onClick={handleCopy}
            title="Copy formatted output"
          >
            {copied ? (
              <Check className="h-3 w-3 text-[var(--green)]" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      {/* Editable Code Display Area */}
      <div className="dash-fmt-display">
        <div className="dash-code-editor-wrap">
          <pre className="dash-syntax-layer" aria-hidden="true">
            <code>{renderHighlightedJson(content)}</code>
          </pre>
          <textarea
            className="dash-demo-editor dash-fmt-textarea"
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setError(null);
            }}
            spellCheck={false}
            aria-label="Demo JSON payload"
            rows={content.split("\n").length}
          />
        </div>
      </div>

      {/* Real Validation & Efficiency Metrics Bar */}
      <div className="dash-fmt-footer">
        {error ? (
          <span className="dash-fmt-error">
            <AlertCircle className="h-3 w-3 text-[var(--red)]" />
            <span>{error}</span>
          </span>
        ) : (
          <>
            <span className="dash-fmt-stat">
              {byteSavings > 0 ? `Saved ${byteSavings}% bytes` : "Valid JSON"}
            </span>
            <span className="dash-fmt-divider">•</span>
            <span className="dash-fmt-stat">
              {new Blob([content]).size} bytes
            </span>
            <span className="dash-fmt-divider">•</span>
            <span className="dash-fmt-stat">Parsed in your browser</span>
          </>
        )}
      </div>
    </div>
  );
}
