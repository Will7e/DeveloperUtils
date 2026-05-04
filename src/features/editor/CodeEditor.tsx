// ============================================================
// Code Editor — Monaco Editor wrapper
// ============================================================

import { useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { FileCode2 } from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import type { editor } from "monaco-editor";

export function CodeEditor() {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const files = useAppStore((s) => s.files);
  const updateFileContent = useAppStore((s) => s.updateFileContent);
  const editorSettings = useAppStore((s) => s.editorSettings);

  const activeFile = files.find((f) => f.id === activeFileId);

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Configure TypeScript/JavaScript defaults
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });

      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2020,
        allowNonTsExtensions: true,
        moduleResolution:
          monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        noEmit: true,
        strict: true,
      });

      // Set custom theme
      monaco.editor.defineTheme("devutils-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
          { token: "comment", foreground: "5c6378", fontStyle: "italic" },
          { token: "keyword", foreground: "c084fc" },
          { token: "string", foreground: "22c55e" },
          { token: "number", foreground: "eab308" },
          { token: "type", foreground: "3b82f6" },
          { token: "function", foreground: "a5b4fc" },
          { token: "variable", foreground: "e8eaed" },
          { token: "operator", foreground: "9aa0b4" },
          { token: "regexp", foreground: "f97316" },
        ],
        colors: {
          "editor.background": "#0c0e14",
          "editor.foreground": "#e8eaed",
          "editor.lineHighlightBackground": "#ffffff05",
          "editor.selectionBackground": "#0ea5e935",
          "editor.inactiveSelectionBackground": "#0ea5e915",
          "editorCursor.foreground": "#0ea5e9",
          "editorLineNumber.foreground": "#2a2f42",
          "editorLineNumber.activeForeground": "#0ea5e9",
          "editor.selectionHighlightBackground": "#0ea5e910",
          "editorIndentGuide.background": "#1a1e2e",
          "editorIndentGuide.activeBackground": "#ffffff20",
          "editorBracketMatch.background": "#0ea5e925",
          "editorBracketMatch.border": "#0ea5e940",
          "editorWidget.background": "#12141d",
          "editorWidget.border": "#1e2235",
          "editorSuggestWidget.background": "#12141d",
          "editorSuggestWidget.border": "#1e2235",
          "editorSuggestWidget.selectedBackground": "#1e2235",
          "editorHoverWidget.background": "#12141d",
          "editorHoverWidget.border": "#1e2235",
          "minimap.background": "#0c0e14",
          "scrollbarSlider.background": "#ffffff08",
          "scrollbarSlider.hoverBackground": "#ffffff14",
          "scrollbarSlider.activeBackground": "#ffffff20",
        },
      });

      monaco.editor.setTheme("devutils-dark");

      // Focus editor
      editor.focus();
    },
    []
  );

  // Manually trigger layout on container resize with explicit dimensions
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && editorRef.current) {
        const { width, height } = entry.contentRect;
        editorRef.current.layout({ width, height });
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (activeFileId && value !== undefined) {
        updateFileContent(activeFileId, value);
      }
    },
    [activeFileId, updateFileContent]
  );

  if (!activeFile) {
    return (
      <div className="flex-1 flex items-center justify-center bg-editor">
        <div className="text-center space-y-4">
          <FileCode2 className="empty-editor-icon" />
          <p className="text-muted-foreground text-lg">
            No file open. Create a new file to get started.
          </p>
        </div>
      </div>
    );
  }

  // Get Monaco language mapping
  const languageMap: Record<string, string> = {
    javascript: "javascript",
    typescript: "typescript",
    python: "python",
    html: "html",
    json: "json",
  };

  return (
    <div 
      className="flex-1 relative w-full h-full min-w-0 min-h-0" 
      ref={containerRef}
    >
      <Editor
        height="100%"
        language={languageMap[activeFile.language] || "plaintext"}
        value={activeFile.content}
        onChange={handleChange}
        onMount={handleEditorMount}
        theme="devutils-dark"
        options={{
          fontSize: editorSettings.fontSize,
          fontFamily: editorSettings.fontFamily,
          tabSize: editorSettings.tabSize,
          wordWrap: editorSettings.wordWrap,
          minimap: { enabled: editorSettings.minimap },
          lineNumbers: editorSettings.lineNumbers,
          cursorStyle: editorSettings.cursorStyle,
          bracketPairColorization: {
            enabled: editorSettings.bracketPairColorization,
          },
          formatOnPaste: editorSettings.formatOnPaste,
          formatOnType: editorSettings.formatOnType,
          smoothScrolling: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          renderLineHighlight: "all",
          renderWhitespace: "selection",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          padding: { top: 16, bottom: 16 },
          suggest: {
            showMethods: true,
            showFunctions: true,
            showConstructors: true,
            showFields: true,
            showVariables: true,
            showClasses: true,
            showStructs: true,
            showInterfaces: true,
            showModules: true,
            showProperties: true,
            showEvents: true,
            showOperators: true,
            showUnits: true,
            showValues: true,
            showConstants: true,
            showEnums: true,
            showEnumMembers: true,
            showKeywords: true,
            showWords: true,
            showColors: true,
            showFiles: true,
            showReferences: true,
          },
        }}
        loading={
          <div className="flex-1 flex items-center justify-center bg-editor">
            <div className="flex items-center gap-3">
              <div className="loading-spinner" />
              <span className="text-muted-foreground text-sm">
                Loading editor...
              </span>
            </div>
          </div>
        }
      />
    </div>
  );
}
