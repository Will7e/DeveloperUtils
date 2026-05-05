// ============================================================
// NodePalette — Draggable node sidebar with categorized types
// ============================================================

import { type DragEvent } from "react";
import { Play, Square, Cog, GitBranch, Database, Globe, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import type { WorkflowNodeType } from "@/types";

interface PaletteItem {
  type: WorkflowNodeType;
  reactFlowType: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  glow: string;
}

const PALETTE_ITEMS: PaletteItem[] = [
  {
    type: "start",
    reactFlowType: "startNode",
    label: "Start",
    description: "Entry point",
    icon: <Play className="h-4 w-4" />,
    color: "#22c55e",
    glow: "rgba(34, 197, 94, 0.15)",
  },
  {
    type: "end",
    reactFlowType: "endNode",
    label: "End",
    description: "Exit point",
    icon: <Square className="h-4 w-4" />,
    color: "#ef4444",
    glow: "rgba(239, 68, 68, 0.15)",
  },
  {
    type: "process",
    reactFlowType: "processNode",
    label: "Process",
    description: "Action step",
    icon: <Cog className="h-4 w-4" />,
    color: "#0ea5e9",
    glow: "rgba(14, 165, 233, 0.15)",
  },
  {
    type: "decision",
    reactFlowType: "decisionNode",
    label: "Decision",
    description: "Conditional branch",
    icon: <GitBranch className="h-4 w-4" />,
    color: "#f59e0b",
    glow: "rgba(245, 158, 11, 0.15)",
  },
  {
    type: "data",
    reactFlowType: "dataNode",
    label: "Data",
    description: "Data operation",
    icon: <Database className="h-4 w-4" />,
    color: "#a78bfa",
    glow: "rgba(167, 139, 250, 0.15)",
  },
  {
    type: "integration",
    reactFlowType: "integrationNode",
    label: "Integration",
    description: "External API",
    icon: <Globe className="h-4 w-4" />,
    color: "#2dd4bf",
    glow: "rgba(45, 212, 191, 0.15)",
  },
];

export function NodePalette() {
  const collapsed = useAppStore((s) => s.workflowPaletteCollapsed);
  const setCollapsed = useAppStore((s) => s.setWorkflowPaletteCollapsed);

  const onDragStart = (e: DragEvent, item: PaletteItem) => {
    e.dataTransfer.setData(
      "application/reactflow",
      JSON.stringify({
        type: item.reactFlowType,
        nodeType: item.type,
        label: item.label,
      })
    );
    e.dataTransfer.effectAllowed = "move";
  };

  // Collapsed: show only draggable icons with tooltips (like the compiler sidebar)
  if (collapsed) {
    return (
      <div className="wf-palette wf-palette-collapsed">
        <button
          className="wf-panel-collapse-btn wf-palette-expand-btn"
          onClick={() => setCollapsed(false)}
          title="Expand Nodes"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <div className="wf-palette-icons">
          {PALETTE_ITEMS.map((item) => (
            <Tooltip key={item.type}>
              <TooltipTrigger asChild>
                <div
                  className="wf-palette-icon-item"
                  draggable
                  onDragStart={(e) => onDragStart(e, item)}
                  style={{ 
                    "--item-color": item.color,
                    "--item-glow": item.glow 
                  } as React.CSSProperties}
                >
                  <div className="wf-palette-icon-wrapper">
                    {item.icon}
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" className="bg-popover border-border shadow-xl">
                {item.label}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="wf-palette">
      <div className="wf-palette-header">
        <span className="wf-palette-title">Nodes</span>
        <div className="wf-palette-header-actions">
          <span className="wf-palette-hint">Drag to canvas</span>
          <button
            className="wf-panel-collapse-btn"
            onClick={() => setCollapsed(true)}
            title="Collapse Nodes"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="wf-palette-list">
        {PALETTE_ITEMS.map((item) => (
          <div
            key={item.type}
            className="wf-palette-item"
            draggable
            onDragStart={(e) => onDragStart(e, item)}
            style={{ 
              "--item-color": item.color,
              "--item-glow": item.glow 
            } as React.CSSProperties}
          >
            <div className="wf-palette-item-icon">
              {item.icon}
            </div>
            <div className="wf-palette-item-info">
              <span className="wf-palette-item-label">{item.label}</span>
              <span className="wf-palette-item-desc">{item.description}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
