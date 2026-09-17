import { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { registerMonacoFormatShortcut } from "./monaco-format";

export function setupMonacoTheme(monaco: Monaco) {
  // Configure TypeScript/JavaScript defaults
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });

  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    noEmit: true,
    strict: true,
  });

  // Set custom dark theme
  monaco.editor.defineTheme("devutils-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "9ca3af", fontStyle: "italic" },
      { token: "keyword", foreground: "c084fc" },
      { token: "string", foreground: "34d399" },
      { token: "number", foreground: "fbbf24" },
      { token: "type", foreground: "60a5fa" },
      { token: "function", foreground: "a5b4fc" },
      { token: "variable", foreground: "f9fafb" },
      { token: "operator", foreground: "cbd5e1" },
      { token: "regexp", foreground: "fb923c" },
      { token: "identifier", foreground: "f9fafb" },
    ],
    colors: {
      "editor.background": "#111827",
      "editor.foreground": "#f9fafb",
      "editor.lineHighlightBackground": "#ffffff07",
      "editor.selectionBackground": "#38bdf835",
      "editor.inactiveSelectionBackground": "#38bdf818",
      "editorCursor.foreground": "#38bdf8",
      "editorLineNumber.foreground": "#6b7280",
      "editorLineNumber.activeForeground": "#38bdf8",
      "editor.selectionHighlightBackground": "#38bdf815",
      "editorIndentGuide.background": "#1f2937",
      "editorIndentGuide.activeBackground": "#4b5563",
      "editorBracketMatch.background": "#38bdf825",
      "editorBracketMatch.border": "#38bdf850",
      "editorWidget.background": "#111827",
      "editorWidget.border": "#374151",
      "editorSuggestWidget.background": "#111827",
      "editorSuggestWidget.border": "#374151",
      "editorSuggestWidget.selectedBackground": "#1f2937",
      "editorHoverWidget.background": "#111827",
      "editorHoverWidget.border": "#374151",
      "editorGutter.background": "#111827",
      "minimap.background": "#111827",
      "scrollbarSlider.background": "#ffffff0a",
      "scrollbarSlider.hoverBackground": "#ffffff18",
      "scrollbarSlider.activeBackground": "#ffffff28",
      "diffEditor.insertedTextBackground": "#10b98135",
      "diffEditor.removedTextBackground": "#f43f5e35",
      "diffEditor.insertedLineBackground": "#10b98118",
      "diffEditor.removedLineBackground": "#f43f5e18",
    },
  });

  // Set custom light theme
  monaco.editor.defineTheme("devutils-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "64748b", fontStyle: "italic" },
      { token: "keyword", foreground: "7c3aed" },
      { token: "string", foreground: "059669" },
      { token: "number", foreground: "d97706" },
      { token: "type", foreground: "2563eb" },
      { token: "function", foreground: "4f46e5" },
      { token: "variable", foreground: "0f172a" },
      { token: "operator", foreground: "475569" },
      { token: "regexp", foreground: "ea580c" },
      { token: "identifier", foreground: "0f172a" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#0f172a",
      "editor.lineHighlightBackground": "#00000006",
      "editor.selectionBackground": "#0284c730",
      "editor.inactiveSelectionBackground": "#0284c715",
      "editorCursor.foreground": "#0284c7",
      "editorLineNumber.foreground": "#64748b",
      "editorLineNumber.activeForeground": "#0284c7",
      "editor.selectionHighlightBackground": "#0284c715",
      "editorIndentGuide.background": "#e2e8f0",
      "editorIndentGuide.activeBackground": "#94a3b8",
      "editorBracketMatch.background": "#0284c720",
      "editorBracketMatch.border": "#0284c745",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#cbd5e1",
      "editorSuggestWidget.background": "#ffffff",
      "editorSuggestWidget.border": "#cbd5e1",
      "editorSuggestWidget.selectedBackground": "#f1f5f9",
      "editorHoverWidget.background": "#ffffff",
      "editorHoverWidget.border": "#cbd5e1",
      "editorGutter.background": "#ffffff",
      "minimap.background": "#ffffff",
      "scrollbarSlider.background": "#00000010",
      "scrollbarSlider.hoverBackground": "#0000001f",
      "scrollbarSlider.activeBackground": "#0000002e",
      "diffEditor.insertedTextBackground": "#05966930",
      "diffEditor.removedTextBackground": "#dc262628",
      "diffEditor.insertedLineBackground": "#05966912",
      "diffEditor.removedLineBackground": "#dc262610",
    },
  });

  // Automatically register Cmd+S / Ctrl+S and Shift+Alt+F formatting for every created editor
  const monacoAny = monaco as unknown as { __devutilsFormatListenerAttached?: boolean };
  if (!monacoAny.__devutilsFormatListenerAttached) {
    monacoAny.__devutilsFormatListenerAttached = true;
    monaco.editor.onDidCreateEditor((codeEditor: editor.ICodeEditor) => {
      registerMonacoFormatShortcut(codeEditor as editor.IStandaloneCodeEditor, monaco);
    });
  }
}

