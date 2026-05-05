// ============================================================
// Workflow Page — Route wrapper for Workflow Designer
// ============================================================

import { WorkflowDesigner } from "@/features/workflows/WorkflowDesigner";

export function WorkflowPage() {
  return (
    <div className="page-container bg-bg-0">
      <WorkflowDesigner />
    </div>
  );
}

export default WorkflowPage;
