import { useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Code2, Copy, Check } from "lucide-react";
import { EditorLoadingFallback } from "@/components/ui/editor-loader";
import { useAppStore } from "@/stores/app.store";
import { useApiTesterStore, type TabState } from "@/stores/api-tester.store";
import { CODE_LANGUAGES, generateCodeSnippet } from "../code-generator";
import { EditorErrorBoundary } from "./EditorErrorBoundary";

interface CodeSnippetDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: TabState;
  currentThemeSetting: string;
  handleEditorMount: OnMount;
}

export function CodeSnippetDrawer({
  isOpen,
  onClose,
  activeTab,
  currentThemeSetting,
  handleEditorMount,
}: CodeSnippetDrawerProps) {
  const [snippetLang, setSnippetLang] = useState<string>("curl");
  const [snippetCopied, setSnippetCopied] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  const envVars = useApiTesterStore((s) => s.envVars);
  const activeEnvironmentId = useApiTesterStore((s) => s.activeEnvironmentId);
  const environments = useApiTesterStore((s) => s.environments);
  const generateCurl = useApiTesterStore((s) => s.generateCurl);

  const activeEnvVars = activeEnvironmentId
    ? environments.find((e) => e.id === activeEnvironmentId)?.variables || []
    : [];

  const codeSnippet = generateCodeSnippet(
    activeTab,
    generateCurl(),
    snippetLang,
    envVars,
    activeEnvVars
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeSnippet);
      setSnippetCopied(true);
      setTimeout(() => setSnippetCopied(false), 2000);
      addToast({
        message: "Snippet copied to clipboard!",
        type: "success",
        duration: 2000,
      });
    } catch (err) {
      console.error("Failed to copy code snippet: ", err);
      addToast({
        message: "Failed to copy code snippet.",
        type: "error",
        duration: 3000,
      });
    }
  };

  return (
    <div className="api-import-curl-wrapper" data-open={isOpen}>
      <div className="api-import-curl-wrapper-inner">
        <div
          className="api-import-curl-panel"
          style={{ height: "400px", display: "flex", flexDirection: "column" }}
        >
          <div className="api-import-curl-header">
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Code2 className="h-4 w-4 text-accent" />
              <span className="api-import-curl-title">Generate Code Snippet</span>
            </div>
            <button
              type="button"
              className="api-import-close-btn"
              onClick={onClose}
              title="Close"
            >
              &times;
            </button>
          </div>
          <div
            style={{
              padding: "0 12px",
              display: "flex",
              gap: "8px",
              borderBottom: "1px solid var(--border)",
              overflowX: "auto",
            }}
          >
            {CODE_LANGUAGES.map((lang) => (
              <button
                key={lang.id}
                className={`api-tab-trigger ${
                  snippetLang === lang.id ? "api-tab-trigger-active" : ""
                }`}
                onClick={() => setSnippetLang(lang.id)}
                style={{ padding: "8px 12px" }}
              >
                {lang.name}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
            {isOpen && (
              <EditorErrorBoundary fallbackMessage="Failed to display code snippet.">
                <Editor
                  className="api-monaco-wrapper"
                  loading={
                    <EditorLoadingFallback message="Loading code snippet..." />
                  }
                  height="100%"
                  language={
                    CODE_LANGUAGES.find((l) => l.id === snippetLang)?.language ||
                    "text"
                  }
                  theme={
                    currentThemeSetting === "light"
                      ? "devutils-light"
                      : "devutils-dark"
                  }
                  onMount={handleEditorMount}
                  value={codeSnippet}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 14,
                    fontFamily: "var(--font-mono), monospace",
                    lineNumbers: "off",
                    scrollBeyondLastLine: false,
                    readOnly: true,
                    wordWrap: "on",
                  }}
                />
              </EditorErrorBoundary>
            )}
          </div>
          <div
            className="api-import-curl-actions"
            style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}
          >
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="api-import-submit-btn"
              onClick={handleCopy}
              style={{ display: "flex", alignItems: "center", gap: "6px" }}
            >
              {snippetCopied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {snippetCopied ? "Copied!" : "Copy Code"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
