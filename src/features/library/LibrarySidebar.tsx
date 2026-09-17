import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { 
  Search, 
  Database, 
  ChevronDown, 
  Server, 
  Monitor, 
  ArrowLeftRight, 
  FileCode2, 
  X, 
  Wrench, 
  ArrowRight, 
  Zap,
  LayoutGrid,
  Cloud,
  Layers,
  Boxes,
  GitBranch,
  BookOpen,
  CheckCircle2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import libraryDataRaw from "../../servicenow_api_library_scripts.json";
import { ServiceNowLibrary } from "@/types";
import { 
  EXCALIDRAW_CATEGORIES, 
  getExcalidrawLibraries, 
  type ExcalidrawLibraryItem 
} from "@/utils/excalidrawLibrary";
import { useNavigate } from "react-router-dom";

const libraryData = libraryDataRaw as ServiceNowLibrary;

const TYPE_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string; short: string }> = {
  "Server-side": {
    icon: <Server className="w-3.5 h-3.5" />,
    color: "var(--accent)",
    label: "Server-side",
    short: "SRV",
  },
  "Client-side": {
    icon: <Monitor className="w-3.5 h-3.5" />,
    color: "var(--green)",
    label: "Client-side",
    short: "CLI",
  },
  "Client/Server Interaction": {
    icon: <ArrowLeftRight className="w-3.5 h-3.5" />,
    color: "var(--yellow)",
    label: "Client ↔ Server",
    short: "C/S",
  },
  "Utils": {
    icon: <Wrench className="w-3.5 h-3.5" />,
    color: "var(--purple)",
    label: "Utilities & Snippets",
    short: "UTL",
  },
};

function normalizeCategory(type: string): string {
  if (type.toLowerCase().startsWith("server-side")) return "Server-side";
  if (type.toLowerCase().startsWith("client-side")) return "Client-side";
  if (type.toLowerCase().includes("interaction")) return "Client/Server Interaction";
  if (type.toLowerCase().includes("util")) return "Utils";
  return type;
}

function getTypeConfig(type: string) {
  const norm = normalizeCategory(type);
  return TYPE_CONFIG[norm] || {
    icon: <FileCode2 className="w-3.5 h-3.5" />,
    color: "var(--text-3)",
    label: norm,
    short: "API",
  };
}

const EXCAL_ICONS: Record<string, React.ReactNode> = {
  all: <LayoutGrid className="w-3.5 h-3.5" />,
  added: <CheckCircle2 className="w-3.5 h-3.5 text-green" />,
  system: <Cloud className="w-3.5 h-3.5" />,
  ui: <Layers className="w-3.5 h-3.5" />,
  icons: <Boxes className="w-3.5 h-3.5" />,
  diagrams: <GitBranch className="w-3.5 h-3.5" />,
};

// --- Search result types ---
interface SearchResult {
  apiName: string;
  apiType: string;
  methodCount: number;
  matchedMethods: string[];
  matchType: "api" | "method" | "description";
  score: number;
}

