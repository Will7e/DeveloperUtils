// ============================================================
// CodeBlock — Syntax highlighted code block with 1-click copy
// ============================================================

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { renderHighlightedTs } from "@/features/dashboard/previews/syntaxHighlight";

interface CodeBlockProps {
  language?: string;
  code: string;
}

export function CodeBlock({ language = "typescript", code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures
    }
  };

  const cleanCode = code.replace(/\n$/, "");
  const langDisplay = language ? language.toLowerCase() : "code";

  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        <span className="font-mono text-[11px] uppercase tracking-wider text-text-3 font-semibold">
          {langDisplay}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="chat-code-copy-btn"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-green-500" />
              <span className="text-green-500 font-medium">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="chat-code-pre">
        <code>{renderHighlightedTs(cleanCode)}</code>
      </pre>
    </div>
  );
}
