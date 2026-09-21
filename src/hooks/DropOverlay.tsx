// ============================================================
// DropOverlay — Shared full-viewport drag & drop affordance
// ============================================================
// Pointer-events are disabled so the drop always reaches the
// underlying element's handlers. Renders through a portal so
// ancestor transforms/backdrop-filters can't break positioning.
// Kept in its own file so useFileDrop.tsx stays fast-refresh-safe.

import React from "react";
import { createPortal } from "react-dom";
import { UploadCloud } from "lucide-react";

interface DropOverlayProps {
  show: boolean;
  /** Message shown inside the overlay card */
  label?: string;
  /** Label for the LEFT half when the overlay is split in two */
  leftLabel?: string;
  /** Label for the RIGHT half when the overlay is split in two */
  rightLabel?: string;
}

export function DropOverlay({
  show,
  label,
  leftLabel,
  rightLabel,
}: DropOverlayProps): React.ReactElement | null {
  if (!show) return null;

  const card = (text: string) => (
    <div className="intab-drop-overlay-card">
      <UploadCloud className="intab-drop-overlay-icon" aria-hidden="true" />
      <span className="intab-drop-overlay-label">{text}</span>
    </div>
  );

  return createPortal(
    <div className="intab-drop-overlay-wrap" aria-hidden="true">
      {leftLabel && rightLabel ? (
        <>
          <div className="intab-drop-overlay-half">{card(leftLabel)}</div>
          <div className="intab-drop-overlay-half intab-drop-overlay-half-right">
            {card(rightLabel)}
          </div>
        </>
      ) : (
        <div className="intab-drop-overlay-full">{card(label ?? "Drop file to load")}</div>
      )}
    </div>,
    document.body
  );
}
