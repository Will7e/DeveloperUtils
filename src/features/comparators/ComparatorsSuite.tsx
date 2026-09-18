// ============================================================
// ComparatorsSuite — Unified Comparison Workspace
// Hosts List & Set, Semantic JSON Object, and Key-Value / .env
// engines with seamless tabs and synchronized workspace settings.
// ============================================================

import React, { useMemo, useCallback } from "react";
import { WorkspaceTabBar, type TabItem } from "@/components/ui/WorkspaceTabBar";
import {
  Columns,
  Braces,
  KeyRound,
  ArrowLeftRight,
  FlaskConical,
  Settings2,
  Trash2,
  ChevronDown,
  Check,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import { ListComparator } from "./ListComparator";
import { JsonComparator } from "./JsonComparator";
import { EnvComparator } from "./EnvComparator";
import { COMPARATOR_SAMPLES } from "./comparatorsUtils";

interface ActionTooltipProps {
  children: React.ReactNode;
  content: string;
  side?: "top" | "bottom" | "left" | "right";
}

const ActionTooltip = ({ children, content, side = "top" }: ActionTooltipProps) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side={side}>
      <p>{content}</p>
    </TooltipContent>
  </Tooltip>
);

export function ComparatorsSuite() {
  const sessions = useAppStore((s) => s.comparatorSessions);
  const activeSessionId = useAppStore((s) => s.activeComparatorSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveComparatorSession);
  const createSession = useAppStore((s) => s.createComparatorSession);
  const deleteSession = useAppStore((s) => s.deleteComparatorSession);
  const duplicateSession = useAppStore((s) => s.duplicateComparatorSession);
  const closeOtherSessions = useAppStore((s) => s.closeOtherComparatorSessions);
  const closeSessionsToRight = useAppStore((s) => s.closeComparatorSessionsToRight);
  const closeAllSessions = useAppStore((s) => s.closeAllComparatorSessions);
  const renameSession = useAppStore((s) => s.renameComparatorSession);
  const reorderSessions = useAppStore((s) => s.reorderComparatorSessions);
  const updateSessionInput = useAppStore((s) => s.updateComparatorSessionInput);
  const updateSessionMode = useAppStore((s) => s.updateComparatorSessionMode);
  const swapInputs = useAppStore((s) => s.swapComparatorSessionInputs);
  const comparatorSettings = useAppStore((s) => s.comparatorSettings);
  const updateComparatorSettings = useAppStore((s) => s.updateComparatorSettings);
  const addToast = useAppStore((s) => s.addToast);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0]!;
  const currentMode = activeSession.mode || "list";

  // Tab Items for WorkspaceTabBar
  const tabs: TabItem[] = useMemo(
    () =>
      sessions.map((session) => {
        const mode = session.mode || "list";
        let icon = <Columns className="h-3 w-3" />;
        let iconClass = "tab-icon-javascript";

        if (mode === "json") {
          icon = <Braces className="h-3 w-3" />;
          iconClass = "tab-icon-json";
        } else if (mode === "env") {
          icon = <KeyRound className="h-3 w-3" />;
          iconClass = "tab-icon-typescript";
        }

        return {
          id: session.id,
          name: session.name,
          icon: <span className={cn("tab-icon", iconClass)}>{icon}</span>,
          closable: sessions.length > 1,
        };
      }),
    [sessions]
  );

  const handleCopyTabContent = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (session) {
        const text = `--- Input A ---\n${session.a}\n\n--- Input B ---\n${session.b}`;
        navigator.clipboard.writeText(text);
        addToast({ message: `Copied ${session.name} inputs to clipboard`, type: "success", duration: 1500 });
      }
    },
    [sessions, addToast]
  );

  const handleCopyTabName = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (session) {
        navigator.clipboard.writeText(session.name);
        addToast({ message: "Session name copied", type: "info", duration: 1500 });
      }
    },
    [sessions, addToast]
  );

  // Load realistic preset sample
  const handleLoadSample = useCallback(() => {
    const sample = COMPARATOR_SAMPLES[currentMode];
    if (sample) {
      updateSessionInput(activeSession.id, "a", sample.a);
      updateSessionInput(activeSession.id, "b", sample.b);
      addToast({
        message: `Loaded ${currentMode.toUpperCase()} sample data`,
        type: "success",
        duration: 2000,
      });
    }
  }, [currentMode, activeSession.id, updateSessionInput, addToast]);

  // Clear inputs
  const handleClear = useCallback(() => {
    updateSessionInput(activeSession.id, "a", "");
    updateSessionInput(activeSession.id, "b", "");
    addToast({ message: "Cleared inputs", type: "info" });
  }, [activeSession.id, updateSessionInput, addToast]);

  // Swap Left and Right inputs
  const handleSwap = useCallback(() => {
    swapInputs(activeSession.id);
    addToast({ message: "Swapped Input A ⇄ Input B", type: "info" });
  }, [swapInputs, activeSession.id, addToast]);

  const { caseSensitive, trimWhitespace, sortAlpha } = comparatorSettings;

  return (
    <div className="list-comparator-container flex-1 flex flex-col h-full overflow-hidden bg-bg-0">
      {/* Top Workspace Tab Bar */}
      <WorkspaceTabBar
        tabs={tabs}
        activeTabId={activeSession.id}
        onSelectTab={setActiveSession}
        onCloseTab={deleteSession}
        onNewTab={() => createSession(undefined, currentMode)}
        onRenameTab={(id, newName) => renameSession(id, newName)}
        onReorderTabs={(_activeId, _overId, oldIndex, newIndex) =>
          reorderSessions(oldIndex, newIndex)
        }
        onDuplicateTab={duplicateSession}
        onCloseOthers={closeOtherSessions}
        onCloseToRight={closeSessionsToRight}
        onCloseAll={closeAllSessions}
        onCopyContent={handleCopyTabContent}
        onCopyName={handleCopyTabName}
        newTabTooltip="New Comparison Session"
        rightContent={
          <>
            {/* Data Type Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="toolbar-btn">
                  {currentMode === "json" ? (
                    <Braces className="h-3.5 w-3.5 text-accent" />
                  ) : currentMode === "env" ? (
                    <KeyRound className="h-3.5 w-3.5 text-purple" />
                  ) : (
                    <Columns className="h-3.5 w-3.5 text-blue" />
                  )}
                  <span className="font-medium">
                    {currentMode === "json"
                      ? "JSON Object"
                      : currentMode === "env"
                      ? ".env / Config"
                      : "List & Set"}
                  </span>
                  <ChevronDown className="h-3 w-3 opacity-50 ml-0.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[170px]">
                <DropdownMenuLabel>Data Type</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className={cn(
                    "flex items-center gap-2 cursor-pointer",
                    currentMode === "list" && "bg-bg-hover font-semibold"
                  )}
                  onClick={() => updateSessionMode(activeSession.id, "list")}
                >
                  <Columns className="h-3.5 w-3.5 text-blue" />
                  <span>List & Set</span>
                  {currentMode === "list" && <Check className="h-3.5 w-3.5 text-accent ml-auto" />}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={cn(
                    "flex items-center gap-2 cursor-pointer",
                    currentMode === "json" && "bg-bg-hover font-semibold"
                  )}
                  onClick={() => updateSessionMode(activeSession.id, "json")}
                >
                  <Braces className="h-3.5 w-3.5 text-accent" />
                  <span>JSON Object</span>
                  {currentMode === "json" && <Check className="h-3.5 w-3.5 text-accent ml-auto" />}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={cn(
                    "flex items-center gap-2 cursor-pointer",
                    currentMode === "env" && "bg-bg-hover font-semibold"
                  )}
                  onClick={() => updateSessionMode(activeSession.id, "env")}
                >
                  <KeyRound className="h-3.5 w-3.5 text-purple" />
                  <span>.env / Config</span>
                  {currentMode === "env" && <Check className="h-3.5 w-3.5 text-accent ml-auto" />}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="tabs-toolbar-sep mx-1" />

            {/* Quick Actions */}
            <ActionTooltip content="Swap Input A ⇄ Input B">
              <button className="toolbar-btn" onClick={handleSwap}>
                <ArrowLeftRight className="h-3.5 w-3.5" />
                <span>Swap</span>
              </button>
            </ActionTooltip>

            <ActionTooltip content={`Load realistic ${currentMode.toUpperCase()} sample data`}>
              <button className="toolbar-btn" onClick={handleLoadSample}>
                <FlaskConical className="h-3.5 w-3.5 text-accent" />
                <span>Sample</span>
              </button>
            </ActionTooltip>

            {/* Settings dropdown for List mode */}
            {currentMode === "list" && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="toolbar-btn">
                    <Settings2 className="h-3.5 w-3.5" />
                    Settings
                    <ChevronDown className="h-3 w-3 opacity-50" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Analysis Rules</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={caseSensitive}
                    onCheckedChange={(checked) =>
                      updateComparatorSettings({ caseSensitive: checked })
                    }
                    onSelect={(e) => e.preventDefault()}
                  >
                    Case Sensitive
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={trimWhitespace}
                    onCheckedChange={(checked) =>
                      updateComparatorSettings({ trimWhitespace: checked })
                    }
                    onSelect={(e) => e.preventDefault()}
                  >
                    Trim Whitespace
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Display</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={sortAlpha}
                    onCheckedChange={(checked) =>
                      updateComparatorSettings({ sortAlpha: checked })
                    }
                    onSelect={(e) => e.preventDefault()}
                  >
                    Natural Sort Order
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <div className="tabs-toolbar-sep mx-1" />

            <ActionTooltip content="Reset both inputs">
              <button
                className="toolbar-btn text-red hover:bg-red-dim"
                onClick={handleClear}
                disabled={!activeSession.a && !activeSession.b}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear</span>
              </button>
            </ActionTooltip>
          </>
        }
      />

      {/* Render Active Engine */}
      <div className="list-comparator-content flex-1 flex flex-col overflow-hidden">
        {currentMode === "json" ? (
          <JsonComparator />
        ) : currentMode === "env" ? (
          <EnvComparator />
        ) : (
          <ListComparator />
        )}
      </div>
    </div>
  );
}
