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

  // Set custom dark theme (InTab - Vercel Geist Dark)
  const darkThemeConfig: editor.IStandaloneThemeData = {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "707070", fontStyle: "italic" },
      { token: "keyword", foreground: "ff6166" },
      { token: "string", foreground: "46a758" },
      { token: "number", foreground: "f5a623" },
      { token: "type", foreground: "3291ff" },
      { token: "function", foreground: "be7bff" },
      { token: "variable", foreground: "ededed" },
      { token: "operator", foreground: "a1a1a1" },
      { token: "regexp", foreground: "f5a623" },
      { token: "identifier", foreground: "ededed" },
      { token: "delimiter", foreground: "707070" },
    ],
    colors: {
      "editor.background": "#000000",
      "editor.foreground": "#ededed",
      "editor.lineHighlightBackground": "#ffffff0a",
      "editor.selectionBackground": "#0070f333",
      "editor.inactiveSelectionBackground": "#0070f318",
      "editorCursor.foreground": "#0070f3",
      "editorLineNumber.foreground": "#555555",
      "editorLineNumber.activeForeground": "#ffffff",
      "editor.selectionHighlightBackground": "#0070f320",
      "editorIndentGuide.background": "#1c1c1c",
      "editorIndentGuide.activeBackground": "#333333",
      "editorBracketMatch.background": "#0070f325",
      "editorBracketMatch.border": "#0070f360",
      "editorWidget.background": "#0a0a0a",
      "editorWidget.border": "#242424",
      "editorSuggestWidget.background": "#0a0a0a",
      "editorSuggestWidget.border": "#242424",
      "editorSuggestWidget.selectedBackground": "#171717",
      "editorHoverWidget.background": "#0a0a0a",
      "editorHoverWidget.border": "#242424",
      "editorGutter.background": "#000000",
      "minimap.background": "#000000",
      "scrollbarSlider.background": "#ffffff0a",
      "scrollbarSlider.hoverBackground": "#ffffff18",
      "scrollbarSlider.activeBackground": "#ffffff28",
      "diffEditor.insertedTextBackground": "#46a75826",
      "diffEditor.removedTextBackground": "#ff616626",
      "diffEditor.insertedLineBackground": "#46a75812",
      "diffEditor.removedLineBackground": "#ff616612",
    },
  };
  monaco.editor.defineTheme("intab-dark", darkThemeConfig);

  // Set custom light theme (InTab - Vercel Geist Light)
  const lightThemeConfig: editor.IStandaloneThemeData = {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "888888", fontStyle: "italic" },
      { token: "keyword", foreground: "db2777" },
      { token: "string", foreground: "218358" },
      { token: "number", foreground: "d97706" },
      { token: "type", foreground: "0070f3" },
      { token: "function", foreground: "6520aa" },
      { token: "variable", foreground: "171717" },
      { token: "operator", foreground: "666666" },
      { token: "regexp", foreground: "ea580c" },
      { token: "identifier", foreground: "171717" },
      { token: "delimiter", foreground: "888888" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#171717",
      "editor.lineHighlightBackground": "#00000006",
      "editor.selectionBackground": "#0070f326",
      "editor.inactiveSelectionBackground": "#0070f314",
      "editorCursor.foreground": "#0070f3",
      "editorLineNumber.foreground": "#a1a1a1",
      "editorLineNumber.activeForeground": "#171717",
      "editor.selectionHighlightBackground": "#0070f314",
      "editorIndentGuide.background": "#f0f0f0",
      "editorIndentGuide.activeBackground": "#d4d4d4",
      "editorBracketMatch.background": "#0070f31a",
      "editorBracketMatch.border": "#0070f340",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#eaeaea",
      "editorSuggestWidget.background": "#ffffff",
      "editorSuggestWidget.border": "#eaeaea",
      "editorSuggestWidget.selectedBackground": "#f5f5f5",
      "editorHoverWidget.background": "#ffffff",
      "editorHoverWidget.border": "#eaeaea",
      "editorGutter.background": "#ffffff",
      "minimap.background": "#ffffff",
      "scrollbarSlider.background": "#00000010",
      "scrollbarSlider.hoverBackground": "#00000018",
      "scrollbarSlider.activeBackground": "#00000024",
      "diffEditor.insertedTextBackground": "#21835820",
      "diffEditor.removedTextBackground": "#cd2b3120",
      "diffEditor.insertedLineBackground": "#21835810",
      "diffEditor.removedLineBackground": "#cd2b310c",
    },
  };
  monaco.editor.defineTheme("intab-light", lightThemeConfig);

  // Register custom .env (dotenv) language if not already present
  const registeredLanguages = monaco.languages.getLanguages();
  if (!registeredLanguages.some((l: { id: string }) => l.id === "dotenv")) {
    monaco.languages.register({ id: "dotenv" });
    monaco.languages.setMonarchTokensProvider("dotenv", {
      defaultToken: "",
      tokenPostfix: ".env",
      tokenizer: {
        root: [
          // Comments starting with #
          [/^\s*#.*$/, "comment"],
          // Key = Value
          [/^\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*(=)/, ["type", "operator"]],
          // Strings with quotes
          [/"([^"\\]|\\.)*"/, "string"],
          [/'([^'\\]|\\.)*'/, "string"],
          // URLs
          [/https?:\/\/[^\s]+/, "string"],
          // Booleans & Null
          [/\b(true|false|null|undefined)\b/i, "keyword"],
          // Numbers
          [/\b\d+(\.\d+)?\b/, "number"],
          // Trailing comments
          [/\s+#.*$/, "comment"],
        ],
      },
    });
  }

  // Register custom List Comparator language for item highlighting
  if (!registeredLanguages.some((l: { id: string }) => l.id === "list-comparator")) {
    monaco.languages.register({ id: "list-comparator" });
    monaco.languages.setMonarchTokensProvider("list-comparator", {
      defaultToken: "",
      tokenPostfix: ".list",
      tokenizer: {
        root: [
          // Comments
          [/^\s*(#|\/\/).*$/, "comment"],
          // Quoted strings
          [/"([^"\\]|\\.)*"/, "string"],
          [/'([^'\\]|\\.)*'/, "string"],
          // Delimiters
          [/[,;|]/, "delimiter"],
          // Numbers
          [/\b\d+(\.\d+)?\b/, "number"],
          // Tokens / IDs
          [/\b[a-zA-Z_][a-zA-Z0-9_.-]*\b/, "identifier"],
        ],
      },
    });
  }

  // Automatically register Cmd+S / Ctrl+S and Shift+Alt+F formatting for every created editor
  const monacoAny = monaco as unknown as { __intabFormatListenerAttached?: boolean };
  if (!monacoAny.__intabFormatListenerAttached) {
    monacoAny.__intabFormatListenerAttached = true;
    monaco.editor.onDidCreateEditor((codeEditor: editor.ICodeEditor) => {
      registerMonacoFormatShortcut(codeEditor as editor.IStandaloneCodeEditor, monaco);
    });
  }
}

