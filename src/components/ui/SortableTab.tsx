// ============================================================
// SortableTab — Shared drag-and-drop tab wrapper using @dnd-kit
// ============================================================
// Wraps any tab button to make it draggable and sortable.
// Used across Editor, Formatter, Comparator, and Workflow tabs.
//
// The wrapper uses display:contents-like flex behavior so it
// integrates seamlessly into any parent flex container without
// breaking tab bar layout.
// ============================================================

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, ReactNode } from "react";

interface SortableTabProps {
  id: string;
  children: ReactNode;
}

export function SortableTab({ id, children }: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: isDragging ? "grabbing" : undefined,
    position: "relative",
    zIndex: isDragging ? 10 : undefined,
    // Seamlessly integrate into parent flex container
    display: "flex",
    alignSelf: "stretch",
    flexShrink: 0,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}
