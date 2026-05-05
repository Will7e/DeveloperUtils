import React, { useState, useMemo, useRef, useEffect } from "react";
import { Search, Database, ChevronDown, Server, Monitor, ArrowLeftRight, FileCode2, X, Wrench } from "lucide-react";
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

export function LibrarySidebar() {
  const selectedId = useAppStore((s) => s.librarySelectedItemId);
  const setSelectedId = useAppStore((s) => s.setLibrarySelectedItemId);
  const searchQuery = useAppStore((s) => s.librarySearchQuery);
  const setSearchQuery = useAppStore((s) => s.setLibrarySearchQuery);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(libraryData.apis.map((a) => a.type)));
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Group APIs by type and sort them
  const grouped = useMemo(() => {
    const groups: Record<string, typeof libraryData.apis> = {};
    for (const api of libraryData.apis) {
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

  // Defined order for categories
  const categoryOrder = ["Server-side", "Client-side", "Client/Server Interaction", "Utils"];

  // Filter
  const filteredGrouped = useMemo(() => {
    if (!searchQuery.trim()) return grouped;
    
    // Normalize query: lowercase and remove trailing ()
    const q = searchQuery.toLowerCase().trim().replace(/\(\)$/, "");
    
    const result: Record<string, typeof libraryData.apis> = {};

    for (const [type, apis] of Object.entries(grouped)) {
      const filtered = apis.filter((api) => {
        const apiName = api.name.toLowerCase();
        const apiDesc = api.description.toLowerCase();
        
        // Extract shorthand: "GlideSystem (gs)" -> "gs"
        const shorthandMatch = apiName.match(/\((.*?)\)/);
        const shorthand = shorthandMatch?.[1]?.toLowerCase() || "";
        
        // Match API name, description or shorthand
        if (apiName.includes(q) || apiDesc.includes(q) || (shorthand && shorthand.includes(q))) return true;

        // Match method names or descriptions
        return api.methods.some((m) => {
          const methodName = m.name.toLowerCase();
          const methodDesc = m.description.toLowerCase();
          
          // Check for API.Method match (e.g., gs.getProperty)
          const fullMatch = `${apiName}.${methodName}`.includes(q);
          const shorthandMatchFull = shorthand ? `${shorthand}.${methodName}`.includes(q) : false;
          
          return methodName.includes(q) || methodDesc.includes(q) || fullMatch || shorthandMatchFull;
        });
      });

      if (filtered.length > 0) {
        result[type] = filtered;
      }
    }

    return result;
  }, [grouped, searchQuery]);

  // Auto-expand matching groups when search changes
  useEffect(() => {
    if (!searchQuery.trim()) return;
    const matches = Object.keys(filteredGrouped);
    if (matches.length > 0) {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        let changed = false;
        matches.forEach((m) => {
          if (next.has(m)) {
            next.delete(m);
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }
  }, [searchQuery, filteredGrouped]);

  const totalResults = Object.values(filteredGrouped).reduce((sum, apis) => sum + apis.length, 0);

  const toggleGroup = (type: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // Keyboard shortcut for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        // Don't hijack if in editor context
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "TEXTAREA" || (tag === "INPUT" && (e.target as HTMLInputElement).type === "text")) return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Scroll active item into view
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedId]);

  // Determine which categories to show based on order
  const displayedCategories = useMemo(() => {
    const existing = Object.keys(filteredGrouped);
    const sorted = categoryOrder.filter(c => existing.includes(c));
    // Add any categories not in categoryOrder at the end
    existing.forEach(c => {
      if (!sorted.includes(c)) sorted.push(c);
    });
    return sorted;
  }, [filteredGrouped]);

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
          />
          {searchQuery ? (
            <button className="lib-search-clear" onClick={() => setSearchQuery("")}>
              <X className="lib-search-clear-icon" />
            </button>
          ) : (
            <kbd className="lib-search-kbd">/</kbd>
          )}
        </div>

        {searchQuery && (
          <div className="lib-search-results-count">
            {totalResults} result{totalResults !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* API Groups */}
      <div className="lib-sidebar-content">
        {displayedCategories.map((type) => {
          const apis = filteredGrouped[type];
          const config = getTypeConfig(type);
          const isCollapsed = collapsedGroups.has(type) && !searchQuery.trim();

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
        })}

        {totalResults === 0 && (
          <div className="lib-empty-state">
            <Search className="lib-empty-icon" />
            <p className="lib-empty-text">No APIs match "{searchQuery}"</p>
            <button className="lib-empty-clear" onClick={() => setSearchQuery("")}>
              Clear search
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="lib-sidebar-footer">
        <div className="lib-footer-stats">
          <span className="lib-footer-stat">
            {libraryData.apis.length} APIs
          </span>
          <span className="lib-footer-divider">·</span>
          <span className="lib-footer-stat">
            {libraryData.apis.reduce((sum, a) => sum + a.methods.length, 0)} Methods
          </span>
        </div>
        <span className="lib-footer-version">v{libraryData.version}</span>
      </div>
    </div>
  );
}
