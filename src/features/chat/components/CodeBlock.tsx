// ============================================================
// CodeBlock — Enterprise Syntax Highlighted Code Viewer
// Multi-language highlighting, Line numbers, Wrap toggle,
// 1-Click Copy, and seamless InTab Compiler integration
// ============================================================

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Copy, WrapText, Play, Hash } from "lucide-react";
import { renderHighlightedCode, normalizeLanguage } from "../utils/syntax-highlighter";
import { useAppStore } from "@/stores/app.store";
import type { Language } from "@/types";

interface CodeBlockProps {
  language?: string;
  code: string;
}

const LANGUAGE_BADGE_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  typescript: { bg: "rgba(56, 189, 248, 0.12)", text: "#38bdf8", dot: "#38bdf8" },
  javascript: { bg: "rgba(250, 204, 21, 0.12)", text: "#facc15", dot: "#facc15" },
  python: { bg: "rgba(74, 222, 128, 0.12)", text: "#4ade80", dot: "#4ade80" },
  json: { bg: "rgba(244, 114, 182, 0.12)", text: "#f472b6", dot: "#f472b6" },
  html: { bg: "rgba(251, 146, 60, 0.12)", text: "#fb923c", dot: "#fb923c" },
  css: { bg: "rgba(167, 139, 250, 0.12)", text: "#a78bfa", dot: "#a78bfa" },
  sql: { bg: "rgba(192, 132, 252, 0.12)", text: "#c084fc", dot: "#c084fc" },
  bash: { bg: "rgba(148, 163, 184, 0.12)", text: "#94a3b8", dot: "#94a3b8" },
  yaml: { bg: "rgba(234, 179, 8, 0.12)", text: "#eab308", dot: "#eab308" },
  markdown: { bg: "rgba(148, 163, 184, 0.12)", text: "#cbd5e1", dot: "#cbd5e1" },
};

export function CodeBlock({ language = "typescript", code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const navigate = useNavigate();

  const createFile = useAppStore((s) => s.createFile);
  const addToast = useAppStore((s) => s.addToast);

  const cleanCode = code.replace(/\n$/, "");
  const lines = cleanCode.split("\n");
  const lineCount = lines.length;
  const normLang = normalizeLanguage(language);
  const colorInfo = LANGUAGE_BADGE_COLORS[normLang] || {
    bg: "rgba(148, 163, 184, 0.12)",
    text: "var(--text-2)",
    dot: "var(--accent)",
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures
    }
  };

  // Check if this snippet can run or open directly in the InTab Compiler
  const isCompilerSupported = ["typescript", "javascript", "python", "html"].includes(normLang);

  const handleOpenInCompiler = () => {
    try {
      const targetLang: Language =
        normLang === "python"
          ? "python"
          : normLang === "html"
          ? "html"
          : normLang === "javascript"
          ? "javascript"
          : "typescript";

      const ext =
        targetLang === "python"
          ? ".py"
          : targetLang === "html"
          ? ".html"
          : targetLang === "javascript"
          ? ".js"
          : ".ts";

      const fileName = `snippet-${Date.now().toString().slice(-4)}${ext}`;
      createFile(fileName, targetLang, cleanCode);
      addToast({
        message: `Snippet opened in Compiler as ${fileName}`,
        type: "success",
        duration: 3000,
      });
      navigate("/compiler");
    } catch {
      navigate("/compiler");
    }
  };

  return (
    <div className="chat-code-block my-3 rounded-lg overflow-hidden border border-border-1 bg-bg-0 shadow-sm">
      {/* Code Block Toolbar Header */}
      <div className="chat-code-header h-9 px-3 bg-bg-2/80 border-b border-border-1 flex items-center justify-between text-xs select-none">
        {/* Left: Language Badge + Line count */}
        <div className="flex items-center gap-2">
          <div
            className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono font-medium tracking-wide uppercase"
            style={{ backgroundColor: colorInfo.bg, color: colorInfo.text }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: colorInfo.dot }}
            />
            <span>{language || "code"}</span>
          </div>
          <span className="text-text-3 text-[11px] font-mono">
            {lineCount} {lineCount === 1 ? "line" : "lines"}
          </span>
        </div>

        {/* Right: Actions (Line numbers, Wrap, Compiler, Copy) */}
        <div className="chat-code-actions flex items-center gap-1">
          {/* Toggle Line Numbers */}
          <button
            type="button"
            onClick={() => setShowLineNumbers(!showLineNumbers)}
            className={`chat-code-action-btn p-1 rounded transition-colors ${
              showLineNumbers ? "text-accent bg-accent/10" : "text-text-3 hover:text-text-1 hover:bg-bg-1"
            }`}
            title={showLineNumbers ? "Hide line numbers" : "Show line numbers"}
            aria-label="Toggle line numbers"
          >
            <Hash className="w-3.5 h-3.5" />
          </button>

          {/* Toggle Wrap */}
          <button
            type="button"
            onClick={() => setWordWrap(!wordWrap)}
            className={`chat-code-action-btn p-1 rounded transition-colors ${
              wordWrap ? "text-accent bg-accent/10" : "text-text-3 hover:text-text-1 hover:bg-bg-1"
            }`}
            title={wordWrap ? "Disable word wrap" : "Enable word wrap"}
            aria-label="Toggle word wrap"
          >
            <WrapText className="w-3.5 h-3.5" />
          </button>

          {/* Open in InTab Compiler */}
          {isCompilerSupported && (
            <button
              type="button"
              onClick={handleOpenInCompiler}
              className="chat-code-action-btn px-2 py-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-1 flex items-center gap-1 text-[11px] font-medium transition-colors"
              title="Open and run this snippet in InTab Compiler"
              aria-label="Open in Compiler"
            >
              <Play className="w-3 h-3 text-accent" />
              <span>Compiler</span>
            </button>
          )}

          {/* Copy Code Button */}
          <button
            type="button"
            onClick={handleCopy}
            className="chat-code-copy-btn px-2 py-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-1 flex items-center gap-1 text-[11px] font-medium transition-colors ml-1"
            aria-label="Copy code"
            title="Copy code to clipboard"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400 font-semibold">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Code Viewer Body */}
      <pre
        className={`chat-code-pre p-3.5 overflow-x-auto text-[12.5px] font-mono leading-relaxed text-text-1 ${
          wordWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"
        }`}
      >
        {showLineNumbers ? (
          <div className="flex">
            {/* Gutter with line numbers */}
            <div
              className="select-none text-right text-text-3/60 pr-3 mr-3 border-r border-border-1/60 font-mono text-[12px] min-w-[24px]"
              aria-hidden="true"
            >
              {lines.map((_, idx) => (
                <div key={idx} className="leading-relaxed">
                  {idx + 1}
                </div>
              ))}
            </div>
            {/* Code lines */}
            <div className="flex-1 min-w-0">
              <code>{renderHighlightedCode(cleanCode, language)}</code>
            </div>
          </div>
        ) : (
          <code>{renderHighlightedCode(cleanCode, language)}</code>
        )}
      </pre>
    </div>
  );
}
