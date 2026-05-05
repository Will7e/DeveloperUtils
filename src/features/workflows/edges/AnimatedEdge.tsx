// ============================================================
// AnimatedEdge — Custom animated edge with gradient and flow
// ============================================================

import { memo } from "react";
import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

function AnimatedEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  animated,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <>
      <defs>
        <linearGradient id={`edge-gradient-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(14, 165, 233, 0.6)" />
          <stop offset="100%" stopColor="rgba(139, 92, 246, 0.6)" />
        </linearGradient>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? "var(--accent)" : `url(#edge-gradient-${id})`,
          strokeWidth: selected ? 2.5 : 2,
          filter: selected ? "drop-shadow(0 0 6px rgba(14, 165, 233, 0.5))" : "none",
          strokeDasharray: animated ? "8 4" : "none",
          animation: animated ? "wf-edge-dash 0.6s linear infinite" : "none",
        }}
      />
      {/* Invisible wide path for easier selection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="react-flow__edge-interaction"
      />
    </>
  );
}

export const AnimatedEdge = memo(AnimatedEdgeComponent);
