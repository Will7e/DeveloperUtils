// ============================================================
// ProcessNode — Action/process step node
// ============================================================

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Cog } from "lucide-react";

interface ProcessNodeData {
  label: string;
  description?: string;
  nodeType: string;
  [key: string]: unknown;
}

function ProcessNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as ProcessNodeData;

  return (
    <div className={`wf-node wf-node-process ${selected ? "wf-node-selected" : ""}`}>
      <Handle type="target" position={Position.Top} className="wf-handle wf-handle-target" />
      <Handle type="source" position={Position.Bottom} className="wf-handle wf-handle-source" />
      <div className="wf-node-header wf-node-header-process">
        <div className="wf-node-icon wf-node-icon-process">
          <Cog className="h-3.5 w-3.5" />
        </div>
        <span className="wf-node-label">{nodeData.label}</span>
      </div>
      {nodeData.description && (
        <div className="wf-node-body">
          <span className="wf-node-desc">{nodeData.description}</span>
        </div>
      )}
    </div>
  );
}

export const ProcessNode = memo(ProcessNodeComponent);
