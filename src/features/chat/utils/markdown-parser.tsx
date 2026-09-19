// ============================================================
// Stream-Tolerant Markdown Parser & Renderer for AI Chat
// Handles codeblocks, tables, quotes, task lists, and inline styles
// Strict TypeScript with noUncheckedIndexedAccess compliance
// ============================================================

import React, { useState } from "react";
import { ExternalLink, CheckSquare, Square, Copy, Check } from "lucide-react";
import { CodeBlock } from "../components/CodeBlock";

export interface MarkdownBlock {
  type: "code" | "table" | "quote" | "heading" | "tasklist" | "list" | "hr" | "text";
  content: string;
  language?: string;
  level?: number;
  tableData?: {
    headers: string[];
    rows: string[][];
  };
}

/**
 * Parses markdown into structured blocks while streaming.
 * Tolerates unclosed code fences ``` so live streaming doesn't break rendering.
 */
export function parseMarkdownBlocks(rawContent: string, isStreaming = false): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = rawContent.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      i++;
      continue;
    }

    // 1. Code Block Fence (```lang)
    const codeFenceMatch = line.match(/^```([a-zA-Z0-9_-]*)/);
    if (codeFenceMatch) {
      const language = codeFenceMatch[1] || "typescript";
      const codeLines: string[] = [];
      i++;
      let closed = false;

      while (i < lines.length) {
        const cLine = lines[i];
        if (cLine === undefined) break;

        if (cLine.startsWith("```")) {
          closed = true;
          i++;
          break;
        }
        codeLines.push(cLine);
        i++;
      }

      // If streaming and unclosed, still treat as valid active code block
      if (closed || isStreaming) {
        blocks.push({
          type: "code",
          language,
          content: codeLines.join("\n"),
        });
      } else {
        blocks.push({
          type: "code",
          language,
          content: codeLines.join("\n"),
        });
      }
      continue;
    }

    // 2. Horizontal Rule (---, ***, ___)
    if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: "hr", content: "" });
      i++;
      continue;
    }

    // 3. Headings (# H1, ## H2, ### H3, #### H4)
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      i++;
      continue;
    }

    // 4. Blockquote (> quote)
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const qLine = lines[i];
        if (!qLine) break;

        if (qLine.startsWith(">")) {
          quoteLines.push(qLine.replace(/^>\s?/, ""));
          i++;
        } else if (qLine.trim() && !qLine.startsWith("#")) {
          quoteLines.push(qLine);
          i++;
        } else {
          break;
        }
      }
      blocks.push({
        type: "quote",
        content: quoteLines.join("\n"),
      });
      continue;
    }

    // 5. Table (| Header | Header | ... \n |---|---| ...)
    if (line.includes("|") && line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      let j = i;
      while (j < lines.length) {
        const tLine = lines[j];
        if (!tLine || !tLine.includes("|") || !tLine.trim().startsWith("|")) {
          break;
        }
        tableLines.push(tLine.trim());
        j++;
      }

      const firstLine = tableLines[0];
      const secondLine = tableLines[1];

      // Must have at least 2 lines and a separator line (|---|)
      if (
        tableLines.length >= 2 &&
        firstLine !== undefined &&
        secondLine !== undefined &&
        secondLine.match(/^\|[\s:-|-]+\|$/)
      ) {
        const parseRow = (rowStr: string) =>
          rowStr
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim());

        const headers = parseRow(firstLine);
        const rows = tableLines.slice(2).map(parseRow);

        blocks.push({
          type: "table",
          content: tableLines.join("\n"),
          tableData: { headers, rows },
        });
        i = j;
        continue;
      }
    }

    // 6. Task List items (- [ ] or - [x])
    const taskMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      const taskLines: string[] = [];
      while (i < lines.length) {
        const tkLine = lines[i];
        if (!tkLine || !tkLine.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/)) {
          break;
        }
        taskLines.push(tkLine);
        i++;
      }
      blocks.push({
        type: "tasklist",
        content: taskLines.join("\n"),
      });
      continue;
    }

    // 7. General Text / Paragraphs / Standard Lists
    const textLines: string[] = [];
    while (i < lines.length) {
      const curLine = lines[i];
      if (curLine === undefined) break;

      if (
        curLine.startsWith("```") ||
        curLine.startsWith("#") ||
        curLine.startsWith(">") ||
        /^(?:---|\*\*\*|___)\s*$/.test(curLine) ||
        (curLine.includes("|") && curLine.trim().startsWith("|")) ||
        curLine.match(/^[-*]\s+\[([ xX])\]\s+/)
      ) {
        break;
      }

      textLines.push(curLine);
      i++;
    }

    if (textLines.length > 0) {
      const combined = textLines.join("\n");
      if (combined.trim().length > 0) {
        blocks.push({
          type: "text",
          content: combined,
        });
      }
    }
  }

  return blocks;
}

