import React, { useState, useMemo, useCallback } from "react";
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
  AlignLeft
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
  const [inputA, setInputA] = useState("");
  const [inputB, setInputB] = useState("");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [trimWhitespace, setTrimWhitespace] = useState(true);
  const [sortAlpha, setSortAlpha] = useState(true);
  const [activeTab, setActiveTab] = useState<ComparisonType>("aOnly");
  const [copied, setCopied] = useState<string | null>(null);
  const [lastResults, setLastResults] = useState<ComparisonResults>({ aOnly: [], bOnly: [], both: [] });
  const [hasCompared, setHasCompared] = useState(false);
  
  const addToast = useAppStore((s) => s.addToast);

  // Helper to process list
  const processList = useCallback((input: string) => {
    if (!input) return [];
    let lines = input.split(/[\n\r,;|]+/).map(l => trimWhitespace ? l.trim() : l);
    lines = lines.filter(l => l.length > 0);
    return Array.from(new Set(lines));
  }, [trimWhitespace]);

  // Format input into newlines
  const formatInput = useCallback((input: string, setter: (val: string) => void) => {
    const processed = processList(input);
    if (processed.length === 0) return;
    setter(processed.join("\n"));
    addToast({ message: "List formatted", type: "success", duration: 1000 });
  }, [processList, addToast]);

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
    addToast({ message: "Comparison complete", type: "success", duration: 1500 });
  }, [inputA, inputB, caseSensitive, trimWhitespace, sortAlpha, processList, addToast]);

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

  return (
    <div className="list-comparator-container">
      {/* Header / Toolbar */}
      <div className="json-formatter-toolbar">
        <div className="toolbar-left">
          <Columns className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">List Comparator</h2>
          <div className="toolbar-sep mx-2" />
          
          <div className="comparator-options">
            <ActionTooltip content="Differentiates between upper and lowercase">
              <label className="comparator-option-label">
                <input 
                  type="checkbox" 
                  checked={caseSensitive} 
                  onChange={(e) => setCaseSensitive(e.target.checked)}
                />
                <span>Case Sensitive</span>
              </label>
            </ActionTooltip>
            <ActionTooltip content="Removes leading and trailing spaces">
              <label className="comparator-option-label">
                <input 
                  type="checkbox" 
                  checked={trimWhitespace} 
                  onChange={(e) => setTrimWhitespace(e.target.checked)}
                />
                <span>Trim</span>
              </label>
            </ActionTooltip>
            <ActionTooltip content="Sorts results numerically and alphabetically">
              <label className="comparator-option-label">
                <input 
                  type="checkbox" 
                  checked={sortAlpha} 
                  onChange={(e) => setSortAlpha(e.target.checked)}
                />
                <span>Sort (Natural)</span>
              </label>
            </ActionTooltip>
          </div>
        </div>
        
        <div className="toolbar-right">
          <ActionTooltip content="Reset both input lists">
            <button className="toolbar-btn text-red hover:bg-red-dim" onClick={() => { setInputA(""); setInputB(""); setHasCompared(false); }}>
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          </ActionTooltip>
          <div className="toolbar-sep" />
          <ActionTooltip content="Analyze differences between List A and B">
            <button className="toolbar-btn-primary" onClick={handleCompare}>
              <Play className="h-3.5 w-3.5 fill-current" />
              Compare Now
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
                        <button className="toolbar-icon-btn" onClick={() => formatInput(inputA, setInputA)}>
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
                    onChange={(e) => setInputA(e.target.value)}
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
                        <button className="toolbar-icon-btn" onClick={() => formatInput(inputB, setInputB)}>
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
                    onChange={(e) => setInputB(e.target.value)}
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
                {!hasCompared ? (
                  <div className="results-empty">
                    <Settings2 className="h-8 w-8 opacity-10 mb-2" />
                    <p>Paste your lists and click "Compare Now"</p>
                  </div>
                ) : filteredResults.length === 0 ? (
                  <div className="results-empty">
                    <Info className="h-8 w-8 opacity-10 mb-2" />
                    <p>No items found for this category</p>
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
