// ============================================================
// AnimatedEdge — Custom animated edge with gradient and flow
// ============================================================

import { memo } from "react";
import { BaseEdge, getSmoothStepPath, getStraightPath, getBezierPath, type EdgeProps } from "@xyflow/react";

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
  data,
}: EdgeProps) {
  const edgeType = (data?.edgeStyle as string) || "smoothstep";
  
  const pathParams = {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  };

  let [edgePath] = ["", ""];
  
  if (edgeType === "straight") {
    [edgePath] = getStraightPath(pathParams);
  } else if (edgeType === "bezier") {
    [edgePath] = getBezierPath(pathParams);
  } else {
    [edgePath] = getSmoothStepPath({ ...pathParams, borderRadius: 16 });
  }

  const isDashed = data?.lineStyle === "dashed";
  const isAnimated = animated || data?.lineStyle === "animated";

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? "#0ea5e9" : "rgba(14, 165, 233, 0.4)",
          strokeWidth: selected ? 3 : 2,
          filter: selected ? "drop-shadow(0 0 8px rgba(14, 165, 233, 0.6))" : "none",
          strokeDasharray: isAnimated ? "8 4" : (isDashed ? "5 5" : "none"),
          animation: isAnimated ? "wf-edge-dash 0.6s linear infinite" : "none",
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
