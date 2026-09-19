// ============================================================
// ChatMessageItem — Renders user or assistant message with Markdown
// ============================================================

import React, { useState, useEffect } from "react";
import { User, Copy, Check, AlertCircle, Maximize2, Download, X } from "lucide-react";
import type { ChatMessage, AIProvider, ChatImageAttachment } from "../types";
import { CodeBlock } from "./CodeBlock";
import { ProviderIcon } from "./ProviderIcon";
import { formatFileSize } from "../utils/image-utils";

interface ChatMessageItemProps {
  message: ChatMessage;
  provider?: AIProvider | string;
  modelId?: string;
}

/**
 * Splits text into markdown blocks (code blocks vs regular markdown text)
 */
function parseMessageBlocks(content: string) {
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  const blocks: Array<{ type: "code" | "text"; content: string; language?: string }> = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({
        type: "text",
        content: content.slice(lastIndex, match.index),
      });
    }

    blocks.push({
      type: "code",
      language: match[1] || "typescript",
      content: match[2] || "",
    });

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    blocks.push({
      type: "text",
      content: content.slice(lastIndex),
    });
  }

  return blocks;
}

/**
 * Lightweight inline markdown renderer for formatting text, bold, italics, inline code, and lists
 */
function renderInlineMarkdown(text: string): React.ReactNode {
  const lines = text.split("\n");

  return lines.map((line, lineIdx) => {
    // Heading 3
    if (line.startsWith("### ")) {
      return (
        <h4 key={lineIdx} className="text-sm font-semibold text-text-0 mt-3 mb-1">
          {formatInlineStyles(line.slice(4))}
        </h4>
      );
    }
    // Heading 2
    if (line.startsWith("## ")) {
      return (
        <h3 key={lineIdx} className="text-base font-semibold text-text-0 mt-3 mb-1.5">
          {formatInlineStyles(line.slice(3))}
        </h3>
      );
    }
    // Heading 1
    if (line.startsWith("# ")) {
      return (
        <h2 key={lineIdx} className="text-lg font-bold text-text-0 mt-4 mb-2">
          {formatInlineStyles(line.slice(2))}
        </h2>
      );
    }
    // Bullet list item
    if (line.match(/^[-*]\s+/)) {
      return (
        <div key={lineIdx} className="flex items-start gap-2 ml-2 my-0.5">
          <span className="text-accent mt-1.5 h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
          <span>{formatInlineStyles(line.replace(/^[-*]\s+/, ""))}</span>
        </div>
      );
    }
    // Numbered list item
    const numMatch = line.match(/^(\d+)\.\s+(.*)/);
    if (numMatch && numMatch[2] !== undefined) {
      return (
        <div key={lineIdx} className="flex items-start gap-2 ml-2 my-0.5">
          <span className="text-text-3 font-mono text-xs mt-0.5 shrink-0">
            {numMatch[1]}.
          </span>
          <span>{formatInlineStyles(numMatch[2])}</span>
        </div>
      );
    }

    if (!line.trim()) {
      return <div key={lineIdx} className="h-2" />;
    }

    return (
      <p key={lineIdx} className="my-1 leading-relaxed">
        {formatInlineStyles(line)}
      </p>
    );
  });
}

/**
 * Replaces **bold**, *italic*, and `inline code`
 */
function formatInlineStyles(str: string): React.ReactNode[] {
  // Regex splitting by backticks and asterisks
  const parts = str.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);

  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={idx}
          className="px-1.5 py-0.5 rounded bg-bg-2 border border-border-1 text-accent font-mono text-[12px]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-text-0">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <em key={idx} className="italic text-text-1">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

