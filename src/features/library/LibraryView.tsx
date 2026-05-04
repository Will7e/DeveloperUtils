import React, { useState, useMemo, useRef, useEffect } from "react";
import { Book, Copy, Check, Code2, Server, Monitor, ArrowLeftRight, FileCode2, ChevronDown, ExternalLink, Sparkles, Hash, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import libraryDataRaw from "../../servicenow_api_library.json";
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
  const addToast = useAppStore((s) => s.addToast);
  const contentRef = useRef<HTMLDivElement>(null);

  const selectedApi = libraryData.apis.find((api) => api.name === selectedId);

  // Scroll to top when API changes
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [selectedId]);

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
              {selectedApi.methods.map((method) => (
                <a
                  key={method.name}
                  className="lib-toc-item"
                  href={`#method-${method.name}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`method-${method.name}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  {method.name}()
                </a>
              ))}
            </div>
          </div>

          {/* Method Cards */}
          <div className="lib-method-list">
            {selectedApi.methods.map((method, idx) => (
              <MethodCard key={method.name} method={method} index={idx} addToast={addToast} badgeColor={badge.color} />
            ))}
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


function MethodCard({ method, index, addToast, badgeColor }: {
  method: ServiceNowMethod;
  index: number;
  addToast: any;
  badgeColor: string;
}) {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  const handleCopy = () => {
    navigator.clipboard.writeText(method.example);
    setCopied(true);
    addToast({ message: `Copied ${method.name}()`, type: "success" });
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = method.example.split('\n');

  return (
    <div
      id={`method-${method.name}`}
      className="lib-method-card"
      style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
    >
      {/* Card Header */}
      <div className="lib-method-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="lib-method-header-left">
          <span className="lib-method-dot" style={{ background: badgeColor }} />
          <h3 className="lib-method-name">
            {method.name}<span className="lib-method-parens">()</span>
          </h3>
        </div>
        <ChevronDown className={cn("lib-method-chevron", !isExpanded && "lib-method-chevron-collapsed")} />
      </div>

      {isExpanded && (
        <div className="lib-method-body">
          {/* Description */}
          <p className="lib-method-desc">{method.description}</p>

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
                    <span className={cn(
                      "lib-code-text",
                      line.trim().startsWith('//') && "lib-code-comment"
                    )}>
                      {line}
                    </span>
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
