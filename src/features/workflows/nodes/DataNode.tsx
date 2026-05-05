// ============================================================
// DataNode — Data input/output node
// ============================================================

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Database } from "lucide-react";

interface DataNodeData {
  label: string;
  description?: string;
  nodeType: string;
  [key: string]: unknown;
}

function DataNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as DataNodeData;

  return (
    <div className={`wf-node wf-node-data ${selected ? "wf-node-selected" : ""}`}>
      <Handle type="target" position={Position.Top} className="wf-handle wf-handle-target" />
      <Handle type="source" position={Position.Bottom} className="wf-handle wf-handle-source" />
      <div className="wf-node-header wf-node-header-data">
        <div className="wf-node-icon wf-node-icon-data">
          <Database className="h-3.5 w-3.5" />
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

export const DataNode = memo(DataNodeComponent);
