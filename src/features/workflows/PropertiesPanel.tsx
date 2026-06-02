// ============================================================
// PropertiesPanel — Edit selected node/edge properties
// ============================================================

import { useCallback, useEffect, useState, useRef } from "react";
import { X, Type, AlignLeft, Tag, ChevronRight, Play, Square, Cog, GitBranch, Database, Globe, Share2, Activity, Zap } from "lucide-react";
import { useAppStore } from "@/stores/app.store";

import { type Node as FlowNode, type Edge as FlowEdge } from "@xyflow/react";

interface PropertiesPanelProps {
  selectedNode?: FlowNode | null;
  selectedEdge?: FlowEdge | null;
  onNodeDataChange?: (nodeId: string, data: Record<string, unknown>) => void;
  onEdgeDataChange?: (edgeId: string, data: Record<string, unknown>) => void;
}

const TYPE_ICONS: Record<string, React.ReactNode> = {
  start: <Play className="h-3.5 w-3.5" style={{ color: "var(--green)" }} />,
  end: <Square className="h-3.5 w-3.5" style={{ color: "var(--red)" }} />,
  process: <Cog className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />,
  decision: <GitBranch className="h-3.5 w-3.5" style={{ color: "var(--yellow)" }} />,
  data: <Database className="h-3.5 w-3.5" style={{ color: "var(--purple)" }} />,
  integration: <Globe className="h-3.5 w-3.5" style={{ color: "var(--teal)" }} />,
};

