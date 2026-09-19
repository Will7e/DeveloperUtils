// ============================================================
// ChatMessageItem — Enterprise Message Card with Rich Markdown,
// Streaming Caret, Edit Prompt, Regenerate, and Model Switching
// ============================================================

import React, { useState, useEffect } from "react";
import {
  User,
  Copy,
  Check,
  AlertCircle,
  Maximize2,
  Download,
  X,
  RotateCw,
  Edit3,
  ThumbsUp,
  ThumbsDown,
  Sparkles,
  ChevronDown,
  FileText,
} from "lucide-react";
import type { ChatMessage, AIProvider, ChatImageAttachment } from "../types";
import { CURATED_MODELS } from "../types";
import { ProviderIcon } from "./ProviderIcon";
import { formatFileSize } from "../utils/image-utils";
import { MarkdownRenderer } from "../utils/markdown-parser";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ChatMessageItemProps {
  message: ChatMessage;
  provider?: AIProvider | string;
  modelId?: string;
  isStreamingMessage?: boolean;
  onRegenerate?: (messageId: string, modelOverride?: string) => void;
  onEditAndResubmit?: (messageId: string, newContent: string) => void;
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "Just now";
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 30) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function ChatMessageItem({
  message,
  provider,
  modelId,
  isStreamingMessage = false,
  onRegenerate,
  onEditAndResubmit,
}: ChatMessageItemProps) {
  const [copied, setCopied] = useState(false);
  const [copiedMd, setCopiedMd] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [lightboxImage, setLightboxImage] = useState<ChatImageAttachment | null>(null);

  const isUser = message.role === "user";

  // Escape key closes lightbox or cancels edit
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightboxImage) setLightboxImage(null);
        if (isEditing) {
          setIsEditing(false);
          setEditContent(message.content);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxImage, isEditing, message.content]);

  const handleCopyText = async () => {
    try {
      // Strip backticks if just plain text wanted
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMd(true);
      setTimeout(() => setCopiedMd(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleSaveEdit = () => {
    const trimmed = editContent.trim();
    if (!trimmed) return;
    setIsEditing(false);
    if (trimmed !== message.content && onEditAndResubmit) {
      onEditAndResubmit(message.id, trimmed);
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

  const hasImages = message.images && message.images.length > 0;
  const currentModelInfo = CURATED_MODELS.find((m) => m.id === (message.model || modelId));
  const displayModelName = currentModelInfo?.name || message.model || modelId || "AI Assistant";

  return (
    <>
      <div className={`chat-message-row ${isUser ? "user" : "assistant"} group`}>
        {/* Assistant Avatar */}
        {!isUser && (
          <div className="chat-avatar assistant">
            <ProviderIcon provider={provider} modelId={modelId} className="w-4 h-4" />
          </div>
        )}

        {isUser ? (
          /* User Message Bubble */
          <div className="chat-bubble-user">
            {/* Attached images preview grid */}
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

            {isEditing ? (
              <div className="chat-user-edit-wrap">
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="chat-user-edit-textarea"
                  rows={Math.max(2, editContent.split("\n").length)}
                  autoFocus
                />
                <div className="chat-user-edit-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditing(false);
                      setEditContent(message.content);
                    }}
                    className="chat-user-edit-btn cancel"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveEdit}
                    className="chat-user-edit-btn save"
                  >
                    Save & Submit
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>

                {/* User Message Action Toolbar */}
                <div className="chat-msg-actions-toolbar justify-end">
                  <button
                    type="button"
                    onClick={() => setIsEditing(true)}
                    className="chat-msg-action-btn"
                    title="Edit prompt and re-run"
                  >
                    <Edit3 className="w-3 h-3" />
                    <span>Edit</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyText}
                    className="chat-msg-action-btn"
                    title="Copy message"
                  >
                    {copied ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    <span>{copied ? "Copied" : "Copy"}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Assistant Message Bubble */
          <div className="chat-bubble-assistant">
            {/* Metadata Header: Model Tag + Timestamp + Latency */}
            <div className="chat-msg-meta">
              <span className="chat-msg-meta-tag">
                <Sparkles className="w-3 h-3 text-accent" />
                <span>{displayModelName}</span>
              </span>

              {message.latencyMs && (
                <span className="chat-msg-meta-latency">
                  {(message.latencyMs / 1000).toFixed(1)}s
                </span>
              )}

              <span className="chat-msg-meta-time">
                {formatRelativeTime(message.timestamp)}
              </span>
            </div>

            {/* Attached images in assistant response if any */}
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

            {/* Error Message Display */}
            {message.error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs mb-3">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{message.content}</span>
              </div>
            )}

            {/* Markdown Body */}
            {!message.error && (
              <div className="chat-msg-body">
                <MarkdownRenderer
                  content={message.content}
                  isStreaming={isStreamingMessage}
                />
                {/* Real-time leading cursor */}
                {isStreamingMessage && <span className="chat-streaming-cursor" />}
              </div>
            )}

            {/* Assistant Action Toolbar */}
            {!isStreamingMessage && !message.error && (
              <div className="chat-msg-actions-toolbar">
                {/* 1-Click Copy Text */}
                <button
                  type="button"
                  onClick={handleCopyText}
                  className="chat-msg-action-btn"
                  title="Copy response text"
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>

                {/* Copy Markdown */}
                <button
                  type="button"
                  onClick={handleCopyMarkdown}
                  className="chat-msg-action-btn"
                  title="Copy as raw Markdown"
                >
                  {copiedMd ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400">Copied MD</span>
                    </>
                  ) : (
                    <>
                      <FileText className="w-3 h-3" />
                      <span>Copy MD</span>
                    </>
                  )}
                </button>

                {/* Regenerate Button */}
                {onRegenerate && (
                  <button
                    type="button"
                    onClick={() => onRegenerate(message.id)}
                    className="chat-msg-action-btn"
                    title="Regenerate this response"
                  >
                    <RotateCw className="w-3 h-3" />
                    <span>Regenerate</span>
                  </button>
                )}

                {/* Try with another model Dropdown */}
                {onRegenerate && (
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="chat-msg-action-btn"
                        title="Compare with another AI model"
                      >
                        <Sparkles className="w-3 h-3 text-accent" />
                        <span>Compare</span>
                        <ChevronDown className="w-2.5 h-2.5 opacity-60" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56 p-1 bg-bg-1 border-border-1 text-xs">
                      <div className="px-2 py-1 text-[10px] font-semibold text-text-3 uppercase tracking-wider">
                        Regenerate with
                      </div>
                      {CURATED_MODELS.map((m) => (
                        <DropdownMenuItem
                          key={m.id}
                          onClick={() => onRegenerate(message.id, m.id)}
                          className="flex items-center justify-between p-2 rounded cursor-pointer hover:bg-bg-2"
                        >
                          <div className="flex items-center gap-2">
                            <ProviderIcon provider={m.provider} className="w-3.5 h-3.5" />
                            <span className="font-medium text-text-1">{m.name}</span>
                          </div>
                          <span className="text-[10px] text-text-3 font-mono">
                            {m.contextWindow.replace(" context", "")}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {/* Feedback Buttons (Thumbs Up / Down) */}
                <div className="flex items-center gap-1 ml-auto">
                  <button
                    type="button"
                    onClick={() => setFeedback(feedback === "up" ? null : "up")}
                    className={`chat-msg-action-btn p-1 ${feedback === "up" ? "active" : ""}`}
                    title="Good response"
                    aria-label="Thumbs up"
                  >
                    <ThumbsUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setFeedback(feedback === "down" ? null : "down")}
                    className={`chat-msg-action-btn p-1 ${feedback === "down" ? "active" : ""}`}
                    title="Poor response"
                    aria-label="Thumbs down"
                  >
                    <ThumbsDown className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* User Avatar */}
        {isUser && (
          <div className="chat-avatar user">
            <User className="w-4 h-4 text-text-2" />
          </div>
        )}
      </div>

      {/* Fullscreen Lightbox Modal for Image Attachments */}
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
                  <span className="text-xs text-text-3 font-mono">
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