/**
 * Formats inline text with bold, italic, code chips, strikethrough, and links
 */
export function renderInlineFormatted(str: string): React.ReactNode[] {
  // Regex to split by markdown tokens: links [text](url), inline code `code`, bold **text**, italic *text*, strike ~~text~~
  const tokenRegex =
    /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~)/g;
  const parts = str.split(tokenRegex);

  return parts.map((part, idx) => {
    if (!part) return null;

    // Link: [title](url)
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch && linkMatch[1] && linkMatch[2]) {
      return (
        <a
          key={idx}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-inline-link inline-flex items-center gap-1 text-accent hover:underline font-medium"
        >
          <span>{linkMatch[1]}</span>
          <ExternalLink className="w-3 h-3 inline-block shrink-0 opacity-70" />
        </a>
      );
    }

    // Inline Code: `code`
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code
          key={idx}
          className="chat-inline-code px-1.5 py-0.5 rounded bg-bg-2 border border-border-1 text-accent font-mono text-[12px]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    // Bold: **text**
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return (
        <strong key={idx} className="font-semibold text-text-0">
          {part.slice(2, -2)}
        </strong>
      );
    }

    // Italic: *text*
    if (part.startsWith("*") && part.endsWith("*") && part.length > 1) {
      return (
        <em key={idx} className="italic text-text-1">
          {part.slice(1, -1)}
        </em>
      );
    }

    // Strikethrough: ~~text~~
    if (part.startsWith("~~") && part.endsWith("~~") && part.length > 3) {
      return (
        <del key={idx} className="line-through text-text-3">
          {part.slice(2, -2)}
        </del>
      );
    }

    return <span key={idx}>{part}</span>;
  });
}

/**
 * Interactive Table Component with 1-click Markdown copy
 */