function computeSearchResults(query: string): SearchResult[] {
  if (!query.trim()) return [];

  const q = query.toLowerCase().trim().replace(/\(\)$/, "");
  const results: SearchResult[] = [];

  for (const api of libraryData.apis) {
    const apiNameLower = api.name.toLowerCase();
    const apiDescLower = api.description.toLowerCase();

    // Extract shorthand from name like "GlideSystem (gs)"
    const shorthandMatch = api.name.match(/\((.*?)\)/);
    const shorthand = shorthandMatch?.[1]?.toLowerCase() || "";

    let score = 0;
    let matchType: "api" | "method" | "description" = "description";
    const matchedMethods: string[] = [];

    // 1. API name exact match (highest)
    if (apiNameLower === q) {
      score = 1000;
      matchType = "api";
    } else if (apiNameLower.startsWith(q)) {
      score = 800;
      matchType = "api";
    } else if (shorthand && shorthand === q) {
      score = 750;
      matchType = "api";
    } else if (apiNameLower.includes(q)) {
      score = 600;
      matchType = "api";
    } else if (shorthand && shorthand.includes(q)) {
      score = 550;
      matchType = "api";
    } else if (apiDescLower.includes(q)) {
      score = 200;
      matchType = "description";
    }

    // Check method-level matches
    for (const method of api.methods) {
      const methodNameLower = method.name.toLowerCase();
      const methodDescLower = method.description.toLowerCase();

      const directMatch = methodNameLower.includes(q);
      const fullCallMatch = `${apiNameLower}.${methodNameLower}`.includes(q);
      const shorthandCallMatch = shorthand ? `${shorthand}.${methodNameLower}`.includes(q) : false;
      const descMatch = methodDescLower.includes(q);

      if (directMatch || fullCallMatch || shorthandCallMatch || descMatch) {
        matchedMethods.push(method.name);

        if (score < 400) {
          if (methodNameLower === q) {
            score = Math.max(score, 500);
          } else if (directMatch || fullCallMatch || shorthandCallMatch) {
            score = Math.max(score, 400);
          } else {
            score = Math.max(score, 150);
          }
          matchType = "method";
        }
      }
    }

    if (score > 0) {
      results.push({
        apiName: api.name,
        apiType: api.type,
        methodCount: api.methods.length,
        matchedMethods,
        matchType,
        score,
      });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.apiName.localeCompare(b.apiName);
  });

  return results;
}

