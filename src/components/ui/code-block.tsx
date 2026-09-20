import * as React from "react";
import { Check, Copy, FileCode } from "lucide-react";
import { cn } from "@/lib/utils";

/* ============================================================
   1. Geist Code Block
   ============================================================ */

export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  code: string;
  language?: string;
  filename?: string;
  icon?: React.ReactNode;
  showLineNumbers?: boolean;
  highlightedLines?: number[];
  copyable?: boolean;
}

export const CodeBlock = React.forwardRef<HTMLDivElement, CodeBlockProps>(
  (
    {
      code,
      language,
      filename,
      icon,
      showLineNumbers = false,
      highlightedLines = [],
      copyable = true,
      className,
      ...props
    },
    ref
  ) => {
    const [copied, setCopied] = React.useState(false);

    const handleCopy = async () => {
      try {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy code: ", err);
      }
    };

    const lines = React.useMemo(() => code.split("\n"), [code]);

    return (
      <div
        ref={ref}
        data-geist-code-block=""
        className={cn(
          "group/codeblock relative my-3 overflow-hidden rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)]",
          className
        )}
        {...props}
      >
        {/* Header Bar */}
        {(filename || language || copyable) && (
          <div className="flex h-9 items-center justify-between border-b border-[var(--ds-gray-400)] bg-[var(--ds-background-200)] px-3 text-[13px]">
            <div className="flex items-center gap-2 font-mono text-[var(--ds-gray-900)]">
              {icon ?? <FileCode className="size-3.5 text-[var(--ds-gray-700)]" />}
              <span className="font-medium text-[var(--ds-gray-1000)]">
                {filename || language || "Code"}
              </span>
            </div>

            {copyable && (
              <button
                type="button"
                onClick={handleCopy}
                aria-label={copied ? "Copied" : "Copy code"}
                className={cn(
                  "flex items-center gap-1.5 rounded px-2 py-1 text-xs font-sans font-medium transition-all duration-150 cursor-pointer outline-none",
                  copied
                    ? "text-[var(--ds-blue-700)] bg-[var(--ds-blue-200)]/30 border border-[var(--ds-blue-400)]"
                    : "text-[var(--ds-gray-900)] hover:text-[var(--ds-gray-1000)] hover:bg-[var(--ds-gray-200)] border border-transparent"
                )}
              >
                {copied ? (
                  <>
                    <Check className="size-3.5 text-[var(--ds-blue-700)]" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            )}
          </div>
        )}

        {/* Code Content */}
        <div className="overflow-x-auto p-3 text-[13px] font-mono leading-[20px] text-[var(--ds-gray-1000)] select-text">
          <pre className="table w-full border-collapse m-0 p-0 font-mono">
            <code>
              {lines.map((line, idx) => {
                const lineNum = idx + 1;
                const isHighlighted = highlightedLines.includes(lineNum);
                return (
                  <div
                    key={idx}
                    data-geist-code-block-line=""
                    className={cn(
                      "table-row",
                      isHighlighted && "bg-[var(--ds-blue-200)]/20"
                    )}
                  >
                    {showLineNumbers && (
                      <span className="table-cell select-none pr-4 text-right text-[12px] text-[var(--ds-gray-600)] font-mono opacity-60 w-8">
                        {lineNum}
                      </span>
                    )}
                    <span className="table-cell whitespace-pre">{line || " "}</span>
                  </div>
                );
              })}
            </code>
          </pre>
        </div>
      </div>
    );
  }
);
CodeBlock.displayName = "CodeBlock";

/* ============================================================
   2. Geist Snippet (Terminal / Command)
   ============================================================ */

export interface SnippetProps extends React.HTMLAttributes<HTMLDivElement> {
  text: string | string[];
  prompt?: string | boolean;
  variant?: "default" | "inverted" | "bordered";
  copyable?: boolean;
}

export const Snippet = React.forwardRef<HTMLDivElement, SnippetProps>(
  (
    {
      text,
      prompt = "$",
      variant = "default",
      copyable = true,
      className,
      ...props
    },
    ref
  ) => {
    const [copied, setCopied] = React.useState(false);

    const textToCopy = Array.isArray(text) ? text.join("\n") : text;
    const lines = Array.isArray(text) ? text : [text];

    const handleCopy = async () => {
      try {
        await navigator.clipboard.writeText(textToCopy);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy snippet: ", err);
      }
    };

    return (
      <div
        ref={ref}
        data-geist-snippet=""
        className={cn(
          "relative flex items-center justify-between rounded-md px-3 py-2 text-[13px] font-mono shadow-xs select-text",
          variant === "default" && [
            "bg-[var(--ds-background-100)] text-[var(--ds-gray-1000)] border border-[var(--ds-gray-400)]",
          ],
          variant === "inverted" && [
            "bg-[var(--ds-gray-1000)] text-[var(--ds-background-100)] border border-transparent",
          ],
          variant === "bordered" && [
            "bg-transparent text-[var(--ds-gray-1000)] border border-[var(--ds-gray-400)]",
          ],
          className
        )}
        {...props}
      >
        <div className="flex flex-col gap-1 overflow-x-auto min-w-0 pr-3">
          {lines.map((line, idx) => (
            <div key={idx} className="flex items-center gap-2 truncate">
              {prompt && (
                <span
                  className={cn(
                    "select-none shrink-0 font-bold",
                    variant === "inverted"
                      ? "text-[var(--ds-background-100)]/70"
                      : "text-[var(--ds-gray-700)]"
                  )}
                >
                  {typeof prompt === "string" ? prompt : "$"}
                </span>
              )}
              <code className="truncate">{line}</code>
            </div>
          ))}
        </div>

        {copyable && (
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? "Copied" : "Copy snippet"}
            className={cn(
              "flex items-center justify-center shrink-0 rounded p-1.5 transition-colors cursor-pointer outline-none",
              variant === "inverted"
                ? "text-[var(--ds-background-100)] hover:bg-[var(--ds-background-100)]/20"
                : "text-[var(--ds-gray-700)] hover:text-[var(--ds-gray-1000)] hover:bg-[var(--ds-gray-200)]"
            )}
          >
            {copied ? (
              <Check className="size-4 text-[var(--ds-blue-700)]" />
            ) : (
              <Copy className="size-4" />
            )}
          </button>
        )}
      </div>
    );
  }
);
Snippet.displayName = "Snippet";
