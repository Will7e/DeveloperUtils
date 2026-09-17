import React, { useState, useEffect, useMemo, useCallback } from "react";
import { WorkspaceTabBar, type TabItem } from "@/components/ui/WorkspaceTabBar";
import Editor, { type OnMount } from "@monaco-editor/react";
import { JsonTreeView } from "./JsonTreeView";
import { XmlTreeView } from "./XmlTreeView";
import { formatXml, minifyXml, xmlToTreeData, type XmlTreeNode } from "./xmlUtils";
import { parseJsonRobust, formatJsonRobust, JsonFormatOptions } from "./jsonUtils";
import { setupMonacoTheme } from "@/utils/monaco-theme";
import { registerMonacoFormatShortcut } from "@/utils/monaco-format";
import { EditorLoadingFallback } from "@/components/ui/editor-loader";
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
  Minus,
  X,
  Settings2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import { 
  Panel, 
  Group as PanelGroup, 
  Separator as PanelResizeHandle 
} from "react-resizable-panels";
import { 
  Tooltip, 
  TooltipContent, 
  TooltipTrigger 
} from "@/components/ui/tooltip";

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

export function FormatterTool() {
  const type = useAppStore((s) => s.formatterType);
  const setType = useAppStore((s) => s.setFormatterType);
  const formatterFiles = useAppStore((s) => s.formatterFiles);
  const activeFileId = useAppStore((s) => s.activeFormatterFileId[type]);
  const setActiveFile = useAppStore((s) => s.setActiveFormatterFile);
  const createFile = useAppStore((s) => s.createFormatterFile);
  const deleteFile = useAppStore((s) => s.deleteFormatterFile);
  const duplicateFormatterFile = useAppStore((s) => s.duplicateFormatterFile);
  const closeOtherFormatterFiles = useAppStore((s) => s.closeOtherFormatterFiles);
  const closeFormatterFilesToRight = useAppStore((s) => s.closeFormatterFilesToRight);
  const closeAllFormatterFiles = useAppStore((s) => s.closeAllFormatterFiles);
  const updateContent = useAppStore((s) => s.updateFormatterFileContent);
  const renameFile = useAppStore((s) => s.renameFormatterFile);
  const reorderFiles = useAppStore((s) => s.reorderFormatterFiles);
  const addToast = useAppStore((s) => s.addToast);
  const currentThemeSetting = useAppStore((s) => s.editorSettings.theme);
  
  const [copied, setCopied] = useState(false);
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const handleFormatRef = React.useRef<(() => void) | null>(null);

  const formatterEditorRef = React.useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = React.useRef<Parameters<OnMount>[1] | null>(null);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    formatterEditorRef.current = editor;
    monacoRef.current = monaco;
    setupMonacoTheme(monaco);

    const initTheme = useAppStore.getState().editorSettings.theme;
    monaco.editor.setTheme(initTheme === "light" ? "devutils-light" : "devutils-dark");

    // Register Cmd+S / Ctrl+S and Shift+Alt+F format shortcut
    registerMonacoFormatShortcut(editor, monaco, {
      onFormat: () => {
        handleFormatRef.current?.();
      },
    });

    // Also support Ctrl+Enter or Cmd+Enter
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      handleFormatRef.current?.();
    });
  }, []);

  // Switch Monaco theme dynamically
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(currentThemeSetting === "light" ? "devutils-light" : "devutils-dark");
    }
  }, [currentThemeSetting]);

  const [jsonSettings, setJsonSettings] = useState<JsonFormatOptions>({
    tabSize: 2,
    sortKeys: false
  });
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = React.useRef<HTMLDivElement>(null);
  
  const [expandVersion, setExpandVersion] = useState(0);
  const [expandTarget, setExpandTarget] = useState(true);

  const files = formatterFiles[type] || formatterFiles.json;
  const activeFile = files.find(f => f.id === activeFileId) || files[0]!;
  const currentInput = activeFile.content;

  // Standardized Workspace Tabs
  const tabs: TabItem[] = useMemo(
    () =>
      files.map((file) => ({
        id: file.id,
        name: file.name,
        icon: (
          <span className={cn("tab-icon", `tab-icon-${type}`)}>
            {type === "json" ? "{}" : "<>"}
          </span>
        ),
        closable: files.length > 1,
      })),
    [files, type]
  );

  const handleCopyTabContent = useCallback(
    (id: string) => {
      const file = files.find((f) => f.id === id);
      if (file) {
        navigator.clipboard.writeText(file.content);
        addToast({ message: `Copied ${file.name} to clipboard`, type: "success", duration: 1500 });
      }
    },
    [files, addToast]
  );

  const handleCopyTabName = useCallback(
    (id: string) => {
      const file = files.find((f) => f.id === id);
      if (file) {
        navigator.clipboard.writeText(file.name);
        addToast({ message: "File name copied", type: "info", duration: 1500 });
      }
    },
    [files, addToast]
  );

  // Derive data and error from current input
  const { data, error } = useMemo(() => {
    if (!currentInput.trim()) return { data: null, error: null };
    try {
      if (type === "json") {
        return parseJsonRobust(currentInput);
      } else {
        return { data: xmlToTreeData(currentInput), error: null };
      }
    } catch (e: unknown) {
      return { data: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [currentInput, type]);

  // Close dropdowns on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowTypeDropdown(false);
      }
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setShowSettings(false);
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
        updateContent("json", activeFile.id, formatJsonRobust(currentInput, { tabSize: 0, sortKeys: jsonSettings.sortKeys }));
      } else {
        updateContent("xml", activeFile.id, minifyXml(currentInput));
      }
    } catch {
      // Error handled by useMemo
    }
  };

  const handleFormat = async () => {
    const input = formatterEditorRef.current?.getValue() ?? currentInput;
    if (!input.trim()) return;

    try {
      let formatted = "";
      if (type === "json") {
        formatted = formatJsonRobust(input, jsonSettings);
      } else {
        formatted = formatXml(input, " ".repeat(jsonSettings.tabSize));
      }
      updateContent(type, activeFile.id, formatted);
      if (formatterEditorRef.current && formatterEditorRef.current.getValue() !== formatted) {
        formatterEditorRef.current.setValue(formatted);
      }
      addToast({
        message: `${type.toUpperCase()} formatted successfully`,
        type: "success",
        duration: 2000
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast({
        message: `Formatting failed: ${msg}`,
        type: "error",
        duration: 2500
      });
    }
  };

  useEffect(() => {
    handleFormatRef.current = handleFormat;
  });

  // Listen for global format event when /formatters is active
  useEffect(() => {
    const handleExternalFormat = () => {
      handleFormatRef.current?.();
    };
    window.addEventListener("devutils:format-formatter", handleExternalFormat);
    return () => window.removeEventListener("devutils:format-formatter", handleExternalFormat);
  }, []);

  const handleClear = () => {
    updateContent(type, activeFile.id, "");
  };

  const handleExpandAll = () => {
    setExpandTarget(true);
    setExpandVersion(v => v + 1);
  };

  const handleCollapseAll = () => {
    setExpandTarget(false);
    setExpandVersion(v => v + 1);
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
          <div className="flex items-center gap-1.5">
            <ActionTooltip content={`Prettify ${type.toUpperCase()} (⌘S)`} side="bottom">
              <button 
                className="toolbar-btn" 
                onClick={handleFormat}
                disabled={!currentInput.trim()}
              >
                <Maximize2 className="h-3.5 w-3.5" />
                Format
              </button>
            </ActionTooltip>
            
            {type === "json" && (
              <div className="relative" ref={settingsRef}>
                <ActionTooltip content="Format Settings" side="bottom">
                  <button 
                    className={cn(
                      "toolbar-btn px-2 flex items-center justify-center transition-all",
                      showSettings ? "bg-bg-3 text-text-1 border-accent" : "text-text-3"
                    )}
                    onClick={() => setShowSettings(!showSettings)}
                    disabled={!currentInput || !!error}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                </ActionTooltip>
                
                {showSettings && (
                  <div className="formatter-settings-popover">
                    <div className="formatter-settings-header">
                      <Settings2 className="h-3.5 w-3.5 text-accent" />
                      <span>Format Settings</span>
                    </div>
                    
                    <div className="formatter-settings-body">
                      <div className="formatter-setting-row">
                        <div className="formatter-setting-label">
                          <span className="title">Tab Size</span>
                          <span className="desc">Indentation spaces</span>
                        </div>
                        <div className="formatter-setting-control relative">
                          <select 
                            className="formatter-setting-select"
                            value={jsonSettings.tabSize}
                            onChange={(e) => setJsonSettings({ ...jsonSettings, tabSize: parseInt(e.target.value) })}
                          >
                            <option value={2}>2 Spaces</option>
                            <option value={4}>4 Spaces</option>
                          </select>
                          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--text-3)] pointer-events-none" />
                        </div>
                      </div>
                      
                      <div className="formatter-setting-row">
                        <div className="formatter-setting-label">
                          <span className="title">Sort Keys</span>
                          <span className="desc">Alphabetical order</span>
                        </div>
                        <button 
                          className={cn(
                            "formatter-setting-toggle",
                            jsonSettings.sortKeys && "active"
                          )}
                          onClick={() => setJsonSettings({ ...jsonSettings, sortKeys: !jsonSettings.sortKeys })}
                        >
                          <div className="formatter-setting-toggle-knob" />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
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
        className={cn(
          "json-formatter-content",
          isPreviewFullscreen && "fullscreen-preview"
        )}
      >
        <PanelGroup orientation="horizontal" id="formatter-split-size">
          {/* Input Section */}
          {!isPreviewFullscreen && (
            <>
              <Panel defaultSize={50} minSize={20}>
                <div className="json-input-section h-full">
                  <WorkspaceTabBar
                    tabs={tabs}
                    activeTabId={activeFile.id}
                    onSelectTab={(id) => setActiveFile(type, id)}
                    onCloseTab={(id) => deleteFile(type, id)}
                    onNewTab={() => createFile(type)}
                    onRenameTab={(id, newName) => renameFile(type, id, newName)}
                    onReorderTabs={(_activeId, _overId, oldIndex, newIndex) =>
                      reorderFiles(type, oldIndex, newIndex)
                    }
                    onDuplicateTab={(id) => duplicateFormatterFile(type, id)}
                    onCloseOthers={(id) => closeOtherFormatterFiles(type, id)}
                    onCloseToRight={(id) => closeFormatterFilesToRight(type, id)}
                    onCloseAll={() => closeAllFormatterFiles(type)}
                    onCopyContent={handleCopyTabContent}
                    onCopyName={handleCopyTabName}
                    newTabTooltip={`New ${type.toUpperCase()} File`}
                  />
                  <div className="flex-1 w-full relative">
                    <Editor
                      className="monaco-wrapper"
                      height="100%"
                      language={type}
                      value={currentInput}
                      onChange={(value) => updateContent(type, activeFile.id, value || "")}
                      onMount={handleEditorMount}
                      theme={currentThemeSetting === "light" ? "devutils-light" : "devutils-dark"}
                      options={{
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        wordWrap: "on",
                        padding: { top: 16, bottom: 16 },
                        formatOnPaste: true,
                        formatOnType: true,
                        folding: true,
                        renderValidationDecorations: "on",
                        bracketPairColorization: { enabled: true },
                        fontSize: 13,
                        fontFamily: "var(--font-mono)",
                        lineNumbers: "on",
                        renderLineHighlight: "all",
                        scrollbar: {
                          useShadows: false,
                          verticalScrollbarSize: 10,
                          horizontalScrollbarSize: 10,
                        }
                      }}
                      loading={<EditorLoadingFallback message="Loading advanced editor..." />}
                    />
                  </div>
                </div>
              </Panel>

              {/* Resize Handle */}
              <PanelResizeHandle className="comparator-resize-handle-h" />
            </>
          )}

          {/* Output Section */}
          <Panel defaultSize={50} minSize={20}>
            <div className="json-output-section h-full">
              <div className="section-header-row">
            <div className="section-label flex items-center">
              Preview
            </div>
            
            <div className="flex items-center gap-2">
              {type === "json" && !error && Boolean(data) && (
                <div className="flex items-center bg-[var(--bg-1)] border border-[var(--border-1)] rounded-[6px] p-0.5 shadow-sm">
                  <ActionTooltip content="Expand All" side="top">
                    <button className="preview-action-btn" onClick={handleExpandAll}>
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </ActionTooltip>
                  <div className="w-[1px] h-3.5 bg-[var(--border-2)] mx-0.5" />
                  <ActionTooltip content="Collapse All" side="top">
                    <button className="preview-action-btn" onClick={handleCollapseAll}>
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                  </ActionTooltip>
                </div>
              )}

              <div className="w-[1px] h-4 bg-[var(--border-1)] mx-1" />

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
                  <JsonTreeView 
                    data={data} 
                    expandVersion={expandVersion} 
                    expandTarget={expandTarget} 
                  />
                ) : (
                  <XmlTreeView data={data as XmlTreeNode | string} />
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
      </Panel>
    </PanelGroup>
  </div>
</div>
  );
}
