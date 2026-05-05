import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Search, Database, ChevronDown, Server, Monitor, ArrowLeftRight, FileCode2, X, Wrench, ArrowRight, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import libraryDataRaw from "../../servicenow_api_library_scripts.json";
import { ServiceNowLibrary } from "@/types";

const libraryData = libraryDataRaw as ServiceNowLibrary;

const TYPE_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  "Server-side": {
    icon: <Server className="lib-cat-icon" />,
    color: "var(--accent)",
    label: "Server-side",
  },
  "Client-side": {
    icon: <Monitor className="lib-cat-icon" />,
    color: "var(--green)",
    label: "Client-side",
  },
  "Client/Server Interaction": {
    icon: <ArrowLeftRight className="lib-cat-icon" />,
    color: "var(--yellow)",
    label: "Client ↔ Server",
  },
  "Utils": {
    icon: <Wrench className="lib-cat-icon" />,
    color: "var(--purple)",
    label: "Utilities & Snippets",
  },
};

function getTypeConfig(type: string) {
  return TYPE_CONFIG[type] || {
    icon: <FileCode2 className="lib-cat-icon" />,
    color: "var(--text-3)",
    label: type,
  };
}

// --- Search result types ---
interface SearchResult {
  apiName: string;
  apiType: string;
  methodCount: number;
  matchedMethods: string[];     // method names that matched
  matchType: 'api' | 'method' | 'description';
  score: number;                // relevance score for ranking
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
    let matchType: 'api' | 'method' | 'description' = 'description';
    const matchedMethods: string[] = [];

    // 1. API name exact match (highest)
    if (apiNameLower === q) {
      score = 1000;
      matchType = 'api';
    }
    // 2. API name starts with query
    else if (apiNameLower.startsWith(q)) {
      score = 800;
      matchType = 'api';
    }
    // 3. Shorthand exact match
    else if (shorthand && shorthand === q) {
      score = 750;
      matchType = 'api';
    }
    // 4. API name contains query
    else if (apiNameLower.includes(q)) {
      score = 600;
      matchType = 'api';
    }
    // 5. Shorthand contains query
    else if (shorthand && shorthand.includes(q)) {
      score = 550;
      matchType = 'api';
    }
    // 6. API description contains query
    else if (apiDescLower.includes(q)) {
      score = 200;
      matchType = 'description';
    }

