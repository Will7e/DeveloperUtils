import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Book, Copy, Check, Code2, Server, Monitor, ArrowLeftRight, FileCode2, ChevronDown, ExternalLink, Sparkles, Hash, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import libraryDataRaw from "../../servicenow_api_library_scripts.json";
import { ServiceNowLibrary, ServiceNowAPI, ServiceNowMethod } from "@/types";

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
    <TooltipContent side={side} sideOffset={10}>
      <p>{content}</p>
    </TooltipContent>
  </Tooltip>
);

const TYPE_BADGE: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  "Server-side": {
    icon: <Server size={11} />,
    color: "var(--accent)",
    bg: "rgba(14,165,233,0.08)",
  },
  "Client-side": {
    icon: <Monitor size={11} />,
    color: "var(--green)",
    bg: "rgba(16,185,129,0.08)",
  },
  "Client/Server Interaction": {
    icon: <ArrowLeftRight size={11} />,
    color: "var(--yellow)",
    bg: "rgba(245,158,11,0.08)",
  },
  "Utils": {
    icon: <Wrench size={11} />,
    color: "var(--purple)",
    bg: "rgba(168,85,247,0.08)",
  },
};

function getTypeBadge(type: string) {
  return TYPE_BADGE[type] || {
    icon: <FileCode2 size={11} />,
    color: "var(--text-3)",
    bg: "rgba(255,255,255,0.04)",
  };
}