export function PropertiesPanel({ 
  selectedNode, 
  selectedEdge, 
  onNodeDataChange, 
  onEdgeDataChange 
}: PropertiesPanelProps) {
  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const selectedNodeId = useAppStore((s) => s.workflowSelectedNodeId);
  const selectedEdgeId = useAppStore((s) => s.workflowSelectedEdgeId);
  const updateWorkflowNodes = useAppStore((s) => s.updateWorkflowNodes);
  const updateWorkflowEdges = useAppStore((s) => s.updateWorkflowEdges);
  const setWorkflowSelectedNodeId = useAppStore((s) => s.setWorkflowSelectedNodeId);

  const collapsed = useAppStore((s) => s.workflowPropertiesCollapsed);
  const setCollapsed = useAppStore((s) => s.setWorkflowPropertiesCollapsed);

  const workflow = workflows.find((w) => w.id === activeWorkflowId);

  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [edgeLabel, setEdgeLabel] = useState("");
  const lastSelectedId = useRef<string | null>(null);

  useEffect(() => {
    const currentId = selectedNodeId || selectedEdgeId;
    if (currentId !== lastSelectedId.current) {
      if (selectedNode) {
        setLabel((selectedNode.data.label as string) || "");
        setDescription((selectedNode.data.description as string) || "");
      }
      if (selectedEdge) {
        setEdgeLabel((selectedEdge.label as string) || "");
      }
      lastSelectedId.current = currentId;
    }
  }, [selectedNode, selectedEdge, selectedNodeId, selectedEdgeId]);

  const handleNodeUpdate = useCallback(
    (updatedLabel?: string, updatedDescription?: string) => {
      if (!selectedNode || !onNodeDataChange) return;
      const finalLabel = updatedLabel ?? label;
      const finalDescription = updatedDescription ?? description;

      onNodeDataChange(selectedNode.id, {
        ...selectedNode.data,
        label: finalLabel,
        description: finalDescription,
      });
    },
    [selectedNode, label, description, onNodeDataChange]
  );

  const handleLabelChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newLabel = e.target.value;
      setLabel(newLabel);
      // Live-update for responsive feel
      if (workflow && selectedNode && onNodeDataChange) {
        onNodeDataChange(selectedNode.id, {
          ...selectedNode.data,
          label: newLabel,
          description,
        });
      }
    },
    [workflow, selectedNode, description, onNodeDataChange]
  );

  const handleDescriptionChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newDesc = e.target.value;
      setDescription(newDesc);
      // Live-update for responsive feel
      if (workflow && selectedNode && onNodeDataChange) {
        onNodeDataChange(selectedNode.id, {
          ...selectedNode.data,
          label,
          description: newDesc,
        });
      }
    },
    [workflow, selectedNode, label, onNodeDataChange]
  );

  const handleEdgeUpdate = useCallback((data: Record<string, any>) => {
    if (!selectedEdge || !onEdgeDataChange) return;
    onEdgeDataChange(selectedEdge.id, data);
  }, [selectedEdge, onEdgeDataChange]);

  const handleEdgeLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newLabel = e.target.value;
    setEdgeLabel(newLabel);
    if (workflow && selectedEdge) {
      handleEdgeUpdate({ label: newLabel });
    }
  }, [workflow, selectedEdge, handleEdgeUpdate]);

  const handleNodeTypeChange = useCallback(
    (newNodeType: "start" | "end" | "process" | "decision" | "data" | "integration") => {
      if (!selectedNode || !onNodeDataChange) return;
      
      onNodeDataChange(selectedNode.id, {
        ...selectedNode.data,
        nodeType: newNodeType,
      });
    },
    [selectedNode, onNodeDataChange]
  );

  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!showTypeMenu) return;
    const handler = (e: MouseEvent) => {
      if (typeMenuRef.current && !typeMenuRef.current.contains(e.target as Node)) {
        setShowTypeMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showTypeMenu]);

  // Collapsed state
  if (collapsed) {
    return (
      <div className="wf-properties wf-properties-collapsed">
        <button
          className="wf-panel-collapse-btn"
          onClick={() => setCollapsed(false)}
          title="Expand Properties"
        >
          <ChevronRight className="h-3.5 w-3.5" style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>
    );
  }

  // No selection
  if (!selectedNode && !selectedEdge) {
    return (
      <div className="wf-properties">
        <div className="wf-properties-header">
          <span className="wf-properties-title">Properties</span>
          <button
            className="wf-panel-collapse-btn"
            onClick={() => setCollapsed(true)}
            title="Collapse Properties"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="wf-properties-empty">
          <span className="wf-properties-empty-text">
            Select a node or edge to edit its properties
          </span>
        </div>
      </div>
    );
  }

  // Node selected
  if (selectedNode) {
    return (
      <div className="wf-properties">
        <div className="wf-properties-header">
          <span className="wf-properties-title">Node Properties</span>
          <div className="wf-properties-header-actions">
            <button
              className="wf-properties-close"
              onClick={() => setWorkflowSelectedNodeId(null)}
              title="Deselect"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <button
              className="wf-panel-collapse-btn"
              onClick={() => setCollapsed(true)}
              title="Collapse Properties"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="wf-properties-body">
          <div className="wf-prop-group">
            <div className="wf-prop-label">
              <Tag className="h-3 w-3" />
              <span>Type</span>
            </div>
            <div className="wf-prop-dropdown-container" ref={typeMenuRef}>
              <button 
                className="wf-prop-dropdown-btn" 
                onClick={() => setShowTypeMenu(!showTypeMenu)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {TYPE_ICONS[selectedNode.data.nodeType as string]}
                  <span>{selectedNode.data.nodeType as string}</span>
                </div>
                <ChevronRight className="h-3.5 w-3.5" style={{ transform: showTypeMenu ? "rotate(-90deg)" : "rotate(90deg)" }} />
              </button>
              
              {showTypeMenu && (
                <div className="wf-prop-dropdown-menu">
                  {(["start", "end", "process", "decision", "data", "integration"] as const).map((type) => (
                    <button
                      key={type}
                      className="wf-prop-dropdown-item"
                      onClick={() => {
                        handleNodeTypeChange(type);
                        setShowTypeMenu(false);
                      }}
                      style={{ display: "flex", alignItems: "center", gap: "8px" }}
                    >
                      {TYPE_ICONS[type]}
                      <span>{type}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="wf-prop-group">
            <label className="wf-prop-label" htmlFor="node-label">
              <Type className="h-3 w-3" />
              <span>Label</span>
            </label>
            <input
              id="node-label"
              className="wf-prop-input"
              value={label}
              onChange={handleLabelChange}
              onBlur={() => handleNodeUpdate()}
              onKeyDown={(e) => e.key === "Enter" && handleNodeUpdate()}
            />
          </div>
          <div className="wf-prop-group">
            <label className="wf-prop-label" htmlFor="node-desc">
              <AlignLeft className="h-3 w-3" />
              <span>Description</span>
            </label>
            <textarea
              id="node-desc"
              className="wf-prop-textarea"
              value={description}
              onChange={handleDescriptionChange}
              onBlur={() => handleNodeUpdate()}
              rows={3}
              placeholder="Add a description..."
            />
          </div>
          <div className="wf-prop-group">
            <div className="wf-prop-label">
              <span>Position</span>
            </div>
            <div className="wf-prop-position">
              <span>X: {Math.round(selectedNode.position.x)}</span>
              <span>Y: {Math.round(selectedNode.position.y)}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Edge selected
  return (
    <div className="wf-properties">
      <div className="wf-properties-header">
        <span className="wf-properties-title">Edge Properties</span>
        <div className="wf-properties-header-actions">
          <button
            className="wf-properties-close"
            onClick={() => setWorkflowSelectedNodeId(null)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            className="wf-panel-collapse-btn"
            onClick={() => setCollapsed(true)}
            title="Collapse Properties"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="wf-properties-body">
        <div className="wf-prop-group">
          <label className="wf-prop-label" htmlFor="edge-label">
            <Type className="h-3 w-3" />
            <span>Label</span>
          </label>
          <input
            id="edge-label"
            className="wf-prop-input"
            value={edgeLabel}
            onChange={handleEdgeLabelChange}
            placeholder="Add label..."
          />
        </div>

        <div className="wf-prop-group">
          <div className="wf-prop-label">
            <Share2 className="h-3 w-3" />
            <span>Path Style</span>
          </div>
          <div className="wf-prop-toggle-group">
            {(["smoothstep", "straight", "bezier"] as const).map((style) => (
              <button
                key={style}
                className={cn(
                  "wf-prop-toggle-item",
                  (selectedEdge?.data?.edgeStyle || "smoothstep") === style && "active"
                )}
                onClick={() => handleEdgeUpdate({ data: { ...selectedEdge?.data, edgeStyle: style } })}
              >
                {style.charAt(0).toUpperCase() + style.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="wf-prop-group">
          <div className="wf-prop-label">
            <Zap className="h-3 w-3" />
            <span>Line Style</span>
          </div>
          <div className="wf-prop-toggle-group">
            {(["solid", "animated", "dashed"] as const).map((style) => (
              <button
                key={style}
                className={cn(
                  "wf-prop-toggle-item",
                  (selectedEdge?.data?.lineStyle || "solid") === style && "active"
                )}
                onClick={() => handleEdgeUpdate({ data: { ...selectedEdge?.data, lineStyle: style }, animated: style === "animated" })}
              >
                {style.charAt(0).toUpperCase() + style.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="wf-prop-group">
          <div className="wf-prop-label">
            <Activity className="h-3 w-3" />
            <span>Connection</span>
          </div>
          <div className="wf-prop-connection">
            <span className="wf-prop-connection-id">{selectedEdge?.source}</span>
            <span className="wf-prop-connection-arrow">→</span>
            <span className="wf-prop-connection-id">{selectedEdge?.target}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper for class merging if not already imported or defined
function cn(...classes: any[]) {
  return classes.filter(Boolean).join(" ");
}
