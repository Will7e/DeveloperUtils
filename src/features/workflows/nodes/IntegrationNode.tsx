// ============================================================
// IntegrationNode — API/webhook integration node
// ============================================================

import { memo } from "react";
import { Handle, Position, NodeResizer, type NodeProps } from "@xyflow/react";
import { Globe } from "lucide-react";

interface IntegrationNodeData {
  label: string;
  description?: string;
  nodeType: string;
  [key: string]: unknown;
}

function IntegrationNodeComponent({ data, selected, width }: NodeProps) {
  const nodeData = data as unknown as IntegrationNodeData;

  const scale = width ? width / 180 : 1;

  return (
    <>
      <NodeResizer color="var(--accent)" isVisible={selected} minWidth={180} minHeight={60} keepAspectRatio />
      <Handle type="target" position={Position.Top} className="wf-handle wf-handle-target" />
      <Handle type="source" position={Position.Bottom} className="wf-handle wf-handle-source" />
      <div 
        className={`wf-node wf-node-integration ${selected ? "wf-node-selected" : ""}`}
        style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: 180 }}
      >
        <div className="wf-node-header wf-node-header-integration">
        <div className="wf-node-icon wf-node-icon-integration">
          <Globe className="h-3.5 w-3.5" />
        </div>
        <span className="wf-node-label">{nodeData.label}</span>
      </div>
      {nodeData.description && (
        <div className="wf-node-body">
          <span className="wf-node-desc">{nodeData.description}</span>
        </div>
      )}
      </div>
    </>
  );
}

export const IntegrationNode = memo(IntegrationNodeComponent);
