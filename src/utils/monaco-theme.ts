import { Monaco } from "@monaco-editor/react";

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
      { token: "comment", foreground: "5c6378", fontStyle: "italic" },
      { token: "keyword", foreground: "c084fc" },
      { token: "string", foreground: "22c55e" },
      { token: "number", foreground: "eab308" },
      { token: "type", foreground: "3b82f6" },
      { token: "function", foreground: "a5b4fc" },
      { token: "variable", foreground: "e8eaed" },
      { token: "operator", foreground: "9aa0b4" },
      { token: "regexp", foreground: "f97316" },
      { token: "identifier", foreground: "e8eaed" },
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

  // Set custom light theme
  monaco.editor.defineTheme("devutils-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "94a3b8", fontStyle: "italic" },
      { token: "keyword", foreground: "7c3aed" },
      { token: "string", foreground: "059669" },
      { token: "number", foreground: "d97706" },
      { token: "type", foreground: "2563eb" },
      { token: "function", foreground: "4f46e5" },
      { token: "variable", foreground: "1e293b" },
      { token: "operator", foreground: "64748b" },
      { token: "regexp", foreground: "ea580c" },
      { token: "identifier", foreground: "1e293b" },
    ],
    colors: {
      "editor.background": "#f8fafc",
      "editor.foreground": "#1e293b",
      "editor.lineHighlightBackground": "#0000000a",
      "editor.selectionBackground": "#0284c730",
      "editor.inactiveSelectionBackground": "#0284c715",
      "editorCursor.foreground": "#0284c7",
      "editorLineNumber.foreground": "#cbd5e1",
      "editorLineNumber.activeForeground": "#0284c7",
      "editor.selectionHighlightBackground": "#0284c712",
      "editorIndentGuide.background": "#e2e8f0",
      "editorIndentGuide.activeBackground": "#94a3b8",
      "editorBracketMatch.background": "#0284c720",
      "editorBracketMatch.border": "#0284c740",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#e2e8f0",
      "editorSuggestWidget.background": "#ffffff",
      "editorSuggestWidget.border": "#e2e8f0",
      "editorSuggestWidget.selectedBackground": "#f1f5f9",
      "editorHoverWidget.background": "#ffffff",
      "editorHoverWidget.border": "#e2e8f0",
      "minimap.background": "#f8fafc",
      "scrollbarSlider.background": "#0000000a",
      "scrollbarSlider.hoverBackground": "#00000014",
      "scrollbarSlider.activeBackground": "#00000020",
    },
  });
}
