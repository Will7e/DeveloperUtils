// ============================================================
// DemoStage — one live demo per tool, switched from the window itself
// ============================================================
// Every tool keeps a real, interactive demo, but only one is mounted at a
// time, so the page shows eight demos while paying for one. The strip on
// the window is the only tool picker here; each demo's own title bar keeps
// the single action — hand the demo's current state to the real tool.

import { useState } from "react";
import type { ComponentType } from "react";
import { DemoShell } from "../autopilot";
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

const DEFAULT_TOOL = DASHBOARD_TOOLS[0]!;

export function DemoStage() {
  const [activeId, setActiveId] = useState<string>(DEFAULT_TOOL.id);
  const activeTool = DASHBOARD_TOOLS.find((tool) => tool.id === activeId) ?? DEFAULT_TOOL;
  const Preview = PREVIEWS[activeTool.id];

  return (
    <section className="dash-demos" aria-label="Live demos">
      <DemoShell
        title={activeTool.demoTitle}
        meta={activeTool.demoMeta}
        label={`${activeTool.short} live demo`}
      >
        <DemoSwitcher activeId={activeTool.id} onSelect={setActiveId} />

        {/* Remounting per tool keeps each demo's state clean. The shell
            itself stays mounted, so switching never steals focus. */}
        <div
          key={activeTool.id}
          id="dash-demo-panel"
          role="tabpanel"
          aria-labelledby={`demo-tab-${activeTool.id}`}
        >
          {Preview ? <Preview /> : null}
        </div>
      </DemoShell>

      <p className="dash-demos-caption">{activeTool.tagline}</p>
    </section>
  );
}
