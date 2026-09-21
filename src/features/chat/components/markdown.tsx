// ============================================================
// Markdown Renderer — React Elements Without innerHTML
// ============================================================
// Parses a pragmatic subset of Markdown into React elements:
// fenced code blocks (with language labels), headings, lists,
// blockquotes, tables, links, bold/italic/inline code. Rendering
// as elements (never dangerouslySetInnerHTML) removes any XSS
// surface from model output.

import React from "react";
import { Check, Copy } from "lucide-react";
import { HighlightedCodeSpan } from "./HighlightedCode";
import { highlightCode } from "../highlight";

// ── Code Block ──────────────────────────────────────────────

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard unavailable */
      }
    );
  }, [code]);

  // Token coloring for supported languages (plain text otherwise).
  // While streaming an open fence, the tail of `code` is still growing —
  // re-tokenizing a bounded block is cheap.
  const { language: displayLanguage, tokens } = React.useMemo(
    () => highlightCode(code, language),
    [code, language]
  );

  return (
    <div className="chat-code-block">
      <div className="chat-code-block-bar">
        <span className="chat-code-block-lang" data-detected={!language || undefined}>
          {displayLanguage || language || "code"}
          {!language && displayLanguage ? " · detected" : ""}
        </span>
        <button
          type="button"
          className="chat-code-block-copy"
          onClick={handleCopy}
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="chat-code-block-pre">
        {tokens.length > 0 ? (
          <code>
            <HighlightedCodeSpan tokens={tokens} />
          </code>
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}

// ── Inline Formatting ───────────────────────────────────────

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Order matters: `code` first so other patterns inside code spans
  // are not processed.
  const pattern =
    /(`[^`]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="chat-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("***")) {
      nodes.push(
        <strong key={key} className="font-semibold">
          <em>{token.slice(3, -3)}</em>
        </strong>
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a
            key={key}
            className="chat-link"
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    } else {
      // Bare URL — don't swallow trailing punctuation into the link
      const trailing = token.match(/[.,;:!?)}\]]+$/)?.[0] ?? "";
      const url = trailing ? token.slice(0, token.length - trailing.length) : token;
      nodes.push(
        <a
          key={key}
          className="chat-link"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {url}
        </a>
      );
      if (trailing) nodes.push(trailing);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

// ── Block Parsing ───────────────────────────────────────────

/**
 * Renders markdown text into block-level React elements.
 * (Internal helper — use <MarkdownContent> in components.)
 */
function renderMarkdown(content: string): React.ReactNode {
  const blocks: React.ReactNode[] = [];
  const lines = content.split("\n");

  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const language = fenceMatch[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <CodeBlock
          key={`b${key++}`}
          code={codeLines.join("\n")}
          language={language}
        />
      );
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!;
      const cls = `chat-md-h chat-md-h${level}`;
      blocks.push(
        React.createElement(
          `h${Math.min(level + 1, 6)}`,
          { key: `b${key++}`, className: cls },
          renderInline(text, `h${key}`)
        )
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} className="chat-md-hr" />);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) {
        quoteLines.push(lines[i]!.slice(2));
        i++;
      }
      blocks.push(
        <blockquote key={`b${key++}`} className="chat-md-quote">
          {renderInline(quoteLines.join(" "), `q${key}`)}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={`b${key++}`} className="chat-md-ul">
          {items.map((item, j) => (
            <li key={j}>{renderInline(item, `ul${key}-${j}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={`b${key++}`} className="chat-md-ol">
          {items.map((item, j) => (
            <li key={j}>{renderInline(item, `ol${key}-${j}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Table
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!)) {
      const parseRow = (row: string): string[] =>
        row
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());

      const headers = parseRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(parseRow(lines[i]!));
        i++;
      }

      blocks.push(
        <div key={`b${key++}`} className="chat-md-table-wrap">
          <table className="chat-md-table">
            <thead>
              <tr>
                {headers.map((h, j) => (
                  <th key={j}>{renderInline(h, `th${key}-${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{renderInline(cell, `td${key}-${r}-${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (accumulate until blank line or block start)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^```/.test(lines[i]!) &&
      !/^(#{1,4})\s/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !lines[i]!.startsWith("> ")
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(
        <p key={`b${key++}`} className="chat-md-p">
          {renderInline(paraLines.join("\n"), `p${key}`)}
        </p>
      );
    } else {
      // Safety: never stall on an unrecognized line
      i++;
    }
  }

  return <>{blocks}</>;
}

export const MarkdownContent = React.memo(function MarkdownContent({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return <div className={className}>{renderMarkdown(content)}</div>;
});
