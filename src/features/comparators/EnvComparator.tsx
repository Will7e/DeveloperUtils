import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import {
  Search,
  Download,
  Copy,
  Check,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Layers,
  ChevronRight,
  X,
} from "lucide-react";
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import Editor, { type OnMount } from "@monaco-editor/react";
import { setupMonacoTheme } from "@/utils/monaco-theme";
import { EditorLoadingFallback } from "@/components/ui/editor-loader";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import {
  compareEnvs,
  maskValue,
  type EnvDiffType,
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

type EnvFilterCategory = "all" | EnvDiffType;

export function EnvComparator() {
  const sessions = useAppStore((s) => s.comparatorSessions);
  const activeSessionId = useAppStore((s) => s.activeComparatorSessionId);
  const updateSessionInput = useAppStore((s) => s.updateComparatorSessionInput);
  const addToast = useAppStore((s) => s.addToast);
  const currentThemeSetting = useAppStore((s) => s.editorSettings.theme);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0]!;
  const inputA = activeSession.a;
  const inputB = activeSession.b;

  const [filterType, setFilterType] = useState<EnvFilterCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [maskSecrets, setMaskSecrets] = useState(false);
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
    (_editor: Parameters<OnMount>[0], monaco: Parameters<OnMount>[1]) => {
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

  // Compute Env Diff
  const diffResult = useMemo(() => {
    return compareEnvs(inputA, inputB);
  }, [inputA, inputB]);

  // Filtered items
  const filteredItems = useMemo(() => {
    let list = diffResult.items;

    if (filterType !== "all") {
      list = list.filter((item) => item.status === filterType);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((item) => {
        const keyMatch = item.key.toLowerCase().includes(q);
        const aMatch = item.valueA?.toLowerCase().includes(q);
        const bMatch = item.valueB?.toLowerCase().includes(q);
        return keyMatch || aMatch || bMatch;
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

  // Copy missing keys in B as .env template (e.g. KEY=)
  const handleCopyMissingKeys = () => {
    const missingInB = diffResult.items
      .filter((item) => item.status === "missing_in_b")
      .map((item) => `${item.key}=`);

    if (missingInB.length === 0) {
      addToast({ message: "No missing keys in Target B", type: "info" });
      return;
    }

    handleCopyText(
      missingInB.join("\n"),
      "copy-missing-env",
      `Copied ${missingInB.length} missing keys as .env template`
    );
  };

  // Export Env Diff report
  const handleExportReport = () => {
    if (diffResult.items.length === 0) return;

    let text = `# DeveloperUtils .env Comparison Report\n`;
    text += `# Generated on ${new Date().toLocaleString()}\n`;
    text += `# Missing in B: ${diffResult.stats.missingInB} | Extra in B: ${diffResult.stats.missingInA} | Mismatched: ${diffResult.stats.mismatch} | Matched: ${diffResult.stats.matched}\n\n`;

    filteredItems.forEach((item) => {
      text += `[${item.status.toUpperCase()}] ${item.key}\n`;
      text += `  A: ${item.valueA ?? "(not set)"}\n`;
      text += `  B: ${item.valueB ?? "(not set)"}\n\n`;
    });

    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `env_comparison_${Date.now()}.env`;
    a.click();
    URL.revokeObjectURL(url);
    addToast({ message: "Exported comparison report", type: "info" });
  };

  // Search match highlighter
  const renderHighlightedText = (text?: string, query?: string) => {
    if (!text) return "";
    if (!query || !query.trim()) return text;
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

  const displayValue = (val?: string) => {
    if (val === undefined) return <span className="opacity-40 italic">not set</span>;
    if (maskSecrets) return <span className="font-mono text-text-3">{maskValue(val)}</span>;
    return (
      <span className="font-mono text-text-1 truncate max-w-[280px]">
        {renderHighlightedText(val, searchQuery)}
      </span>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <PanelGroup orientation="vertical">
        {/* Top: Dual .env Inputs */}
        <Panel defaultSize={42} minSize={20}>
          <PanelGroup orientation="horizontal">
            {/* Input A Panel */}
            <Panel defaultSize={50} minSize={25}>
              <div className="comparator-input-panel h-full border-r border-border-1 flex flex-col min-w-0">
                <div className="section-header-row px-3 py-2 border-b border-border-1 flex items-center justify-between">
                  <span className="section-label font-medium text-xs text-text-1">
                    Environment A (Reference / Staging)
                  </span>
                  <ActionTooltip content="Copy Env A">
                    <button
                      className="toolbar-icon-btn"
                      onClick={() => handleCopyText(inputA, "copy-env-a", "Copied Env A")}
                      disabled={!inputA.trim()}
                    >
                      {copiedId === "copy-env-a" ? (
                        <Check className="h-3.5 w-3.5 text-green" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </ActionTooltip>
                </div>
                <div className="flex-1 w-full min-h-0 relative bg-bg-1">
                  <Editor
                    className="monaco-wrapper"
                    height="100%"
                    language="dotenv"
                    value={inputA}
                    onChange={(val) => updateSessionInput(activeSession.id, "a", val || "")}
                    onMount={handleEditorMount}
                    theme={currentThemeSetting === "light" ? "intab-light" : "intab-dark"}
                    options={monacoOptions}
                    loading={<EditorLoadingFallback message="Loading .env editor..." />}
                  />
                  {!inputA.trim() && (
                    <div className="pointer-events-none absolute left-14 top-2 text-xs font-mono text-text-3 select-none">
                      Paste reference .env here... e.g. PORT=3000
                    </div>
                  )}
                </div>
              </div>
            </Panel>

            <PanelResizeHandle className="comparator-resize-handle-h" />

            {/* Input B Panel */}
            <Panel defaultSize={50} minSize={25}>
              <div className="comparator-input-panel h-full flex flex-col min-w-0">
                <div className="section-header-row px-3 py-2 border-b border-border-1 flex items-center justify-between">
                  <span className="section-label font-medium text-xs text-text-1">
                    Environment B (Target / Production)
                  </span>
                  <ActionTooltip content="Copy Env B">
                    <button
                      className="toolbar-icon-btn"
                      onClick={() => handleCopyText(inputB, "copy-env-b", "Copied Env B")}
                      disabled={!inputB.trim()}
                    >
                      {copiedId === "copy-env-b" ? (
                        <Check className="h-3.5 w-3.5 text-green" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </ActionTooltip>
                </div>
                <div className="flex-1 w-full min-h-0 relative bg-bg-1">
                  <Editor
                    className="monaco-wrapper"
                    height="100%"
                    language="dotenv"
                    value={inputB}
                    onChange={(val) => updateSessionInput(activeSession.id, "b", val || "")}
                    onMount={handleEditorMount}
                    theme={currentThemeSetting === "light" ? "intab-light" : "intab-dark"}
                    options={monacoOptions}
                    loading={<EditorLoadingFallback message="Loading .env editor..." />}
                  />
                  {!inputB.trim() && (
                    <div className="pointer-events-none absolute left-14 top-2 text-xs font-mono text-text-3 select-none">
                      Paste target .env here... e.g. PORT=8080
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="comparator-resize-handle-v" />

        {/* Bottom: Env Differences Results */}
        <Panel defaultSize={58} minSize={20}>
          <div className="list-comparator-results h-full flex flex-col bg-bg-1">
            {/* Filter Bar with Venn Summary Pills */}
            <div className="results-tabs">
              <button
                className={cn("results-tab", filterType === "all" && "active")}
                onClick={() => setFilterType("all")}
              >
                <span>All Keys</span>
                <span className="tab-badge">{diffResult.stats.total}</span>
              </button>

              <button
                className={cn("results-tab tab-bOnly", filterType === "missing_in_b" && "active")}
                onClick={() => setFilterType("missing_in_b")}
              >
                <span className="h-2 w-2 rounded-full bg-red inline-block flex-shrink-0" />
                <span>Missing in B</span>
                <span className="tab-badge">{diffResult.stats.missingInB}</span>
              </button>

              <button
                className={cn("results-tab tab-union", filterType === "missing_in_a" && "active")}
                onClick={() => setFilterType("missing_in_a")}
              >
                <span className="h-2 w-2 rounded-full bg-purple inline-block flex-shrink-0" />
                <span>Extra in B</span>
                <span className="tab-badge">{diffResult.stats.missingInA}</span>
              </button>

              <button
                className={cn("results-tab tab-mismatch", filterType === "mismatch" && "active")}
                onClick={() => setFilterType("mismatch")}
              >
                <span className="h-2 w-2 rounded-full bg-yellow inline-block flex-shrink-0" />
                <span>Value Mismatch</span>
                <span className="tab-badge">{diffResult.stats.mismatch}</span>
              </button>

              <button
                className={cn("results-tab tab-aOnly", filterType === "matched" && "active")}
                onClick={() => setFilterType("matched")}
              >
                <span className="h-2 w-2 rounded-full bg-green inline-block flex-shrink-0" />
                <span>Matched</span>
                <span className="tab-badge">{diffResult.stats.matched}</span>
              </button>

              {/* Right Side: Mask Toggle, Copy Missing, Search, Export */}
              <div className="ml-auto flex items-center gap-2">
                <ActionTooltip content={maskSecrets ? "Reveal raw secret values" : "Mask sensitive values with dots"}>
                  <button
                    className={cn(
                      "toolbar-btn text-xs",
                      maskSecrets && "text-accent bg-accent/10 border-accent/30"
                    )}
                    onClick={() => setMaskSecrets(!maskSecrets)}
                  >
                    {maskSecrets ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    <span>{maskSecrets ? "Masked" : "Mask Secrets"}</span>
                  </button>
                </ActionTooltip>

                <ActionTooltip content="Copy keys missing in B as an empty .env template">
                  <button
                    className="toolbar-btn text-xs"
                    onClick={handleCopyMissingKeys}
                    disabled={diffResult.stats.missingInB === 0}
                  >
                    <KeyRound className="h-3 w-3 text-accent" />
                    <span>Copy Missing Keys</span>
                  </button>
                </ActionTooltip>

                <div className="results-search-wrap">
                  <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3 pointer-events-none" />
                  <input
                    type="text"
                    className="results-search"
                    placeholder="Search key or value..."
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

                <ActionTooltip content="Download .env comparison report">
                  <button
                    className="toolbar-icon-btn"
                    onClick={handleExportReport}
                    disabled={filteredItems.length === 0}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </ActionTooltip>
              </div>
            </div>

            {/* Results Table Header */}
            <div className="results-table-header">
              <div className="w-28 px-2 text-text-3 font-mono text-[10px]">Status</div>
              <div className="w-64 px-2 text-text-3 font-mono text-[10px]">Variable Key</div>
              <div className="flex-1 px-2 text-text-3 font-mono text-[10px]">Environment Comparison (A ➔ B)</div>
              <div className="w-16 text-right pr-2">Actions</div>
            </div>

            {/* Results List */}
            <div className="results-list-container">
              {!inputA.trim() && !inputB.trim() ? (
                <div className="results-empty">
                  <div className="h-12 w-12 rounded-xl bg-bg-2 flex items-center justify-center border border-border-1 mb-3">
                    <Layers className="h-6 w-6 text-accent opacity-80" />
                  </div>
                  <p className="font-semibold text-sm text-text-1">Paste .env or config files in both panels</p>
                  <p className="text-xs text-text-3 mt-1 max-w-sm text-center">
                    Spot missing configuration variables and mismatched values across environments instantly.
                  </p>
                </div>
              ) : filteredItems.length === 0 ? (
                <div className="results-empty">
                  <div className="h-10 w-10 rounded-xl bg-bg-2 flex items-center justify-center border border-border-1 mb-2">
                    <Info className="h-5 w-5 text-text-3" />
                  </div>
                  <p className="font-medium text-sm text-text-2">No items found</p>
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
                      key={item.key}
                      className={cn(
                        "result-row group",
                        item.status === "missing_in_b" && "row-removed",
                        item.status === "missing_in_a" && "row-type-changed",
                        item.status === "mismatch" && "row-modified",
                        item.status === "matched" && "row-added"
                      )}
                    >
                      {/* Status Tag */}
                      <div className="w-28 px-2 flex-shrink-0">
                        {item.status === "missing_in_b" && (
                          <span className="comparator-tag-badge tag-missing">
                            MISSING IN B
                          </span>
                        )}
                        {item.status === "missing_in_a" && (
                          <span className="comparator-tag-badge tag-extra">
                            EXTRA IN B
                          </span>
                        )}
                        {item.status === "mismatch" && (
                          <span className="comparator-tag-badge tag-mismatch">
                            DIFFERENT
                          </span>
                        )}
                        {item.status === "matched" && (
                          <span className="comparator-tag-badge tag-matched">
                            MATCHED
                          </span>
                        )}
                      </div>

                      {/* Key Name */}
                      <div className="w-64 px-2 flex items-center gap-1.5 flex-shrink-0">
                        <code className="comparator-path-code text-text-1 truncate max-w-[230px]">
                          {renderHighlightedText(item.key, searchQuery)}
                        </code>
                      </div>

                      {/* Values Comparison */}
                      <div className="flex-1 px-3 flex items-center gap-3 overflow-x-auto">
                        <div className="comparator-value-badge">
                          <span className="comparator-value-prefix">A:</span>
                          <span className="comparator-value-text">{displayValue(item.valueA)}</span>
                        </div>

                        <ChevronRight className="h-3.5 w-3.5 text-text-3 flex-shrink-0" />

                        <div className="comparator-value-badge">
                          <span className="comparator-value-prefix">B:</span>
                          <span className="comparator-value-text">{displayValue(item.valueB)}</span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="result-row-actions w-16 justify-end pr-2">
                        <ActionTooltip content="Copy Key Name">
                          <button
                            className="toolbar-icon-btn h-6 w-6"
                            onClick={() =>
                              handleCopyText(item.key, `key-${item.key}`, `Copied key: ${item.key}`)
                            }
                          >
                            {copiedId === `key-${item.key}` ? (
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
                  Showing {filteredItems.length} of {diffResult.stats.total} configuration keys
                </span>
                <span className="opacity-40">•</span>
                <span>
                  Missing in B: {diffResult.stats.missingInB} | Extra in B: {diffResult.stats.missingInA} | Mismatched: {diffResult.stats.mismatch} | Matched: {diffResult.stats.matched}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-text-3">
                  Format: KEY=VALUE • Comments ignored
                </span>
              </div>
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