    // Check method-level matches (always, to populate matchedMethods)
    for (const method of api.methods) {
      const methodNameLower = method.name.toLowerCase();
      const methodDescLower = method.description.toLowerCase();
      
      // Check various patterns
      const directMatch = methodNameLower.includes(q);
      const fullCallMatch = `${apiNameLower}.${methodNameLower}`.includes(q);
      const shorthandCallMatch = shorthand ? `${shorthand}.${methodNameLower}`.includes(q) : false;
      const descMatch = methodDescLower.includes(q);

      if (directMatch || fullCallMatch || shorthandCallMatch || descMatch) {
        matchedMethods.push(method.name);
        
        // Boost score for method matches if no API-level match yet
        if (score < 400) {
          if (methodNameLower === q) {
            score = Math.max(score, 500); // exact method name
          } else if (directMatch || fullCallMatch || shorthandCallMatch) {
            score = Math.max(score, 400); // method name contains
          } else {
            score = Math.max(score, 150); // only desc match
          }
          matchType = 'method';
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

  // Sort by score descending, then alphabetically
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
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === q
        ? <mark key={i} className="lib-search-highlight">{part}</mark>
        : part
    );
  } catch {
    return text;
  }
}

export function LibrarySidebar() {
  const selectedId = useAppStore((s) => s.librarySelectedItemId);
  const setSelectedId = useAppStore((s) => s.setLibrarySelectedItemId);
  const searchQuery = useAppStore((s) => s.librarySearchQuery);
  const setSearchQuery = useAppStore((s) => s.setLibrarySearchQuery);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(libraryData.apis.map((a) => a.type)));
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [selectedResultIndex, setSelectedResultIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const resultRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Group APIs by type for browse mode
  const grouped = useMemo(() => {
    const groups: Record<string, typeof libraryData.apis> = {};
    const seen = new Set<string>();
    for (const api of libraryData.apis) {
      // Skip duplicates
      if (seen.has(api.name)) continue;
      seen.add(api.name);
      
      const key = api.type;
      if (!groups[key]) groups[key] = [];
      groups[key].push(api);
    }

    // Sort APIs within each group: Glide classes first, then alphabetical
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

  const categoryOrder = ["Server-side", "Client-side", "Client/Server Interaction", "Utils"];

  // Compute search results
  const searchResults = useMemo(() => computeSearchResults(searchQuery), [searchQuery]);

  // Switch in/out of search mode
  useEffect(() => {
    const hasQuery = searchQuery.trim().length > 0;
    setIsSearchMode(hasQuery);
    if (hasQuery) {
      setSelectedResultIndex(-1);
    }
  }, [searchQuery]);

  // Auto-select first result when searching
  useEffect(() => {
    if (isSearchMode && searchResults.length > 0 && selectedResultIndex === -1) {
      setSelectedResultIndex(0);
    }
  }, [isSearchMode, searchResults, selectedResultIndex]);

  // "/" keyboard shortcut to focus search
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

  // Keyboard navigation within search results
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isSearchMode || searchResults.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedResultIndex((prev) => {
        const next = Math.min(prev + 1, searchResults.length - 1);
        // Scroll into view
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
  }, [isSearchMode, searchResults, selectedResultIndex, setSelectedId, setSearchQuery]);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSelectedResultIndex(-1);
    searchRef.current?.focus();
  }, [setSearchQuery]);

  // Scroll active item into view in browse mode
  useEffect(() => {
    if (!isSearchMode && activeRef.current) {
      activeRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedId, isSearchMode]);

  // Get categories for browse mode
  const displayedCategories = useMemo(() => {
    const existing = Object.keys(grouped);
    const sorted = categoryOrder.filter(c => existing.includes(c));
    existing.forEach(c => {
      if (!sorted.includes(c)) sorted.push(c);
    });
    return sorted;
  }, [grouped]);

  const toggleGroup = (type: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // Total unique API count
  const totalApis = useMemo(() => {
    const seen = new Set<string>();
    libraryData.apis.forEach(a => seen.add(a.name));
    return seen.size;
  }, []);

  const totalMethods = useMemo(() => {
    const seen = new Set<string>();
    let count = 0;
    libraryData.apis.forEach(a => {
      if (!seen.has(a.name)) {
        seen.add(a.name);
        count += a.methods.length;
      }
    });
    return count;
  }, []);

  return (
    <div className="lib-sidebar">
      {/* Header */}
      <div className="lib-sidebar-header">
        <div className="lib-sidebar-title-row">
          <div className="lib-sidebar-title-icon">
            <Database className="lib-db-icon" />
          </div>
          <div className="lib-sidebar-title-text">
            <span className="lib-sidebar-title">API Library</span>
            <span className="lib-sidebar-subtitle">ServiceNow Reference</span>
          </div>
        </div>

        {/* Search */}
        <div className="lib-search-container">
          <Search className="lib-search-icon" />
          <input
            ref={searchRef}
            type="text"
            placeholder="Search APIs, methods..."
            className="lib-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {searchQuery ? (
            <button className="lib-search-clear" onClick={clearSearch}>
              <X className="lib-search-clear-icon" />
            </button>
          ) : (
            <kbd className="lib-search-kbd">/</kbd>
          )}
        </div>

        {isSearchMode && (
          <div className="lib-search-status">
            <Zap size={10} className="lib-search-status-icon" />
            <span>
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
              {searchResults.length > 0 && (
                <span className="lib-search-status-hint"> · ↑↓ navigate · ⏎ select</span>
              )}
            </span>
          </div>
        )}
      </div>

      {/* Content: Search mode or Browse mode */}
      <div className="lib-sidebar-content">
        {isSearchMode ? (
          // ---- SEARCH RESULTS ----
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
                      <div
                        className="lib-search-result-dot"
                        style={{ background: config.color }}
                      />
                      <span className="lib-search-result-name">
                        {highlightMatch(result.apiName, searchQuery)}
                      </span>
                      <span className="lib-search-result-badge" style={{ color: config.color }}>
                        {result.apiType === "Server-side" ? "SRV" :
                         result.apiType === "Client-side" ? "CLI" :
                         result.apiType === "Client/Server Interaction" ? "C/S" :
                         result.apiType === "Utils" ? "UTL" : "API"}
                      </span>
                    </div>
                    
                    {result.matchedMethods.length > 0 && (
                      <div className="lib-search-result-methods">
                        <ArrowRight size={8} className="lib-search-result-arrow" />
                        <span className="lib-search-result-methods-text">
                          {result.matchedMethods.slice(0, 3).map((name, i) => (
                            <React.Fragment key={name}>
                              {i > 0 && <span className="lib-search-method-sep">, </span>}
                              <span className="lib-search-method-name">
                                {highlightMatch(name, searchQuery)}
                                <span className="lib-search-method-parens">()</span>
                              </span>
                            </React.Fragment>
                          ))}
                          {result.matchedMethods.length > 3 && (
                            <span className="lib-search-method-more">
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
            <div className="lib-empty-state">
              <Search className="lib-empty-icon" />
              <p className="lib-empty-text">No results for "{searchQuery}"</p>
              <p className="lib-empty-subtext">Try searching for an API name or method</p>
              <button className="lib-empty-clear" onClick={clearSearch}>
                Clear search
              </button>
            </div>
          )
        ) : (
          // ---- BROWSE MODE ----
          displayedCategories.map((type) => {
            const apis = grouped[type];
            const config = getTypeConfig(type);
            const isCollapsed = collapsedGroups.has(type);

            return (
              <div key={type} className="lib-group">
                <button
                  className="lib-group-header"
                  onClick={() => toggleGroup(type)}
                >
                  <ChevronDown
                    className={cn("lib-group-chevron", isCollapsed && "lib-group-chevron-collapsed")}
                  />
                  <span className="lib-group-icon" style={{ color: config.color }}>
                    {config.icon}
                  </span>
                  <span className="lib-group-label">{config.label}</span>
                  <span className="lib-group-count">{apis?.length || 0}</span>
                </button>

                {!isCollapsed && (
                  <div className="lib-group-items">
                    {apis && apis.map((api) => {
                      const isActive = selectedId === api.name;
                      const typeConfig = getTypeConfig(api.type);
                      return (
                        <button
                          key={api.name}
                          ref={isActive ? activeRef : null}
                          className={cn("lib-item", isActive && "lib-item-active")}
                          onClick={() => setSelectedId(api.name)}
                        >
                          <div
                            className="lib-item-dot"
                            style={{ background: isActive ? typeConfig.color : undefined }}
                          />
                          <span className="lib-item-name">{api.name}</span>
                          <span className="lib-item-method-count">
                            {api.methods.length}
                          </span>
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
        <div className="lib-footer-stats">
          <span className="lib-footer-stat">
            {totalApis} APIs
          </span>
          <span className="lib-footer-divider">·</span>
          <span className="lib-footer-stat">
            {totalMethods} Methods
          </span>
        </div>
        <span className="lib-footer-version">v{libraryData.version}</span>
      </div>
    </div>
  );
}
