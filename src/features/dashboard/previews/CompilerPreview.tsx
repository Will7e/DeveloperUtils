import { useState, useEffect, useRef } from "react";
import { Play, RotateCcw, Terminal, Code2 } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { renderHighlightedTs, stripTsTypes } from "./syntaxHighlight";
import { getTargetCenter, type CursorPosition } from "../components/cursorUtils";

interface ScriptPreset {
  id: string;
  name: string;
  code: string;
}

const PRESETS: ScriptPreset[] = [
  {
    id: "fibonacci",
    name: "fibonacci.ts",
    code: `function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}\nconsole.log("Computing fibonacci(16)...");\nconst result: number = fibonacci(16);\nconsole.log("Calculated:", result);\nreturn result;`,
  },
  {
    id: "quicksort",
    name: "sort.ts",
    code: `const data: number[] = [64, 25, 12, 22, 11, 90];\nconsole.log("Original array:", JSON.stringify(data));\nconst sorted: number[] = [...data].sort((a: number, b: number): number => a - b);\nconsole.log("Sorted array:", JSON.stringify(sorted));\nreturn sorted;`,
  },
  {
    id: "crypto",
    name: "uuid.ts",
    code: `const uuid: string = crypto.randomUUID();\nconsole.log("Entropy: 128 bit cryptographically secure");\nconsole.log("UUID:", uuid);\nreturn uuid;`,
  },
];

