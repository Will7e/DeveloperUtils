// ============================================================
// DemoControls — pause/play + hand-off control for a live demo
// ============================================================
// Rendered by the demo body (which owns the autopilot state) but portalled
// into the window chrome, so every demo keeps the same control location
// without crowding its own toolbar.

import { useContext } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Pause, Play } from "lucide-react";
import { DemoChromeSlotContext } from "./demoChromeSlot";
import type { Autopilot } from "./useAutopilot";

export interface DemoControlsProps {
  autopilot: Autopilot;
  /** Hands the demo's current state to the real tool. */
  onOpen: () => void;
  openLabel: string;
}

export function DemoControls({ autopilot, onOpen, openLabel }: DemoControlsProps) {
  const slot = useContext(DemoChromeSlotContext);
  const { isPaused } = autopilot.controls;

  if (!slot) return null;

  return createPortal(
    <div className="dash-demo-controls">
      <button type="button" className="dash-demo-control" onClick={onOpen} title={openLabel}>
        <ArrowUpRight className="h-3 w-3" />
        <span className="dash-demo-control-label">{openLabel}</span>
      </button>

      <button
        type="button"
        className="dash-demo-control"
        onClick={isPaused ? autopilot.controls.play : autopilot.controls.pause}
        aria-pressed={!isPaused}
        title={isPaused ? "Resume the demo" : "Pause the demo"}
      >
        {isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        <span className="dash-demo-control-label">{isPaused ? "Play" : "Pause"}</span>
      </button>
    </div>,
    slot
  );
}
