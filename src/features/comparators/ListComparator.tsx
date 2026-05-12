import React, { useState, useMemo, useCallback, useEffect } from "react";
import { DndContext, closestCenter, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { SortableTab } from "@/components/ui/SortableTab";
import { 
  Columns, 
  ArrowRight, 
  Trash2, 
  Copy, 
  Check, 
  Search, 
  Download,
  Info,
  Play,
  Settings2,
  AlignLeft,
  ChevronDown,
  FileText,
  Plus,
  X
} from "lucide-react";
import { 
  Panel, 
  Group as PanelGroup, 
  Separator as PanelResizeHandle 
} from "react-resizable-panels";
import { 
  Tooltip, 
  TooltipTrigger, 
  TooltipContent 
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";

type ComparisonType = "aOnly" | "bOnly" | "both";

interface ComparisonResults {
  aOnly: string[];
  bOnly: string[];
  both: string[];
}

interface ActionTooltipProps {
  children: React.ReactNode;
  content: string;
  side?: "top" | "bottom" | "left" | "right";
}

const ActionTooltip = ({ children, content, side = "top" }: ActionTooltipProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      {children}
    </TooltipTrigger>
    <TooltipContent side={side}>
      <p>{content}</p>
    </TooltipContent>
  </Tooltip>
);

export function ListComparator() {
  // Store persistence
  const sessions = useAppStore((s) => s.comparatorSessions);
  const activeSessionId = useAppStore((s) => s.activeComparatorSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveComparatorSession);
  const createSession = useAppStore((s) => s.createComparatorSession);
  const deleteSession = useAppStore((s) => s.deleteComparatorSession);
  const renameSession = useAppStore((s) => s.renameComparatorSession);
  const updateSessionInput = useAppStore((s) => s.updateComparatorSessionInput);

  const comparatorSettings = useAppStore((s) => s.comparatorSettings);
  const updateComparatorSettings = useAppStore((s) => s.updateComparatorSettings);
  const addToast = useAppStore((s) => s.addToast);
  const reorderSessions = useAppStore((s) => s.reorderComparatorSessions);

  // Local runtime state
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<ComparisonType>("aOnly");
  const [copied, setCopied] = useState<string | null>(null);
  const [lastResults, setLastResults] = useState<ComparisonResults>({ aOnly: [], bOnly: [], both: [] });
  const [hasCompared, setHasCompared] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // DnD sensor with activation constraint to allow clicks without triggering drag
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sessions.findIndex((s) => s.id === active.id);
    const newIndex = sessions.findIndex((s) => s.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      reorderSessions(oldIndex, newIndex);
    }
  }, [sessions, reorderSessions]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0]!;
  const inputA = activeSession.a;
  const inputB = activeSession.b;

  const { caseSensitive, trimWhitespace, sortAlpha } = comparatorSettings;

  // Hydration check to ensure we use persisted state
  useEffect(() => {
    setIsHydrated(true);
  }, []);

  // Helper to process list
  const processList = useCallback((input: string) => {
    if (!input) return [];
    let lines = input.split(/[\n\r,;|]+/).map(l => trimWhitespace ? l.trim() : l);
    lines = lines.filter(l => l.length > 0);
    return Array.from(new Set(lines));
  }, [trimWhitespace]);

  const formatInput = useCallback((input: string, key: "a" | "b") => {
    const list = processList(input);
    updateSessionInput(activeSession.id, key, list.join("\n"));
    addToast({ message: "List formatted with newlines", type: "info" });
  }, [processList, updateSessionInput, activeSession.id, addToast]);

  const handleCompare = useCallback(() => {
    const listA = processList(inputA);
    const listB = processList(inputB);

    const setA = new Set(caseSensitive ? listA : listA.map(s => s.toLowerCase()));
    const setB = new Set(caseSensitive ? listB : listB.map(s => s.toLowerCase()));

    let aOnly: string[] = [];
    let bOnly: string[] = [];
    let both: string[] = [];

    listA.forEach(item => {
      const checkItem = caseSensitive ? item : item.toLowerCase();
      if (setB.has(checkItem)) {
        both.push(item);
      } else {
        aOnly.push(item);
      }
    });

    listB.forEach(item => {
      const checkItem = caseSensitive ? item : item.toLowerCase();
      if (!setA.has(checkItem)) {
        bOnly.push(item);
      }
    });

    if (sortAlpha) {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      aOnly.sort(collator.compare);
      bOnly.sort(collator.compare);
      both.sort(collator.compare);
    }

    setLastResults({ aOnly, bOnly, both });
    setHasCompared(true);
  }, [inputA, inputB, caseSensitive, trimWhitespace, sortAlpha, processList]);

  // Auto-compare when hydrated or when settings/inputs change if already compared
  useEffect(() => {
    if (isHydrated && (inputA || inputB)) {
      handleCompare();
    }
  }, [isHydrated, inputA, inputB, caseSensitive, trimWhitespace, sortAlpha, handleCompare]);

  const filteredResults = useMemo(() => {
    const current = lastResults[activeTab];
    if (!query.trim()) return current;
    const q = query.toLowerCase();
    return current.filter((item: string) => item.toLowerCase().includes(q));
  }, [lastResults, activeTab, query]);

  const handleCopy = (content: string[], id: string) => {
    if (content.length === 0) return;
    navigator.clipboard.writeText(content.join("\n"));
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
    addToast({ message: "Copied to clipboard", type: "success" });
  };

  const handleExport = () => {
    if (filteredResults.length === 0) return;
    const content = filteredResults.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `comparator_${activeTab}_results.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Only render once hydrated to avoid mismatch and ensure persistence is loaded
  if (!isHydrated) return null;

  return (
    <div className="list-comparator-container">
      <div className="tabs-bar">
        <div className="tabs-list">
          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sessions.map(s => s.id)} strategy={horizontalListSortingStrategy}>
              {sessions.map(session => (
                <SortableTab key={session.id} id={session.id}>
                  <button 
                    className={cn(
                      "tab",
                      activeSessionId === session.id && "tab-active"
                    )}
                    onClick={() => setActiveSession(session.id)}
                    onDoubleClick={() => {
                      setEditName(session.name);
                      setEditingSessionId(session.id);
                    }}
                  >
                    <span className="tab-icon tab-icon-javascript">
                      <Columns className="h-3 w-3" />
                    </span>
                    {editingSessionId === session.id ? (
                      <input
                        autoFocus
                        className="tab-rename-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onBlur={() => {
                          if (editName.trim() && editName !== session.name) {
                            renameSession(session.id, editName.trim());
                          }
                          setEditingSessionId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            setEditingSessionId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="tab-name">
                        {session.name}
                      </span>
                    )}
                    <span 
                      className="tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(session.id);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </span>
                  </button>
                </SortableTab>
              ))}
            </SortableContext>
          </DndContext>
          <button 
            className="tab-new"
            onClick={() => createSession()}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        <div className="tabs-toolbar">
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
                onCheckedChange={(checked) => updateComparatorSettings({ caseSensitive: checked })}
                onSelect={(e) => e.preventDefault()}
              >
                Case Sensitive
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={trimWhitespace}
                onCheckedChange={(checked) => updateComparatorSettings({ trimWhitespace: checked })}
                onSelect={(e) => e.preventDefault()}
              >
                Trim Whitespace
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Display</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={sortAlpha}
                onCheckedChange={(checked) => updateComparatorSettings({ sortAlpha: checked })}
                onSelect={(e) => e.preventDefault()}
              >
                Natural Sort Order
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="tabs-toolbar-sep" />

          <ActionTooltip content="Reset both input lists">
            <button className="toolbar-btn text-red hover:bg-red-dim" onClick={() => { 
              updateSessionInput(activeSession.id, "a", ""); 
              updateSessionInput(activeSession.id, "b", ""); 
              setHasCompared(false); 
              setLastResults({ aOnly: [], bOnly: [], both: [] });
            }}>
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          </ActionTooltip>

          <div className="tabs-toolbar-sep" />

          <ActionTooltip content="Analyze differences between List A and B">
            <button className="tabs-run-btn" onClick={handleCompare}>
              <Play className="h-3 w-3 fill-current" />
              <span>Compare Now</span>
            </button>
          </ActionTooltip>
        </div>
      </div>

      <div className="list-comparator-content">
        <PanelGroup orientation="vertical">
          <Panel defaultSize={45} minSize={20}>
            <PanelGroup orientation="horizontal">
              {/* List A Panel */}
              <Panel defaultSize={50} minSize={20}>
                <div className="comparator-input-panel h-full">
                  <div className="section-header-row">
                    <div className="section-label">List A ({processList(inputA).length} items)</div>
                    <div className="flex items-center gap-1">
                      <ActionTooltip content="Convert commas/separators to newlines">
                        <button className="toolbar-icon-btn" onClick={() => formatInput(inputA, "a")}>
                          <AlignLeft className="h-3.5 w-3.5" />
                        </button>
                      </ActionTooltip>
                      <ActionTooltip content="Copy List A to clipboard">
                        <button className="toolbar-icon-btn" onClick={() => handleCopy(processList(inputA), "list-a")}>
                          {copied === "list-a" ? <Check className="h-3.5 w-3.5 text-green" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                      </ActionTooltip>
                    </div>
                  </div>
                  <textarea
                    className="comparator-textarea"
                    placeholder="Paste List A here..."
                    value={inputA}
                    onChange={(e) => updateSessionInput(activeSession.id, "a", e.target.value)}
                    spellCheck={false}
                  />
                </div>
              </Panel>

              <PanelResizeHandle className="comparator-resize-handle-h" />

              {/* List B Panel */}
              <Panel defaultSize={50} minSize={20}>
                <div className="comparator-input-panel h-full">
                  <div className="section-header-row">
                    <div className="section-label">List B ({processList(inputB).length} items)</div>
                    <div className="flex items-center gap-1">
                      <ActionTooltip content="Convert commas/separators to newlines">
                        <button className="toolbar-icon-btn" onClick={() => formatInput(inputB, "b")}>
                          <AlignLeft className="h-3.5 w-3.5" />
                        </button>
                      </ActionTooltip>
                      <ActionTooltip content="Copy List B to clipboard">
                        <button className="toolbar-icon-btn" onClick={() => handleCopy(processList(inputB), "list-b")}>
                          {copied === "list-b" ? <Check className="h-3.5 w-3.5 text-green" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                      </ActionTooltip>
                    </div>
                  </div>
                  <textarea
                    className="comparator-textarea"
                    placeholder="Paste List B here..."
                    value={inputB}
                    onChange={(e) => updateSessionInput(activeSession.id, "b", e.target.value)}
                    spellCheck={false}
                  />
                </div>
              </Panel>
            </PanelGroup>
          </Panel>

          <PanelResizeHandle className="comparator-resize-handle-v" />

          <Panel defaultSize={55} minSize={20}>
            {/* Results Section */}
            <div className="list-comparator-results h-full">
              <div className="results-tabs">
                <button 
                  className={cn("results-tab", activeTab === "aOnly" && "active")}
                  onClick={() => setActiveTab("aOnly")}
                >
                  Only in A
                  <span className="tab-badge">{lastResults.aOnly.length}</span>
                </button>
                <button 
                  className={cn("results-tab", activeTab === "bOnly" && "active")}
                  onClick={() => setActiveTab("bOnly")}
                >
                  Only in B
                  <span className="tab-badge">{lastResults.bOnly.length}</span>
                </button>
                <button 
                  className={cn("results-tab", activeTab === "both" && "active")}
                  onClick={() => setActiveTab("both")}
                >
                  Common
                  <span className="tab-badge">{lastResults.both.length}</span>
                </button>

                <div className="ml-auto flex items-center gap-2 px-2">
                  <div className="relative">
                    <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-text-3" />
                    <input 
                      type="text" 
                      className="results-search" 
                      placeholder="Filter results..."
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <ActionTooltip content="Download results as .txt">
                    <button className="toolbar-icon-btn" onClick={handleExport}>
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </ActionTooltip>
                </div>
              </div>

              <div className="results-list-container">
                {!hasCompared && !inputA && !inputB ? (
                  <div className="results-empty">
                    <Settings2 className="h-8 w-8 opacity-10 mb-2" />
                    <p>Paste your lists and click "Compare Now"</p>
                  </div>
                ) : filteredResults.length === 0 ? (
                  <div className="results-empty">
                    <Info className="h-8 w-8 opacity-10 mb-2" />
                    <p>{hasCompared ? "No items found for this category" : "Click 'Compare Now' to analyze"}</p>
                  </div>
                ) : (
                  <div className="results-scroll">
                    {filteredResults.map((item: string, idx: number) => (
                      <div key={idx} className="result-item">
                        <span className="result-idx">{idx + 1}</span>
                        <span className="result-text">{item}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
