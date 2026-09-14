// ============================================================
// Code Editor — Monaco Editor wrapper
// ============================================================

import { useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { FileCode2 } from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { formatCode, supportsFormatting } from "@/services/formatter.service";
import { setupMonacoTheme } from "@/utils/monaco-theme";
import type { editor } from "monaco-editor";

export function CodeEditor() {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const files = useAppStore((s) => s.files);
  const updateFileContent = useAppStore((s) => s.updateFileContent);
  const editorSettings = useAppStore((s) => s.editorSettings);

  const activeFile = files.find((f) => f.id === activeFileId);

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      // Setup custom themes and defaults
      setupMonacoTheme(monaco);

      // Set initial theme based on settings
      monaco.editor.setTheme(
        editorSettings.theme === "light" ? "devutils-light" : "devutils-dark"
      );

      // Focus editor
      editor.focus();

      // Add format document action
      editor.addAction({
        id: "format-code",
        label: "Format Document",
        keybindings: [
          // Shift + Alt + F (standard VS Code formatting shortcut)
          monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
        ],
        run: async (ed) => {
          const content = ed.getValue();
          const file = useAppStore.getState().files.find(
            (f) => f.id === useAppStore.getState().activeFileId
          );
          if (!file) return;

          if (supportsFormatting(file.language)) {
            const formatted = await formatCode(content, file.language);
            ed.setValue(formatted);
          } else {
            useAppStore.getState().addToast({
              message: `Formatting is not supported for ${file.language}`,
              type: "info",
              duration: 1500,
            });
          }
        },
      });

      // Add Cmd+S / Ctrl+S support for formatting
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
        const state = useAppStore.getState();
        const activeFile = state.files.find((f) => f.id === state.activeFileId);
        
        if (!activeFile) return;

        if (supportsFormatting(activeFile.language)) {
          try {
            const formatted = await formatCode(activeFile.content, activeFile.language);
            state.updateFileContent(activeFile.id, formatted);
            state.saveFile(activeFile.id);
            state.addToast({ 
              message: "Formatted & saved", 
              type: "success", 
              duration: 1500 
            });
          } catch (error) {
            console.error("Formatting failed:", error);
            state.addToast({ 
              message: "Saved (formatting error)", 
              type: "info", 
              duration: 1500 
            });
          }
        } else {
          state.addToast({ 
            message: "Saved", 
            type: "info", 
            duration: 1500 
          });
        }
      });
    },
    [editorSettings.theme]
  );

  // Dynamically switch Monaco theme when settings change
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(editorSettings.theme === "light" ? "devutils-light" : "devutils-dark");
    }
  }, [editorSettings.theme]);


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

  return (
    <div 
      className="flex-1 relative w-full h-full min-w-0 min-h-0" 
      ref={containerRef}
    >
      <Editor
        className="monaco-wrapper"
        height="100%"
        language={activeFile.language}
        value={activeFile.content}
        onChange={handleChange}
        onMount={handleEditorMount}
        theme={editorSettings.theme === "light" ? "devutils-light" : "devutils-dark"}
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
