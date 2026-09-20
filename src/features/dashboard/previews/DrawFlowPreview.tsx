import { useState, useRef } from "react";
import {
  MousePointer,
  Square,
  Diamond,
  Pencil,
  RotateCcw,
  Eraser,
} from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import type { CursorPosition } from "../components/cursorUtils";
import { DemoControls, useAutopilot, type AutopilotStep } from "../autopilot";
import { requestHandoff } from "@/services/handoff.service";

interface CanvasNode {
  id: string;
  type: "rect" | "diamond";
  label: string;
  sublabel: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

interface FreehandStroke {
  id: string;
  points: { x: number; y: number }[];
  color: string;
}

const INITIAL_NODES: CanvasNode[] = [
  {
    id: "node-client",
    type: "rect",
    label: "Client App",
    sublabel: "React SPA",
    x: 20,
    y: 45,
    w: 110,
    h: 52,
    color: "#0070f3",
  },
  {
    id: "node-gateway",
    type: "diamond",
    label: "API Gateway",
    sublabel: "Kong / Edge",
    x: 185,
    y: 35,
    w: 110,
    h: 72,
    color: "#3291ff",
  },
  {
    id: "node-db",
    type: "rect",
    label: "Distributed DB",
    sublabel: "PostgreSQL",
    x: 340,
    y: 45,
    w: 110,
    h: 52,
    color: "#00df8f",
  },
];

const PALETTE = [
  { label: "Blue", value: "#0070f3" },
  { label: "Emerald", value: "#00df8f" },
  { label: "Violet", value: "#8e4ec6" },
  { label: "Amber", value: "#f5a623" },
  { label: "Slate", value: "#a1a1a1" },
];

const AMBER = "#fbbf24";

/** Builds real diagram elements so the handoff opens a usable board. */
function toDiagramElements(nodes: CanvasNode[]): unknown[] {
  const elements: unknown[] = [];

  nodes.forEach((node, index) => {
    elements.push({
      type: "rectangle",
      version: 1,
      versionNonce: 2000 + index,
      isDeleted: false,
      id: `demo-${node.id}`,
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      angle: 0,
      x: node.x,
      y: node.y,
      strokeColor: node.color,
      backgroundColor: "transparent",
      width: node.w,
      height: node.h,
      seed: 20000 + index,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      boundElements: [],
      updated: 1,
      link: null,
      locked: false,
    });

    elements.push({
      type: "text",
      version: 1,
      versionNonce: 3000 + index,
      isDeleted: false,
      id: `demo-${node.id}-label`,
      fillStyle: "hachure",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      angle: 0,
      x: node.x + 8,
      y: node.y + node.h / 2 - 10,
      strokeColor: node.color,
      backgroundColor: "transparent",
      width: node.w - 16,
      height: 20,
      seed: 30000 + index,
      groupIds: [],
      frameId: null,
      roundness: null,
      boundElements: [],
      updated: 1,
      link: null,
      locked: false,
      text: node.label,
      fontSize: 16,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      baseline: 14,
      containerId: null,
      originalText: node.label,
      lineHeight: 1.25,
    });
  });

  return elements;
}

export function DrawFlowPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>(INITIAL_NODES);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("node-gateway");
  const [activeTool, setActiveTool] = useState<"pencil" | "select" | "rect" | "diamond">("pencil");
  const [activeColor, setActiveColor] = useState<string>("#0070f3");
  const [strokes, setStrokes] = useState<FreehandStroke[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentStroke, setCurrentStroke] = useState<{ x: number; y: number }[]>([]);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const newIdRef = useRef(0);
  const strokeIdRef = useRef<string>("");

  const getSvgCoordinates = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = 460 / rect.width;
    const scaleY = 200 / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    e.stopPropagation();
    const coords = getSvgCoordinates(e);

    if (activeTool === "pencil") {
      setIsDrawing(true);
      setCurrentStroke([coords]);
    } else if (activeTool === "rect" || activeTool === "diamond") {
      const newNode: CanvasNode = {
        id: `node-new-${++newIdRef.current}`,
        type: activeTool,
        label: activeTool === "rect" ? "Service Node" : "Condition",
        sublabel: "Active Element",
        x: Math.min(340, Math.max(10, coords.x - 50)),
        y: Math.min(140, Math.max(10, coords.y - 25)),
        w: activeTool === "rect" ? 105 : 100,
        h: activeTool === "rect" ? 50 : 65,
        color: activeColor,
      };
      setNodes((prev) => [...prev, newNode]);
      setSelectedNodeId(newNode.id);
      setActiveTool("select");
    }
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    e.stopPropagation();
    const coords = getSvgCoordinates(e);