// Highlight matching text
function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const q = query.toLowerCase().trim().replace(/\(\)$/, "");
  if (!q) return text;

  try {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${escaped})`, "gi"));
    return parts.map((part, i) =>
      part.toLowerCase() === q ? (
        <mark key={i} className="lib-search-highlight">
          {part}
        </mark>
      ) : (
        part
      )
    );
  } catch {
    return text;
  }
}

const CATEGORY_ORDER = ["Server-side", "Client-side", "Client/Server Interaction", "Utils"] as const;

export function LibrarySidebar() {
  const navigate = useNavigate();
  const selectedId = useAppStore((s) => s.librarySelectedItemId);
  const setSelectedId = useAppStore((s) => s.setLibrarySelectedItemId);
  const searchQuery = useAppStore((s) => s.librarySearchQuery);
  const setSearchQuery = useAppStore((s) => s.setLibrarySearchQuery);
  const libraryTab = useAppStore((s) => s.libraryTab);
  const setLibraryTab = useAppStore((s) => s.setLibraryTab);
  const excalCategory = useAppStore((s) => s.libraryExcalidrawCategory);
  const setExcalCategory = useAppStore((s) => s.setLibraryExcalidrawCategory);
  const storeAddedIds = useAppStore((s) => s.excalidrawAddedLibraryIds || []);

  const [activeChip, setActiveChip] = useState<string>("All");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [excalLibraries, setExcalLibraries] = useState<ExcalidrawLibraryItem[]>([]);
  const isSearchMode = searchQuery.trim().length > 0;
  const [prevSearchQuery, setPrevSearchQuery] = useState(searchQuery);
  const [selectedResultIndex, setSelectedResultIndex] = useState(0);

  if (searchQuery !== prevSearchQuery) {
    setPrevSearchQuery(searchQuery);
    setSelectedResultIndex(0);
  }

  const searchRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const resultRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Load Excalidraw libraries for category counts
  useEffect(() => {
    getExcalidrawLibraries().then((data) => {
      setExcalLibraries(data);
    });
  }, []);

  // Group APIs by normalized type for browse mode
  const grouped = useMemo(() => {
    const groups: Record<string, typeof libraryData.apis> = {};
    const seen = new Set<string>();

    for (const api of libraryData.apis) {
      if (seen.has(api.name)) continue;
      seen.add(api.name);

      const normType = normalizeCategory(api.type);
      if (!groups[normType]) groups[normType] = [];
      groups[normType].push(api);
    }

    for (const type in groups) {
      const apis = groups[type];
      if (apis) {
        apis.sort((a, b) => {
          const aIsGlide = a.name.startsWith("Glide");
          const bIsGlide = b.name.startsWith("Glide");
          if (aIsGlide && !bIsGlide) return -1;
          if (!aIsGlide && bIsGlide) return 1;
          return a.name.localeCompare(b.name);
        });
      }
    }
    return groups;
  }, []);

  const searchResults = useMemo(() => computeSearchResults(searchQuery), [searchQuery]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isSearchMode || searchResults.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedResultIndex((prev) => {
          const next = Math.min(prev + 1, searchResults.length - 1);
          resultRefs.current.get(next)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedResultIndex((prev) => {
          const next = Math.max(prev - 1, 0);
          resultRefs.current.get(next)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          return next;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selectedResultIndex >= 0 && selectedResultIndex < searchResults.length) {
          const selected = searchResults[selectedResultIndex];
          if (selected) {
            setSelectedId(selected.apiName);
          }
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSearchQuery("");
        searchRef.current?.blur();
      }
    },
    [isSearchMode, searchResults, selectedResultIndex, setSelectedId, setSearchQuery]
  );

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSelectedResultIndex(-1);
    searchRef.current?.focus();
  }, [setSearchQuery]);

  useEffect(() => {
    if (!isSearchMode && activeRef.current) {
      activeRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedId, isSearchMode]);

  const displayedCategories = useMemo(() => {
    const existing = Object.keys(grouped);
    const sorted = CATEGORY_ORDER.filter((c) => existing.includes(c));
    existing.forEach((c) => {
      if (!sorted.includes(c as (typeof CATEGORY_ORDER)[number])) sorted.push(c as (typeof CATEGORY_ORDER)[number]);
    });

    if (activeChip === "All") return sorted;
    return sorted.filter((c) => {
      if (activeChip === "Server") return c === "Server-side";
      if (activeChip === "Client") return c === "Client-side";
      if (activeChip === "Interaction") return c === "Client/Server Interaction";
      if (activeChip === "Utils") return c === "Utils";
      return true;
    });
  }, [grouped, activeChip]);

  const toggleGroup = (type: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const totalApis = useMemo(() => {
    const seen = new Set<string>();
    libraryData.apis.forEach((a) => seen.add(a.name));
    return seen.size;
  }, []);

  const totalMethods = useMemo(() => {
    const seen = new Set<string>();
    let count = 0;
    libraryData.apis.forEach((a) => {
      if (!seen.has(a.name)) {
        seen.add(a.name);
        count += a.methods.length;
      }
    });
    return count;
  }, []);

  // Compute Excalidraw counts
  const excalCounts = useMemo(() => {
    const counts: Record<string, number> = { 
      all: excalLibraries.length,
      added: storeAddedIds.length,
    };
    EXCALIDRAW_CATEGORIES.forEach((cat) => {
      if (cat.id === "all" || cat.id === "added") return;
      if (cat.keywords) {
        const matching = excalLibraries.filter((lib) =>
          cat.keywords!.some((kw) => lib.name.toLowerCase().includes(kw) || lib.description.toLowerCase().includes(kw))
        );
        counts[cat.id] = matching.length;
      }
    });
    return counts;
  }, [excalLibraries, storeAddedIds]);

  return (
    <div className="lib-sidebar">
      {/* Header */}
      <div className="lib-sidebar-header">
        <div className="lib-sidebar-title-row">
          <div 
            className="lib-sidebar-brand" 
            onClick={() => {
              setSelectedId(null);
              setSearchQuery("");
            }}
            title="Return to Library Discovery Hub"
          >
            <div className="lib-sidebar-title-icon">
              {libraryTab === "servicenow" ? <Database className="w-3.5 h-3.5" /> : <BookOpen className="w-3.5 h-3.5" />}
            </div>
            <div className="lib-sidebar-title-text">
              <span className="lib-sidebar-title">Developer Library</span>
              <span className="lib-sidebar-subtitle">
                {libraryTab === "servicenow" ? "ServiceNow API Hub" : "Community Shapes"}
              </span>
            </div>
          </div>
        </div>

        {/* Dual Tab Segmented Control */}
        <div className="lib-mode-tabs">
          <button
            className={cn("lib-mode-tab", libraryTab === "servicenow" && "lib-mode-tab-active")}
            onClick={() => setLibraryTab("servicenow")}
            title="ServiceNow APIs"
          >
            <Server className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">ServiceNow</span>
          </button>
          <button
            className={cn("lib-mode-tab", libraryTab === "excalidraw" && "lib-mode-tab-active")}
            onClick={() => setLibraryTab("excalidraw")}
            title="Excalidraw Shapes & Diagrams"
          >
            <Boxes className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Excalidraw</span>
          </button>
        </div>

        {/* Search Input */}
        <div className="lib-search-container">
          <Search className="lib-search-icon" />
          <input
            ref={searchRef}
            type="text"
            placeholder={
              libraryTab === "servicenow"
                ? "Search APIs, methods..."
                : "Search shapes, authors..."
            }
            className="lib-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {searchQuery ? (
            <button className="lib-search-clear" onClick={clearSearch} title="Clear search">
              <X className="w-2.5 h-2.5" />
            </button>
          ) : (
            <kbd className="lib-search-kbd">/</kbd>
          )}
        </div>

        {/* Quick Filter Chips (ServiceNow mode only when not searching) */}
        {libraryTab === "servicenow" && !isSearchMode && (
          <div className="lib-filter-chips">
            {["All", "Server", "Client", "Interaction", "Utils"].map((chip) => (
              <button
                key={chip}
                className={cn("lib-filter-chip", activeChip === chip && "lib-filter-chip-active")}
                onClick={() => setActiveChip(chip)}
              >
                {chip}
              </button>
            ))}
          </div>
        )}

        {isSearchMode && libraryTab === "servicenow" && (
          <div className="lib-search-status">
            <div className="flex items-center gap-1.5">
              <Zap className="w-3 h-3 text-accent" />
              <span>
                {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
              </span>
            </div>
            {searchResults.length > 0 && (
              <span className="text-[10px] text-text-3 font-normal">↑↓ navigate · ⏎ open</span>
            )}
          </div>
        )}
      </div>

      {/* Sidebar Content */}
      <div className="lib-sidebar-content">
        {libraryTab === "excalidraw" ? (
          /* ---- EXCALIDRAW CATEGORY NAV ---- */
          <div className="lib-excal-nav">
            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-text-3">
              Collections
            </div>
            {EXCALIDRAW_CATEGORIES.map((cat) => {
              const isActive = excalCategory === cat.id;
              const count = excalCounts[cat.id] ?? 0;
              const icon = EXCAL_ICONS[cat.id] || <LayoutGrid className="w-3.5 h-3.5" />;

              return (
                <button
                  key={cat.id}
                  className={cn("lib-excal-cat-item", isActive && "lib-excal-cat-item-active")}
                  onClick={() => setExcalCategory(cat.id)}
                >
                  <span className={cn("shrink-0", isActive ? "text-accent" : "text-text-3")}>
                    {icon}
                  </span>
                  <span className="flex-1 truncate">{cat.label}</span>
                  <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-bg-2 border border-border-1 text-text-3">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        ) : isSearchMode ? (
          /* ---- SERVICENOW SEARCH RESULTS ---- */
          searchResults.length > 0 ? (
            <div className="lib-search-results">
              {searchResults.map((result, idx) => {
                const config = getTypeConfig(result.apiType);
                const isActive = selectedId === result.apiName;
                const isSelected = idx === selectedResultIndex;

                return (
                  <button
                    key={`${result.apiName}-${idx}`}
                    ref={(el) => {
                      if (el) resultRefs.current.set(idx, el);
                      else resultRefs.current.delete(idx);
                    }}
                    className={cn(
                      "lib-search-result",
                      isSelected && "lib-search-result-selected",
                      isActive && "lib-search-result-active"
                    )}
                    onClick={() => {
                      setSelectedId(result.apiName);
                      setSelectedResultIndex(idx);
                    }}
                    onMouseEnter={() => setSelectedResultIndex(idx)}
                  >
                    <div className="lib-search-result-header">
                      <div className="lib-search-result-dot" style={{ background: config.color }} />
                      <span className="lib-search-result-name">
                        {highlightMatch(result.apiName, searchQuery)}
                      </span>
                      <span
                        className="lib-search-result-badge"
                        style={{ color: config.color, borderColor: config.color }}
                      >
                        {config.short}
                      </span>
                    </div>

                    {result.matchedMethods.length > 0 && (
                      <div className="lib-search-result-methods">
                        <ArrowRight className="w-2.5 h-2.5 text-text-3 shrink-0" />
                        <span className="lib-search-result-methods-text">
                          {result.matchedMethods.slice(0, 3).map((name, i) => (
                            <React.Fragment key={name}>
                              {i > 0 && <span className="opacity-40">, </span>}
                              <span className="text-accent font-medium">
                                {highlightMatch(name, searchQuery)}
                                <span className="text-text-3 font-normal">()</span>
                              </span>
                            </React.Fragment>
                          ))}
                          {result.matchedMethods.length > 3 && (
                            <span className="text-text-3 text-[9px] font-semibold ml-1">
                              +{result.matchedMethods.length - 3} more
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="p-8 text-center flex flex-col items-center gap-2">
              <Search className="w-6 h-6 text-text-3 opacity-40 mb-1" />
              <p className="text-xs font-semibold text-text-2">No matching APIs</p>
              <p className="text-[11px] text-text-3">Try searching for methods like 'addQuery' or 'info'</p>
              <button
                className="mt-2 text-xs text-accent hover:underline font-medium"
                onClick={clearSearch}
              >
                Clear search query
              </button>
            </div>
          )
        ) : (
          /* ---- SERVICENOW BROWSE CATEGORIES ---- */
          displayedCategories.map((type) => {
            const apis = grouped[type] || [];
            const config = getTypeConfig(type);
            const isCollapsed = collapsedGroups.has(type);

            return (
              <div key={type} className="lib-group">
                <button
                  className="lib-group-header"
                  onClick={() => toggleGroup(type)}
                >
                  <ChevronDown
                    className={cn(
                      "lib-group-chevron",
                      isCollapsed && "lib-group-chevron-collapsed"
                    )}
                  />
                  <span className="lib-group-icon" style={{ color: config.color }}>
                    {config.icon}
                  </span>
                  <span className="lib-group-label">{config.label}</span>
                  <span className="lib-group-count">{apis.length}</span>
                </button>

                {!isCollapsed && (
                  <div className="lib-group-items">
                    {apis.map((api) => {
                      const isActive = selectedId === api.name;
                      const isScoped = api.type.toLowerCase().includes("scoped");
                      const isGlobal = api.type.toLowerCase().includes("global");

                      return (
                        <button
                          key={api.name}
                          ref={isActive ? activeRef : null}
                          className={cn("lib-item", isActive && "lib-item-active")}
                          onClick={() => setSelectedId(api.name)}
                          title={`${api.name} (${api.methods.length} methods)`}
                        >
                          <div
                            className="lib-item-dot"
                            style={{
                              background: isActive ? config.color : undefined,
                            }}
                          />
                          <span className="lib-item-name">{api.name}</span>

                          {isScoped && (
                            <span className="text-[9px] font-mono text-purple font-semibold uppercase px-1 rounded bg-purple/10">
                              scope
                            </span>
                          )}
                          {isGlobal && (
                            <span className="text-[9px] font-mono text-yellow font-semibold uppercase px-1 rounded bg-yellow/10">
                              global
                            </span>
                          )}

                          <span className="lib-item-method-count">{api.methods.length}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="lib-sidebar-footer">
        {libraryTab === "servicenow" ? (
          <>
            <div className="lib-footer-stats">
              <span>{totalApis} APIs</span>
              <span className="opacity-30">·</span>
              <span>{totalMethods} Methods</span>
            </div>
            <span className="lib-footer-version">v{libraryData.version}</span>
          </>
        ) : (
          <>
            <div className="lib-footer-stats">
              <span>{excalLibraries.length} Collections</span>
            </div>
            <span className="text-[10px] text-accent font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              Offline Ready
            </span>
          </>
        )}
      </div>
    </div>
  );
}
