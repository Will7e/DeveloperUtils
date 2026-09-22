import { useState, useRef } from "react";
import { Play, RotateCcw, Terminal, Code2 } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { renderHighlightedTs, stripTsTypes } from "./syntaxHighlight";
import { DemoControls, useAutopilot, type AutopilotStep } from "../autopilot";
import { requestHandoff } from "@/services/handoff.service";

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

const FIBONACCI = PRESETS[0]!;
const UUID = PRESETS[2]!;

export function CompilerPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState(FIBONACCI.id);
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

  // DEMO-ONLY execution on the app origin.
  //
  // Unlike the real code runner (a Web Worker with no DOM/storage access),
  // this runs `new Function` in the page, so the code shares this origin's
  // localStorage, IDB and session. That is acceptable only because `code` can
  // solely ever be a bundled preset or text the user typed into the textarea
  // above — it is never hydrated from storage, a URL or model output.
  // Keep that invariant if this demo ever starts accepting input from outside
  // the component; otherwise route it through compiler.service instead.
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

  const selectPreset = (preset: ScriptPreset) => {
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

  const activePreset = PRESETS.find((preset) => preset.id === selectedPresetId) ?? FIBONACCI;

  const steps: AutopilotStep[] = [
    {
      target: '[data-action="run"]',
      fallback: { x: 88, y: 12 },
      action: "Run script",
      hover: "run",
      run: () => executeCode(code),
    },
    {
      target: ".dash-perf-badge",
      fallback: { x: 62, y: 78 },
      action: "Check the timing",
      transition: 700,
    },
    {
      target: '[data-tab="crypto"]',
      fallback: { x: 44, y: 12 },
      action: `Preset: ${UUID.name}`,
      hover: "crypto",
      run: () => selectPreset(UUID),
    },
    {
      target: '[data-action="run"]',
      fallback: { x: 88, y: 12 },
      action: "Run the UUID script",
      hover: "run",
      run: () => executeCode(UUID.code),
    },
    {
      target: ".dash-demo-console-logs",
      fallback: { x: 50, y: 72 },
      action: "Verify the output",
      transition: 650,
    },
    {
      target: '[data-tab="fibonacci"]',
      fallback: { x: 14, y: 12 },
      action: `Preset: ${FIBONACCI.name}`,
      hover: "fibonacci",
      run: () => selectPreset(FIBONACCI),
    },
  ];

  const autopilot = useAutopilot(containerRef, steps, { stepMs: 1750 });

  return (
    <div
      ref={containerRef}
      className="dash-demo-box dash-demo-compiler"
      {...autopilot.containerProps}
    >
      <VirtualCursor {...autopilot.cursorProps} />

      <DemoControls
        autopilot={autopilot}
        openLabel="Open in Compiler"
        onOpen={() =>
          requestHandoff({
            target: "compiler",
            label: activePreset.name,
            compiler: {
              code,
              language: "typescript",
              fileName: activePreset.name,
            },
          })
        }
      />

      {/* Tab bar & Run action */}
      <div className="dash-demo-bar">
        <div className="dash-demo-tabs">
          <div className="dash-file-tab">
            <Code2 className="h-3 w-3 text-[var(--accent)]" />
            <span>{activePreset.name}</span>
          </div>
          <div className="dash-presets-divider" />
          <div className="dash-presets-group">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                data-tab={p.id}
                type="button"
                className={`dash-preset-chip ${selectedPresetId === p.id ? "active" : ""} ${autopilot.hoverClass(p.id)}`}
                onClick={() => selectPreset(p)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div className="dash-demo-actions">
          <button
            data-action="run"
            type="button"
            className={`dash-run-btn ${isRunning ? "loading" : ""} ${autopilot.hoverClass("run")}`}
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
            spellCheck={false}
            aria-label="Demo script"
            rows={code.split("\n").length}
          />
        </div>
      </div>

      {/* Live Output Stream Console */}
      <div className="dash-demo-console">
        <div className="dash-demo-console-header">
          <div className="dash-demo-console-title">
            <Terminal className="h-3 w-3 text-[var(--ds-gray-700)]" />
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