    if (isDrawing && activeTool === "pencil") {
      setCurrentStroke((prev) => [...prev, coords]);
    } else if (draggingNodeId) {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === draggingNodeId
            ? {
                ...n,
                x: Math.max(5, Math.min(350, coords.x - dragOffsetRef.current.x)),
                y: Math.max(5, Math.min(140, coords.y - dragOffsetRef.current.y)),
              }
            : n
        )
      );
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDrawing && currentStroke.length > 1) {
      setStrokes((prev) => [
        ...prev,
        {
          id: `stroke-new-${++newIdRef.current}`,
          points: currentStroke,
          color: activeColor,
        },
      ]);
    }
    setIsDrawing(false);
    setCurrentStroke([]);
    setDraggingNodeId(null);
  };

  const handleNodeMouseDown = (e: React.MouseEvent, node: CanvasNode) => {
    e.stopPropagation();
    setSelectedNodeId(node.id);
    if (activeTool === "select") {
      const coords = getSvgCoordinates(e as unknown as React.MouseEvent<SVGSVGElement>);
      dragOffsetRef.current = {
        x: coords.x - node.x,
        y: coords.y - node.y,
      };
      setDraggingNodeId(node.id);
    }
  };

  const handleColorChange = (color: string) => {
    setActiveColor(color);
    if (selectedNodeId) {
      setNodes((prev) => prev.map((n) => (n.id === selectedNodeId ? { ...n, color } : n)));
    }
  };

  const handleClearStrokes = () => {
    setStrokes([]);
    setCurrentStroke([]);
  };

  const handleReset = () => {
    setNodes(INITIAL_NODES);
    setStrokes([]);
    setSelectedNodeId("node-gateway");
  };

  const getSvgPointInContainer = (svgX: number, svgY: number): CursorPosition => {
    if (!containerRef.current || !svgRef.current) {
      return { x: (svgX / 460) * 100, y: (svgY / 200) * 100, isPercent: true };
    }
    const contRect = containerRef.current.getBoundingClientRect();
    const svgRect = svgRef.current.getBoundingClientRect();
    const scaleX = svgRect.width / 460;
    const scaleY = svgRect.height / 200;
    const x = Math.round(svgRect.left + svgX * scaleX - contRect.left);
    const y = Math.round(svgRect.top + svgY * scaleY - contRect.top);
    return { x, y, isPercent: false };
  };

  const appendStrokePoint = (strokeId: string, point: { x: number; y: number }) => {
    setStrokes((prev) =>
      prev.map((s) => (s.id === strokeId ? { ...s, points: [...s.points, point] } : s))
    );
  };

  const steps: AutopilotStep[] = [
    {
      target: '[data-tool="pencil"]',
      fallback: { x: 5, y: 7.5 },
      action: "Pencil tool",
      cursor: "pointer",
      transition: 450,
      hover: "tool-pencil",
      run: () => setActiveTool("pencil"),
    },
    // Four short steps trace the note one point at a time, like a real hand.
    {
      target: () => getSvgPointInContainer(320, 48),
      action: "Sketching a note",
      cursor: "pencil",
      transition: 450,
      click: true,
      hold: 300,
      run: () => {
        const strokeId = `stroke-new-${++newIdRef.current}`;
        strokeIdRef.current = strokeId;
        setStrokes((prev) => [
          ...prev.slice(-3),
          { id: strokeId, points: [{ x: 320, y: 48 }], color: activeColor },
        ]);
      },
    },
    {
      target: () => getSvgPointInContainer(345, 55),
      transition: 200,
      click: false,
      hold: 210,
      run: () => appendStrokePoint(strokeIdRef.current, { x: 345, y: 55 }),
    },
    {
      target: () => getSvgPointInContainer(370, 72),
      transition: 200,
      click: false,
      hold: 210,
      run: () => appendStrokePoint(strokeIdRef.current, { x: 370, y: 72 }),
    },
    {
      target: () => getSvgPointInContainer(388, 96),
      action: "Note added",
      transition: 200,
      click: false,
      hold: 620,
      run: () => appendStrokePoint(strokeIdRef.current, { x: 388, y: 96 }),
    },
    {
      target: `[data-color="${AMBER}"]`,
      fallback: { x: 32, y: 7.5 },
      action: "Color: amber",
      transition: 500,
      hover: `color-${AMBER}`,
      run: () => handleColorChange(AMBER),
    },
    {
      target: '[data-node-id="node-gateway"]',
      fallback: { x: 52, y: 28 },
      action: "Select the gateway",
      transition: 480,
      run: () => setSelectedNodeId("node-gateway"),
    },
    {
      target: () => getSvgPointInContainer(215 + 55, 48 + 36),
      action: "Dragging the node",
      cursor: "grabbing",
      transition: 550,
      click: true,
      releaseAt: 1150,
      hold: 700,
      run: () =>
        setNodes((prev) =>
          prev.map((n) => (n.id === "node-gateway" ? { ...n, x: 215, y: 48 } : n))
        ),
    },
    {
      action: "Released",
      cursor: "pointer",
      hold: 400,
    },
    {
      target: '[data-tool="select"]',
      fallback: { x: 9, y: 7.5 },
      action: "Pointer tool",
      transition: 480,
      hover: "tool-select",
      run: () => {
        setActiveTool("select");
        setNodes(INITIAL_NODES);
      },
    },
  ];

  const autopilot = useAutopilot(containerRef, steps, { stepMs: 1850 });

  const pointsToSvgPath = (pts: { x: number; y: number }[]) => {
    if (pts.length < 2 || !pts[0]) return "";
    const first = pts[0];
    return `M ${first.x.toFixed(1)} ${first.y.toFixed(1)} ` +
      pts.slice(1).map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  };

  const gatewayNode = nodes.find((n) => n.id === "node-gateway") || nodes[1];
  const clientNode = nodes.find((n) => n.id === "node-client") || nodes[0];
  const dbNode = nodes.find((n) => n.id === "node-db") || nodes[2];

  return (
    <div
      ref={containerRef}
      className="dash-demo-box dash-demo-excalidraw"
      {...autopilot.containerProps}
    >
      <VirtualCursor {...autopilot.cursorProps} />

      <DemoControls
        autopilot={autopilot}
        openLabel="Open in DrawFlows"
        onOpen={() =>
          requestHandoff({
            target: "drawflows",
            label: "Demo architecture",
            workflow: {
              name: "Demo architecture",
              elements: toDiagramElements(INITIAL_NODES),
            },
          })
        }
      />

      {/* Floating Excalidraw Toolbar */}
      <div className="dash-excali-toolbar">
        <div className="dash-excali-toolgroup">
          <button
            type="button"
            data-tool="pencil"
            className={`dash-tool-icon-btn ${activeTool === "pencil" ? "active" : ""} ${autopilot.hoverClass("tool-pencil")}`}
            onClick={() => setActiveTool("pencil")}
            title="Freehand pencil (draw with your mouse)"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-tool="select"
            className={`dash-tool-icon-btn ${activeTool === "select" ? "active" : ""} ${autopilot.hoverClass("tool-select")}`}
            onClick={() => setActiveTool("select")}
            title="Pointer / drag nodes (V)"
          >
            <MousePointer className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-tool="rect"
            className={`dash-tool-icon-btn ${activeTool === "rect" ? "active" : ""}`}
            onClick={() => setActiveTool("rect")}
            title="Click the canvas to place a rectangle"
          >
            <Square className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-tool="diamond"
            className={`dash-tool-icon-btn ${activeTool === "diamond" ? "active" : ""}`}
            onClick={() => setActiveTool("diamond")}
            title="Click the canvas to place a diamond"
          >
            <Diamond className="h-3 w-3" />
          </button>
        </div>

        <div className="dash-excali-divider" />

        {/* Color Palette */}
        <div className="dash-excali-palette">
          {PALETTE.map((c) => (
            <button
              key={c.value}
              type="button"
              data-color={c.value}
              className={`dash-swatch-btn ${activeColor === c.value ? "active" : ""} ${autopilot.hoverClass(`color-${c.value}`)}`}
              style={{ background: c.value }}
              onClick={() => handleColorChange(c.value)}
              title={`Color: ${c.label}`}
            />
          ))}
        </div>

        <div className="dash-excali-divider" />

        {/* Canvas Controls */}
        <div className="dash-excali-actions">
          {strokes.length > 0 && (
            <button
              type="button"
              className="dash-excali-action-btn"
              onClick={handleClearStrokes}
              title="Clear freehand strokes"
            >
              <Eraser className="h-3 w-3" />
              <span>Erase</span>
            </button>
          )}
          <button
            type="button"
            className="dash-excali-action-btn"
            onClick={handleReset}
            title="Reset the whiteboard"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset</span>
          </button>
        </div>

      </div>

      {/* Interactive SVG Whiteboard Canvas */}
      <div className="dash-excali-canvas-wrap">
        <svg
          ref={svgRef}
          className={`dash-excali-svg tool-${activeTool}`}
          viewBox="0 0 460 200"
          preserveAspectRatio="xMidYMid meet"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <defs>
            <pattern
              id="excali-dots-real"
              x="0"
              y="0"
              width="18"
              height="18"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="2" cy="2" r="1" fill="currentColor" opacity="0.12" />
            </pattern>
            <marker
              id="sketch-arrow-real"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path
                d="M 1 2 L 9 5 L 1 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.6"
              />
            </marker>
          </defs>

          {/* Dotted Grid Background */}
          <rect width="100%" height="100%" fill="url(#excali-dots-real)" />

          {/* Dynamic Connectors following node positions */}
          {clientNode && gatewayNode && (
            <path
              d={`M ${clientNode.x + clientNode.w} ${clientNode.y + clientNode.h / 2} C ${(clientNode.x + clientNode.w + gatewayNode.x) / 2} ${clientNode.y + clientNode.h / 2}, ${(clientNode.x + clientNode.w + gatewayNode.x) / 2} ${gatewayNode.y + gatewayNode.h / 2}, ${gatewayNode.x} ${gatewayNode.y + gatewayNode.h / 2}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="4 2"
              opacity="0.55"
              markerEnd="url(#sketch-arrow-real)"
            />
          )}

          {gatewayNode && dbNode && (
            <path
              d={`M ${gatewayNode.x + gatewayNode.w / 2} ${gatewayNode.y + gatewayNode.h} C ${gatewayNode.x + gatewayNode.w / 2} ${(gatewayNode.y + gatewayNode.h + dbNode.y) / 2}, ${dbNode.x + dbNode.w / 2} ${(gatewayNode.y + gatewayNode.h + dbNode.y) / 2}, ${dbNode.x + dbNode.w / 2} ${dbNode.y}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="4 2"
              opacity="0.55"
              markerEnd="url(#sketch-arrow-real)"
            />
          )}

          {/* Freehand Strokes Drawn by the Viewer or the Autopilot */}
          {strokes.map((stroke) => (
            <path
              key={stroke.id}
              d={pointsToSvgPath(stroke.points)}
              fill="none"
              stroke={stroke.color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.85"
            />
          ))}

          {/* Active Freehand Stroke */}
          {isDrawing && currentStroke.length > 1 && (
            <path
              d={pointsToSvgPath(currentStroke)}
              fill="none"
              stroke={activeColor}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.9"
            />
          )}

          {/* Nodes */}
          {nodes.map((node) => {
            const isSelected = selectedNodeId === node.id;
            return (
              <g
                key={node.id}
                data-node-id={node.id}
                className={`dash-canvas-node ${isSelected ? "selected" : ""}`}
                onMouseDown={(e) => handleNodeMouseDown(e, node)}
                style={{ cursor: activeTool === "select" ? "grab" : "pointer" }}
              >
                {node.type === "rect" ? (
                  <>
                    <rect
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={node.h}
                      rx="6"
                      fill={node.color}
                      fillOpacity="0.16"
                      stroke={node.color}
                      strokeWidth="2"
                    />
                    <path
                      d={`M ${node.x + 2} ${node.y + 4} L ${node.x + node.w - 2} ${node.y + 2}`}
                      stroke={node.color}
                      strokeWidth="1.2"
                      opacity="0.6"
                    />
                  </>
                ) : (
                  <polygon
                    points={`${node.x + node.w / 2},${node.y} ${node.x + node.w},${node.y + node.h / 2} ${node.x + node.w / 2},${node.y + node.h} ${node.x},${node.y + node.h / 2}`}
                    fill={node.color}
                    fillOpacity="0.16"
                    stroke={node.color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                )}

                <text
                  x={node.x + node.w / 2}
                  y={node.y + (node.type === "diamond" ? node.h / 2 - 2 : node.h / 2 - 4)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="currentColor"
                  fontSize="11.5"
                  fontWeight="600"
                  fontFamily="var(--font-sans), system-ui, -apple-system, sans-serif"
                  pointerEvents="none"
                >
                  {node.label}
                </text>
                <text
                  x={node.x + node.w / 2}
                  y={node.y + (node.type === "diamond" ? node.h / 2 + 12 : node.h / 2 + 10)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="currentColor"
                  opacity="0.65"
                  fontSize="9.5"
                  fontFamily="system-ui, sans-serif"
                  pointerEvents="none"
                >
                  {node.sublabel}
                </text>

                {isSelected && (
                  <g className="dash-selection-box">
                    <rect
                      x={node.x - 3}
                      y={node.y - 3}
                      width={node.w + 6}
                      height={node.h + 6}
                      fill="none"
                      stroke={node.color}
                      strokeWidth="1"
                      strokeDasharray="3 3"
                    />
                    <circle cx={node.x - 3} cy={node.y - 3} r="2.5" fill="#fff" stroke={node.color} strokeWidth="1" />
                    <circle cx={node.x + node.w + 3} cy={node.y - 3} r="2.5" fill="#fff" stroke={node.color} strokeWidth="1" />
                    <circle cx={node.x - 3} cy={node.y + node.h + 3} r="2.5" fill="#fff" stroke={node.color} strokeWidth="1" />
                    <circle cx={node.x + node.w + 3} cy={node.y + node.h + 3} r="2.5" fill="#fff" stroke={node.color} strokeWidth="1" />
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
