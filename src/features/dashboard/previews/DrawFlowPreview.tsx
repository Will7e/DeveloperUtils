import { useState, useRef, useEffect } from "react";
import {
  MousePointer,
  Square,
  Diamond,
  Pencil,
  RotateCcw,
  Eraser,
} from "lucide-react";
import { VirtualCursor, type CursorType } from "../components/VirtualCursor";
import { getTargetCenter, type CursorPosition } from "../components/cursorUtils";

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

  // Virtual Cursor Autopilot State
  const [cursorPos, setCursorPos] = useState<CursorPosition>({ x: 65, y: 35, isPercent: true });
  const [cursorClicking, setCursorClicking] = useState(false);
  const [cursorAction, setCursorAction] = useState<string>("Ready");
  const [cursorType, setCursorType] = useState<CursorType>("pointer");
  const [cursorDuration, setCursorDuration] = useState<number>(550);
  const [virtualHover, setVirtualHover] = useState<string | null>(null);
  const [isUserActive, setIsUserActive] = useState(false);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);

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
        id: `node-${Date.now()}`,
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
          id: `stroke-${Date.now()}`,
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
      setNodes((prev) =>
        prev.map((n) => (n.id === selectedNodeId ? { ...n, color } : n))
      );
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

  // Autonomous Lifelike Cursor Motion Loop for Excalidraw
  useEffect(() => {
    if (isUserActive) return;

    let step = 0;
    const timeouts: NodeJS.Timeout[] = [];

    const cycle = () => {
      if (isUserActive) return;

      if (step === 0) {
        // Glide to Pencil tool with pixel accuracy
        setCursorType("pointer");
        setCursorDuration(450);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-tool="pencil"]', { x: 5, y: 7.5 })
        );
        setCursorAction("Pencil Tool");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("tool-pencil");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setActiveTool("pencil");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 480)
        );
      } else if (step === 1) {
        // Switch to pencil cursor & glide to canvas start point with sub-pixel alignment
        setCursorType("pencil");
        setCursorDuration(550);
        setCursorPos(getSvgPointInContainer(320, 48));
        setCursorAction("Sketching...");
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            const strokeId = `stroke-${Date.now()}`;
            // Live stroke interpolation!
            setStrokes((prev) => [
              ...prev.slice(-3),
              {
                id: strokeId,
                points: [{ x: 320, y: 48 }],
                color: activeColor,
              },
            ]);

            // Point 2
            timeouts.push(
              setTimeout(() => {
                setCursorDuration(200);
                setCursorPos(getSvgPointInContainer(345, 55));
                setStrokes((prev) =>
                  prev.map((s) =>
                    s.id === strokeId
                      ? { ...s, points: [...s.points, { x: 345, y: 55 }] }
                      : s
                  )
                );
              }, 170)
            );

            // Point 3
            timeouts.push(
              setTimeout(() => {
                setCursorDuration(200);
                setCursorPos(getSvgPointInContainer(370, 72));
                setStrokes((prev) =>
                  prev.map((s) =>
                    s.id === strokeId
                      ? { ...s, points: [...s.points, { x: 370, y: 72 }] }
                      : s
                  )
                );
              }, 340)
            );

            // Point 4 & release
            timeouts.push(
              setTimeout(() => {
                setCursorDuration(200);
                setCursorPos(getSvgPointInContainer(388, 96));
                setStrokes((prev) =>
                  prev.map((s) =>
                    s.id === strokeId
                      ? { ...s, points: [...s.points, { x: 388, y: 96 }] }
                      : s
                  )
                );
                timeouts.push(
                  setTimeout(() => {
                    setCursorClicking(false);
                    setCursorAction("Done sketch");
                  }, 120)
                );
              }, 510)
            );
          }, 600)
        );
      } else if (step === 2) {
        // Glide to Amber swatch with pixel accuracy
        setCursorType("pointer");
        setCursorDuration(500);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-color="#fbbf24"]', { x: 32, y: 7.5 })
        );
        setCursorAction("Color: Amber");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("color-#fbbf24");
          }, 320)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            handleColorChange("#fbbf24");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 500)
        );
      } else if (step === 3) {
        // Glide to API Gateway diamond node with pixel accuracy
        setCursorDuration(480);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-node-id="node-gateway"]', { x: 52, y: 28 })
        );
        setCursorAction("Select Node");
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setSelectedNodeId("node-gateway");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
              }, 180)
            );
          }, 490)
        );
      } else if (step === 4) {
        // Drag Gateway node slightly
        setCursorType("grabbing");
        setCursorDuration(550);
        setCursorPos(getSvgPointInContainer(215 + 55, 48 + 36));
        setCursorAction("Dragging Node");
        setCursorClicking(true);
        setNodes((prev) =>
          prev.map((n) =>
            n.id === "node-gateway" ? { ...n, x: 215, y: 48 } : n
          )
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(false);
            setCursorType("pointer");
            setCursorAction("Released");
          }, 600)
        );
      } else if (step === 5) {
        // Switch tool back to Select with pixel accuracy and reset node position
        setCursorDuration(480);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-tool="select"]', { x: 9, y: 7.5 })
        );
        setCursorAction("Pointer Tool");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("tool-select");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setActiveTool("select");
            setNodes(INITIAL_NODES);
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 490)
        );
      }

      step = (step + 1) % 6;
    };

    cycle();
    const interval = setInterval(cycle, 1850);

    return () => {
      clearInterval(interval);
      timeouts.forEach(clearTimeout);
      setVirtualHover(null);
    };
  }, [isUserActive, activeColor]);

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
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Animated Virtual Cursor */}
      <VirtualCursor
        x={cursorPos.x}
        y={cursorPos.y}
        isPercent={cursorPos.isPercent}
        isClicking={cursorClicking}
        visible={!isUserActive}
        actionText={cursorAction}
        cursorType={cursorType}
        transitionDuration={cursorDuration}
      />

      {/* Floating Excalidraw Toolbar */}
      <div className="dash-excali-toolbar">
        <div className="dash-excali-toolgroup">
          <button
            type="button"
            data-tool="pencil"
            className={`dash-tool-icon-btn ${activeTool === "pencil" ? "active" : ""} ${virtualHover === "tool-pencil" ? "is-virtual-hover" : ""}`}
            onClick={() => setActiveTool("pencil")}
            title="Freehand Pencil (Draw with mouse)"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-tool="select"
            className={`dash-tool-icon-btn ${activeTool === "select" ? "active" : ""} ${virtualHover === "tool-select" ? "is-virtual-hover" : ""}`}
            onClick={() => setActiveTool("select")}
            title="Pointer / Drag nodes (V)"
          >
            <MousePointer className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-tool="rect"
            className={`dash-tool-icon-btn ${activeTool === "rect" ? "active" : ""}`}
            onClick={() => setActiveTool("rect")}
            title="Click canvas to place Rectangle"
          >
            <Square className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-tool="diamond"
            className={`dash-tool-icon-btn ${activeTool === "diamond" ? "active" : ""}`}
            onClick={() => setActiveTool("diamond")}
            title="Click canvas to place Diamond"
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
              className={`dash-swatch-btn ${activeColor === c.value ? "active" : ""} ${virtualHover === `color-${c.value}` ? "is-virtual-hover" : ""}`}
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
              title="Clear freehand pencil strokes"
            >
              <Eraser className="h-3 w-3" />
              <span>Erase</span>
            </button>
          )}
          <button
            type="button"
            className="dash-excali-action-btn"
            onClick={handleReset}
            title="Reset whiteboard"
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

          {/* Freehand Strokes Drawn by User or Autopilot */}
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
