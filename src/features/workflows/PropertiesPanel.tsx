// ============================================================
// PropertiesPanel — Edit selected node/edge properties
// ============================================================

import { useCallback, useEffect, useState, useRef } from "react";
import { X, Type, AlignLeft, Tag, ChevronRight, Play, Square, Cog, GitBranch, Database, Globe } from "lucide-react";
import { useAppStore } from "@/stores/app.store";

interface PropertiesPanelProps {
  onNodeDataChange?: (nodeId: string, data: Record<string, unknown>) => void;
}

const TYPE_ICONS: Record<string, React.ReactNode> = {
  start: <Play className="h-3.5 w-3.5" style={{ color: "#22c55e" }} />,
  end: <Square className="h-3.5 w-3.5" style={{ color: "#ef4444" }} />,
  process: <Cog className="h-3.5 w-3.5" style={{ color: "#0ea5e9" }} />,
  decision: <GitBranch className="h-3.5 w-3.5" style={{ color: "#f59e0b" }} />,
  data: <Database className="h-3.5 w-3.5" style={{ color: "#a78bfa" }} />,
  integration: <Globe className="h-3.5 w-3.5" style={{ color: "#2dd4bf" }} />,
};

export function PropertiesPanel({ onNodeDataChange }: PropertiesPanelProps) {
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
  const selectedNode = workflow?.nodes.find((n) => n.id === selectedNodeId);
  const selectedEdge = workflow?.edges.find((e) => e.id === selectedEdgeId);

  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [edgeLabel, setEdgeLabel] = useState("");

  useEffect(() => {
    if (selectedNode) {
      setLabel(selectedNode.data.label);
      setDescription(selectedNode.data.description || "");
    }
  }, [selectedNode]);

  useEffect(() => {
    if (selectedEdge) {
      setEdgeLabel(selectedEdge.label || "");
    }
  }, [selectedEdge]);

  const handleNodeUpdate = useCallback(
    (updatedLabel?: string, updatedDescription?: string) => {
      if (!workflow || !selectedNode) return;
      const finalLabel = updatedLabel ?? label;
      const finalDescription = updatedDescription ?? description;

      // Update the store (persistence)
      const updatedNodes = workflow.nodes.map((n) =>
        n.id === selectedNode.id
          ? { ...n, data: { ...n.data, label: finalLabel, description: finalDescription } }
          : n
      );
      updateWorkflowNodes(workflow.id, updatedNodes);

      // Also update React Flow's internal state via callback
      if (onNodeDataChange) {
        onNodeDataChange(selectedNode.id, {
          ...selectedNode.data,
          label: finalLabel,
          description: finalDescription,
        });
      }
    },
    [workflow, selectedNode, label, description, updateWorkflowNodes, onNodeDataChange]
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

  const handleEdgeUpdate = useCallback(() => {
    if (!workflow || !selectedEdge) return;
    const updatedEdges = workflow.edges.map((e) =>
      e.id === selectedEdge.id ? { ...e, label: edgeLabel } : e
    );
    updateWorkflowEdges(workflow.id, updatedEdges);
  }, [workflow, selectedEdge, edgeLabel, updateWorkflowEdges]);

  const handleNodeTypeChange = useCallback(
    (newNodeType: "start" | "end" | "process" | "decision" | "data" | "integration") => {
      if (!workflow || !selectedNode) return;
      
      const newTypeMap: Record<string, string> = {
        start: "startNode",
        end: "endNode",
        process: "processNode",
        decision: "decisionNode",
        data: "dataNode",
        integration: "integrationNode"
      };

      const updatedNodes = workflow.nodes.map((n) =>
        n.id === selectedNode.id
          ? { 
              ...n, 
              type: newTypeMap[newNodeType] || n.type, 
              data: { ...n.data, nodeType: newNodeType } 
            }
          : n
      );
      updateWorkflowNodes(workflow.id, updatedNodes);

      if (onNodeDataChange) {
        onNodeDataChange(selectedNode.id, {
          ...selectedNode.data,
          nodeType: newNodeType,
        });
      }
    },
    [workflow, selectedNode, updateWorkflowNodes, onNodeDataChange]
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
            onChange={(e) => setEdgeLabel(e.target.value)}
            onBlur={handleEdgeUpdate}
            onKeyDown={(e) => e.key === "Enter" && handleEdgeUpdate()}
            placeholder="Add label..."
          />
        </div>
        <div className="wf-prop-group">
          <div className="wf-prop-label">
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