export function LibraryView() {
  const selectedId = useAppStore((s) => s.librarySelectedItemId);
  const searchQuery = useAppStore((s) => s.librarySearchQuery);
  const libraryTab = useAppStore((s) => s.libraryTab);
  const addToast = useAppStore((s) => s.addToast);
  const contentRef = useRef<HTMLDivElement>(null);

  const selectedApi = libraryData.apis.find((api) => api.name === selectedId);

  // Normalize query
  const q = useMemo(() => searchQuery.toLowerCase().trim().replace(/\(\)$/, ""), [searchQuery]);

  // Scroll to top when API changes
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [selectedId]);

  if (libraryTab === "excalidraw") {
    return <ExcalidrawLibraryGallery searchQuery={searchQuery} addToast={addToast} />;
  }

  if (!selectedApi) {
    return (
      <div className="lib-view-empty">
        <div className="lib-view-empty-glow" />
        <div className="lib-view-empty-content">
          <div className="lib-view-empty-icon-ring">
            <div className="lib-view-empty-icon-inner">
              <Book className="lib-view-empty-book" />
            </div>
          </div>
          <h2 className="lib-view-empty-title">API Reference</h2>
          <p className="lib-view-empty-desc">
            Select an API from the sidebar to explore detailed documentation, method signatures, and production-ready code snippets.
          </p>
          <div className="lib-view-empty-hints">
            <div className="lib-view-empty-hint">
              <kbd className="lib-kbd">/</kbd>
              <span>to search</span>
            </div>
            <div className="lib-view-empty-hint">
              <kbd className="lib-kbd">↑↓</kbd>
              <span>to navigate</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const badge = getTypeBadge(selectedApi.type);

  return (
    <div className="lib-view">
      {/* Sticky Header */}
      <header className="lib-view-header">
        <div className="lib-view-header-inner">
          <div className="lib-view-header-top">
            <div className="lib-view-header-meta">
              <h1 className="lib-view-api-name">{selectedApi.name}</h1>
              <span
                className="lib-view-type-badge"
                style={{ color: badge.color, background: badge.bg, borderColor: `color-mix(in srgb, ${badge.color} 20%, transparent)` }}
              >
                {badge.icon}
                {selectedApi.type}
              </span>
            </div>
            <div className="lib-view-header-stats">
              <div className="lib-view-stat">
                <Hash size={12} />
                <span>{selectedApi.methods.length} methods</span>
              </div>
              <div className="lib-view-stat lib-view-stat-verified">
                <Sparkles size={12} />
                <span>Verified</span>
              </div>
            </div>
          </div>
          <p className="lib-view-description">{selectedApi.description}</p>
        </div>
      </header>

      {/* Method List */}
      <div className="lib-view-content" ref={contentRef}>
        <div className="lib-view-methods">
          {/* Quick Jump TOC */}
          <div className="lib-toc">
            <span className="lib-toc-label">Jump to</span>
            <div className="lib-toc-list">
              {selectedApi.methods.map((method) => {
                const isMatch = q && (method.name.toLowerCase().includes(q) || method.description.toLowerCase().includes(q));
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
                    {isMatch && <Sparkles size={10} className="lib-match-sparkle" />}
                  </a>
                );
              })}
            </div>
          </div>

          {/* Method Cards */}
          <div className="lib-method-list">
            {selectedApi.methods.map((method, idx) => {
              const isMatch = q && (method.name.toLowerCase().includes(q) || method.description.toLowerCase().includes(q));
              return (
                <MethodCard 
                  key={method.name} 
                  method={method} 
                  index={idx} 
                  addToast={addToast} 
                  badgeColor={badge.color} 
                  isHighlighted={!!isMatch}
                  searchQuery={q}
                />
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <footer className="lib-view-footer">
          <div className="lib-view-footer-left">
            <span className="lib-view-footer-source">Source: {libraryData.source}</span>
          </div>
          <span className="lib-view-footer-updated">Updated {libraryData.last_updated}</span>
        </footer>
      </div>
    </div>
  );
}


function MethodCard({ method, index, addToast, badgeColor, isHighlighted, searchQuery }: {
  method: ServiceNowMethod;
  index: number;
  addToast: any;
  badgeColor: string;
  isHighlighted?: boolean;
  searchQuery?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  const handleCopy = () => {
    navigator.clipboard.writeText(method.example);
    setCopied(true);
    addToast({ message: `Copied ${method.name}()`, type: "success" });
    setTimeout(() => setCopied(false), 2000);
  };

  const highlightText = (text: string, query: string | undefined) => {
    if (!query || !text) return text;
    try {
      // Escape special regex characters
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const parts = text.split(new RegExp(`(${escapedQuery})`, 'gi'));
      return parts.map((part, i) => 
        part.toLowerCase() === query.toLowerCase() 
          ? <mark key={i} className="lib-text-highlight">{part}</mark> 
          : part
      );
    } catch (e) {
      return text;
    }
  };

  const lines = method.example.split('\n');

  return (
    <div
      id={`method-${method.name}`}
      className={cn("lib-method-card", isHighlighted && "lib-method-card-highlighted")}
      style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
    >
      {/* Card Header */}
      <div className="lib-method-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="lib-method-header-left">
          <span className="lib-method-dot" style={{ background: badgeColor }} />
          <h3 className="lib-method-name">
            {highlightText(method.name, searchQuery)}<span className="lib-method-parens">()</span>
          </h3>
          {isHighlighted && <Sparkles size={14} className="lib-highlight-sparkle" />}
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
                      {p.split(' ')[0]}
                      {isOptional && <span className="lib-param-opt-label">?</span>}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Code Block */}
          <div className="lib-code-block">
            <div className="lib-code-toolbar">
              <div className="lib-code-toolbar-left">
                <Code2 size={12} />
                <span>Example</span>
              </div>
              <ActionTooltip content={copied ? "Copied to clipboard" : "Copy example to clipboard"} side="left">
                <button
                  className={cn("lib-code-copy-btn", copied && "lib-code-copy-btn-copied")}
                  onClick={handleCopy}
                >
                  {copied ? (
                    <><Check size={12} /><span>Copied!</span></>
                  ) : (
                    <><Copy size={12} /><span>Copy</span></>
                  )}
                </button>
              </ActionTooltip>
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

/* ========================================
   JavaScript Syntax Highlighter
   ======================================== */

const JS_KEYWORDS = new Set([
  'var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'new', 'this', 'typeof',
  'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw', 'class',
  'extends', 'import', 'export', 'default', 'from', 'async', 'await', 'yield',
  'delete', 'void', 'with',
]);

const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

interface Token {
  type: 'keyword' | 'string' | 'number' | 'comment' | 'function' | 'method' | 'operator' | 'punctuation' | 'literal' | 'property' | 'text';
  value: string;
}

function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  // Check for full-line comment (with leading whitespace)
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//')) {
    tokens.push({ type: 'comment', value: line });
    return tokens;
  }

  while (i < line.length) {
    const ch = line[i] as string;
    const rest = line.slice(i);

    // Inline comment
    if (ch === '/' && line[i + 1] === '/') {
      tokens.push({ type: 'comment', value: line.slice(i) });
      break;
    }

    // Strings (single or double quoted)
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === '\\') j++; // skip escaped chars
        j++;
      }
      j++; // include closing quote
      tokens.push({ type: 'string', value: line.slice(i, j) });
      i = j;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) && (i === 0 || /[\s(,=!<>+\-*/:;\[]/.test(line[i - 1] as string))) {
      let j = i;
      while (j < line.length && /[0-9._xXa-fA-F]/.test(line[j] as string)) j++;
      tokens.push({ type: 'number', value: line.slice(i, j) });
      i = j;
      continue;
    }

    // Operators
    if (/[=!<>+\-*/%&|^~?:]/.test(ch)) {
      let j = i;
      while (j < line.length && /[=!<>+\-*/%&|^~?:]/.test(line[j] as string)) j++;
      tokens.push({ type: 'operator', value: line.slice(i, j) });
      i = j;
      continue;
    }

    // Punctuation
    if (/[(){}\[\];,.]/.test(ch)) {
      tokens.push({ type: 'punctuation', value: ch });
      i++;
      continue;
    }

    // Whitespace
    if (/\s/.test(ch)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j] as string)) j++;
      tokens.push({ type: 'text', value: line.slice(i, j) });
      i = j;
      continue;
    }

    // Words (identifiers, keywords)
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j] as string)) j++;
      const word = line.slice(i, j);

      // Determine type
      if (JS_KEYWORDS.has(word)) {
        tokens.push({ type: 'keyword', value: word });
      } else if (JS_LITERALS.has(word)) {
        tokens.push({ type: 'literal', value: word });
      } else {
        // Look ahead: is this a function/method call? (word followed by '(')
        let lookAhead = j;
        while (lookAhead < line.length && line[lookAhead] === ' ') lookAhead++;
        const isCall = lookAhead < line.length && line[lookAhead] === '(';

        // Look behind: is this accessed via '.'?
        const prevToken = tokens.length > 0 ? tokens[tokens.length - 1] : null;
        const isDotAccess = prevToken && prevToken.type === 'punctuation' && prevToken.value === '.';

        if (isCall && isDotAccess) {
          tokens.push({ type: 'method', value: word });
        } else if (isCall) {
          tokens.push({ type: 'function', value: word });
        } else if (isDotAccess) {
          tokens.push({ type: 'property', value: word });
        } else {
          tokens.push({ type: 'text', value: word });
        }
      }
      i = j;
      continue;
    }

    // Fallback
    tokens.push({ type: 'text', value: ch });
    i++;
  }

  return tokens;
}