export function ChatMessageItem({ message, provider, modelId }: ChatMessageItemProps) {
  const [copied, setCopied] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<ChatImageAttachment | null>(null);
  const isUser = message.role === "user";

  // Escape key closes lightbox
  useEffect(() => {
    if (!lightboxImage) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLightboxImage(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxImage]);

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleDownload = (img: ChatImageAttachment) => {
    const a = document.createElement("a");
    a.href = img.url;
    a.download = img.name || "image.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const blocks = parseMessageBlocks(message.content);
  const hasImages = message.images && message.images.length > 0;

  return (
    <>
      <div className={`chat-message-row ${isUser ? "user" : "assistant"} group`}>
        {!isUser && (
          <div className="chat-avatar assistant">
            <ProviderIcon provider={provider} modelId={modelId} className="w-4 h-4" />
          </div>
        )}

        {isUser ? (
          <div className="chat-bubble-user">
            {/* Attached images in user message */}
            {hasImages && (
              <div className="chat-message-images-grid">
                {message.images!.map((img) => (
                  <div
                    key={img.id}
                    className="chat-message-image-thumb group/img"
                    onClick={() => setLightboxImage(img)}
                    title={`${img.name} (Click to expand)`}
                  >
                    <img src={img.url} alt={img.name} className="chat-message-image" />
                    <div className="chat-message-image-overlay">
                      <Maximize2 className="w-4 h-4 text-white drop-shadow" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* User message text */}
            {message.content && <div>{message.content}</div>}
          </div>
        ) : (
          <div className="chat-bubble-assistant relative">
            {hasImages && (
              <div className="chat-message-images-grid mb-2">
                {message.images!.map((img) => (
                  <div
                    key={img.id}
                    className="chat-message-image-thumb group/img"
                    onClick={() => setLightboxImage(img)}
                    title={`${img.name} (Click to expand)`}
                  >
                    <img src={img.url} alt={img.name} className="chat-message-image" />
                    <div className="chat-message-image-overlay">
                      <Maximize2 className="w-4 h-4 text-white drop-shadow" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {message.error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs mb-3">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{message.content}</span>
              </div>
            )}

            {!message.error &&
              blocks.map((block, i) =>
                block.type === "code" ? (
                  <CodeBlock
                    key={i}
                    language={block.language}
                    code={block.content}
                  />
                ) : (
                  <div key={i}>{renderInlineMarkdown(block.content)}</div>
                )
              )}

            {/* Quick Copy Message Action */}
            <button
              type="button"
              onClick={handleCopyMessage}
              className="chat-conv-action-btn opacity-0 group-hover:opacity-100 transition-opacity mt-2 p-1.5 rounded hover:bg-bg-2 text-text-3 hover:text-text-0 text-xs flex items-center gap-1.5"
              title="Copy entire response"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-green-500" />
                  <span className="text-green-500 text-[11px]">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span className="text-[11px]">Copy response</span>
                </>
              )}
            </button>
          </div>
        )}

        {isUser && (
          <div className="chat-avatar user">
            <User className="w-4 h-4 text-text-2" />
          </div>
        )}
      </div>

      {/* Lightbox Modal for Full Image View */}
      {lightboxImage && (
        <div
          className="chat-lightbox-backdrop"
          onClick={() => setLightboxImage(null)}
        >
          <div
            className="chat-lightbox-container"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="chat-lightbox-header">
              <div className="chat-lightbox-title">
                <span className="font-medium text-text-0 truncate max-w-sm">
                  {lightboxImage.name}
                </span>
                {lightboxImage.size && (
                  <span className="text-xs text-text-3">
                    ({formatFileSize(lightboxImage.size)})
                  </span>
                )}
              </div>

              <div className="chat-lightbox-actions">
                <button
                  type="button"
                  onClick={() => handleDownload(lightboxImage)}
                  className="chat-lightbox-btn"
                  title="Download image"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setLightboxImage(null)}
                  className="chat-lightbox-btn"
                  title="Close preview (Esc)"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="chat-lightbox-body">
              <img
                src={lightboxImage.url}
                alt={lightboxImage.name}
                className="chat-lightbox-img"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
