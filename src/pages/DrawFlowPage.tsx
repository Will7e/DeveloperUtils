// ============================================================
// DrawFlow Page — Route wrapper for DrawFlow Designer
// ============================================================

import { DrawFlowDesigner } from "@/features/drawflows/DrawFlowDesigner";

export function DrawFlowPage() {
  return (
    <div className="page-container bg-bg-0">
      <DrawFlowDesigner />
    </div>
  );
}

export default DrawFlowPage;