const TOKEN_CLASS_MAP: Record<Token['type'], string> = {
  keyword: 'lib-syn-keyword',
  string: 'lib-syn-string',
  number: 'lib-syn-number',
  comment: 'lib-syn-comment',
  function: 'lib-syn-function',
  method: 'lib-syn-method',
  operator: 'lib-syn-operator',
  punctuation: 'lib-syn-punctuation',
  literal: 'lib-syn-literal',
  property: 'lib-syn-property',
  text: 'lib-syn-text',
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

import { useNavigate } from "react-router-dom";
import {
  getExcalidrawLibraries,
  getExcalidrawLibraryPreviewUrl,
  getExcalidrawLibraryCdnPreviewUrl,
  type ExcalidrawLibraryItem,
} from "@/utils/excalidrawLibrary";

function ExcalidrawLibraryGallery({ searchQuery, addToast }: { searchQuery: string; addToast: any }) {
  const [libraries, setLibraries] = useState<ExcalidrawLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState("all");
  const navigate = useNavigate();

  useEffect(() => {
    getExcalidrawLibraries().then((data) => {
      setLibraries(data);
      setLoading(false);
    });
  }, []);

  const categories = [
    { id: "all", label: "All Libraries" },
    { id: "system", label: "System Design", keywords: ["system", "architecture", "cloud", "aws", "gcp", "azure", "kubernetes", "docker", "snowflake"] },
    { id: "ui", label: "UI & Wireframes", keywords: ["ui", "wireframe", "mobile", "android", "ios", "gadget", "component", "design"] },
    { id: "icons", label: "Icons & Logos", keywords: ["icon", "logo", "brand", "dev", "tech"] },
    { id: "diagrams", label: "Flowcharts & Diagrams", keywords: ["flowchart", "diagram", "process", "map", "mindmap", "tree", "chart"] },
  ];

  const filteredLibraries = useMemo(() => {
    return libraries.filter((lib) => {
      if (activeCategory !== "all") {
        const cat = categories.find((c) => c.id === activeCategory);
        if (cat?.keywords) {
          const matchCat = cat.keywords.some((kw) =>
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

  return (
    <div className="flex-1 flex flex-col h-full bg-bg-0 overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-border/40 bg-bg-1/50 shrink-0">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <h1 className="text-xl font-bold text-text-0 flex items-center gap-2.5">
              Excalidraw Community Libraries
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-accent/15 text-accent font-semibold">
                {libraries.length} Libraries
              </span>
            </h1>
            <p className="text-xs text-text-2 mt-1">
              Explore 200+ offline community shape collections downloaded into your DeveloperUtils workspace.
            </p>
          </div>
          <button
            onClick={() => navigate("/drawflows")}
            className="px-3.5 py-1.5 rounded-lg bg-accent text-white text-xs font-medium flex items-center gap-1.5 shadow-sm hover:bg-accent/90 transition-colors"
          >
            <span>Open DrawFlow Studio</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto py-1">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`text-xs px-3 py-1 rounded-md transition-colors whitespace-nowrap ${
                activeCategory === cat.id
                  ? "bg-accent text-white font-medium shadow-sm"
                  : "bg-bg-2 text-text-2 hover:text-text-0 hover:bg-bg-3"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center text-text-2 gap-2">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-xs">Loading library catalog...</span>
          </div>
        ) : filteredLibraries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-text-3 py-12 gap-2">
            <p className="text-sm font-medium text-text-2">No libraries match your search</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredLibraries.map((lib) => {
              const previewUrl = getExcalidrawLibraryPreviewUrl(lib.preview);
              const cdnPreviewUrl = getExcalidrawLibraryCdnPreviewUrl(lib.preview);

              return (
                <div
                  key={lib.id}
                  className="group bg-bg-1 border border-border/40 hover:border-accent/40 rounded-xl p-3.5 flex flex-col justify-between transition-all hover:shadow-lg hover:bg-bg-1/90"
                >
                  <div>
                    <div className="w-full h-32 rounded-lg bg-bg-2/80 border border-border/30 overflow-hidden flex items-center justify-center mb-3 relative group-hover:bg-bg-2 transition-colors">
                      <img
                        src={previewUrl}
                        alt={lib.name}
                        className="max-h-full max-w-full object-contain p-2 filter dark:invert-[0.1]"
                        onError={(e) => {
                          const img = e.currentTarget;
                          if (img.src !== cdnPreviewUrl) {
                            img.src = cdnPreviewUrl;
                          } else {
                            img.style.display = "none";
                          }
                        }}
                      />
                    </div>

                    <h3 className="text-xs font-semibold text-text-0 line-clamp-1 group-hover:text-accent transition-colors">
                      {lib.name}
                    </h3>
                    <p className="text-[11px] text-text-2 line-clamp-2 my-1 min-h-[32px]">
                      {lib.description}
                    </p>

                    {lib.authors.length > 0 && (
                      <div className="text-[10px] text-text-3 mb-3 flex items-center gap-1">
                        <span>by</span>
                        <a
                          href={lib.authors[0]!.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-text-2 hover:text-accent underline flex items-center gap-0.5 truncate"
                        >
                          {lib.authors[0]!.name}
                        </a>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => {
                      navigate("/workflows");
                      addToast({ message: `Open /workflows and click "Libraries" to import "${lib.name}"`, type: "info" });
                    }}
                    className="w-full py-1.5 px-3 rounded-lg bg-bg-2 hover:bg-accent hover:text-white border border-border/40 text-text-0 text-xs font-medium flex items-center justify-center gap-1.5 transition-all"
                  >
                    <span>Use in Workflow</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
