// ============================================================
// WorkspaceTabBar — Shared, reusable drag-and-drop tab bar
// ============================================================
// Standardizes tabs across Editor, Formatters, Comparators,
// Diff Checker, and DrawFlow diagrams.
//
// Features:
// - Drag & drop sortable tabs using @dnd-kit
// - Double-click inline renaming with keyboard navigation
// - Dirty status indicator dot
// - Close tab button with tooltips
// - New tab "+" button with optional custom renderer
// - Right-side toolbar slot for contextual actions
// ============================================================

import React, { useState, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { X, Plus } from "lucide-react";
import { SortableTab } from "@/components/ui/SortableTab";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { TabContextMenu } from "@/components/ui/TabContextMenu";
import { cn } from "@/lib/utils";

export interface TabItem {
  id: string;
  name: string;
  icon?: React.ReactNode;
  isDirty?: boolean;
  isRunning?: boolean;
  closable?: boolean;
  tooltip?: string;
}

export interface WorkspaceTabBarProps<T extends TabItem = TabItem> {
  tabs: T[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab?: (id: string) => void;
  onNewTab?: () => void;
  onRenameTab?: (id: string, newName: string) => void;
  onReorderTabs?: (
    activeId: string,
    overId: string,
    oldIndex: number,
    newIndex: number
  ) => void;
  // Tab Context Menu callbacks
  onCloseOthers?: (id: string) => void;
  onCloseToRight?: (id: string) => void;
  onCloseAll?: () => void;
  onDuplicateTab?: (id: string) => void;
  onCopyContent?: (id: string) => void;
  onCopyName?: (id: string) => void;
  newTabTooltip?: string;
  closeTabTooltip?: string;
  renderNewTabButton?: () => React.ReactNode;
  rightContent?: React.ReactNode;
  className?: string;
}

export function WorkspaceTabBar<T extends TabItem = TabItem>({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onRenameTab,
  onReorderTabs,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onDuplicateTab,
  onCopyContent,
  onCopyName,
  newTabTooltip = "New Tab",
  closeTabTooltip = "Close Tab",
  renderNewTabButton,
  rightContent,
  className,
}: WorkspaceTabBarProps<T>) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    tab: T;
    position: { x: number; y: number };
  } | null>(null);

  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !onReorderTabs) return;

      const oldIndex = tabs.findIndex((t) => t.id === active.id);
      const newIndex = tabs.findIndex((t) => t.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        onReorderTabs(String(active.id), String(over.id), oldIndex, newIndex);
      }
    },
    [tabs, onReorderTabs]
  );

  const handleStartRename = (tab: T) => {
    if (!onRenameTab) return;
    setRenamingId(tab.id);
    setRenameValue(tab.name);
  };

  const handleCommitRename = (tab: T) => {
    if (onRenameTab && renameValue.trim() && renameValue.trim() !== tab.name) {
      onRenameTab(tab.id, renameValue.trim());
    }
    setRenamingId(null);
  };

  const handleCloseOthers = useCallback(
    (targetTabId: string) => {
      if (onCloseOthers) {
        onCloseOthers(targetTabId);
        return;
      }
      if (!onCloseTab) return;
      tabs.forEach((t) => {
        if (t.id !== targetTabId && t.closable !== false) {
          onCloseTab(t.id);
        }
      });
    },
    [onCloseOthers, onCloseTab, tabs]
  );

  const handleCloseToRight = useCallback(
    (targetTabId: string) => {
      if (onCloseToRight) {
        onCloseToRight(targetTabId);
        return;
      }
      if (!onCloseTab) return;
      const targetIndex = tabs.findIndex((t) => t.id === targetTabId);
      if (targetIndex === -1) return;
      tabs.slice(targetIndex + 1).forEach((t) => {
        if (t.closable !== false) {
          onCloseTab(t.id);
        }
      });
    },
    [onCloseToRight, onCloseTab, tabs]
  );

  const handleCloseAll = useCallback(() => {
    if (onCloseAll) {
      onCloseAll();
      return;
    }
    if (!onCloseTab) return;
    tabs.forEach((t) => {
      if (t.closable !== false) {
        onCloseTab(t.id);
      }
    });
  }, [onCloseAll, onCloseTab, tabs]);

  const handleCopyName = useCallback(
    (targetTab: T) => {
      if (onCopyName) {
        onCopyName(targetTab.id);
        return;
      }
      navigator.clipboard.writeText(targetTab.name);
    },
    [onCopyName]
  );

  return (
    <div className={cn("tabs-bar", className)}>
      <div className="tabs-list">
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={tabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const isRenaming = renamingId === tab.id;
              const canClose =
                onCloseTab &&
                (tab.closable !== undefined ? tab.closable : tabs.length > 1);

              return (
                <SortableTab key={tab.id} id={tab.id}>
                  <button
                    type="button"
                    className={cn("tab", isActive && "tab-active")}
                    onClick={() => onSelectTab(tab.id)}
                    onDoubleClick={() => handleStartRename(tab)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelectTab(tab.id);
                      setContextMenu({
                        tab,
                        position: { x: e.clientX, y: e.clientY },
                      });
                    }}
                    title={tab.tooltip}
                  >
                    {tab.icon && (
                      <span className="tab-icon-wrapper flex items-center justify-center shrink-0">
                        {tab.icon}
                      </span>
                    )}

                    {isRenaming ? (
                      <input
                        autoFocus
                        className="tab-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => handleCommitRename(tab)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleCommitRename(tab);
                          } else if (e.key === "Escape") {
                            setRenamingId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <span className="tab-name">{tab.name}</span>
                        {tab.isDirty && <span className="tab-dirty" />}
                        {tab.isRunning && tab.id !== activeTabId && (
                          <span className="tab-running-dot" aria-label="Running" />
                        )}
                      </>
                    )}

                    {canClose && (
                      <SimpleTooltip content={closeTabTooltip}>
                        <span
                          className="tab-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCloseTab(tab.id);
                          }}
                        >
                          <X className="h-3 w-3" />
                        </span>
                      </SimpleTooltip>
                    )}
                  </button>
                </SortableTab>
              );
            })}
          </SortableContext>
        </DndContext>

        {renderNewTabButton
          ? renderNewTabButton()
          : onNewTab && (
              <SimpleTooltip content={newTabTooltip}>
                <button
                  type="button"
                  className="tab-new"
                  onClick={onNewTab}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </SimpleTooltip>
            )}
      </div>

      {rightContent && <div className="tabs-toolbar">{rightContent}</div>}

      {/* Tab Context Menu */}
      {contextMenu && (
        <TabContextMenu
          isOpen={Boolean(contextMenu)}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          tabName={contextMenu.tab.name}
          canRename={Boolean(onRenameTab)}
          canDuplicate={Boolean(onDuplicateTab)}
          canCopyContent={Boolean(onCopyContent)}
          canClose={
            onCloseTab !== undefined &&
            (contextMenu.tab.closable !== undefined
              ? contextMenu.tab.closable
              : tabs.length > 1)
          }
          canCloseOthers={
            tabs.length > 1 && Boolean(onCloseOthers || onCloseTab)
          }
          canCloseToRight={
            tabs.findIndex((t) => t.id === contextMenu.tab.id) <
              tabs.length - 1 && Boolean(onCloseToRight || onCloseTab)
          }
          canCloseAll={Boolean(onCloseAll || onCloseTab)}
          onRename={
            onRenameTab ? () => handleStartRename(contextMenu.tab) : undefined
          }
          onDuplicate={
            onDuplicateTab
              ? () => onDuplicateTab(contextMenu.tab.id)
              : undefined
          }
          onCopyName={() => handleCopyName(contextMenu.tab)}
          onCopyContent={
            onCopyContent
              ? () => onCopyContent(contextMenu.tab.id)
              : undefined
          }
          onCloseTab={
            onCloseTab ? () => onCloseTab(contextMenu.tab.id) : undefined
          }
          onCloseOthers={
            onCloseOthers || onCloseTab
              ? () => handleCloseOthers(contextMenu.tab.id)
              : undefined
          }
          onCloseToRight={
            onCloseToRight || onCloseTab
              ? () => handleCloseToRight(contextMenu.tab.id)
              : undefined
          }
          onCloseAll={
            onCloseAll || onCloseTab ? handleCloseAll : undefined
          }
        />
      )}
    </div>
  );
}
