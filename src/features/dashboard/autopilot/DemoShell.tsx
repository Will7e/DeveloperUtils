// ============================================================
// DemoShell — window chrome shared by every dashboard live demo
// ============================================================

import { useState, type ReactNode } from "react";
import { StatusDot } from "@/components/ui/dots";
import { cn } from "@/lib/utils";
import { DemoChromeSlotContext } from "./demoChromeSlot";

export interface DemoShellProps {
  /** Fake file name shown in the title bar. */
  title: string;
  /** Short runtime/tech chips rendered next to the title. */
  meta?: string[];
  /** Accessible name for the interactive region. */
  label: string;
  className?: string;
  children: ReactNode;
}

export function DemoShell({ title, meta, label, className, children }: DemoShellProps) {
  // Portal target for the demo's own controls (see DemoControls).
  const [controlsSlot, setControlsSlot] = useState<HTMLDivElement | null>(null);

  return (
    <div className={cn("dash-window-mockup", className)}>
      <div className="dash-window-titlebar">
        <div className="dash-window-dots" aria-hidden="true">
          <span className="dash-window-dot dot-red" />
          <span className="dash-window-dot dot-yellow" />
          <span className="dash-window-dot dot-green" />
        </div>

        <div className="dash-window-title">
          <span className="dash-window-url">{title}</span>
          {meta?.map((chip) => (
            <span key={chip} className="dash-window-chip">
              {chip}
            </span>
          ))}
        </div>

        <div className="dash-window-controls" ref={setControlsSlot} />

        <span className="dash-window-live" title="This demo is running">
          <StatusDot status="success" size="sm" pulse />
          <span className="dash-window-live-text">Live demo</span>
        </span>
      </div>

      <div className="dash-window-body" role="group" aria-label={label}>
        <DemoChromeSlotContext.Provider value={controlsSlot}>
          {children}
        </DemoChromeSlotContext.Provider>
      </div>
    </div>
  );
}
