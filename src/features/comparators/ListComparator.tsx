import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  Copy,
  Check,
  Search,
  Download,
  Info,
  AlignLeft,
  Columns,
  X,
  Quote,
} from "lucide-react";
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import Editor, { type OnMount } from "@monaco-editor/react";
import { setupMonacoTheme } from "@/utils/monaco-theme";
import { EditorLoadingFallback } from "@/components/ui/editor-loader";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import {
  compareLists,
  processRawList,
} from "./comparatorsUtils";

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

type ComparisonType = "aOnly" | "bOnly" | "both" | "union";

export function ListComparator() {
  const sessions = useAppStore((s) => s.comparatorSessions);
  const activeSessionId = useAppStore((s) => s.activeComparatorSessionId);
  const updateSessionInput = useAppStore((s) => s.updateComparatorSessionInput);
  const comparatorSettings = useAppStore((s) => s.comparatorSettings);
  const addToast = useAppStore((s) => s.addToast);
  const currentThemeSetting = useAppStore((s) => s.editorSettings.theme);

  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<ComparisonType>("aOnly");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);

  // Handle Monaco theme dynamic switching
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(
        currentThemeSetting === "light" ? "intab-light" : "intab-dark"
      );
    }
  }, [currentThemeSetting]);

  const handleEditorMount = useCallback(
    (_side: "a" | "b") => (_editor: Parameters<OnMount>[0], monaco: Parameters<OnMount>[1]) => {
      monacoRef.current = monaco;
      setupMonacoTheme(monaco);
      const initTheme = useAppStore.getState().editorSettings.theme;
      monaco.editor.setTheme(initTheme === "light" ? "intab-light" : "intab-dark");
    },
    []
  );

  const monacoOptions = useMemo(
    () => ({
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on" as const,
      padding: { top: 8, bottom: 8 },
      fontSize: 12,
      fontFamily: "var(--font-mono)",
      lineNumbers: "on" as const,
      renderLineHighlight: "all" as const,
      tabSize: 2,
      automaticLayout: true,
      scrollbar: {
        useShadows: false,
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
      },
    }),
    []
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0]!;
  const inputA = activeSession.a;
  const inputB = activeSession.b;

  const { caseSensitive, trimWhitespace, sortAlpha } = comparatorSettings;

  // Compute set comparison
  const comparisonResults = useMemo(() => {
    return compareLists(inputA, inputB, {
      caseSensitive,
      trimWhitespace,
      sortAlpha,
      stripQuotes: true,
    });
  }, [inputA, inputB, caseSensitive, trimWhitespace, sortAlpha]);

  const hasCompared = Boolean(inputA.trim() || inputB.trim());

  // Filtered result list
  const filteredResults = useMemo(() => {
    const current = comparisonResults[activeTab];
    if (!query.trim()) return current;
    const q = query.toLowerCase();
    return current.filter((item: string) => item.toLowerCase().includes(q));
  }, [comparisonResults, activeTab, query]);

  // Clean & Format inputs with newlines
  const formatInput = useCallback(
    (input: string, key: "a" | "b") => {
      const list = processRawList(input, { trimWhitespace: true, stripQuotes: true });
      updateSessionInput(activeSession.id, key, list.join("\n"));
      addToast({
        message: `Formatted List ${key.toUpperCase()} (${list.length} items)`,
        type: "info",
      });
    },
    [updateSessionInput, activeSession.id, addToast]
  );

  const handleCopy = (content: string[], id: string, message = "Copied to clipboard") => {
    if (content.length === 0) return;
    navigator.clipboard.writeText(content.join("\n"));
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    addToast({ message, type: "success" });
  };

  const handleCopyQuoted = (item: string, id: string) => {
    navigator.clipboard.writeText(`"${item}"`);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    addToast({ message: "Copied with quotes", type: "success" });
  };

  const handleExport = () => {
    if (filteredResults.length === 0) return;
    const content = filteredResults.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `comparator_${activeTab}_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    addToast({ message: `Exported ${filteredResults.length} items`, type: "info" });
  };

  const listACount = comparisonResults.countA;
  const listBCount = comparisonResults.countB;
  const activeTabTotal = comparisonResults[activeTab].length;

  // Search match highlighter
  const renderHighlightedText = (text: string, searchQuery: string) => {
    if (!searchQuery.trim()) return text;
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${escaped})`, "gi"));
    return parts.map((part, i) =>
      part.toLowerCase() === searchQuery.toLowerCase() ? (
        <mark
          key={i}
          className="bg-accent/25 text-accent font-semibold px-0.5 rounded"
        >
          {part}
        </mark>
      ) : (
        part
      )
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <PanelGroup orientation="vertical">
        {/* Top: Dual List Inputs */}
        <Panel defaultSize={42} minSize={20}>
          <PanelGroup orientation="horizontal">
            {/* List A Panel */}
            <Panel defaultSize={50} minSize={20}>
              <div className="comparator-input-panel h-full border-r border-border-1 flex flex-col min-w-0">
                <div className="section-header-row px-3 py-2 bg-bg-1 border-b border-border-1 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="section-label font-medium text-xs text-text-1">
                      List A
                    </span>
                    <span className="tab-badge bg-bg-2 text-text-2">
                      {listACount} items
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <ActionTooltip content="Format separators & quotes to clean newlines">
                      <button
                        className="toolbar-icon-btn"
                        onClick={() => formatInput(inputA, "a")}
                        disabled={!inputA.trim()}
                      >
                        <AlignLeft className="h-3.5 w-3.5" />
                      </button>
                    </ActionTooltip>
                    <ActionTooltip content="Copy List A to clipboard">
                      <button
                        className="toolbar-icon-btn"
                        onClick={() =>
                          handleCopy(processRawList(inputA), "list-a", "Copied List A")
                        }
                        disabled={listACount === 0}
                      >
                        {copiedId === "list-a" ? (
                          <Check className="h-3.5 w-3.5 text-green" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </ActionTooltip>
                  </div>
                </div>
                <div className="flex-1 w-full min-h-0 relative bg-bg-0">
                  <Editor
                    className="monaco-wrapper"
                    height="100%"
                    language="list-comparator"
                    value={inputA}
                    onChange={(val) => updateSessionInput(activeSession.id, "a", val || "")}
                    onMount={handleEditorMount("a")}
                    theme={currentThemeSetting === "light" ? "intab-light" : "intab-dark"}
                    options={monacoOptions}
                    loading={<EditorLoadingFallback message="Loading List editor..." />}
                  />
                  {!inputA.trim() && (
                    <div className="pointer-events-none absolute left-14 top-2 text-xs font-mono text-text-3 select-none">
                      Paste List A here... (comma, newline, or semicolon delimited)
                    </div>
                  )}
                </div>
              </div>
            </Panel>

            <PanelResizeHandle className="comparator-resize-handle-h" />

            {/* List B Panel */}
            <Panel defaultSize={50} minSize={20}>
              <div className="comparator-input-panel h-full flex flex-col min-w-0">
                <div className="section-header-row px-3 py-2 bg-bg-1 border-b border-border-1 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="section-label font-medium text-xs text-text-1">
                      List B
                    </span>
                    <span className="tab-badge bg-bg-2 text-text-2">
                      {listBCount} items
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <ActionTooltip content="Format separators & quotes to clean newlines">
                      <button
                        className="toolbar-icon-btn"
                        onClick={() => formatInput(inputB, "b")}
                        disabled={!inputB.trim()}
                      >
                        <AlignLeft className="h-3.5 w-3.5" />
                      </button>
                    </ActionTooltip>
                    <ActionTooltip content="Copy List B to clipboard">
                      <button
                        className="toolbar-icon-btn"
                        onClick={() =>
                          handleCopy(processRawList(inputB), "list-b", "Copied List B")
                        }
                        disabled={listBCount === 0}
                      >
                        {copiedId === "list-b" ? (
                          <Check className="h-3.5 w-3.5 text-green" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </ActionTooltip>
                  </div>
                </div>
                <div className="flex-1 w-full min-h-0 relative bg-bg-0">
                  <Editor
                    className="monaco-wrapper"
                    height="100%"
                    language="list-comparator"
                    value={inputB}
                    onChange={(val) => updateSessionInput(activeSession.id, "b", val || "")}
                    onMount={handleEditorMount("b")}
                    theme={currentThemeSetting === "light" ? "intab-light" : "intab-dark"}
                    options={monacoOptions}
                    loading={<EditorLoadingFallback message="Loading List editor..." />}
                  />
                  {!inputB.trim() && (
                    <div className="pointer-events-none absolute left-14 top-2 text-xs font-mono text-text-3 select-none">
                      Paste List B here... (comma, newline, or semicolon delimited)
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="comparator-resize-handle-v" />

        {/* Bottom: Premium Results Section */}
        <Panel defaultSize={58} minSize={20}>
          <div className="list-comparator-results h-full flex flex-col bg-bg-1">
            {/* Results Filter Toolbar */}
            <div className="results-tabs">
              <button
                className={cn(
                  "results-tab tab-aOnly",
                  activeTab === "aOnly" && "active"
                )}
                onClick={() => setActiveTab("aOnly")}
              >
                <span className="h-2 w-2 rounded-full bg-green inline-block flex-shrink-0" />
                <span>Only in A</span>
                <span className="tab-badge">
                  {comparisonResults.aOnly.length}
                </span>
              </button>

              <button
                className={cn(
                  "results-tab tab-bOnly",
                  activeTab === "bOnly" && "active"
                )}
                onClick={() => setActiveTab("bOnly")}
              >
                <span className="h-2 w-2 rounded-full bg-red inline-block flex-shrink-0" />
                <span>Only in B</span>
                <span className="tab-badge">
                  {comparisonResults.bOnly.length}
                </span>
              </button>

              <button
                className={cn(
                  "results-tab tab-both",
                  activeTab === "both" && "active"
                )}
                onClick={() => setActiveTab("both")}
              >
                <span className="h-2 w-2 rounded-full bg-blue inline-block flex-shrink-0" />
                <span>Common (Overlap)</span>
                <span className="tab-badge">
                  {comparisonResults.both.length}
                </span>
              </button>

              <button
                className={cn(
                  "results-tab tab-union",
                  activeTab === "union" && "active"
                )}
                onClick={() => setActiveTab("union")}
              >
                <span className="h-2 w-2 rounded-full bg-purple inline-block flex-shrink-0" />
                <span>Total Unique Union</span>
                <span className="tab-badge">
                  {comparisonResults.totalUnique}
                </span>
              </button>

              {/* Right Tools: Search, Copy, Download */}
              <div className="ml-auto flex items-center gap-2">
                <div className="results-search-wrap">
                  <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3 pointer-events-none" />
                  <input
                    type="text"
                    className="results-search"
                    placeholder="Search results..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-3 hover:text-text-1 p-0.5"
                      onClick={() => setQuery("")}
                      title="Clear search"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {query && (
                  <span className="text-[10px] font-mono text-text-3 bg-bg-2 px-1.5 py-0.5 rounded border border-border-1 whitespace-nowrap">
                    {filteredResults.length} / {activeTabTotal}
                  </span>
                )}

                <ActionTooltip content={`Copy all ${filteredResults.length} items in current view`}>
                  <button
                    className="toolbar-btn text-xs"
                    onClick={() =>
                      handleCopy(
                        filteredResults,
                        "copy-active-tab",
                        `Copied ${filteredResults.length} items`
                      )
                    }
                    disabled={filteredResults.length === 0}
                  >
                    {copiedId === "copy-active-tab" ? (
                      <Check className="h-3 w-3 text-green" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    <span>Copy All</span>
                  </button>
                </ActionTooltip>

                <ActionTooltip content="Download results as .txt">
                  <button
                    className="toolbar-icon-btn"
                    onClick={handleExport}
                    disabled={filteredResults.length === 0}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </ActionTooltip>
              </div>
            </div>

            {/* Results Table Header */}
            <div className="results-table-header">
              <div className="w-12 text-center text-text-3 font-mono text-[10px]">#</div>
              <div className="flex-1 px-2">Item Content</div>
              <div className="w-24 text-right pr-6 hidden sm:block text-text-3 font-mono text-[10px]">Length</div>
              <div className="w-20 text-right pr-2">Actions</div>
            </div>

            {/* List Result Items */}
            <div className="results-list-container">
              {!hasCompared && !inputA && !inputB ? (
                <div className="results-empty">
                  <div className="h-12 w-12 rounded-xl bg-bg-2 flex items-center justify-center border border-border-1 mb-3">
                    <Columns className="h-6 w-6 text-accent opacity-80" />
                  </div>
                  <p className="font-semibold text-sm text-text-1">Paste your lists to compare</p>
                  <p className="text-xs text-text-3 mt-1 max-w-sm text-center">
                    Set operations run automatically as you type to identify unique differences, missing items, and intersections.
                  </p>
                </div>
              ) : filteredResults.length === 0 ? (
                <div className="results-empty">
                  <div className="h-10 w-10 rounded-xl bg-bg-2 flex items-center justify-center border border-border-1 mb-2">
                    <Info className="h-5 w-5 text-text-3" />
                  </div>
                  <p className="font-medium text-sm text-text-2">No items found</p>
                  <p className="text-xs text-text-3 mt-0.5">
                    {query ? (
                      <span>
                        No matches for "{query}".{" "}
                        <button
                          className="text-accent hover:underline font-medium"
                          onClick={() => setQuery("")}
                        >
                          Clear search
                        </button>
                      </span>
                    ) : (
                      "No elements exist in this category."
                    )}
                  </p>
                </div>
              ) : (
                <div className="results-scroll">
                  {filteredResults.map((item: string, idx: number) => (
                    <div key={`${activeTab}-${idx}`} className="result-row group">
                      {/* Index Gutter */}
                      <div className="result-row-idx text-center font-mono text-text-3 text-[11px] select-none">
                        {idx + 1}
                      </div>

                      {/* Content with Search Highlighting */}
                      <div className="result-row-content px-2 font-mono text-xs select-text">
                        {renderHighlightedText(item, query)}
                      </div>

                      {/* Item Length badge */}
                      <div className="w-24 text-right pr-6 hidden sm:block font-mono text-[10.5px] text-text-3 opacity-60 group-hover:opacity-100">
                        {item.length} chars
                      </div>

                      {/* Row Hover Actions */}
                      <div className="result-row-actions w-20 justify-end pr-2">
                        <ActionTooltip content="Copy item">
                          <button
                            className="toolbar-icon-btn h-6 w-6"
                            onClick={() =>
                              handleCopy([item], `item-${idx}`, `Copied: ${item}`)
                            }
                          >
                            {copiedId === `item-${idx}` ? (
                              <Check className="h-3 w-3 text-green" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </ActionTooltip>

                        <ActionTooltip content='Copy with quotes ("item")'>
                          <button
                            className="toolbar-icon-btn h-6 w-6"
                            onClick={() =>
                              handleCopyQuoted(item, `quote-${idx}`)
                            }
                          >
                            {copiedId === `quote-${idx}` ? (
                              <Check className="h-3 w-3 text-green" />
                            ) : (
                              <Quote className="h-3 w-3" />
                            )}
                          </button>
                        </ActionTooltip>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Results Footer Bar */}
            <div className="results-footer-bar">
              <div className="flex items-center gap-2">
                <span>
                  Showing {filteredResults.length} of {activeTabTotal} items
                </span>
                <span className="opacity-40">•</span>
                <span className="capitalize">
                  Category:{" "}
                  {activeTab === "aOnly"
                    ? "Unique to A"
                    : activeTab === "bOnly"
                    ? "Unique to B"
                    : activeTab === "both"
                    ? "Common Elements"
                    : "Total Union"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-text-3">
                  Delimiters: newlines, commas, semicolons, pipes
                </span>
              </div>
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
