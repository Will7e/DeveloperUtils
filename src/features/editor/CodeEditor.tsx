// ============================================================
// Code Editor — Monaco Editor wrapper
// ============================================================

import { useCallback, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useAppStore } from "@/stores/app.store";
import type { editor } from "monaco-editor";

export function CodeEditor() {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
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
      monaco.editor.defineTheme("codeforge-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
          { token: "comment", foreground: "6b7280", fontStyle: "italic" },
          { token: "keyword", foreground: "c084fc" },
          { token: "string", foreground: "34d399" },
          { token: "number", foreground: "f59e0b" },
          { token: "type", foreground: "60a5fa" },
          { token: "function", foreground: "818cf8" },
          { token: "variable", foreground: "e2e8f0" },
          { token: "operator", foreground: "94a3b8" },
        ],
        colors: {
          "editor.background": "#0a0a1a",
          "editor.foreground": "#e2e8f0",
          "editor.lineHighlightBackground": "#1e1b4b20",
          "editor.selectionBackground": "#6366f140",
          "editor.inactiveSelectionBackground": "#6366f120",
          "editorCursor.foreground": "#818cf8",
          "editorLineNumber.foreground": "#374151",
          "editorLineNumber.activeForeground": "#6366f1",
          "editor.selectionHighlightBackground": "#6366f115",
          "editorIndentGuide.background": "#1e293b",
          "editorIndentGuide.activeBackground": "#334155",
          "editorBracketMatch.background": "#6366f130",
          "editorBracketMatch.border": "#6366f150",
          "editorWidget.background": "#0f0f23",
          "editorWidget.border": "#1e293b",
          "editorSuggestWidget.background": "#0f0f23",
          "editorSuggestWidget.border": "#1e293b",
          "editorSuggestWidget.selectedBackground": "#1e1b4b",
          "editorHoverWidget.background": "#0f0f23",
          "editorHoverWidget.border": "#1e293b",
          "minimap.background": "#0a0a1a",
          "scrollbarSlider.background": "#6366f120",
          "scrollbarSlider.hoverBackground": "#6366f140",
          "scrollbarSlider.activeBackground": "#6366f160",
        },
      });

      monaco.editor.setTheme("codeforge-dark");

      // Focus editor
      editor.focus();
    },
    []
  );

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
          <div className="text-6xl opacity-20">⚡</div>
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
  };

  return (
    <div className="flex-1 relative">
      <Editor
        height="100%"
        language={languageMap[activeFile.language] || "plaintext"}
        value={activeFile.content}
        onChange={handleChange}
        onMount={handleEditorMount}
        theme="codeforge-dark"
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
