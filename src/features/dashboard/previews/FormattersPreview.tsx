import { useState, useRef, useEffect } from "react";
import { AlignLeft, Minimize2, Copy, Check, AlertCircle } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { renderHighlightedJson } from "./syntaxHighlight";
import { getTargetCenter, type CursorPosition } from "../components/cursorUtils";

const SAMPLE_JSON = `{\n  "service": "InTab Suite",\n  "version": "2.4.0",\n  "clientSide": true,\n  "features": ["compiler", "apitester", "drawflow", "formatters"]\n}`;

export function FormattersPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<string>(SAMPLE_JSON);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [byteSavings, setByteSavings] = useState<number>(0);

  // Virtual Cursor Autopilot State (Pixel-accurate coordinates)
  const [cursorPos, setCursorPos] = useState<CursorPosition>({ x: 28, y: 12, isPercent: true });
  const [cursorClicking, setCursorClicking] = useState(false);
  const [cursorAction, setCursorAction] = useState<string>("Ready");
  const [cursorDuration, setCursorDuration] = useState<number>(500);
  const [virtualHover, setVirtualHover] = useState<string | null>(null);
  const [isUserActive, setIsUserActive] = useState(false);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const formatJson = (source: string) => {
    try {
      const parsed = JSON.parse(source);
      const formatted = JSON.stringify(parsed, null, 2);
      setContent(formatted);
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
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  // Autonomous Lifelike Cursor Motion Loop for Formatter
  useEffect(() => {
    if (isUserActive) return;

    let step = 0;
    const timeouts: NodeJS.Timeout[] = [];

    const cycle = () => {
      if (isUserActive) return;

      if (step === 0) {
        // Glide to Minify button with pixel accuracy
        setCursorDuration(460);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-action="minify"]', { x: 28, y: 12 })
        );
        setCursorAction("Minify");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("minify");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            minifyJson(content);
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 480)
        );
      } else if (step === 1) {
        // Drift over the minified output
        setCursorDuration(600);
        setCursorPos(
          getTargetCenter(containerRef.current, ".dash-code-editor-wrap", { x: 55, y: 48 })
        );
        setCursorAction("Compressed");
      } else if (step === 2) {
        // Glide to Prettify button with pixel accuracy
        setCursorDuration(500);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-action="prettify"]', { x: 10, y: 12 })
        );
        setCursorAction("Prettify");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("prettify");
          }, 320)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            formatJson(content);
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 500)
        );
      } else if (step === 3) {
        // Glide to Copy button with pixel accuracy
        setCursorDuration(550);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-action="copy"]', { x: 94, y: 12 })
        );
        setCursorAction("Copy");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("copy");
          }, 350)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 550)
        );
      } else if (step === 4) {
        // Drift to metrics footer
        setCursorDuration(600);
        setCursorPos(
          getTargetCenter(containerRef.current, ".dash-fmt-footer", { x: 35, y: 88 })
        );
        setCursorAction("Valid JSON");
      }

      step = (step + 1) % 5;
    };

    cycle();
    const interval = setInterval(cycle, 1850);

    return () => {
      clearInterval(interval);
      timeouts.forEach(clearTimeout);
      setVirtualHover(null);
    };
  }, [isUserActive, content]);

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
      className="dash-demo-box dash-demo-formatters"
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Animated Virtual Cursor with Pixel-Accurate Positioning */}
      <VirtualCursor
        x={cursorPos.x}
        y={cursorPos.y}
        isPercent={cursorPos.isPercent}
        isClicking={cursorClicking}
        visible={!isUserActive}
        actionText={cursorAction}
        transitionDuration={cursorDuration}
      />

      {/* Mini Controls Bar */}
      <div className="dash-demo-bar">
        <div className="dash-fmt-actions">
          <div className="dash-fmt-pill-group">
            <button
              data-action="prettify"
              type="button"
              className={`dash-fmt-pill-btn ${virtualHover === "prettify" ? "is-virtual-hover" : ""}`}
              onClick={handlePrettify}
              title="Parse and format JSON"
            >
              <AlignLeft className="h-2.5 w-2.5" />
              <span>Prettify</span>
            </button>
            <button
              data-action="minify"
              type="button"
              className={`dash-fmt-pill-btn ${virtualHover === "minify" ? "is-virtual-hover" : ""}`}
              onClick={handleMinify}
              title="Minify JSON into single line"
            >
              <Minimize2 className="h-2.5 w-2.5" />
              <span>Minify</span>
            </button>
          </div>
        </div>

        <button
          data-action="copy"
          type="button"
          className={`dash-demo-icon-btn ${virtualHover === "copy" ? "is-virtual-hover" : ""}`}
          onClick={handleCopy}
          title="Copy formatted output"
        >
          {copied ? (
            <Check className="h-3 w-3 text-emerald-400" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
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
            onClick={(e) => e.stopPropagation()}
            spellCheck={false}
            rows={content.split("\n").length}
          />
        </div>
      </div>

      {/* Real Validation & Efficiency Metrics Bar */}
      <div className="dash-fmt-footer">
        {error ? (
          <span className="dash-fmt-error">
            <AlertCircle className="h-3 w-3 text-rose-400" />
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
            <span className="dash-fmt-stat">Browser parser</span>
          </>
        )}
      </div>
    </div>
  );
}
