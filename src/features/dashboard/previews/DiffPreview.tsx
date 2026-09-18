import { useState, useRef, useEffect } from "react";
import { Columns2, AlignJustify } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { renderHighlightedTs } from "./syntaxHighlight";
import { getTargetCenter, type CursorPosition } from "../components/cursorUtils";

interface DiffPreset {
  id: string;
  name: string;
  original: string[];
  modified: string[];
}

const DIFF_PRESETS: DiffPreset[] = [
  {
    id: "network",
    name: "server.ts",
    original: ["const port = 8080;", 'const host = "127.0.0.1";'],
    modified: ["const port = 8080;", 'const host = "0.0.0.0";', "const tls = true;"],
  },
  {
    id: "auth",
    name: "auth.ts",
    original: ['export const ALGO = "HS256";', "export const TTL = 3600;"],
    modified: ['export const ALGO = "RS256";', "export const TTL = 7200;", "export const AUD = true;"],
  },
  {
    id: "sql",
    name: "query.sql",
    original: ["SELECT id, name FROM users;", "WHERE active = true;"],
    modified: ["SELECT id, name, email FROM users;", "WHERE active = true;", "LIMIT 50;"],
  },
];

export function DiffPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewMode, setViewMode] = useState<"unified" | "split">("split");
  const [activePresetId, setActivePresetId] = useState("network");

  // Virtual Cursor Autopilot State (Pixel-accurate coordinates)
  const [cursorPos, setCursorPos] = useState<CursorPosition>({ x: 28, y: 12, isPercent: true });
  const [cursorClicking, setCursorClicking] = useState(false);
  const [cursorAction, setCursorAction] = useState<string>("Ready");
  const [cursorDuration, setCursorDuration] = useState<number>(500);
  const [virtualHover, setVirtualHover] = useState<string | null>(null);
  const [isUserActive, setIsUserActive] = useState(false);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const preset: DiffPreset = DIFF_PRESETS.find((p) => p.id === activePresetId) ?? DIFF_PRESETS[0]!;

  const addedLines = preset.modified.filter((line) => !preset.original.includes(line));
  const removedLines = preset.original.filter((line) => !preset.modified.includes(line));

  // Autonomous Lifelike Cursor Motion Loop for Diff
  useEffect(() => {
    if (isUserActive) return;

    let step = 0;
    const timeouts: NodeJS.Timeout[] = [];

    const cycle = () => {
      if (isUserActive) return;

      if (step === 0) {
        // Glide to auth.ts preset button with pixel accuracy
        setCursorDuration(480);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-preset="auth"]', { x: 28, y: 12 })
        );
        setCursorAction("auth.ts");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("preset-auth");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setActivePresetId("auth");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 500)
        );
      } else if (step === 1) {
        // Glide to Unified view toggle with pixel accuracy
        setCursorDuration(520);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-mode="unified"]', { x: 90, y: 12 })
        );
        setCursorAction("Unified View");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("mode-unified");
          }, 320)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setViewMode("unified");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 520)
        );
      } else if (step === 2) {
        // Drift over unified additions / deletions
        setCursorDuration(650);
        setCursorPos(
          getTargetCenter(containerRef.current, ".dash-diff-unified", { x: 45, y: 55 })
        );
        setCursorAction("Reviewing diff");
      } else if (step === 3) {
        // Glide to Split view toggle with pixel accuracy
        setCursorDuration(500);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-mode="split"]', { x: 78, y: 12 })
        );
        setCursorAction("Split View");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("mode-split");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setViewMode("split");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 500)
        );
      } else if (step === 4) {
        // Glide back to server.ts preset with pixel accuracy
        setCursorDuration(500);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-preset="network"]', { x: 10, y: 12 })
        );
        setCursorAction("server.ts");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("preset-network");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setActivePresetId("network");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 500)
        );
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
  }, [isUserActive]);

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
      className="dash-demo-box dash-demo-diff"
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

      {/* View Switcher & Presets Bar */}
      <div className="dash-diff-topbar">
        <div className="dash-diff-presets">
          {DIFF_PRESETS.map((p) => (
            <button
              key={p.id}
              data-preset={p.id}
              type="button"
              className={`dash-diff-preset-btn ${activePresetId === p.id ? "active" : ""} ${virtualHover === `preset-${p.id}` ? "is-virtual-hover" : ""}`}
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
            className={`dash-diff-mode-btn ${viewMode === "split" ? "active" : ""} ${virtualHover === "mode-split" ? "is-virtual-hover" : ""}`}
            onClick={() => setViewMode("split")}
            title="Side by side split comparison"
          >
            <Columns2 className="h-2.5 w-2.5" />
            <span>Split</span>
          </button>
          <button
            data-mode="unified"
            type="button"
            className={`dash-diff-mode-btn ${viewMode === "unified" ? "active" : ""} ${virtualHover === "mode-unified" ? "is-virtual-hover" : ""}`}
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
