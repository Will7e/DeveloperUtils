import React, { useState, useMemo, useRef, useEffect } from "react";
import { Search, Database, ChevronDown, Server, Monitor, ArrowLeftRight, FileCode2, X, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import libraryDataRaw from "../../servicenow_api_library.json";
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
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(libraryData.apis.map((a) => a.type)));
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Group APIs by type
  const grouped = useMemo(() => {
    const groups: Record<string, typeof libraryData.apis> = {};
    for (const api of libraryData.apis) {
      const key = api.type;
      if (!groups[key]) groups[key] = [];
      groups[key].push(api);
    }
    return groups;
  }, []);

  // Filter
  const filteredGrouped = useMemo(() => {
    if (!searchQuery.trim()) return grouped;
    const q = searchQuery.toLowerCase();
    const result: Record<string, typeof libraryData.apis> = {};
    for (const [type, apis] of Object.entries(grouped)) {
      const filtered = apis.filter(
        (api) =>
          api.name.toLowerCase().includes(q) ||
          api.description.toLowerCase().includes(q) ||
          api.methods.some((m) => m.name.toLowerCase().includes(q))
      );
      if (filtered.length > 0) result[type] = filtered;
    }
    return result;
  }, [grouped, searchQuery]);

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
        {Object.entries(filteredGrouped).map(([type, apis]) => {
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
                <span className="lib-group-count">{apis.length}</span>
              </button>

              {!isCollapsed && (
                <div className="lib-group-items">
                  {apis.map((api) => {
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
