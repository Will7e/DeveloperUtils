import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  Search,
  Download,
  Copy,
  Check,
  AlertCircle,
  Layers,
  ChevronRight,
  X,
  Info,
} from "lucide-react";
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import Editor, { type OnMount } from "@monaco-editor/react";
import { setupMonacoTheme } from "@/utils/monaco-theme";
import { registerMonacoFormatShortcut } from "@/utils/monaco-format";
import { EditorLoadingFallback } from "@/components/ui/editor-loader";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import {
  parseJsonLenient,
  deepCompareJson,
  type JsonDiffItem,
  type JsonDiffType,
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

type FilterCategory = "all" | JsonDiffType;

export function JsonComparator() {
  const sessions = useAppStore((s) => s.comparatorSessions);
  const activeSessionId = useAppStore((s) => s.activeComparatorSessionId);
  const updateSessionInput = useAppStore((s) => s.updateComparatorSessionInput);
  const addToast = useAppStore((s) => s.addToast);
  const currentThemeSetting = useAppStore((s) => s.editorSettings.theme);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0]!;
  const inputA = activeSession.a;
  const inputB = activeSession.b;

  const [filterType, setFilterType] = useState<FilterCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const editorARef = useRef<Parameters<OnMount>[0] | null>(null);
  const editorBRef = useRef<Parameters<OnMount>[0] | null>(null);
  const activeSessionIdRef = useRef(activeSession.id);

  useEffect(() => {
    activeSessionIdRef.current = activeSession.id;
  }, [activeSession.id]);

  // Handle Monaco theme dynamic switching
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(
        currentThemeSetting === "light" ? "intab-light" : "intab-dark"
      );
    }
  }, [currentThemeSetting]);

  // Editor Mount Handler
  const handleEditorMount = useCallback(
    (side: "a" | "b") => (editor: Parameters<OnMount>[0], monaco: Parameters<OnMount>[1]) => {
      if (side === "a") editorARef.current = editor;
      else editorBRef.current = editor;

      monacoRef.current = monaco;
      setupMonacoTheme(monaco);

      const initTheme = useAppStore.getState().editorSettings.theme;
      monaco.editor.setTheme(initTheme === "light" ? "intab-light" : "intab-dark");

      // Register Cmd+S / Ctrl+S and Shift+Alt+F format shortcut
      registerMonacoFormatShortcut(editor, monaco, {
        onFormat: () => {
          const val = editor.getValue();
          if (!val.trim()) return;
          const parsed = parseJsonLenient(val);
          if (parsed.success && parsed.data !== undefined) {
            const formatted = JSON.stringify(parsed.data, null, 2);
            editor.setValue(formatted);
            updateSessionInput(activeSessionIdRef.current, side, formatted);
            addToast({ message: `Prettified JSON (${side.toUpperCase()})`, type: "success", duration: 1500 });
          }
        },
      });

      // Auto-format on paste if lenient or unformatted JSON is pasted
      editor.onDidPaste(() => {
        const val = editor.getValue();
        if (!val.trim()) return;
        const parsed = parseJsonLenient(val);
        if (parsed.success && parsed.data !== undefined) {
          const formatted = JSON.stringify(parsed.data, null, 2);
          if (formatted !== val.trim()) {
            editor.setValue(formatted);
            updateSessionInput(activeSessionIdRef.current, side, formatted);
          }
        }
      });
    },
    [updateSessionInput, addToast]
  );

  // Parse JSON payloads with lenient fallback
  const parsedA = useMemo(() => parseJsonLenient(inputA), [inputA]);
  const parsedB = useMemo(() => parseJsonLenient(inputB), [inputB]);

  // Compute Semantic Diff
  const diffResult = useMemo(() => {
    if (!parsedA.success || !parsedB.success) {
      return { items: [], stats: { added: 0, removed: 0, modified: 0, typeChanged: 0, unchanged: 0, total: 0 } };
    }
    if (parsedA.data === undefined && parsedB.data === undefined) {
      return { items: [], stats: { added: 0, removed: 0, modified: 0, typeChanged: 0, unchanged: 0, total: 0 } };
    }
    return deepCompareJson(parsedA.data, parsedB.data, false);
  }, [parsedA, parsedB]);

  // Filtered diff items
  const filteredItems = useMemo(() => {
    let list = diffResult.items;

    if (filterType !== "all") {
      list = list.filter((item) => item.type === filterType);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((item) => {
        const pathMatch = item.path.toLowerCase().includes(q);
        const leftMatch = JSON.stringify(item.leftValue)?.toLowerCase().includes(q);
        const rightMatch = JSON.stringify(item.rightValue)?.toLowerCase().includes(q);
        return pathMatch || leftMatch || rightMatch;
      });
    }

    return list;
  }, [diffResult.items, filterType, searchQuery]);

  // Copy helper
  const handleCopyText = (text: string, id: string, message = "Copied to clipboard") => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    addToast({ message, type: "success" });
  };

  // Export Delta Report as JSON
  const handleExportDelta = () => {
    if (filteredItems.length === 0) return;
    const report = {
      timestamp: new Date().toISOString(),
      summary: diffResult.stats,
      diffs: filteredItems.map((item) => ({
        path: item.path,
        status: item.type,
        left: item.leftValue,
        right: item.rightValue,
      })),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `json_semantic_diff_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    addToast({ message: "Exported diff report as JSON", type: "info" });
  };

  // Search match highlighter
  const renderHighlightedText = (text: string, query: string) => {
    if (!query.trim()) return text;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${escaped})`, "gi"));
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase() ? (
        <mark key={i} className="bg-accent/25 text-accent font-semibold px-0.5 rounded">
          {part}
        </mark>
      ) : (
        part
      )
    );
  };

  const renderValueBadge = (val: unknown, typeName?: string) => {
    if (val === undefined) return <span className="opacity-40 italic">undefined</span>;
    if (val === null) return <span className="text-amber font-mono">null</span>;
    if (typeof val === "boolean") {
      return <span className="text-blue font-mono">{val ? "true" : "false"}</span>;
    }
    if (typeof val === "number") {
      return <span className="text-purple font-mono">{val}</span>;
    }
    if (typeof val === "string") {
      return (
        <span className="text-green font-mono font-medium truncate max-w-[320px]">
          "{renderHighlightedText(val, searchQuery)}"
        </span>
      );
    }
    const str = JSON.stringify(val);
    return (
      <span className="text-text-2 font-mono text-[11px] truncate max-w-[320px]">
        {renderHighlightedText(str, searchQuery)} {typeName && <span className="opacity-50">({typeName})</span>}
      </span>
    );
  };

  const monacoEditorOptions = useMemo(
    () => ({
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on" as const,
      padding: { top: 8, bottom: 8 },
      formatOnPaste: true,
      formatOnType: true,
      folding: true,
      renderValidationDecorations: "on" as const,
      bracketPairColorization: { enabled: true },
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

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <PanelGroup orientation="vertical">
        {/* Top: Dual JSON Inputs */}
        <Panel defaultSize={42} minSize={20}>
          <PanelGroup orientation="horizontal">
            {/* JSON A Panel */}
            <Panel defaultSize={50} minSize={25}>
              <div className="comparator-input-panel h-full border-r border-border-1 flex flex-col min-w-0">
                <div className="section-header-row px-3 py-2 bg-bg-1 border-b border-border-1 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="section-label font-medium text-xs text-text-1">
                      JSON A (Original)
                    </span>
                    {!parsedA.success && inputA.trim() && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-red bg-red-dim px-2 py-0.5 rounded">
                        <AlertCircle className="h-3 w-3" /> Syntax Error
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <ActionTooltip content="Copy JSON A">
                      <button
                        className="toolbar-icon-btn"
                        onClick={() => handleCopyText(inputA, "copy-json-a", "Copied JSON A")}
                        disabled={!inputA.trim()}
                      >
                        {copiedId === "copy-json-a" ? (
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
                    language="json"
                    value={inputA}
                    onChange={(val) => updateSessionInput(activeSession.id, "a", val || "")}
                    onMount={handleEditorMount("a")}
                    theme={currentThemeSetting === "light" ? "intab-light" : "intab-dark"}
                    options={monacoEditorOptions}
                    loading={<EditorLoadingFallback message="Loading JSON editor..." />}
                  />
                  {!inputA.trim() && (
                    <div className="pointer-events-none absolute left-14 top-2 text-xs font-mono text-text-3 select-none">
                      Paste original JSON here... e.g. {`{ "status": "active" }`}
                    </div>
                  )}
                </div>
                {!parsedA.success && inputA.trim() && (
                  <div className="px-3 py-1.5 bg-red-dim text-red text-[11px] border-t border-red/20 font-mono truncate">
                    {parsedA.error}
                  </div>
                )}
              </div>
            </Panel>

            <PanelResizeHandle className="comparator-resize-handle-h" />

            {/* JSON B Panel */}
            <Panel defaultSize={50} minSize={25}>
              <div className="comparator-input-panel h-full flex flex-col min-w-0">
                <div className="section-header-row px-3 py-2 bg-bg-1 border-b border-border-1 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="section-label font-medium text-xs text-text-1">
                      JSON B (Target / Compare)
                    </span>
                    {!parsedB.success && inputB.trim() && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-red bg-red-dim px-2 py-0.5 rounded">
                        <AlertCircle className="h-3 w-3" /> Syntax Error
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <ActionTooltip content="Copy JSON B">
                      <button
                        className="toolbar-icon-btn"
                        onClick={() => handleCopyText(inputB, "copy-json-b", "Copied JSON B")}
                        disabled={!inputB.trim()}
                      >
                        {copiedId === "copy-json-b" ? (
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
                    language="json"
                    value={inputB}
                    onChange={(val) => updateSessionInput(activeSession.id, "b", val || "")}
                    onMount={handleEditorMount("b")}
                    theme={currentThemeSetting === "light" ? "intab-light" : "intab-dark"}
                    options={monacoEditorOptions}
                    loading={<EditorLoadingFallback message="Loading JSON editor..." />}
                  />
                  {!inputB.trim() && (
                    <div className="pointer-events-none absolute left-14 top-2 text-xs font-mono text-text-3 select-none">
                      Paste modified JSON here... e.g. {`{ "status": "pending" }`}
                    </div>
                  )}
                </div>
                {!parsedB.success && inputB.trim() && (
                  <div className="px-3 py-1.5 bg-red-dim text-red text-[11px] border-t border-red/20 font-mono truncate">
                    {parsedB.error}
                  </div>
                )}
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="comparator-resize-handle-v" />

        {/* Bottom: Semantic Results View */}
        <Panel defaultSize={58} minSize={20}>
          <div className="list-comparator-results h-full flex flex-col bg-bg-1">
            {/* Filter Bar with Venn Summary Pills */}
            <div className="results-tabs">
              <button
                className={cn("results-tab", filterType === "all" && "active")}
                onClick={() => setFilterType("all")}
              >
                <span>All Changes</span>
                <span className="tab-badge">{diffResult.stats.total}</span>
              </button>

              <button
                className={cn("results-tab tab-aOnly", filterType === "added" && "active")}
                onClick={() => setFilterType("added")}
              >
                <span className="h-2 w-2 rounded-full bg-green inline-block flex-shrink-0" />
                <span>Added</span>
                <span className="tab-badge">+{diffResult.stats.added}</span>
              </button>

              <button
                className={cn("results-tab tab-bOnly", filterType === "removed" && "active")}
                onClick={() => setFilterType("removed")}
              >
                <span className="h-2 w-2 rounded-full bg-red inline-block flex-shrink-0" />
                <span>Removed</span>
                <span className="tab-badge">-{diffResult.stats.removed}</span>
              </button>

              <button
                className={cn("results-tab tab-both", filterType === "modified" && "active")}
                onClick={() => setFilterType("modified")}
              >
                <span className="h-2 w-2 rounded-full bg-amber inline-block flex-shrink-0" />
                <span>Modified</span>
                <span className="tab-badge">~{diffResult.stats.modified}</span>
              </button>

              <button
                className={cn("results-tab tab-union", filterType === "type_changed" && "active")}
                onClick={() => setFilterType("type_changed")}
              >
                <span className="h-2 w-2 rounded-full bg-purple inline-block flex-shrink-0" />
                <span>Type Mutation</span>
                <span className="tab-badge">!{diffResult.stats.typeChanged}</span>
              </button>

              {/* Right Side: Search and Export */}
              <div className="ml-auto flex items-center gap-2">
                <div className="results-search-wrap">
                  <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3 pointer-events-none" />
                  <input
                    type="text"
                    className="results-search"
                    placeholder="Search path or value..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-3 hover:text-text-1 p-0.5"
                      onClick={() => setSearchQuery("")}
                      title="Clear search"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {searchQuery && (
                  <span className="text-[10px] font-mono text-text-3 bg-bg-2 px-1.5 py-0.5 rounded border border-border-1 whitespace-nowrap">
                    {filteredItems.length} / {diffResult.stats.total}
                  </span>
                )}

                <ActionTooltip content="Export delta report as JSON">
                  <button
                    className="toolbar-icon-btn"
                    onClick={handleExportDelta}
                    disabled={filteredItems.length === 0}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </ActionTooltip>
              </div>
            </div>

            {/* Results Table Header */}
            <div className="results-table-header">
              <div className="w-24 px-2 text-text-3 font-mono text-[10px]">Status</div>
              <div className="w-64 px-2 text-text-3 font-mono text-[10px]">JSON Path</div>
              <div className="flex-1 px-2 text-text-3 font-mono text-[10px]">Comparison (A ➔ B)</div>
              <div className="w-16 text-right pr-2">Actions</div>
            </div>

            {/* Results Table List */}
            <div className="results-list-container">
              {!inputA.trim() && !inputB.trim() ? (
                <div className="results-empty">
                  <div className="h-12 w-12 rounded-xl bg-bg-2 flex items-center justify-center border border-border-1 mb-3">
                    <Layers className="h-6 w-6 text-accent opacity-80" />
                  </div>
                  <p className="font-semibold text-sm text-text-1">Paste JSON in both panels to compare</p>
                  <p className="text-xs text-text-3 mt-1 max-w-sm text-center">
                    Semantic diff recursively inspects objects and arrays to highlight additions, deletions, modifications, and type changes regardless of key ordering.
                  </p>
                </div>
              ) : !parsedA.success || !parsedB.success ? (
                <div className="results-empty">
                  <div className="h-10 w-10 rounded-xl bg-red-dim flex items-center justify-center border border-red/30 mb-2">
                    <AlertCircle className="h-5 w-5 text-red" />
                  </div>
                  <p className="font-semibold text-sm text-red">Invalid JSON Syntax Detected</p>
                  <p className="text-xs text-text-3 mt-1 max-w-sm text-center">
                    Please correct the syntax error indicated in the panels above to compute semantic differences.
                  </p>
                </div>
              ) : diffResult.stats.total === 0 ? (
                <div className="results-empty">
                  <div className="h-10 w-10 rounded-xl bg-green-dim flex items-center justify-center border border-green/30 mb-2">
                    <Check className="h-5 w-5 text-green" />
                  </div>
                  <p className="font-semibold text-sm text-green">Identical Semantic Content</p>
                  <p className="text-xs text-text-3 mt-1 text-center">
                    Both JSON objects are completely identical in keys, structures, and values.
                  </p>
                </div>
              ) : filteredItems.length === 0 ? (
                <div className="results-empty">
                  <div className="h-10 w-10 rounded-xl bg-bg-2 flex items-center justify-center border border-border-1 mb-2">
                    <Info className="h-5 w-5 text-text-3" />
                  </div>
                  <p className="font-medium text-sm text-text-2">No differences found</p>
                  <p className="text-xs text-text-3 mt-0.5">
                    {searchQuery ? (
                      <span>
                        No matches for "{searchQuery}".{" "}
                        <button
                          className="text-accent hover:underline font-medium"
                          onClick={() => setSearchQuery("")}
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
                  {filteredItems.map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        "result-row group",
                        item.type === "added" && "hover:bg-green-dim/20",
                        item.type === "removed" && "hover:bg-red-dim/20",
                        item.type === "modified" && "hover:bg-amber-dim/20",
                        item.type === "type_changed" && "hover:bg-purple-dim/20"
                      )}
                    >
                      {/* Status Tag */}
                      <div className="w-24 px-2 flex-shrink-0">
                        {item.type === "added" && (
                          <span className="comparator-tag-badge bg-green-dim text-green">
                            + ADDED
                          </span>
                        )}
                        {item.type === "removed" && (
                          <span className="comparator-tag-badge bg-red-dim text-red">
                            - REMOVED
                          </span>
                        )}
                        {item.type === "modified" && (
                          <span className="comparator-tag-badge bg-amber-dim text-amber">
                            ~ MODIFIED
                          </span>
                        )}
                        {item.type === "type_changed" && (
                          <span className="comparator-tag-badge bg-purple-dim text-purple">
                            ! MUTATION
                          </span>
                        )}
                      </div>

                      {/* JSON Path */}
                      <div className="w-64 px-2 flex items-center gap-1.5 flex-shrink-0">
                        <code className="comparator-path-code truncate max-w-[230px]">
                          {renderHighlightedText(item.path, searchQuery)}
                        </code>
                      </div>

                      {/* Values Before & After */}
                      <div className="flex-1 px-3 flex items-center gap-3 overflow-x-auto">
                        {item.type !== "added" && (
                          <div className="comparator-value-badge">
                            <span className="comparator-value-prefix">A:</span>
                            <span className="comparator-value-text">
                              {renderValueBadge(item.leftValue, item.leftType)}
                            </span>
                          </div>
                        )}

                        {item.type !== "added" && item.type !== "removed" && (
                          <ChevronRight className="h-3.5 w-3.5 text-text-3 flex-shrink-0" />
                        )}

                        {item.type !== "removed" && (
                          <div className="comparator-value-badge">
                            <span className="comparator-value-prefix">B:</span>
                            <span className="comparator-value-text">
                              {renderValueBadge(item.rightValue, item.rightType)}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="result-row-actions w-16 justify-end pr-2">
                        <ActionTooltip content="Copy JSON Path">
                          <button
                            className="toolbar-icon-btn h-6 w-6"
                            onClick={() =>
                              handleCopyText(item.path, `path-${item.id}`, `Copied path: ${item.path}`)
                            }
                          >
                            {copiedId === `path-${item.id}` ? (
                              <Check className="h-3 w-3 text-green" />
                            ) : (
                              <Copy className="h-3 w-3" />
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
                  Showing {filteredItems.length} of {diffResult.stats.total} changes
                </span>
                <span className="opacity-40">•</span>
                <span>
                  Added: {diffResult.stats.added} | Removed: {diffResult.stats.removed} | Modified: {diffResult.stats.modified} | Type Changes: {diffResult.stats.typeChanged}
                </span>
              </div>
              <div>
                <span>Engine: Semantic AST Deep Object Diff</span>
              </div>
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