export function CompilerPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState("fibonacci");
  const [code, setCode] = useState(PRESETS[0]!.code);
  const [isRunning, setIsRunning] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number>(0.08);
  const [returnValue, setReturnValue] = useState<string>("987");
  const [logs, setLogs] = useState<string[]>([
    "Console ready",
    "Calculated: 987",
  ]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const syntaxRef = useRef<HTMLPreElement | null>(null);

  const handleScroll = () => {
    if (textareaRef.current && syntaxRef.current) {
      syntaxRef.current.scrollTop = textareaRef.current.scrollTop;
      syntaxRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  };

  // Virtual Cursor Autopilot State (Pixel-accurate coordinates)
  const [cursorPos, setCursorPos] = useState<CursorPosition>({ x: 88, y: 12, isPercent: true });
  const [cursorClicking, setCursorClicking] = useState(false);
  const [cursorAction, setCursorAction] = useState<string>("Ready");
  const [virtualHover, setVirtualHover] = useState<string | null>(null);
  const [cursorDuration, setCursorDuration] = useState(550);
  const [isUserActive, setIsUserActive] = useState(false);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const executeCode = (sourceCode: string) => {
    setIsRunning(true);
    const capturedLogs: string[] = [];
    const mockConsole = {
      log: (...args: unknown[]) => {
        capturedLogs.push(
          args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")
        );
      },
    };

    const t0 = performance.now();
    try {
      const cleanCode = stripTsTypes(sourceCode);
      const runner = new Function("console", cleanCode);
      const res = runner(mockConsole);
      const duration = Math.max(0.02, performance.now() - t0);

      setTimeout(() => {
        setLatencyMs(Number(duration.toFixed(3)));
        setReturnValue(typeof res === "object" ? JSON.stringify(res) : String(res));
        setLogs(
          capturedLogs.length > 0
            ? capturedLogs.map((l) => `▶ ${l}`)
            : [`▶ Script executed with return value: ${res}`]
        );
        setIsRunning(false);
      }, 100);
    } catch (err: unknown) {
      const duration = performance.now() - t0;
      setTimeout(() => {
        setLatencyMs(Number(duration.toFixed(3)));
        setLogs([`✖ Error: ${err instanceof Error ? err.message : String(err)}`]);
        setIsRunning(false);
      }, 100);
    }
  };

  const handleSelectPreset = (preset: ScriptPreset) => {
    setSelectedPresetId(preset.id);
    setCode(preset.code);
  };

  const handleRun = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (isRunning) return;
    executeCode(code);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLogs(["Console cleared"]);
    setReturnValue("");
  };

  // Autonomous Lifelike Cursor Sequence Loop
  useEffect(() => {
    if (isUserActive) return;

    let step = 0;
    const timeouts: NodeJS.Timeout[] = [];

    const cycle = () => {
      if (isUserActive) return;

      if (step === 0) {
        // Glide to "Run Script" button with pixel accuracy
        setCursorDuration(500);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-action="run"]', { x: 88, y: 12 })
        );
        setCursorAction("Run");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("run");
          }, 350)
        );
        // Click Run
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setCursorAction("Executing...");
            executeCode(code);
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 220)
            );
          }, 550)
        );
      } else if (step === 1) {
        // Drift to Console Output to inspect result
        setCursorDuration(700);
        setCursorPos(
          getTargetCenter(containerRef.current, ".dash-perf-badge", { x: 62, y: 78 })
        );
        setCursorAction("Inspect Result");
      } else if (step === 2) {
        // Glide to UUID preset tab
        setCursorDuration(550);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-tab="crypto"]', { x: 44, y: 12 })
        );
        setCursorAction("Preset: UUID");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("crypto");
          }, 350)
        );
        // Click tab
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            const p = PRESETS[2]!;
            setSelectedPresetId(p.id);
            setCode(p.code);
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 200)
            );
          }, 550)
        );
      } else if (step === 3) {
        // Glide to Run button again
        setCursorDuration(450);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-action="run"]', { x: 88, y: 12 })
        );
        setCursorAction("Run UUID");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("run");
          }, 300)
        );
        // Click Run
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setCursorAction("Generating...");
            executeCode(PRESETS[2]!.code);
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 220)
            );
          }, 500)
        );
      } else if (step === 4) {
        // Drift across new output logs
        setCursorDuration(650);
        setCursorPos(
          getTargetCenter(containerRef.current, ".dash-demo-console-logs", { x: 50, y: 72 })
        );
        setCursorAction("Verified UUID");
      } else if (step === 5) {
        // Glide to Fibonacci preset tab
        setCursorDuration(550);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-tab="fibonacci"]', { x: 14, y: 12 })
        );
        setCursorAction("Preset: Fib");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("fibonacci");
          }, 350)
        );
        // Click tab
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            const p = PRESETS[0]!;
            setSelectedPresetId(p.id);
            setCode(p.code);
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 200)
            );
          }, 550)
        );
      }

      step = (step + 1) % 6;
    };

    cycle();
    const interval = setInterval(cycle, 1750);

    return () => {
      clearInterval(interval);
      timeouts.forEach(clearTimeout);
      setVirtualHover(null);
    };
  }, [isUserActive, code]);

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
      className="dash-demo-box dash-demo-compiler"
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
        color="var(--accent, #38bdf8)"
        transitionDuration={cursorDuration}
      />

      {/* Tab bar & Run action */}
      <div className="dash-demo-bar">
        <div className="dash-demo-tabs">
          <div className="dash-file-tab">
            <Code2 className="h-3 w-3 text-sky-400" />
            <span>script.ts</span>
          </div>
          <div className="dash-presets-divider" />
          <div className="dash-presets-group">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                data-tab={p.id}
                type="button"
                className={`dash-preset-chip ${selectedPresetId === p.id ? "active" : ""} ${virtualHover === p.id ? "is-virtual-hover" : ""}`}
                onClick={() => handleSelectPreset(p)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <button
          data-action="run"
          type="button"
          className={`dash-run-btn ${isRunning ? "loading" : ""} ${virtualHover === "run" ? "is-virtual-hover" : ""}`}
          onClick={handleRun}
          disabled={isRunning}
          title="Run script"
        >
          {isRunning ? (
            <span className="dash-spinner-dots" />
          ) : (
            <>
              <Play className="h-2.5 w-2.5 fill-current" />
              <span>Run</span>
            </>
          )}
        </button>
      </div>

      {/* Code Editor Area */}
      <div className="dash-demo-code-area">
        <div className="dash-demo-gutter">
          {code.split("\n").map((_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <div className="dash-code-editor-wrap">
          <pre ref={syntaxRef} className="dash-syntax-layer" aria-hidden="true">
            <code>{renderHighlightedTs(code)}</code>
          </pre>
          <textarea
            ref={textareaRef}
            className="dash-demo-editor"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onScroll={handleScroll}
            onClick={(e) => e.stopPropagation()}
            spellCheck={false}
            rows={code.split("\n").length}
          />
        </div>
      </div>

      {/* Live Output Stream Console */}
      <div className="dash-demo-console">
        <div className="dash-demo-console-header">
          <div className="dash-demo-console-title">
            <Terminal className="h-3 w-3 text-slate-400" />
            <span>Console Output</span>
            <span className="dash-perf-badge">{latencyMs}ms</span>
            {returnValue && (
              <span className="dash-return-badge">
                Return: <code>{returnValue}</code>
              </span>
            )}
          </div>
          <button
            type="button"
            className="dash-demo-icon-btn"
            onClick={handleClear}
            title="Clear output console"
          >
            <RotateCcw className="h-2.5 w-2.5" />
          </button>
        </div>
        <div className="dash-demo-console-logs">
          {logs.map((log, idx) => (
            <div key={idx} className="dash-demo-log-line">
              {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
