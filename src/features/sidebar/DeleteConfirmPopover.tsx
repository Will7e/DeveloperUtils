// ============================================================
// Delete Confirm Popover — single-click delete with confirmation
// ============================================================
// Replaces the old "click twice to confirm" flow: clicking a file's
// delete button opens this small anchored popover where the user
// explicitly confirms or cancels. Styled after the NewFileMenu
// popover (Geist design language).

import { useEffect, useMemo, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface DeleteConfirmPopoverProps {
  open: boolean;
  file: { id: string; name: string; isDirty?: boolean } | null;
  /** Fixed-position anchor (top-left corner where the popover should appear) */
  anchor: { top: number; left: number } | null;
  onCancel: () => void;
  onConfirm: () => void;
}

const POPOVER_WIDTH = 236;
const POPOVER_HEIGHT = 118;

export function DeleteConfirmPopover({
  open,
  file,
  anchor,
  onCancel,
  onConfirm,
}: DeleteConfirmPopoverProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  // Focus the confirm button + wire Escape when the popover opens
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => confirmBtnRef.current?.focus());
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", handleKey, true);
    };
  }, [open, onCancel]);

  // Clamp position to the viewport; flip above the anchor when
  // there isn't room below (delete button sits near the list bottom)
  const pos = useMemo(() => {
    if (!anchor) return null;
    const fitsBelow = anchor.top + POPOVER_HEIGHT + 12 <= window.innerHeight;
    const top = fitsBelow
      ? anchor.top
      : Math.max(8, anchor.top - POPOVER_HEIGHT - 34);
    const left = Math.min(anchor.left, window.innerWidth - POPOVER_WIDTH - 12);
    return { top: Math.max(8, top), left: Math.max(8, left) };
  }, [anchor]);

  if (!open || !file || !pos) return null;

  return (
    <>
      <div className="newfile-backdrop" onClick={onCancel} aria-hidden="true" />
      <div
        className="delete-confirm-popover"
        style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
        role="alertdialog"
        aria-label={`Delete ${file.name}`}
      >
        <div className="delete-confirm-body">
          <AlertTriangle className="h-4 w-4 delete-confirm-icon" />
          <span className="delete-confirm-text">
            Delete <strong className="delete-confirm-name">{file.name}</strong>?
            {file.isDirty && (
              <span className="delete-confirm-dirty">Unsaved changes will be lost.</span>
            )}
          </span>
        </div>
        <div className="delete-confirm-actions">
          <button
            type="button"
            className="delete-confirm-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={cn("delete-confirm-delete")}
            onClick={onConfirm}
          >
            Delete
          </button>
        </div>
      </div>
    </>
  );
}
