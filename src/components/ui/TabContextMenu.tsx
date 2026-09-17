// ============================================================
// TabContextMenu — Right-click context menu for workspace tabs
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Pencil,
  CopyPlus,
  Copy,
  Tag,
  X,
  FolderMinus,
  ArrowRightToLine,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface TabContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  tabName: string;
  canRename?: boolean;
  canDuplicate?: boolean;
  canCopyContent?: boolean;
  canClose?: boolean;
  canCloseOthers?: boolean;
  canCloseToRight?: boolean;
  canCloseAll?: boolean;
  onRename?: () => void;
  onDuplicate?: () => void;
  onCopyName?: () => void;
  onCopyContent?: () => void;
  onCloseTab?: () => void;
  onCloseOthers?: () => void;
  onCloseToRight?: () => void;
  onCloseAll?: () => void;
}

export function TabContextMenu({
  isOpen,
  position,
  onClose,
  tabName,
  canRename = true,
  canDuplicate = true,
  canCopyContent = false,
  canClose = true,
  canCloseOthers = true,
  canCloseToRight = true,
  canCloseAll = true,
  showShortcuts = false,
  onRename,
  onDuplicate,
  onCopyName,
  onCopyContent,
  onCloseTab,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
}: TabContextMenuProps & { showShortcuts?: boolean }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);

  // Auto-clamp to screen boundaries
  useEffect(() => {
    if (!isOpen) return;

    // Read bounding dimensions and clamp
    const menuEl = menuRef.current;
    if (menuEl) {
      const rect = menuEl.getBoundingClientRect();
      const padding = 8;
      const maxX = window.innerWidth - rect.width - padding;
      const maxY = window.innerHeight - rect.height - padding;

      const clampedX = Math.max(padding, Math.min(position.x, maxX));
      const clampedY = Math.max(padding, Math.min(position.y, maxY));

      setAdjustedPos({ x: clampedX, y: clampedY });
    } else {
      setAdjustedPos(position);
    }
  }, [isOpen, position]);

  // Click outside & Escape key listeners
  useEffect(() => {
    if (!isOpen) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    const handleScrollOrResize = () => {
      onClose();
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleAction = (action?: () => void) => {
    if (!action) return;
    onClose();
    action();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Tab options for ${tabName}`}
      className="dropdown-content tab-context-menu fixed z-[9999] min-w-[175px] py-1 select-none shadow-2xl"
      style={{
        left: adjustedPos.x,
        top: adjustedPos.y,
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* ── Section 1: Tab Editing & Duplication ── */}
      {onRename && (
        <button
          type="button"
          role="menuitem"
          disabled={!canRename}
          className={cn(
            "dropdown-item w-full text-left flex items-center justify-between",
            !canRename && "opacity-40 cursor-not-allowed pointer-events-none"
          )}
          onClick={() => handleAction(onRename)}
        >
          <span className="flex items-center gap-2">
            <Pencil className="h-3.5 w-3.5 opacity-70" />
            <span>Rename</span>
          </span>
          {showShortcuts && (
            <span className="ml-auto pl-4 text-[11px] text-text-3 font-mono opacity-50">
              F2
            </span>
          )}
        </button>
      )}

      {onDuplicate && (
        <button
          type="button"
          role="menuitem"
          disabled={!canDuplicate}
          className={cn(
            "dropdown-item w-full text-left flex items-center justify-between",
            !canDuplicate && "opacity-40 cursor-not-allowed pointer-events-none"
          )}
          onClick={() => handleAction(onDuplicate)}
        >
          <span className="flex items-center gap-2">
            <CopyPlus className="h-3.5 w-3.5 opacity-70" />
            <span>Duplicate Tab</span>
          </span>
          {showShortcuts && (
            <span className="ml-auto pl-4 text-[11px] text-text-3 font-mono opacity-50">
              ⌘D
            </span>
          )}
        </button>
      )}

      {(onRename || onDuplicate) && (onCopyName || onCopyContent) && (
        <div className="dropdown-separator my-1" />
      )}

      {/* ── Section 2: Clipboard Actions ── */}
      {onCopyName && (
        <button
          type="button"
          role="menuitem"
          className="dropdown-item w-full text-left flex items-center justify-between"
          onClick={() => handleAction(onCopyName)}
        >
          <span className="flex items-center gap-2">
            <Tag className="h-3.5 w-3.5 opacity-70" />
            <span>Copy Name</span>
          </span>
        </button>
      )}

      {onCopyContent && (
        <button
          type="button"
          role="menuitem"
          disabled={!canCopyContent}
          className={cn(
            "dropdown-item w-full text-left flex items-center justify-between",
            !canCopyContent && "opacity-40 cursor-not-allowed pointer-events-none"
          )}
          onClick={() => handleAction(onCopyContent)}
        >
          <span className="flex items-center gap-2">
            <Copy className="h-3.5 w-3.5 opacity-70" />
            <span>Copy Content</span>
          </span>
          {showShortcuts && (
            <span className="ml-auto pl-4 text-[11px] text-text-3 font-mono opacity-50">
              ⌘C
            </span>
          )}
        </button>
      )}

      <div className="dropdown-separator my-1" />

      {/* ── Section 3: Tab Closing Actions ── */}
      {onCloseTab && (
        <button
          type="button"
          role="menuitem"
          disabled={!canClose}
          className={cn(
            "dropdown-item w-full text-left flex items-center justify-between",
            !canClose && "opacity-40 cursor-not-allowed pointer-events-none"
          )}
          onClick={() => handleAction(onCloseTab)}
        >
          <span className="flex items-center gap-2">
            <X className="h-3.5 w-3.5 opacity-70" />
            <span>Close</span>
          </span>
          {showShortcuts && (
            <span className="ml-auto pl-4 text-[11px] text-text-3 font-mono opacity-50">
              ⌘W
            </span>
          )}
        </button>
      )}

      {onCloseOthers && (
        <button
          type="button"
          role="menuitem"
          disabled={!canCloseOthers}
          className={cn(
            "dropdown-item w-full text-left flex items-center justify-between",
            !canCloseOthers && "opacity-40 cursor-not-allowed pointer-events-none"
          )}
          onClick={() => handleAction(onCloseOthers)}
        >
          <span className="flex items-center gap-2">
            <FolderMinus className="h-3.5 w-3.5 opacity-70" />
            <span>Close Others</span>
          </span>
        </button>
      )}

      {onCloseToRight && (
        <button
          type="button"
          role="menuitem"
          disabled={!canCloseToRight}
          className={cn(
            "dropdown-item w-full text-left flex items-center justify-between",
            !canCloseToRight && "opacity-40 cursor-not-allowed pointer-events-none"
          )}
          onClick={() => handleAction(onCloseToRight)}
        >
          <span className="flex items-center gap-2">
            <ArrowRightToLine className="h-3.5 w-3.5 opacity-70" />
            <span>Close to the Right</span>
          </span>
        </button>
      )}

      {onCloseAll && (
        <>
          <div className="dropdown-separator my-1" />
          <button
            type="button"
            role="menuitem"
            disabled={!canCloseAll}
            className={cn(
              "dropdown-item w-full text-left flex items-center justify-between text-red-400 hover:text-red-300 hover:bg-red-500/10",
              !canCloseAll && "opacity-40 cursor-not-allowed pointer-events-none"
            )}
            onClick={() => handleAction(onCloseAll)}
          >
            <span className="flex items-center gap-2">
              <Trash2 className="h-3.5 w-3.5" />
              <span>Close All</span>
            </span>
          </button>
        </>
      )}
    </div>,
    document.body
  );
}
