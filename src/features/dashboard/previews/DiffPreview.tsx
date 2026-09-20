import { useState, useRef } from "react";
import { Columns2, AlignJustify } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { renderHighlightedTs } from "./syntaxHighlight";
import { DemoControls, useAutopilot, type AutopilotStep } from "../autopilot";
import { requestHandoff } from "@/services/handoff.service";

interface DiffPreset {
  id: string;
  name: string;
  language: string;
  original: string[];
  modified: string[];
}

const DIFF_PRESETS: DiffPreset[] = [
  {
    id: "network",
    name: "server.ts",
    language: "typescript",
    original: ["const port = 8080;", 'const host = "127.0.0.1";'],
    modified: ["const port = 8080;", 'const host = "0.0.0.0";', "const tls = true;"],
  },
  {
    id: "auth",
    name: "auth.ts",
    language: "typescript",
    original: ['export const ALGO = "HS256";', "export const TTL = 3600;"],
    modified: ['export const ALGO = "RS256";', "export const TTL = 7200;", "export const AUD = true;"],
  },
  {
    id: "sql",
    name: "query.sql",
    language: "sql",
    original: ["SELECT id, name FROM users;", "WHERE active = true;"],
    modified: ["SELECT id, name, email FROM users;", "WHERE active = true;", "LIMIT 50;"],
  },
];

const FIRST_PRESET = DIFF_PRESETS[0]!;
const AUTH_PRESET = DIFF_PRESETS[1]!;

export function DiffPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewMode, setViewMode] = useState<"unified" | "split">("split");
  const [activePresetId, setActivePresetId] = useState(FIRST_PRESET.id);

  const preset: DiffPreset = DIFF_PRESETS.find((p) => p.id === activePresetId) ?? FIRST_PRESET;

  const addedLines = preset.modified.filter((line) => !preset.original.includes(line));
  const removedLines = preset.original.filter((line) => !preset.modified.includes(line));

  const steps: AutopilotStep[] = [
    {
      target: `[data-preset="${AUTH_PRESET.id}"]`,
      fallback: { x: 28, y: 12 },
      action: AUTH_PRESET.name,
      hover: `preset-${AUTH_PRESET.id}`,
      run: () => setActivePresetId(AUTH_PRESET.id),
    },
    {
      target: '[data-mode="unified"]',
      fallback: { x: 90, y: 12 },
      action: "Inline view",
      hover: "mode-unified",
      transition: 520,
      run: () => setViewMode("unified"),
    },
    {
      target: ".dash-diff-unified",
      fallback: { x: 45, y: 55 },
      action: "Review the changes",
      transition: 650,
    },
    {
      target: '[data-mode="split"]',
      fallback: { x: 78, y: 12 },
      action: "Split view",
      hover: "mode-split",
      run: () => setViewMode("split"),
    },
    {
      target: `[data-preset="${FIRST_PRESET.id}"]`,
      fallback: { x: 10, y: 12 },
      action: FIRST_PRESET.name,
      hover: `preset-${FIRST_PRESET.id}`,
      run: () => setActivePresetId(FIRST_PRESET.id),
    },
  ];

  const autopilot = useAutopilot(containerRef, steps, { stepMs: 1850 });

  return (
    <div
      ref={containerRef}
      className="dash-demo-box dash-demo-diff"
      {...autopilot.containerProps}
    >
      <VirtualCursor {...autopilot.cursorProps} />

      <DemoControls
        autopilot={autopilot}
        openLabel="Open in Diff Checker"
        onOpen={() =>
          requestHandoff({
            target: "diff",
            label: preset.name,
            diff: {
              original: preset.original.join("\n"),
              modified: preset.modified.join("\n"),
              name: preset.name,
              language: preset.language,
            },
          })
        }
      />

      {/* View Switcher & Presets Bar */}
      <div className="dash-diff-topbar">
        <div className="dash-diff-presets">
          {DIFF_PRESETS.map((p) => (
            <button
              key={p.id}
              data-preset={p.id}
              type="button"
              className={`dash-diff-preset-btn ${activePresetId === p.id ? "active" : ""} ${autopilot.hoverClass(`preset-${p.id}`)}`}
              onClick={() => setActivePresetId(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>

        <div className="dash-diff-modes">
          <span className="dash-diff-chip add">+{addedLines.length}</span>
          <span className="dash-diff-chip del">-{removedLines.length}</span>
          <button
            data-mode="split"
            type="button"
            className={`dash-diff-mode-btn ${viewMode === "split" ? "active" : ""} ${autopilot.hoverClass("mode-split")}`}
            onClick={() => setViewMode("split")}
            title="Side by side split comparison"
          >
            <Columns2 className="h-2.5 w-2.5" />
            <span>Split</span>
          </button>
          <button
            data-mode="unified"
            type="button"
            className={`dash-diff-mode-btn ${viewMode === "unified" ? "active" : ""} ${autopilot.hoverClass("mode-unified")}`}
            onClick={() => setViewMode("unified")}
            title="Unified line by line diff"
          >
            <AlignJustify className="h-2.5 w-2.5" />
            <span>Unified</span>
          </button>
        </div>

      </div>

      {/* Diff Code Area */}
      <div className="dash-diff-body">
        {viewMode === "unified" ? (
          <div className="dash-diff-unified">
            {preset.original.map((line, idx) => {
              const isRemoved = !preset.modified.includes(line);
              return (
                <div key={`orig-${idx}`} className={`dash-diff-line ${isRemoved ? "del" : "same"}`}>
                  <span className="dash-diff-ln">{idx + 1}</span>
                  <span className="dash-diff-sym">{isRemoved ? "-" : " "}</span>
                  <span className="dash-diff-txt">{renderHighlightedTs(line)}</span>
                </div>
              );
            })}
            {addedLines.map((line, idx) => (
              <div key={`add-${idx}`} className="dash-diff-line add">
                <span className="dash-diff-ln">+</span>
                <span className="dash-diff-sym">+</span>
                <span className="dash-diff-txt">{renderHighlightedTs(line)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="dash-diff-split">
            {/* Left Pane (Original) */}
            <div className="dash-diff-pane">
              <div className="dash-diff-pane-tag">Original</div>
              {preset.original.map((line, idx) => {
                const isRemoved = !preset.modified.includes(line);
                return (
                  <div key={idx} className={`dash-diff-line ${isRemoved ? "del" : "same"}`}>
                    <span className="dash-diff-ln">{idx + 1}</span>
                    <span className="dash-diff-txt">{renderHighlightedTs(line)}</span>
                  </div>
                );
              })}
            </div>

            {/* Right Pane (Modified) */}
            <div className="dash-diff-pane">
              <div className="dash-diff-pane-tag modified">Modified</div>
              {preset.modified.map((line, idx) => {
                const isAdded = !preset.original.includes(line);
                return (
                  <div key={idx} className={`dash-diff-line ${isAdded ? "add" : "same"}`}>
                    <span className="dash-diff-ln">{idx + 1}</span>
                    <span className="dash-diff-txt">{renderHighlightedTs(line)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
