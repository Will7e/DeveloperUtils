// ============================================================
// StartNode — Terminal start/end nodes for workflow
// ============================================================

import { memo } from "react";
import { Handle, Position, NodeResizer, type NodeProps } from "@xyflow/react";
import { Play, Square } from "lucide-react";

interface StartNodeData {
  label: string;
  description?: string;
  nodeType: "start" | "end";
  [key: string]: unknown;
}

function StartNodeComponent({ data, selected, width }: NodeProps) {
  const nodeData = data as unknown as StartNodeData;
  const isEnd = nodeData.nodeType === "end";
  const scale = width ? width / 160 : 1;

  return (
    <>
      <NodeResizer color="var(--accent)" isVisible={selected} minWidth={160} minHeight={48} keepAspectRatio />
      {!isEnd && (
        <Handle type="source" position={Position.Bottom} className="wf-handle wf-handle-source" />
      )}
      {isEnd && (
        <Handle type="target" position={Position.Top} className="wf-handle wf-handle-target" />
      )}
      <div 
        className={`wf-node wf-node-terminal ${isEnd ? "wf-node-end" : "wf-node-start"} ${selected ? "wf-node-selected" : ""}`}
        style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: 160 }}
      >
        <div className="wf-node-terminal-inner">
        <div className={`wf-node-terminal-icon ${isEnd ? "wf-node-terminal-icon-end" : "wf-node-terminal-icon-start"}`}>
          {isEnd ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </div>
        <span className="wf-node-terminal-label">{nodeData.label}</span>
      </div>
      </div>
    </>
  );
}

export const StartNode = memo(StartNodeComponent);