function MarkdownTable({ tableData, raw }: { tableData: { headers: string[]; rows: string[][] }; raw: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore
    }
  };

  return (
    <div className="chat-table-wrapper my-3 border border-border-1 rounded-lg overflow-hidden bg-bg-1 shadow-sm">
      <div className="chat-table-header flex items-center justify-between px-3 py-1.5 bg-bg-2 border-b border-border-1 text-xs text-text-3">
        <span className="font-mono text-[11px] uppercase tracking-wider font-semibold">Table</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-[11px] hover:text-text-0 transition-colors p-1 rounded hover:bg-bg-0"
          title="Copy table as Markdown"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? "Copied!" : "Copy Table"}</span>
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="chat-table w-full text-left text-xs border-collapse">
          <thead>
            <tr className="bg-bg-2/50 border-b border-border-1">
              {tableData.headers.map((h, i) => (
                <th key={i} className="p-2.5 font-semibold text-text-1 border-r border-border-1 last:border-r-0">
                  {renderInlineFormatted(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableData.rows.map((row, rIdx) => (
              <tr
                key={rIdx}
                className="border-b border-border-1/60 hover:bg-bg-hover transition-colors last:border-b-0"
              >
                {row.map((cell, cIdx) => (
                  <td key={cIdx} className="p-2.5 text-text-1 border-r border-border-1/60 last:border-r-0 font-normal">
                    {renderInlineFormatted(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Task List Component with styled checkboxes
 */
function MarkdownTaskList({ content }: { content: string }) {
  const lines = content.split("\n");

  return (
    <div className="chat-tasklist my-2 flex flex-col gap-1.5 ml-1">
      {lines.map((line, idx) => {
        const match = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
        if (!match || !match[1] || !match[2]) return null;
        const checked = match[1].toLowerCase() === "x";
        const text = match[2];

        return (
          <div key={idx} className="flex items-start gap-2 text-xs text-text-1">
            {checked ? (
              <CheckSquare className="w-3.5 h-3.5 text-accent mt-0.5 shrink-0" />
            ) : (
              <Square className="w-3.5 h-3.5 text-text-3 mt-0.5 shrink-0" />
            )}
            <span className={checked ? "line-through text-text-3" : "text-text-0"}>
              {renderInlineFormatted(text)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Main Markdown Renderer Component
 */
export function MarkdownRenderer({ content, isStreaming = false }: { content: string; isStreaming?: boolean }) {
  const blocks = parseMarkdownBlocks(content, isStreaming);

  return (
    <div className="chat-markdown-content space-y-2.5 text-[13.5px] leading-relaxed">
      {blocks.map((block, idx) => {
        switch (block.type) {
          case "code":
            return (
              <CodeBlock
                key={idx}
                language={block.language}
                code={block.content}
              />
            );

          case "table":
            return block.tableData ? (
              <MarkdownTable key={idx} tableData={block.tableData} raw={block.content} />
            ) : null;

          case "tasklist":
            return <MarkdownTaskList key={idx} content={block.content} />;

          case "quote":
            return (
              <blockquote
                key={idx}
                className="chat-blockquote my-2 pl-3.5 py-1 border-l-2 border-accent/60 bg-accent/5 rounded-r text-text-2 text-xs italic"
              >
                {block.content.split("\n").map((qLine, qIdx) => (
                  <p key={qIdx} className="my-0.5 leading-relaxed">
                    {renderInlineFormatted(qLine)}
                  </p>
                ))}
              </blockquote>
            );

          case "heading":
            if (block.level === 1) {
              return (
                <h2 key={idx} className="text-lg font-bold text-text-0 mt-4 mb-2 pb-1 border-b border-border-1">
                  {renderInlineFormatted(block.content)}
                </h2>
              );
            }
            if (block.level === 2) {
              return (
                <h3 key={idx} className="text-base font-semibold text-text-0 mt-3 mb-1.5">
                  {renderInlineFormatted(block.content)}
                </h3>
              );
            }
            if (block.level === 3) {
              return (
                <h4 key={idx} className="text-sm font-semibold text-text-0 mt-2.5 mb-1">
                  {renderInlineFormatted(block.content)}
                </h4>
              );
            }
            return (
              <h5 key={idx} className="text-xs font-semibold uppercase tracking-wider text-text-2 mt-2 mb-1">
                {renderInlineFormatted(block.content)}
              </h5>
            );

          case "hr":
            return <hr key={idx} className="my-4 border-border-1/60" />;

          case "text":
          default: {
            const lines = block.content.split("\n");
            return (
              <div key={idx} className="chat-text-block space-y-1.5">
                {lines.map((line, lineIdx) => {
                  // Bullet list
                  if (line.match(/^[-*]\s+/)) {
                    return (
                      <div key={lineIdx} className="flex items-start gap-2 ml-2 my-0.5">
                        <span className="text-accent mt-1.5 h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
                        <span className="text-text-1">{renderInlineFormatted(line.replace(/^[-*]\s+/, ""))}</span>
                      </div>
                    );
                  }

                  // Numbered list
                  const numMatch = line.match(/^(\d+)\.\s+(.*)/);
                  if (numMatch && numMatch[1] !== undefined && numMatch[2] !== undefined) {
                    return (
                      <div key={lineIdx} className="flex items-start gap-2 ml-2 my-0.5">
                        <span className="text-text-3 font-mono text-xs mt-0.5 shrink-0 min-w-[16px]">
                          {numMatch[1]}.
                        </span>
                        <span className="text-text-1">{renderInlineFormatted(numMatch[2])}</span>
                      </div>
                    );
                  }

                  if (!line.trim()) {
                    return <div key={lineIdx} className="h-1.5" />;
                  }

                  return (
                    <p key={lineIdx} className="leading-relaxed text-text-1">
                      {renderInlineFormatted(line)}
                    </p>
                  );
                })}
              </div>
            );
          }
        }
      })}
    </div>
  );
}
