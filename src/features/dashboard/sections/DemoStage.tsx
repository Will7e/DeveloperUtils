// ============================================================
// DemoStage — one live demo per tool, auto-rotating carousel
// ============================================================
// Every tool keeps a real, interactive demo, but only one is mounted at a
// time, so the page shows eight demos while paying for one. The strip on
// the window is the only tool picker here; each demo's own title bar keeps
// the single action — hand the demo's current state to the real tool.
//
// Auto-rotation: each demo gets a per-tool dwell time tuned to the
// animation length of its autopilot loop. The active tab shows a slim
// progress bar that fills as the timer counts down. Hovering the window
// or clicking a tab pauses / resets the countdown.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { DemoShell } from "../autopilot";
import { isMotionAllowed } from "../autopilot/scheduler";
import { DASHBOARD_TOOLS } from "../tools";
import {
  ApiTesterPreview,
  ChatPreview,
  ComparatorsPreview,
  CompilerPreview,
  DiffPreview,
  DrawFlowPreview,
  FormattersPreview,
  LibraryPreview,
} from "../previews";
import { DemoSwitcher } from "./DemoSwitcher";

const PREVIEWS: Record<string, ComponentType> = {
  compiler: CompilerPreview,
  "api-tester": ApiTesterPreview,
  chat: ChatPreview,
  drawflows: DrawFlowPreview,
  formatters: FormattersPreview,
  diff: DiffPreview,
  comparators: ComparatorsPreview,
  library: LibraryPreview,
};

/** Per-tool dwell time in ms — tuned to each demo's autopilot loop length
    so the carousel switches after one full cycle feels natural. */
const DWELL_MS: Record<string, number> = {
  compiler: 12_000,
  "api-tester": 14_000,
  chat: 12_000,
  drawflows: 16_000,
  formatters: 10_000,
  diff: 10_000,
  comparators: 12_000,
  library: 10_000,
};
const DEFAULT_DWELL = 12_000;

const DEFAULT_TOOL = DASHBOARD_TOOLS[0]!;

export function DemoStage() {
  const [activeId, setActiveId] = useState<string>(DEFAULT_TOOL.id);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const activeTool = DASHBOARD_TOOLS.find((tool) => tool.id === activeId) ?? DEFAULT_TOOL;
  const Preview = PREVIEWS[activeTool.id];

  const dwellMs = DWELL_MS[activeTool.id] ?? DEFAULT_DWELL;
  const startRef = useRef(Date.now());
  const elapsedRef = useRef(0);
  const rafRef = useRef<number>(0);

  const canAutoRotate = isMotionAllowed();

  const advanceToNext = useCallback(() => {
    const currentIdx = DASHBOARD_TOOLS.findIndex((t) => t.id === activeId);
    const nextIdx = (currentIdx + 1) % DASHBOARD_TOOLS.length;
    setActiveId(DASHBOARD_TOOLS[nextIdx]!.id);
  }, [activeId]);

  // Reset the timer whenever the active tool changes.
  useEffect(() => {
    elapsedRef.current = 0;
    startRef.current = Date.now();
    setProgress(0);
  }, [activeId]);

  // The rAF loop: ticks progress and triggers advance at 100%.
  useEffect(() => {
    if (!canAutoRotate || isPaused) return;

    startRef.current = Date.now() - elapsedRef.current;

    const tick = () => {
      const elapsed = Date.now() - startRef.current;
      elapsedRef.current = elapsed;
      const pct = Math.min(elapsed / dwellMs, 1);
      setProgress(pct);

      if (pct >= 1) {
        advanceToNext();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [canAutoRotate, isPaused, dwellMs, advanceToNext]);

  // Manual selection resets the timer.
  const handleSelect = useCallback((id: string) => {
    elapsedRef.current = 0;
    startRef.current = Date.now();
    setProgress(0);
    setActiveId(id);
  }, []);

  const handleMouseEnter = useCallback(() => setIsPaused(true), []);
  const handleMouseLeave = useCallback(() => setIsPaused(false), []);

  return (
    <section className="dash-demos" aria-label="Live demos">
      <DemoShell
        title={activeTool.demoTitle}
        meta={activeTool.demoMeta}
        label={`${activeTool.short} live demo`}
      >
        <DemoSwitcher
          activeId={activeTool.id}
          onSelect={handleSelect}
          progress={canAutoRotate ? progress : undefined}
          isPaused={isPaused}
        />

        {/* Remounting per tool keeps each demo's state clean. The shell
            itself stays mounted, so switching never steals focus. */}
        <div
          key={activeTool.id}
          id="dash-demo-panel"
          role="tabpanel"
          aria-labelledby={`demo-tab-${activeTool.id}`}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {Preview ? <Preview /> : null}
        </div>
      </DemoShell>

      <p className="dash-demos-caption">{activeTool.tagline}</p>
    </section>
  );
}
