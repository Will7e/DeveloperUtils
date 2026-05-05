// ============================================================
// DecisionNode — Diamond-style conditional branch node
// ============================================================

import { memo } from "react";
import { Handle, Position, NodeResizer, type NodeProps } from "@xyflow/react";
import { GitBranch } from "lucide-react";

interface DecisionNodeData {
  label: string;
  description?: string;
  nodeType: string;
  [key: string]: unknown;
}

function DecisionNodeComponent({ data, selected, width }: NodeProps) {
  const nodeData = data as unknown as DecisionNodeData;

  const scale = width ? width / 160 : 1;

  return (
    <>
      <NodeResizer color="var(--accent)" isVisible={selected} minWidth={160} minHeight={60} keepAspectRatio />
      <Handle type="target" position={Position.Top} className="wf-handle wf-handle-target" />
      <Handle type="source" position={Position.Bottom} id="default" className="wf-handle wf-handle-source" />
      <Handle type="source" position={Position.Right} id="yes" className="wf-handle wf-handle-source wf-handle-yes" />
      <Handle type="source" position={Position.Left} id="no" className="wf-handle wf-handle-source wf-handle-no" />
      <div 
        className={`wf-node wf-node-decision ${selected ? "wf-node-selected" : ""}`}
        style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: 160 }}
      >
        <div className="wf-node-decision-diamond">
        <div className="wf-node-decision-inner">
          <div className="wf-node-icon wf-node-icon-decision">
            <GitBranch className="h-3.5 w-3.5" />
          </div>
          <span className="wf-node-label">{nodeData.label}</span>
        </div>
      </div>
      <div className="wf-decision-labels">
        <span className="wf-decision-label-yes">Yes</span>
        <span className="wf-decision-label-no">No</span>
      </div>
      </div>
    </>
  );
}

export const DecisionNode = memo(DecisionNodeComponent);
