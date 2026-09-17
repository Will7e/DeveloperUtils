import React, { useState, useMemo, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { LoadingState } from "@/components/ui/loading-state";
import { 
  Copy, 
  Check, 
  Code2, 
  Server, 
  Monitor, 
  ArrowLeftRight, 
  FileCode2, 
  ChevronDown, 
  ExternalLink, 
  Sparkles, 
  Wrench,
  Search,
  ArrowRight,
  ArrowLeft,
  Play,
  Layers,
  ChevronRight,
  Maximize2,
  Minimize2,
  X,
  Boxes,
  Plus,
  Trash2,
  Loader2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import libraryDataRaw from "../../servicenow_api_library_scripts.json";
import { ServiceNowLibrary, ServiceNowMethod, Toast } from "@/types";
import {
  getExcalidrawLibraries,
  getExcalidrawLibraryPreviewUrl,
  getExcalidrawLibraryCdnPreviewUrl,
  EXCALIDRAW_CATEGORIES,
  type ExcalidrawLibraryItem,
} from "@/utils/excalidrawLibrary";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const libraryData = libraryDataRaw as ServiceNowLibrary;

interface ActionTooltipProps {
  children: React.ReactNode;
  content: string;
  side?: "top" | "bottom" | "left" | "right";
}

const ActionTooltip = ({ children, content, side = "top" }: ActionTooltipProps) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side={side} sideOffset={8}>
      <p className="text-xs">{content}</p>
    </TooltipContent>
  </Tooltip>
);

const TYPE_BADGE: Record<string, { icon: React.ReactNode; color: string; bg: string; label: string }> = {
  "Server-side": {
    icon: <Server size={11} />,
    color: "var(--accent)",
    bg: "rgba(56, 189, 248, 0.1)",
    label: "Server-side",
  },
  "Client-side": {
    icon: <Monitor size={11} />,
    color: "var(--green)",
    bg: "rgba(16, 185, 129, 0.1)",
    label: "Client-side",
  },
  "Client/Server Interaction": {
    icon: <ArrowLeftRight size={11} />,
    color: "var(--yellow)",
    bg: "rgba(245, 158, 11, 0.1)",
    label: "Client ↔ Server",
  },
  "Utils": {
    icon: <Wrench size={11} />,
    color: "var(--purple)",
    bg: "rgba(168, 85, 247, 0.1)",
    label: "Utilities & Snippets",
  },
};

function normalizeType(type: string): string {
  if (type.toLowerCase().startsWith("server-side")) return "Server-side";
  if (type.toLowerCase().startsWith("client-side")) return "Client-side";
  if (type.toLowerCase().includes("interaction")) return "Client/Server Interaction";
  if (type.toLowerCase().includes("util")) return "Utils";
  return type;
}

function getTypeBadge(type: string) {
  const norm = normalizeType(type);
  return TYPE_BADGE[norm] || {
    icon: <FileCode2 size={11} />,
    color: "var(--text-3)",
    bg: "rgba(255,255,255,0.05)",
    label: norm,
  };
}

export function LibraryView() {
  const selectedId = useAppStore((s) => s.librarySelectedItemId);
  const setSelectedId = useAppStore((s) => s.setLibrarySelectedItemId);
  const searchQuery = useAppStore((s) => s.librarySearchQuery);
  const setSearchQuery = useAppStore((s) => s.setLibrarySearchQuery);
  const libraryTab = useAppStore((s) => s.libraryTab);
  const addToast = useAppStore((s) => s.addToast);
  const createFile = useAppStore((s) => s.createFile);

  const selectedApi = useMemo(() => {
    return libraryData.apis.find((api) => api.name === selectedId);
  }, [selectedId]);

  // Normalize query
  const q = useMemo(() => searchQuery.toLowerCase().trim().replace(/\(\)$/, ""), [searchQuery]);

  if (libraryTab === "excalidraw") {
    return <ExcalidrawLibraryGallery searchQuery={searchQuery} />;
  }

  // If no API is selected, render the Welcome / Discovery Hub
  if (!selectedApi) {
    return (
      <LibraryDiscoveryHub 
        onSelectApi={(name) => setSelectedId(name)} 
        onSearch={(query) => setSearchQuery(query)}
        addToast={addToast}
        createFile={createFile}
      />
    );
  }

  return (
    <ApiDocumentationView
      key={selectedApi.name}
      selectedApi={selectedApi}
      q={q}
      addToast={addToast}
      createFile={createFile}
      onBackToHub={() => setSelectedId(null)}
    />
  );
}

/* ============================================================
   API DOCUMENTATION DETAIL VIEW
   ============================================================ */

function ApiDocumentationView({
  selectedApi,
  q,
  addToast,
  createFile,
  onBackToHub,
}: {
  selectedApi: (typeof libraryData.apis)[0];
  q: string;
  addToast: (toast: Omit<Toast, "id">) => void;
  createFile: (name: string, language: "javascript", content?: string) => void;
  onBackToHub: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [methodFilter, setMethodFilter] = useState("");
  const [expandAll, setExpandAll] = useState(true);

  const badge = getTypeBadge(selectedApi.type);

  // Filter methods inside this API if methodFilter is set
  const filteredMethods = useMemo(() => {
    return selectedApi.methods.filter((m) => {
      if (!methodFilter.trim()) return true;
      const term = methodFilter.toLowerCase();
      return m.name.toLowerCase().includes(term) || m.description.toLowerCase().includes(term);
    });
  }, [selectedApi, methodFilter]);

  const handleCopyApiName = () => {
    navigator.clipboard.writeText(selectedApi.name);
    addToast({ message: `Copied "${selectedApi.name}" to clipboard`, type: "success" });
  };

  return (
    <div className="lib-view">
      {/* Sleek Compact Header */}
      <header className="lib-view-header">
        <div className="lib-view-header-inner">
          {/* Top Row: Navigation Breadcrumbs */}
          <div className="flex items-center justify-between gap-4 mb-2">
            <div className="lib-breadcrumbs mb-0">
              <button 
                className="lib-breadcrumb-link flex items-center gap-1 font-medium hover:text-accent" 
                onClick={onBackToHub}
                title="Return to Developer Library Hub"
              >
                <ArrowLeft className="w-3 h-3" />
                <span>Developer Library</span>
              </button>
              <ChevronRight className="w-3 h-3 lib-breadcrumb-sep" />
              <span className="text-text-3">{badge.label}</span>
              <ChevronRight className="w-3 h-3 lib-breadcrumb-sep" />
              <span className="text-text-1 font-semibold">{selectedApi.name}</span>
            </div>
          </div>

          {/* Middle Row: Title, Badges, and Method Controls Toolbar */}
          <div className="flex items-center justify-between gap-4 flex-wrap mb-2">
            <div className="flex items-center gap-2.5 flex-wrap">
              <div className="flex items-center gap-2">
                <h1 className="lib-view-api-name text-xl md:text-2xl">{selectedApi.name}</h1>
                <ActionTooltip content="Copy API Name">
                  <button
                    onClick={handleCopyApiName}
                    className="p-1 text-text-3 hover:text-text-1 hover:bg-bg-2 rounded-md transition-all"
                    aria-label="Copy API Name"
                  >
                    <Copy size={13} />
                  </button>
                </ActionTooltip>
              </div>
              <span
                className="lib-view-type-badge"
                style={{ 
                  color: badge.color, 
                  background: badge.bg, 
                  borderColor: `color-mix(in srgb, ${badge.color} 30%, transparent)` 
                }}
              >
                {badge.icon}
                {badge.label}
              </span>

            </div>

            {/* Consolidated Method Controls: Filter + Count + Collapse/Expand */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="lib-method-filter-input-wrap !w-56">
                <Search className="w-3.5 h-3.5 lib-method-filter-icon" />
                <input
                  type="text"
                  className="lib-method-filter-input !h-7 text-xs"
                  placeholder={`Filter ${selectedApi.methods.length} methods...`}
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value)}
                />
                {methodFilter && (
                  <button 
                    className="lib-method-filter-clear" 
                    onClick={() => setMethodFilter("")}
                    title="Clear filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <span className="text-[11px] text-text-3 font-mono shrink-0 hidden sm:inline-block">
                {filteredMethods.length}/{selectedApi.methods.length}
              </span>

              <button
                className="lib-view-action-btn !h-7 !py-0 !px-2.5 text-xs"
                onClick={() => setExpandAll(!expandAll)}
                title={expandAll ? "Collapse All Methods" : "Expand All Methods"}
              >
                {expandAll ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
                <span>{expandAll ? "Collapse All" : "Expand All"}</span>
              </button>
            </div>
          </div>

          {/* Description */}
          <p className="lib-view-description !mb-0 text-xs md:text-[13px] text-text-2 leading-relaxed max-w-4xl line-clamp-2">
            {selectedApi.description}
          </p>
        </div>
      </header>

      {/* Method List Content */}
      <div className="lib-view-content" ref={contentRef}>
        <div className="lib-view-methods">
          {/* Quick Jump TOC */}
          {selectedApi.methods.length > 0 && (
            <div className="lib-toc">
              <span className="lib-toc-label">Jump to</span>
              <div className="lib-toc-list">
                {selectedApi.methods.map((method) => {
                  const isMatch = (q && (method.name.toLowerCase().includes(q) || method.description.toLowerCase().includes(q))) ||
                                  (methodFilter && method.name.toLowerCase().includes(methodFilter.toLowerCase()));
                  return (
                    <a
                      key={method.name}
                      className={cn("lib-toc-item", isMatch && "lib-toc-item-match")}
                      href={`#method-${method.name}`}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(`method-${method.name}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                    >
                      {method.name}()
                      {isMatch && <Sparkles size={10} className="text-yellow shrink-0 ml-0.5" />}
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          {/* Method Cards */}
          <div className="lib-method-list">
            {filteredMethods.length > 0 ? (
              filteredMethods.map((method, idx) => {
                const isMatch = q && (method.name.toLowerCase().includes(q) || method.description.toLowerCase().includes(q));
                return (
                  <MethodCard 
                    key={method.name} 
                    apiName={selectedApi.name}
                    method={method} 
                    index={idx} 
                    addToast={addToast} 
                    badgeColor={badge.color} 
                    isHighlighted={!!isMatch}
                    searchQuery={q || methodFilter}
                    forceExpanded={expandAll}
                    createFile={createFile}
                  />
                );
              })
            ) : (
              <div className="p-8 text-center bg-bg-1 border border-border-1 rounded-xl">
                <Search className="w-8 h-8 text-text-3 opacity-40 mx-auto mb-2" />
                <p className="text-sm font-semibold text-text-1">No methods match "{methodFilter}"</p>
                <p className="text-xs text-text-3 mt-1">Try another search term or clear the filter.</p>
                <button
                  className="mt-3 text-xs text-accent hover:underline font-medium"
                  onClick={() => setMethodFilter("")}
                >
                  Clear method filter
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <footer className="lib-view-footer px-8">
          <div className="lib-view-footer-source">Source: {libraryData.source}</div>
          <div className="lib-view-footer-updated">Documentation v{libraryData.version} · Updated {libraryData.last_updated}</div>
        </footer>
      </div>
    </div>
  );
}

/* ============================================================
   Method Card Component
   ============================================================ */

function MethodCard({ 
  apiName,
  method, 
  index, 
  addToast, 
  badgeColor, 
  isHighlighted, 
  searchQuery,
  forceExpanded,
  createFile,
}: {
  apiName: string;
  method: ServiceNowMethod;
  index: number;
  addToast: (toast: Omit<Toast, "id">) => void;
  badgeColor: string;
  isHighlighted?: boolean;
  searchQuery?: string;
  forceExpanded: boolean;
  createFile: (name: string, language: "javascript", content?: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const navigate = useNavigate();

  const isExpanded = userExpanded !== null ? userExpanded : forceExpanded;

  const handleCopy = () => {
    navigator.clipboard.writeText(method.example);
    setCopied(true);
    addToast({ message: `Copied ${method.name}() example to clipboard`, type: "success" });
    setTimeout(() => setCopied(false), 2000);
  };

  const handleTryInCompiler = () => {
    const filename = `${apiName.replace(/[^a-zA-Z0-9]/g, "")}_${method.name}.js`;
    createFile(filename, "javascript", method.example);
    addToast({ message: `Loaded ${method.name}() in Compiler`, type: "success" });
    navigate("/compiler");
  };

  const highlightText = (text: string, query: string | undefined) => {
    if (!query || !text) return text;
    try {
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const parts = text.split(new RegExp(`(${escapedQuery})`, "gi"));
      return parts.map((part, i) => 
        part.toLowerCase() === query.toLowerCase() 
          ? <mark key={i} className="lib-search-highlight">{part}</mark> 
          : part
      );
    } catch {
      return text;
    }
  };

  const lines = method.example.split("\n");

  return (
    <div
      id={`method-${method.name}`}
      className={cn("lib-method-card", isHighlighted && "lib-method-card-highlighted")}
      style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
    >
      {/* Card Header */}
      <div className="lib-method-header" onClick={() => setUserExpanded(!isExpanded)}>
        <div className="lib-method-header-left">
          <span className="lib-method-dot" style={{ background: badgeColor }} />
          <h3 className="lib-method-name">
            {highlightText(method.name, searchQuery)}
            <span className="lib-method-parens">
              ({method.parameters.map(p => p.split(" ")[0]).join(", ")})
            </span>
          </h3>
          {isHighlighted && <Sparkles size={13} className="text-yellow shrink-0 animate-pulse" />}
        </div>
        <ChevronDown className={cn("lib-method-chevron", !isExpanded && "lib-method-chevron-collapsed")} />
      </div>

      {isExpanded && (
        <div className="lib-method-body">
          {/* Description */}
          <p className="lib-method-desc">{highlightText(method.description, searchQuery)}</p>

          {/* Parameters */}
          {method.parameters.length > 0 && (
            <div className="lib-method-params">
              <span className="lib-method-params-label">Parameters</span>
              <div className="lib-method-params-list">
                {method.parameters.map((p, i) => {
                  const isOptional = p.toLowerCase().includes("optional");
                  return (
                    <span key={i} className={cn("lib-param-tag", isOptional && "lib-param-optional")}>
                      <span>{p.split(" ")[0]}</span>
                      {isOptional && <span className="lib-param-opt-label">optional</span>}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* macOS-style Code Block */}
          <div className="lib-code-block">
            <div className="lib-code-toolbar">
              <div className="flex items-center gap-2">
                <div className="lib-code-toolbar-dots">
                  <div className="lib-code-dot lib-code-dot-red" />
                  <div className="lib-code-dot lib-code-dot-yellow" />
                  <div className="lib-code-dot lib-code-dot-green" />
                </div>
                <span className="lib-code-lang">JavaScript</span>
              </div>

              <div className="lib-code-actions">
                <ActionTooltip content="Run and experiment with this snippet in Compiler">
                  <button
                    className="lib-code-action-btn lib-code-action-btn-compiler"
                    onClick={handleTryInCompiler}
                  >
                    <Play size={10} />
                    <span>Try in Compiler</span>
                  </button>
                </ActionTooltip>

                <ActionTooltip content={copied ? "Copied!" : "Copy snippet to clipboard"}>
                  <button
                    className="lib-code-action-btn"
                    onClick={handleCopy}
                  >
                    {copied ? (
                      <><Check size={10} className="text-green" /><span>Copied</span></>
                    ) : (
                      <><Copy size={10} /><span>Copy</span></>
                    )}
                  </button>
                </ActionTooltip>
              </div>
            </div>

            <pre className="lib-code-pre">
              <code>
                {lines.map((line, i) => (
                  <div key={i} className="lib-code-line">
                    <span className="lib-code-ln">{i + 1}</span>
                    <SyntaxLine line={line} />
                  </div>
                ))}
              </code>
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   WELCOME & DISCOVERY HUB (When no API is selected)
   ============================================================ */

function LibraryDiscoveryHub({ 
  onSelectApi,
  onSearch,
  addToast,
  createFile,
}: { 
  onSelectApi: (name: string) => void;
  onSearch: (query: string) => void;
  addToast: (toast: Omit<Toast, "id">) => void;
  createFile: (name: string, language: "javascript", content?: string) => void;
}) {
  const [localSearch, setLocalSearch] = useState("");
  const navigate = useNavigate();

  const handleHeroSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (localSearch.trim()) {
      onSearch(localSearch);
    }
  };

  const handleRunRecipe = (title: string, code: string) => {
    createFile(`${title.toLowerCase().replace(/[^a-z0-9]/g, "_")}.js`, "javascript", code);
    addToast({ message: `Opened "${title}" recipe in Compiler`, type: "success" });
    navigate("/compiler");
  };

  const handleCopyRecipe = (title: string, code: string) => {
    navigator.clipboard.writeText(code);
    addToast({ message: `Copied "${title}" recipe to clipboard`, type: "success" });
  };

  // 6 Essential APIs
  const essentialApis = [
    {
      name: "GlideRecord",
      type: "Server-side",
      desc: "Primary class for database operations. Provides object-oriented querying, record inserts, updates, and deletes without raw SQL.",
      methods: 48,
    },
    {
      name: "GlideSystem (gs)",
      type: "Server-side",
      desc: "Comprehensive system utility class for logging, session information, dates, events, security roles, and user context.",
      methods: 35,
    },
    {
      name: "GlideAggregate",
      type: "Server-side",
      desc: "Performant database aggregations (COUNT, SUM, MIN, MAX, AVG). Replaces slow GlideRecord iterating for counts.",
      methods: 8,
    },
    {
      name: "GlideAjax",
      type: "Client/Server Interaction",
      desc: "Standard client-side class for invoking server-side Script Includes asynchronously with XML/JSON response handling.",
      methods: 6,
    },
    {
      name: "g_form",
      type: "Client-side",
      desc: "Core client API for form interaction: retrieve/set values, display field messages, toggle visibility, and control UI actions.",
      methods: 42,
    },
    {
      name: "RESTMessageV2",
      type: "Server-side",
      desc: "Send outbound REST HTTP requests to external web services with endpoints, headers, query params, and JSON responses.",
      methods: 24,
    },
  ];

  // Common production snippets
  const recipes = [
    {
      title: "Asynchronous GlideAjax Call",
      desc: "Best-practice pattern to fetch server data without freezing the browser UI.",
      code: `// Client Script: Asynchronous GlideAjax
var ga = new GlideAjax('IncidentUtils');
ga.addParam('sysparm_name', 'getIncidentDetails');
ga.addParam('sysparm_sys_id', g_form.getUniqueValue());
ga.getXMLAnswer(function(response) {
  if (!response) return;
  var data = JSON.parse(response);
  if (data.assignedTo) {
    g_form.setValue('assigned_to', data.assignedTo);
    g_form.showFieldMsg('assigned_to', 'Assigned via auto-dispatch', 'info');
  }
});`,
    },
    {
      title: "Optimized GlideAggregate Count",
      desc: "Fast database count query grouped by category without loading records.",
      code: `// Server-side: High Performance Aggregation
var ga = new GlideAggregate('incident');
ga.addAggregate('COUNT', 'category');
ga.addEncodedQuery('active=true^priority<=2');
ga.groupBy('category');
ga.query();

while (ga.next()) {
  var category = ga.getValue('category') || 'Uncategorized';
  var count = ga.getAggregate('COUNT', 'category');
  gs.info(category + ': ' + count + ' open priority 1/2 incidents');
}`,
    },
    {
      title: "GlideRecord Encoded Query with Limit",
      desc: "Query high-priority incidents safely with sorting and hard limit safeguard.",
      code: `// Server-side: Encoded Query with Safeguards
var gr = new GlideRecord('incident');
gr.addEncodedQuery('active=true^assigned_toISEMPTY^priority=1');
gr.orderByDesc('sys_created_on');
gr.setLimit(50);
gr.query();

while (gr.next()) {
  gs.info('P1 Alert: ' + gr.number + ' - ' + gr.short_description);
}`,
    },
    {
      title: "g_form Dynamic Validation & Notice",
      desc: "Client-side validation and responsive field messages for user feedback.",
      code: `// Client Script: onChange Validation
function onChange(control, oldValue, newValue, isLoading) {
  if (isLoading || newValue === '') return;
  
  var shortDesc = g_form.getValue('short_description');
  if (shortDesc.length < 10) {
    g_form.showFieldMsg('short_description', 'Please provide at least 10 characters.', 'error');
  } else {
    g_form.hideFieldMsg('short_description', true);
  }
}`,
    },
  ];

  return (
    <div className="lib-hub-container">
      {/* Hero Banner */}
      <div className="lib-hub-hero">
        <div className="lib-hub-hero-glow" />
        <div className="relative z-10">
          <div className="lib-hub-hero-badge">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Developer Reference & Code Recipes</span>
          </div>

          <h1 className="lib-hub-hero-title">ServiceNow Developer Hub</h1>
          <p className="lib-hub-hero-desc">
            Explore 125+ verified ServiceNow APIs, 720+ method signatures, and production-tested snippets. 
            Test any script immediately in the local JavaScript compiler or copy straight into your workspace.
          </p>

          <form onSubmit={handleHeroSearch} className="lib-hub-hero-search">
            <Search className="w-4 h-4 lib-hub-hero-search-icon" />
            <input
              type="text"
              placeholder="Search APIs, methods (e.g. GlideRecord, addQuery, GlideAjax)..."
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
            />
          </form>
        </div>
      </div>

      {/* Category Overview Cards */}
      <div className="lib-hub-section">
        <div className="lib-hub-section-header">
          <h2 className="lib-hub-section-title">
            <Layers className="w-4 h-4 text-accent" />
            <span>API Categories</span>
          </h2>
          <span className="lib-hub-section-count">4 Domains · 125 Total APIs</span>
        </div>

        <div className="lib-cat-grid">
          <div 
            className="lib-cat-card"
            onClick={() => onSelectApi("GlideRecord")}
          >
            <div className="lib-cat-card-top">
              <div className="lib-cat-card-icon" style={{ background: "rgba(56, 189, 248, 0.12)", color: "var(--accent)" }}>
                <Server className="w-4 h-4" />
              </div>
              <span className="lib-cat-card-count">75 APIs</span>
            </div>
            <h3 className="lib-cat-card-title">Server-side APIs</h3>
            <p className="lib-cat-card-desc">
              Database operations, background scripts, business rules, script includes, and system utilities.
            </p>
            <div className="lib-cat-card-action text-accent">
              <span>Browse Server APIs</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>

          <div 
            className="lib-cat-card"
            onClick={() => onSelectApi("g_form")}
          >
            <div className="lib-cat-card-top">
              <div className="lib-cat-card-icon" style={{ background: "rgba(16, 185, 129, 0.12)", color: "var(--green)" }}>
                <Monitor className="w-4 h-4" />
              </div>
              <span className="lib-cat-card-count">17 APIs</span>
            </div>
            <h3 className="lib-cat-card-title">Client-side APIs</h3>
            <p className="lib-cat-card-desc">
              Client scripts, UI policies, form manipulation (g_form), user data (g_user), and dialog controls.
            </p>
            <div className="lib-cat-card-action text-green">
              <span>Browse Client APIs</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>

          <div 
            className="lib-cat-card"
            onClick={() => onSelectApi("GlideAjax")}
          >
            <div className="lib-cat-card-top">
              <div className="lib-cat-card-icon" style={{ background: "rgba(245, 158, 11, 0.12)", color: "var(--yellow)" }}>
                <ArrowLeftRight className="w-4 h-4" />
              </div>
              <span className="lib-cat-card-count">3 APIs</span>
            </div>
            <h3 className="lib-cat-card-title">Client ↔ Server</h3>
            <p className="lib-cat-card-desc">
              Asynchronous communication bridges between browser UI and server via GlideAjax and scratchpads.
            </p>
            <div className="lib-cat-card-action text-yellow">
              <span>Browse Ajax APIs</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>

          <div 
            className="lib-cat-card"
            onClick={() => onSelectApi("JSON")}
          >
            <div className="lib-cat-card-top">
              <div className="lib-cat-card-icon" style={{ background: "rgba(168, 85, 247, 0.12)", color: "var(--purple)" }}>
                <Wrench className="w-4 h-4" />
              </div>
              <span className="lib-cat-card-count">30 APIs</span>
            </div>
            <h3 className="lib-cat-card-title">Utilities & Helpers</h3>
            <p className="lib-cat-card-desc">
              JSON serialization, XML parsers, regular expressions, date math, and array manipulation.
            </p>
            <div className="lib-cat-card-action text-purple">
              <span>Browse Utilities</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>
        </div>
      </div>

      {/* Essential APIs Grid */}
      <div className="lib-hub-section">
        <div className="lib-hub-section-header">
          <h2 className="lib-hub-section-title">
            <Sparkles className="w-4 h-4 text-yellow" />
            <span>Essential APIs & Quick Start</span>
          </h2>
          <span className="lib-hub-section-count">Most Used Enterprise Classes</span>
        </div>

        <div className="lib-essentials-grid">
          {essentialApis.map((api) => {
            const badge = getTypeBadge(api.type);
            return (
              <div
                key={api.name}
                className="lib-essential-card"
                onClick={() => onSelectApi(api.name)}
              >
                <div className="lib-essential-header">
                  <span className="lib-essential-name">{api.name}</span>
                  <span
                    className="lib-view-type-badge"
                    style={{ 
                      color: badge.color, 
                      background: badge.bg, 
                      borderColor: `color-mix(in srgb, ${badge.color} 30%, transparent)` 
                    }}
                  >
                    {badge.icon}
                    {api.type}
                  </span>
                </div>
                <p className="lib-essential-desc">{api.desc}</p>
                <div className="lib-essential-footer">
                  <span>{api.methods} documented methods</span>
                  <span className="text-accent font-semibold flex items-center gap-1">
                    Open Docs <ChevronRight className="w-3 h-3" />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Production Recipes */}
      <div className="lib-hub-section">
        <div className="lib-hub-section-header">
          <h2 className="lib-hub-section-title">
            <Code2 className="w-4 h-4 text-accent" />
            <span>Production Code Recipes</span>
          </h2>
          <span className="lib-hub-section-count">Ready to copy or run in Compiler</span>
        </div>

        <div className="lib-recipes-grid">
          {recipes.map((recipe) => (
            <div key={recipe.title} className="lib-recipe-card">
              <div className="lib-recipe-header">
                <div>
                  <h3 className="lib-recipe-title">
                    <Code2 className="w-3.5 h-3.5 text-accent" />
                    <span>{recipe.title}</span>
                  </h3>
                  <p className="text-[11px] text-text-3 mt-0.5">{recipe.desc}</p>
                </div>
                <div className="lib-recipe-actions">
                  <ActionTooltip content="Run this recipe in Compiler">
                    <button
                      className="lib-recipe-btn text-accent border-accent/30 hover:bg-accent/15"
                      onClick={() => handleRunRecipe(recipe.title, recipe.code)}
                    >
                      <Play size={10} />
                      <span>Compiler</span>
                    </button>
                  </ActionTooltip>

                  <ActionTooltip content="Copy snippet to clipboard">
                    <button
                      className="lib-recipe-btn"
                      onClick={() => handleCopyRecipe(recipe.title, recipe.code)}
                    >
                      <Copy size={10} />
                      <span>Copy</span>
                    </button>
                  </ActionTooltip>
                </div>
              </div>
              <pre className="lib-recipe-pre">
                <code>{recipe.code}</code>
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   JavaScript Syntax Highlighter Line
   ============================================================ */

const JS_KEYWORDS = new Set([
  "var", "let", "const", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "new", "this", "typeof",
  "instanceof", "in", "of", "try", "catch", "finally", "throw", "class",
  "extends", "import", "export", "default", "from", "async", "await", "yield",
  "delete", "void", "with",
]);

const JS_LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

interface Token {
  type: "keyword" | "string" | "number" | "comment" | "function" | "method" | "operator" | "punctuation" | "literal" | "property" | "text";
  value: string;
}

function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const trimmed = line.trimStart();
  if (trimmed.startsWith("//")) {
    tokens.push({ type: "comment", value: line });
    return tokens;
  }

  while (i < line.length) {
    const ch = line[i] as string;

    if (ch === "/" && line[i + 1] === "/") {
      tokens.push({ type: "comment", value: line.slice(i) });
      break;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === "\\") j++;
        j++;
      }
      j++;
      tokens.push({ type: "string", value: line.slice(i, j) });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch) && (i === 0 || /[\s(,=!<>+\-*/:;[]/.test(line[i - 1] as string))) {
      let j = i;
      while (j < line.length && /[0-9._xXa-fA-F]/.test(line[j] as string)) j++;
      tokens.push({ type: "number", value: line.slice(i, j) });
      i = j;
      continue;
    }

    if (/[=!<>+\-*/%&|^~?:]/.test(ch)) {
      let j = i;
      while (j < line.length && /[=!<>+\-*/%&|^~?:]/.test(line[j] as string)) j++;
      tokens.push({ type: "operator", value: line.slice(i, j) });
      i = j;
      continue;
    }

    if (/[(){}[\];,.]/.test(ch)) {
      tokens.push({ type: "punctuation", value: ch });
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j] as string)) j++;
      tokens.push({ type: "text", value: line.slice(i, j) });
      i = j;
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j] as string)) j++;
      const word = line.slice(i, j);

      if (JS_KEYWORDS.has(word)) {
        tokens.push({ type: "keyword", value: word });
      } else if (JS_LITERALS.has(word)) {
        tokens.push({ type: "literal", value: word });
      } else {
        let lookAhead = j;
        while (lookAhead < line.length && line[lookAhead] === " ") lookAhead++;
        const isCall = lookAhead < line.length && line[lookAhead] === "(";

        const prevToken = tokens.length > 0 ? tokens[tokens.length - 1] : null;
        const isDotAccess = prevToken && prevToken.type === "punctuation" && prevToken.value === ".";

        if (isCall && isDotAccess) {
          tokens.push({ type: "method", value: word });
        } else if (isCall) {
          tokens.push({ type: "function", value: word });
        } else if (isDotAccess) {
          tokens.push({ type: "property", value: word });
        } else {
          tokens.push({ type: "text", value: word });
        }
      }
      i = j;
      continue;
    }

    tokens.push({ type: "text", value: ch });
    i++;
  }

  return tokens;
}

const TOKEN_CLASS_MAP: Record<Token["type"], string> = {
  keyword: "lib-syn-keyword",
  string: "lib-syn-string",
  number: "lib-syn-number",
  comment: "lib-syn-comment",
  function: "lib-syn-function",
  method: "lib-syn-method",
  operator: "lib-syn-operator",
  punctuation: "lib-syn-punctuation",
  literal: "lib-syn-literal",
  property: "lib-syn-property",
  text: "lib-syn-text",
};

const SyntaxLine = React.memo(function SyntaxLine({ line }: { line: string }) {
  const tokens = useMemo(() => tokenizeLine(line), [line]);

  return (
    <span className="lib-code-text">
      {tokens.map((token, i) => (
        <span key={i} className={TOKEN_CLASS_MAP[token.type]}>
          {token.value}
        </span>
      ))}
    </span>
  );
});

/* ============================================================
   EXCALIDRAW COMMUNITY GALLERY
   ============================================================ */

function ExcalidrawLibraryGallery({ 
  searchQuery, 
}: { 
  searchQuery: string; 
}) {
  const [libraries, setLibraries] = useState<ExcalidrawLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const activeCategory = useAppStore((s) => s.libraryExcalidrawCategory);
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();

  useEffect(() => {
    getExcalidrawLibraries().then((data) => {
      setLibraries(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const categoryLabel = useMemo(() => {
    const found = EXCALIDRAW_CATEGORIES.find((c) => c.id === activeCategory);
    return found?.label || "All Libraries";
  }, [activeCategory]);

  const filteredLibraries = useMemo(() => {
    return libraries.filter((lib) => {
      if (activeCategory !== "all") {
        const cat = EXCALIDRAW_CATEGORIES.find((c) => c.id === activeCategory);
        if (cat && "keywords" in cat && cat.keywords) {
          const keywords = cat.keywords as readonly string[];
          const matchCat = keywords.some((kw: string) =>
            lib.name.toLowerCase().includes(kw) || lib.description.toLowerCase().includes(kw)
          );
          if (!matchCat) return false;
        }
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchName = lib.name.toLowerCase().includes(q);
        const matchDesc = lib.description.toLowerCase().includes(q);
        const matchAuthor = lib.authors.some((a) => a.name.toLowerCase().includes(q));
        return matchName || matchDesc || matchAuthor;
      }

      return true;
    });
  }, [libraries, activeCategory, searchQuery]);

  const handleUseInDrawFlow = (lib: ExcalidrawLibraryItem) => {
    addToast({ message: `Importing "${lib.name}" into DrawFlow Studio...`, type: "success" });
    navigate(`/drawflows?importLib=${encodeURIComponent(lib.id)}`);
  };

  return (
    <div className="lib-excal-container">
      {/* Header Bar */}
      <div className="lib-excal-header">
        <div className="lib-excal-title-group">
          <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/25 flex items-center justify-center text-accent">
            <Boxes className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="lib-excal-title">{categoryLabel}</h2>
              <span className="lib-excal-count-badge">
                {filteredLibraries.length} collection{filteredLibraries.length !== 1 ? "s" : ""}
              </span>
            </div>
            <p className="text-xs text-text-3 mt-0.5">
              Ready-to-use shape libraries, architecture icons, and UI components for DrawFlow Studio
            </p>
          </div>
        </div>

        <div className="lib-excal-header-actions">
          <button 
            className="lib-excal-studio-btn"
            onClick={() => navigate("/drawflows")}
          >
            <span>Open DrawFlow Studio</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingState
          size="md"
          message="Loading Excalidraw libraries..."
          description="Fetching community component packs"
          minHeight={260}
        />
      ) : filteredLibraries.length === 0 ? (
        <div className="p-12 text-center bg-bg-1 border border-border-1 rounded-2xl flex flex-col items-center justify-center">
          <Boxes className="w-10 h-10 text-text-3 opacity-40 mb-3" />
          <h3 className="text-sm font-bold text-text-1">No collections match your criteria</h3>
          <p className="text-xs text-text-3 mt-1 max-w-sm">
            {searchQuery ? `No shape packs found for "${searchQuery}".` : "No items found in this collection category."}
          </p>
        </div>
      ) : (
        <div className="lib-excal-grid">
          {filteredLibraries.map((lib) => (
            <ExcalidrawCard 
              key={lib.id} 
              lib={lib} 
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ExcalidrawCard({ 
  lib, 
}: { 
  lib: ExcalidrawLibraryItem; 
}) {
  const [imgError, setImgError] = useState(false);
  const [triedCdn, setTriedCdn] = useState(false);
  const storeIds = useAppStore((s) => s.excalidrawAddedLibraryIds || []);
  const storeAdd = useAppStore((s) => s.addExcalidrawAddedLibraryId);
  const storeRemove = useAppStore((s) => s.removeExcalidrawAddedLibraryId);
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const isAdded = storeIds.includes(lib.id);

  const previewUrl = getExcalidrawLibraryPreviewUrl(lib.preview);
  const cdnPreviewUrl = getExcalidrawLibraryCdnPreviewUrl(lib.preview);

  const handleAdd = () => {
    storeAdd(lib.id);
    addToast({ message: `Added "${lib.name}" to DrawFlow Studio`, type: "success" });
    navigate(`/drawflows?importLib=${encodeURIComponent(lib.id)}`);
  };

  const handleRemove = () => {
    setLoading(true);
    storeRemove(lib.id);
    addToast({ message: `Removed "${lib.name}" from added libraries`, type: "success" });
    setLoading(false);
  };

  return (
    <div className="lib-excal-card">
      <div className="lib-excal-preview-wrap">
        {isAdded && (
          <div className="absolute top-2 right-2 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-green/15 border border-green/30 text-green text-[10px] font-semibold">
            <Check className="w-2.5 h-2.5" />
            Added
          </div>
        )}
        {!imgError ? (
          <img
            src={triedCdn ? cdnPreviewUrl : previewUrl}
            alt={lib.name}
            className="lib-excal-preview-img"
            loading="lazy"
            onError={() => {
              if (!triedCdn) {
                setTriedCdn(true);
              } else {
                setImgError(true);
              }
            }}
          />
        ) : (
          <div className="lib-excal-preview-fallback">
            <Boxes className="w-6 h-6 opacity-30" />
            <span>Preview unavailable</span>
          </div>
        )}
      </div>

      <div className="lib-excal-body">
        <h3 className="lib-excal-name" title={lib.name}>{lib.name}</h3>
        <p className="lib-excal-desc" title={lib.description}>{lib.description || "Collection of diagram elements and shapes."}</p>

        <div className="lib-excal-footer">
          <div className="lib-excal-meta">
            <span className="lib-excal-author" title={lib.authors[0]?.name || "Community"}>
              by {lib.authors[0]?.name || "Community"}
            </span>
            <span>v{lib.version || 1} · {lib.created || "2024"}</span>
          </div>

          <button
            className={`lib-excal-action-btn ${isAdded ? "lib-excal-action-btn-remove" : ""}`}
            onClick={isAdded ? handleRemove : handleAdd}
            disabled={loading}
            title={isAdded ? `Remove "${lib.name}"` : `Add "${lib.name}" to DrawFlow Studio`}
          >
            {loading ? (
              <><Loader2 className="w-3 h-3 animate-spin" /><span>Removing...</span></>
            ) : isAdded ? (
              <><Trash2 className="w-3 h-3" /><span>Remove</span></>
            ) : (
              <><Plus className="w-3 h-3" /><span>Add to DrawFlow</span></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
