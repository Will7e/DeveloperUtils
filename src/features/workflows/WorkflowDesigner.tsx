// ============================================================
// WorkflowDesigner — Main canvas with React Flow
// ============================================================

import { useCallback, useRef, useMemo, useState, type DragEvent, useEffect } from "react";
import {
  ReactFlow,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  SelectionMode,
  type Connection,
  type Node,
  type Edge,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import * as dagre from "dagre";

import { useAppStore } from "@/stores/app.store";
import { generateId } from "@/lib/utils";
import { StartNode } from "./nodes/StartNode";
import { ProcessNode } from "./nodes/ProcessNode";
import { DecisionNode } from "./nodes/DecisionNode";
import { DataNode } from "./nodes/DataNode";
import { IntegrationNode } from "./nodes/IntegrationNode";
import { AnimatedEdge } from "./edges/AnimatedEdge";
import { NodePalette } from "./NodePalette";
import { PropertiesPanel } from "./PropertiesPanel";
import { WorkflowToolbar } from "./WorkflowToolbar";

// Register custom node types
const nodeTypes = {
  startNode: StartNode,
  endNode: StartNode, // reuse with nodeType="end"
  processNode: ProcessNode,
  decisionNode: DecisionNode,
  dataNode: DataNode,
  integrationNode: IntegrationNode,
};

const edgeTypes = {
  animated: AnimatedEdge,
};

const defaultEdgeOptions = {
  type: "animated",
  animated: true,
};

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction = 'TB') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, nodesep: 70, ranksep: 100 });

  nodes.forEach((node) => {
    const nodeData = node.data as Record<string, any>;
    const type = node.type || nodeData?.nodeType;
    const isTerminal = type === "startNode" || type === "endNode" || type === "start" || type === "end";
    const isDecision = type === "decisionNode" || type === "decision";
    const hasDescription = !!nodeData?.description;

    const defaultWidth = isTerminal ? 160 : isDecision ? 160 : 180;
    const defaultHeight = isTerminal ? 48 : isDecision ? 60 : (hasDescription ? 90 : 60);

    dagreGraph.setNode(node.id, { width: defaultWidth, height: defaultHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    if (!nodeWithPosition) return node;

    const nodeData = node.data as Record<string, any>;
    const type = node.type || nodeData?.nodeType;
    const isTerminal = type === "startNode" || type === "endNode" || type === "start" || type === "end";
    const isDecision = type === "decisionNode" || type === "decision";
    const hasDescription = !!nodeData?.description;

    const defaultWidth = isTerminal ? 160 : isDecision ? 160 : 180;
    const defaultHeight = isTerminal ? 48 : isDecision ? 60 : (hasDescription ? 90 : 60);

    const x = nodeWithPosition.x - defaultWidth / 2;
    const y = nodeWithPosition.y - defaultHeight / 2;

    return {
      ...node,
      position: { x, y },
    };
  });

  return { nodes: newNodes, edges: [...edges] };
};

function WorkflowCanvas() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, zoomIn, zoomOut, fitView, setViewport } = useReactFlow();

  const workflows = useAppStore((s) => s.workflows);
  const activeWorkflowId = useAppStore((s) => s.activeWorkflowId);
  const updateWorkflowNodes = useAppStore((s) => s.updateWorkflowNodes);
  const updateWorkflowEdges = useAppStore((s) => s.updateWorkflowEdges);
  const updateWorkflowViewport = useAppStore((s) => s.updateWorkflowViewport);
  const setWorkflowSelectedNodeId = useAppStore((s) => s.setWorkflowSelectedNodeId);
  const setWorkflowSelectedEdgeId = useAppStore((s) => s.setWorkflowSelectedEdgeId);
  const setWorkflowPropertiesCollapsed = useAppStore((s) => s.setWorkflowPropertiesCollapsed);
  const addToast = useAppStore((s) => s.addToast);

  // Persistent Minimap state from store
  const showMinimap = useAppStore((s) => s.workflowMinimapVisible);
  const toggleMinimap = useAppStore((s) => s.toggleWorkflowMinimap);
  const propertiesCollapsed = useAppStore((s) => s.workflowPropertiesCollapsed);

  // Track right-click for cursor feedback
  const [isRightClicking, setIsRightClicking] = useState(false);

  const activeWorkflow = useMemo(
    () => workflows.find((w) => w.id === activeWorkflowId),
    [workflows, activeWorkflowId]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(
    (activeWorkflow?.nodes || []) as Node[]
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    (activeWorkflow?.edges || []) as Edge[]
  );

  // Sync from store when workflow changes (tab switch or initial load after hydration)
  const lastSyncedId = useRef<string | null>(null);

  useEffect(() => {
    if (activeWorkflow && activeWorkflowId !== lastSyncedId.current) {
      setNodes(activeWorkflow.nodes as Node[]);
      setEdges(activeWorkflow.edges as Edge[]);
      // Restore persisted viewport for this workflow
      if (activeWorkflow.viewport) {
        setViewport(activeWorkflow.viewport);
      }
      lastSyncedId.current = activeWorkflowId;
    }
  }, [activeWorkflow, activeWorkflowId, setNodes, setEdges, setViewport]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      clearTimeout(saveTimeout.current);
      clearTimeout(viewportTimeout.current);
    };
  }, []);

  // Persist nodes/edges changes to store (debounced)
  const saveTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Persist viewport changes (debounced separately to avoid thrashing)
  const viewportTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const onViewportChange = useCallback(
    (viewport: Viewport) => {
      clearTimeout(viewportTimeout.current);
      viewportTimeout.current = setTimeout(() => {
        if (activeWorkflowId) {
          updateWorkflowViewport(activeWorkflowId, {
            x: viewport.x,
            y: viewport.y,
            zoom: viewport.zoom,
          });
        }
      }, 400);
    },
    [activeWorkflowId, updateWorkflowViewport]
  );

  const persistNodes = useCallback(
    (updatedNodes: Node[]) => {
      clearTimeout(saveTimeout.current);
      saveTimeout.current = setTimeout(() => {
        if (activeWorkflowId) {
          updateWorkflowNodes(
            activeWorkflowId,
            updatedNodes.map((n) => ({
              id: n.id,
              type: n.type || "processNode",
              position: n.position,
              data: n.data as any,
              measured: n.measured as { width: number; height: number } | undefined,
              style: n.style,
              width: n.width,
              height: n.height,
            }))
          );
        }
      }, 300);
    },
    [activeWorkflowId, updateWorkflowNodes]
  );

  const persistEdges = useCallback(
    (updatedEdges: Edge[]) => {
      clearTimeout(saveTimeout.current);
      saveTimeout.current = setTimeout(() => {
        if (activeWorkflowId) {
          updateWorkflowEdges(
            activeWorkflowId,
            updatedEdges.map((e) => ({
              id: e.id,
              source: e.source,
              target: e.target,
              sourceHandle: e.sourceHandle ?? null,
              targetHandle: e.targetHandle ?? null,
              label: (e.label as string) || undefined,
              animated: e.animated,
              type: e.type || "animated",
              data: e.data as any,
            }))
          );
        }
      }, 300);
    },
    [activeWorkflowId, updateWorkflowEdges]
  );

  // Handle node changes with persistence
  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      // Get updated nodes after state change
      setNodes((nds) => {
        persistNodes(nds);
        return nds;
      });
    },
    [onNodesChange, setNodes, persistNodes]
  );

  // Handle edge changes with persistence
  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      setEdges((eds) => {
        persistEdges(eds);
        return eds;
      });
    },
    [onEdgesChange, setEdges, persistEdges]
  );

  // Connect handler
  const onConnect = useCallback(
    (connection: Connection) => {
      const newEdge: Edge = {
        ...connection,
        id: `edge-${generateId()}`,
        source: connection.source,
        target: connection.target,
        type: "animated",
        animated: true,
        data: {
          edgeStyle: "smoothstep",
          lineStyle: "animated",
        },
      };
      setEdges((eds) => {
        const updated = addEdge(newEdge, eds);
        persistEdges(updated as Edge[]);
        return updated;
      });
    },
    [setEdges, persistEdges]
  );

  // Drop handler for palette drag-n-drop
  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();

      const data = e.dataTransfer.getData("application/reactflow");
      if (!data) return;

      const { type, nodeType, label } = JSON.parse(data);
      const position = screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      const newNode: Node = {
        id: `${nodeType}-${generateId()}`,
        type,
        position,
        data: {
          label,
          nodeType,
          description: "",
        },
      };

      setNodes((nds) => {
        const updated = [...nds, newNode];
        persistNodes(updated);
        return updated;
      });

      addToast({ message: `Added ${label} node`, type: "info", duration: 1500 });
    },
    [screenToFlowPosition, setNodes, persistNodes, addToast]
  );

  // Node selection
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setWorkflowSelectedNodeId(node.id);
    },
    [setWorkflowSelectedNodeId]
  );

  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setWorkflowSelectedNodeId(node.id);
      setWorkflowPropertiesCollapsed(!propertiesCollapsed);
    },
    [setWorkflowSelectedNodeId, setWorkflowPropertiesCollapsed, propertiesCollapsed]
  );

  // Edge selection
  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      setWorkflowSelectedEdgeId(edge.id);
    },
    [setWorkflowSelectedEdgeId]
  );

  // Pane click (deselect)
  const onPaneClick = useCallback(() => {
    setWorkflowSelectedNodeId(null);
    setWorkflowSelectedEdgeId(null);
  }, [setWorkflowSelectedNodeId, setWorkflowSelectedEdgeId]);

  // Clear canvas
  const handleClearCanvas = useCallback(() => {
    setNodes([]);
    setEdges([]);
    if (activeWorkflowId) {
      updateWorkflowNodes(activeWorkflowId, []);
      updateWorkflowEdges(activeWorkflowId, []);
    }
    addToast({ message: "Canvas cleared", type: "info" });
  }, [setNodes, setEdges, activeWorkflowId, updateWorkflowNodes, updateWorkflowEdges, addToast]);

  // Beautify canvas
  const handleBeautify = useCallback(() => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      nodes,
      edges,
      'TB'
    );

    clearTimeout(saveTimeout.current);
    setNodes([...layoutedNodes]);
    setEdges([...layoutedEdges]);
    
    // Immediate save for manual actions to ensure persistence on refresh
    if (activeWorkflowId) {
      updateWorkflowNodes(
        activeWorkflowId,
        layoutedNodes.map((n) => ({
          id: n.id,
          type: n.type || "processNode",
          position: n.position,
          data: n.data as any,
          measured: n.measured as any,
          style: n.style,
          width: n.width,
          height: n.height,
        }))
      );
      updateWorkflowEdges(
        activeWorkflowId,
        layoutedEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? null,
          targetHandle: e.targetHandle ?? null,
          label: (e.label as string) || undefined,
          animated: e.animated,
          type: e.type || "animated",
          data: e.data as any,
        }))
      );
    }

    window.requestAnimationFrame(() => {
      fitView({ padding: 0.3, maxZoom: 1 });
    });

    addToast({ message: "Nodes beautified", type: "success" });
  }, [nodes, edges, setNodes, setEdges, persistNodes, fitView, addToast]);

  // Delete selected nodes/edges with keyboard
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        const selectedNodes = nodes.filter((n) => n.selected);
        const selectedEdges = edges.filter((e) => e.selected);
        if (selectedNodes.length > 0 || selectedEdges.length > 0) {
          const remainingNodes = nodes.filter((n) => !n.selected);
          const deletedNodeIds = new Set(selectedNodes.map((n) => n.id));
          const remainingEdges = edges.filter(
            (e) => !e.selected && !deletedNodeIds.has(e.source) && !deletedNodeIds.has(e.target)
          );
          setNodes(remainingNodes);
          setEdges(remainingEdges);
          persistNodes(remainingNodes);
          persistEdges(remainingEdges);
        }
      }
    },
    [nodes, edges, setNodes, setEdges, persistNodes, persistEdges]
  );

  const handleNodeDataChange = useCallback(
    (nodeId: string, data: Record<string, unknown>) => {
      setNodes((nds) => {
        const updated = nds.map((n) => {
          if (n.id === nodeId) {
            let newType = n.type;
            if (data.nodeType && typeof data.nodeType === "string") {
              const newTypeMap: Record<string, string> = {
                start: "startNode",
                end: "endNode",
                process: "processNode",
                decision: "decisionNode",
                data: "dataNode",
                integration: "integrationNode"
              };
              newType = newTypeMap[data.nodeType] || n.type;
            }
            return { ...n, type: newType, data: { ...n.data, ...data } };
          }
          return n;
        });
        persistNodes(updated);
        return updated;
      });
    },
    [setNodes, persistNodes]
  );

  const handleEdgeDataChange = useCallback(
    (edgeId: string, data: Record<string, any>) => {
      setEdges((eds) => {
        const updated = eds.map((e) => {
          if (e.id === edgeId) {
            // Unpack animated if present, otherwise merge into data
            const { animated: isAnimated, ...rest } = data;
            return { 
              ...e, 
              ...(isAnimated !== undefined ? { animated: isAnimated } : {}),
              data: { ...e.data, ...rest.data } 
            };
          }
          return e;
        });
        persistEdges(updated);
        return updated;
      });
    },
    [setEdges, persistEdges]
  );

  const selectedNodeId = useAppStore((s) => s.workflowSelectedNodeId);
  const selectedEdgeId = useAppStore((s) => s.workflowSelectedEdgeId);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId),
    [nodes, selectedNodeId]
  );
  const selectedEdge = useMemo(
    () => edges.find((e) => e.id === selectedEdgeId),
    [edges, selectedEdgeId]
  );

  // Use persisted viewport or sensible default (not fitView which over-zooms)
  const defaultViewport = activeWorkflow?.viewport || { x: 0, y: 0, zoom: 0.75 };

  return (
    <div className="wf-layout">
      <WorkflowToolbar
        onZoomIn={() => zoomIn()}
        onZoomOut={() => zoomOut()}
        onFitView={() => fitView({ padding: 0.3, maxZoom: 1 })}
        onClearCanvas={handleClearCanvas}
        onBeautify={handleBeautify}
        showMinimap={showMinimap}
        onToggleMinimap={toggleMinimap}
      />
      <div className="wf-body">
        <NodePalette />
        <div
          className={`wf-canvas-wrapper ${isRightClicking ? 'wf-right-clicking' : ''}`}
          ref={reactFlowWrapper}
          onKeyDown={onKeyDown}
          onMouseDown={(e) => {
            if (e.button === 2 || e.button === 1) setIsRightClicking(true);
          }}
          onMouseUp={() => setIsRightClicking(false)}
          onMouseLeave={() => setIsRightClicking(false)}
          tabIndex={0}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            onViewportChange={onViewportChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            defaultViewport={defaultViewport}
            deleteKeyCode={["Backspace", "Delete"]}
            multiSelectionKeyCode="Shift"
            snapToGrid
            snapGrid={[16, 16]}
            minZoom={0.1}
            maxZoom={4}
            panOnDrag={[1, 2]}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnScroll
            onPaneContextMenu={(e) => e.preventDefault()}
            className="wf-canvas"
            proOptions={{ hideAttribution: true }}
          >
            {showMinimap && (
              <MiniMap
                className="wf-minimap"
                nodeColor={(node) => {
                  const nodeType = (node.data as Record<string, unknown>)?.nodeType as string;
                  switch (nodeType) {
                    case "start": return "#22c55e";
                    case "end": return "#ef4444";
                    case "process": return "#0ea5e9";
                    case "decision": return "#f59e0b";
                    case "data": return "#a78bfa";
                    case "integration": return "#2dd4bf";
                    default: return "#475569";
                  }
                }}
                maskColor="rgba(2, 6, 23, 0.7)"
                style={{ width: 140, height: 90 }}
                position="bottom-right"
                pannable
                zoomable={false}
              />
            )}
          </ReactFlow>
        </div>
        <PropertiesPanel 
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          onNodeDataChange={handleNodeDataChange} 
          onEdgeDataChange={handleEdgeDataChange}
        />
      </div>
    </div>
  );
}

export function WorkflowDesigner() {
  return (
    <ReactFlowProvider>
      <WorkflowCanvas />
    </ReactFlowProvider>
  );
}
