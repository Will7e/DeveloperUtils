import React, { useState, useEffect, useMemo } from "react";
import { JsonTreeView } from "./JsonTreeView";
import { XmlTreeView } from "./XmlTreeView";
import { formatXml, minifyXml, xmlToTreeData } from "./xmlUtils";
import { 
  FileJson, 
  FileCode,
  Copy, 
  Trash2, 
  Check, 
  AlertCircle,
  Minimize2,
  Maximize2,
  Code2,
  ChevronDown,
  Braces,
  Expand,
  Shrink,
  Plus,
  X,
  FileText
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import { useResizable } from "@/hooks/useResizable";
import { 
  Tooltip, 
  TooltipTrigger, 
  TooltipContent 
} from "@/components/ui/tooltip";

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

export function FormatterTool() {
  const type = useAppStore((s) => s.formatterType);
  const setType = useAppStore((s) => s.setFormatterType);
  const formatterFiles = useAppStore((s) => s.formatterFiles);
  const activeFileId = useAppStore((s) => s.activeFormatterFileId[type]);
  const setActiveFile = useAppStore((s) => s.setActiveFormatterFile);
  const createFile = useAppStore((s) => s.createFormatterFile);
  const deleteFile = useAppStore((s) => s.deleteFormatterFile);
  const updateContent = useAppStore((s) => s.updateFormatterFileContent);
  const renameFile = useAppStore((s) => s.renameFormatterFile);
  const addToast = useAppStore((s) => s.addToast);
  
  const [copied, setCopied] = useState(false);
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  // Split Resizing
  const { size: splitSize, containerRef, handleMouseDown, isDragging } = useResizable({
    direction: "horizontal",
    initialSize: 50,
    storageKey: "formatter-split-size",
    minSize: 20,
    maxSize: 80
  });

  const files = formatterFiles[type];
  const activeFile = files.find(f => f.id === activeFileId) || files[0]!;
  const currentInput = activeFile.content;

  // Derive data and error from current input
  const { data, error } = useMemo(() => {
    if (!currentInput.trim()) return { data: null, error: null };
    try {
      if (type === "json") {
        return { data: JSON.parse(currentInput), error: null };
      } else {
        return { data: xmlToTreeData(currentInput), error: null };
      }
    } catch (e: any) {
      return { data: null, error: e.message };
    }
  }, [currentInput, type]);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowTypeDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleCopy = () => {
    if (!currentInput) return;
    navigator.clipboard.writeText(currentInput);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    addToast({
      message: `${type.toUpperCase()} copied to clipboard`,
      type: "success"
    });
  };

  const handleMinify = () => {
    if (!currentInput || error) return;
    try {
      if (type === "json") {
        updateContent("json", activeFile.id, JSON.stringify(JSON.parse(currentInput)));
      } else {
        updateContent("xml", activeFile.id, minifyXml(currentInput));
      }
    } catch (e: any) {
      // Error handled by useMemo
    }
  };

  const handleFormat = () => {
    if (!currentInput || error) return;
    try {
      if (type === "json") {
        updateContent("json", activeFile.id, JSON.stringify(JSON.parse(currentInput), null, 2));
      } else {
        updateContent("xml", activeFile.id, formatXml(currentInput));
      }
    } catch (e: any) {
      // Error handled by useMemo
    }
  };

  const handleClear = () => {
    updateContent(type, activeFile.id, "");
  };

  const handleSample = () => {
    if (type === "json") {
      const sample = {
        id: "dev-utils-001",
        name: "Developer Utilities",
        version: "1.0.0",
        features: [
          { name: "Formatter", types: ["JSON", "XML"] },
          { name: "Compiler", status: "stable" }
        ],
        config: { theme: "obsidian", active: true }
      };
      updateContent("json", activeFile.id, JSON.stringify(sample, null, 2));
    } else {
      const sample = `<?xml version="1.0" encoding="UTF-8"?>
<root id="dev-utils-001">
  <name>Developer Utilities</name>
  <version>1.0.0</version>
  <features>
    <feature name="Formatter">
      <type>JSON</type>
      <type>XML</type>
    </feature>
    <feature name="Compiler" status="stable" />
  </features>
  <config theme="obsidian" active="true" />
</root>`;
      updateContent("xml", activeFile.id, sample);
    }
  };

  return (
    <div className="json-formatter-container">
      {/* Header / Toolbar */}
      <div className="json-formatter-toolbar">
        <div className="toolbar-left">
          {type === "json" ? (
            <FileJson className="h-4 w-4 text-accent" />
          ) : (
            <FileCode className="h-4 w-4 text-accent" />
          )}
          <h2 className="text-sm font-semibold">
            {type.toUpperCase()} Formatter
          </h2>
          
          <div className="toolbar-sep mx-2" />
          
          {/* Type Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <ActionTooltip content="Switch between JSON and XML" side="bottom">
              <button 
                className={cn(
                  "formatter-type-btn",
                  showTypeDropdown && "formatter-type-btn-active"
                )}
                onClick={() => setShowTypeDropdown(!showTypeDropdown)}
              >
                {type === "json" ? (
                  <Braces className="h-3.5 w-3.5 text-accent" />
                ) : (
                  <FileCode className="h-3.5 w-3.5 text-accent" />
                )}
                <span className="text-[11px] font-semibold uppercase tracking-wider">
                  {type}
                </span>
                <ChevronDown className={cn(
                  "h-3 w-3 transition-transform duration-200",
                  showTypeDropdown && "rotate-180"
                )} />
              </button>
            </ActionTooltip>

            {showTypeDropdown && (
              <div className="formatter-dropdown">
                <div className="formatter-dropdown-title">Select Format</div>
                <button 
                  className={cn("formatter-dropdown-item", type === "json" && "active")}
                  onClick={() => { 
                    setType("json"); 
                    setShowTypeDropdown(false);
                  }}
                >
                  <Braces className="h-4 w-4" />
                  <span>JSON Formatter</span>
                  {type === "json" && <div className="active-dot" />}
                </button>
                <button 
                  className={cn("formatter-dropdown-item", type === "xml" && "active")}
                  onClick={() => { 
                    setType("xml"); 
                    setShowTypeDropdown(false);
                  }}
                >
                  <FileCode className="h-4 w-4" />
                  <span>XML Formatter</span>
                  {type === "xml" && <div className="active-dot" />}
                </button>
              </div>
            )}
          </div>
        </div>
        
        <div className="toolbar-right">
          <ActionTooltip content={`Load sample ${type.toUpperCase()}`} side="bottom">
            <button 
              className="toolbar-btn" 
              onClick={handleSample}
            >
              Sample
            </button>
          </ActionTooltip>
          <div className="toolbar-sep" />
          <ActionTooltip content={`Prettify ${type.toUpperCase()}`} side="bottom">
            <button 
              className="toolbar-btn" 
              onClick={handleFormat}
              disabled={!currentInput || !!error}
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Format
            </button>
          </ActionTooltip>
          <ActionTooltip content={`Minify ${type.toUpperCase()}`} side="bottom">
            <button 
              className="toolbar-btn" 
              onClick={handleMinify}
              disabled={!currentInput || !!error}
            >
              <Minimize2 className="h-3.5 w-3.5" />
              Minify
            </button>
          </ActionTooltip>
          <ActionTooltip content="Copy to clipboard" side="bottom">
            <button 
              className="toolbar-btn" 
              onClick={handleCopy}
              disabled={!currentInput}
            >
              {copied ? <Check className="h-3.5 w-3.5 text-green" /> : <Copy className="h-3.5 w-3.5" />}
              Copy
            </button>
          </ActionTooltip>
          <ActionTooltip content="Clear current input" side="bottom">
            <button 
              className="toolbar-btn text-red hover:bg-red-dim" 
              onClick={handleClear}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          </ActionTooltip>
        </div>
      </div>

      <div 
        ref={containerRef}
        className={cn(
          "json-formatter-content",
          isPreviewFullscreen && "fullscreen-preview"
        )}
      >
        {/* Input Section */}
        {!isPreviewFullscreen && (
          <div 
            className="json-input-section"
            style={{ width: `${splitSize}%`, flex: "none" }}
          >
            <div className="tabs-bar">
              <div className="tabs-list">
                {files.map(file => (
                  <button 
                    key={file.id}
                    className={cn(
                      "tab",
                      activeFile.id === file.id && "tab-active"
                    )}
                    onClick={() => setActiveFile(type, file.id)}
                    onDoubleClick={() => {
                      setEditName(file.name);
                      setEditingFileId(file.id);
                    }}
                  >
                    <span className={cn("tab-icon", `tab-icon-${type}`)}>
                      {type === "json" ? "{}" : "<>"}
                    </span>
                    {editingFileId === file.id ? (
                      <input
                        autoFocus
                        className="tab-rename-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onBlur={() => {
                          if (editName.trim() && editName !== file.name) {
                            renameFile(type, file.id, editName.trim());
                          }
                          setEditingFileId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            setEditingFileId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="tab-name">
                        {file.name}
                      </span>
                    )}
                    <span 
                      className="tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteFile(type, file.id);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </span>
                  </button>
                ))}
                <button 
                  className="tab-new"
                  onClick={() => createFile(type)}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
            <textarea
              className="json-textarea"
              placeholder={`Paste your ${type.toUpperCase()} here...`}
              value={currentInput}
              onChange={(e) => updateContent(type, activeFile.id, e.target.value)}
              spellCheck={false}
            />
          </div>
        )}

        {/* Resize Handle */}
        {!isPreviewFullscreen && (
          <div 
            className="comparator-resize-handle-h"
            onMouseDown={handleMouseDown}
            data-resize-handle-state={isDragging ? "drag" : "idle"}
          >
            <div className="resize-handle-indicator" />
          </div>
        )}

        {/* Output Section */}
        <div 
          className="json-output-section"
          style={{ width: isPreviewFullscreen ? "100%" : `${100 - splitSize}%`, flex: isPreviewFullscreen ? 1 : "none" }}
        >
          <div className="section-header-row">
            <div className="section-label">Preview</div>
            <ActionTooltip content={isPreviewFullscreen ? "Exit Fullscreen" : "Fullscreen Preview"} side="left">
              <button 
                className="preview-fullscreen-btn"
                onClick={() => setIsPreviewFullscreen(!isPreviewFullscreen)}
              >
                {isPreviewFullscreen ? (
                  <Shrink className="h-3.5 w-3.5" />
                ) : (
                  <Expand className="h-3.5 w-3.5" />
                )}
              </button>
            </ActionTooltip>
          </div>
          
          <div className="json-tree-container">
            {error ? (
              <div className="json-error-state">
                <AlertCircle className="h-5 w-5 text-red" />
                <div className="json-error-message">
                  <div className="font-semibold mb-1">Invalid {type.toUpperCase()}</div>
                  <div className="text-xs opacity-70">{error}</div>
                </div>
              </div>
            ) : data ? (
              <div className="json-tree-scroll">
                {type === "json" ? (
                  <JsonTreeView data={data} />
                ) : (
                  <XmlTreeView data={data as any} />
                )}
              </div>
            ) : (
              <div className="json-empty-state">
                <Code2 className="h-10 w-10 opacity-10 mb-3" />
                <p>Paste {type.toUpperCase()} on the left to begin formatting</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
