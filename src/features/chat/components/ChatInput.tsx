// ============================================================
// ChatInput — Input textarea with dynamic Send / Stop control & Image Support
// ============================================================

import React, { useState, useRef, useEffect, useCallback } from "react";
import { ArrowUp, Square, ImagePlus, X, FileImage, Loader2 } from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
import { useAppStore } from "@/stores/app.store";
import {
  streamChatCompletion,
  abortCurrentRequest,
} from "../services/ai-client.service";
import { PROVIDER_LABELS, buildEffectiveSystemPrompt, type ChatImageAttachment } from "../types";
import { processImageFile, formatFileSize } from "../utils/image-utils";

export function ChatInput() {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const conversations = useChatStore((s) => s.conversations);
  const settings = useChatStore((s) => s.settings);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const createConversation = useChatStore((s) => s.createConversation);
  const addMessage = useChatStore((s) => s.addMessage);
  const setStreaming = useChatStore((s) => s.setStreaming);
  const setStreamingContent = useChatStore((s) => s.setStreamingContent);
  const appendStreamingContent = useChatStore((s) => s.appendStreamingContent);

  const activeProvider = settings?.activeProvider || "openai";
  const activeModel = settings?.activeModel || "gpt-4o";
  const apiKeys = settings?.apiKeys || { openai: "", anthropic: "", gemini: "" };
  const activeKey = apiKeys[activeProvider]?.trim();
  const hasKey = Boolean(activeKey);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(
        textareaRef.current.scrollHeight,
        200
      )}px`;
    }
  }, [input]);

  // Process and append multiple image files
  const handleAddFiles = useCallback(async (files: FileList | File[]) => {
    const fileList = Array.from(files);
    const imageFiles = fileList.filter((f) => f.type.startsWith("image/"));

    if (imageFiles.length === 0) {
      if (fileList.length > 0) {
        useAppStore.getState().addToast({
          message: "Only image files (PNG, JPG, WebP, GIF, SVG) are supported.",
          type: "info",
          duration: 3000,
        });
      }
      return;
    }

    setIsProcessingImage(true);
    try {
      const processed = await Promise.all(
        imageFiles.map((file) => processImageFile(file))
      );
      setAttachments((prev) => [...prev, ...processed]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to process image";
      useAppStore.getState().addToast({
        message: msg,
        type: "error",
        duration: 3500,
      });
    } finally {
      setIsProcessingImage(false);
      // Focus textarea after adding images
      textareaRef.current?.focus();
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleAddFiles(e.target.files);
      e.target.value = ""; // Reset input so same file can be re-selected if deleted
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  };

  // Clipboard Paste Support (Cmd+V / Ctrl+V)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement> | ClipboardEvent) => {
      const clipboardData = e.clipboardData;
      if (!clipboardData) return;

      const items = Array.from(clipboardData.items);
      const imageItems = items.filter((item) => item.type.startsWith("image/"));

      if (imageItems.length > 0) {
        // Prevent default only if pure image paste to avoid pasting binary text
        const textData = clipboardData.getData("text");
        if (!textData) {
          e.preventDefault();
        }

        const files: File[] = [];
        for (const item of imageItems) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }

        if (files.length > 0) {
          handleAddFiles(files);
        }
      }
    },
    [handleAddFiles]
  );

  // Global window paste handler when chat view is mounted
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // If focused inside another input/textarea outside this container, don't hijack
      const activeEl = document.activeElement;
      if (
        activeEl &&
        activeEl !== textareaRef.current &&
        (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")
      ) {
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;

      const hasImage = Array.from(items).some((item) =>
        item.type.startsWith("image/")
      );

      if (hasImage) {
        handlePaste(e);
      }
    };

    window.addEventListener("paste", handleGlobalPaste);
    return () => window.removeEventListener("paste", handleGlobalPaste);
  }, [handlePaste]);

  // Drag and Drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      containerRef.current &&
      !containerRef.current.contains(e.relatedTarget as Node)
    ) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleAddFiles(e.dataTransfer.files);
    }
  };

  const canSend =
    (input.trim().length > 0 || attachments.length > 0) &&
    !isStreaming &&
    !isProcessingImage;

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!canSend) return;

    if (!hasKey) {
      useAppStore.getState().addToast({
        message: `API Key required for ${PROVIDER_LABELS[activeProvider] || "AI Provider"}. Please configure it in Settings.`,
        type: "error",
        duration: 3500,
      });
      return;
    }

    // Ensure there is an active conversation
    let targetConvId = activeConversationId;
    if (!targetConvId || !conversations.some((c) => c.id === targetConvId)) {
      targetConvId = createConversation(
        settings.activeProvider,
        settings.activeModel
      );
    }

    const currentAttachments = [...attachments];

    // Clear input & attachments, and reset height
    setInput("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    // Add user message with images
    addMessage(targetConvId, {
      role: "user",
      content: trimmed,
      images: currentAttachments.length > 0 ? currentAttachments : undefined,
    });

    // Start streaming
    setStreaming(true);
    setStreamingContent("");

    // Prepare message history
    const conv = useChatStore
      .getState()
      .conversations.find((c) => c.id === targetConvId);
    const messagesHistory = conv ? [...conv.messages] : [];

    let accumulatedResponse = "";

    try {
      await streamChatCompletion({
        provider: settings.activeProvider,
        model: settings.activeModel,
        apiKey: activeKey,
        messages: messagesHistory,
        systemPrompt: buildEffectiveSystemPrompt(
          settings?.skills,
          settings?.systemPrompt
        ),
        temperature: settings.temperature,
        customBaseUrl: settings.baseUrls?.[settings.activeProvider],
        useProxy: settings.useProxy,
        onChunk: (chunk) => {
          accumulatedResponse += chunk;
          appendStreamingContent(chunk);
        },
      });

      // Save completed assistant message
      if (accumulatedResponse.trim()) {
        addMessage(targetConvId, {
          role: "assistant",
          content: accumulatedResponse,
        });
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "An unexpected error occurred.";

      // Only record as error message if not manually aborted
      if (
        errorMessage !== "The user aborted a request." &&
        !errorMessage.includes("aborted")
      ) {
        addMessage(targetConvId, {
          role: "assistant",
          content: `Error: ${errorMessage}`,
          error: true,
        });
      } else if (accumulatedResponse.trim()) {
        // Save what was generated before abort
        addMessage(targetConvId, {
          role: "assistant",
          content: accumulatedResponse,
        });
      }
    } finally {
      setStreaming(false);
      setStreamingContent("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = () => {
    abortCurrentRequest();
  };

  return (
    <div className="chat-bottom-bar">
      <div
        ref={containerRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`chat-input-wrapper-container ${isDragging ? "chat-drag-active" : ""}`}
      >
        {/* Hidden File Input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          multiple
          className="hidden"
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />

        {/* Drag & Drop Visual Overlay */}
        {isDragging && (
          <div className="chat-drop-overlay">
            <FileImage className="w-8 h-8 text-accent animate-bounce" />
            <span className="text-sm font-medium text-text-0">
              Drop images to attach
            </span>
          </div>
        )}

        {/* Attached Images Preview Tray */}
        {attachments.length > 0 && (
          <div className="chat-attachments-tray">
            {attachments.map((att) => (
              <div key={att.id} className="chat-attachment-chip" title={`${att.name} (${formatFileSize(att.size)})`}>
                <img
                  src={att.url}
                  alt={att.name}
                  className="chat-attachment-thumbnail"
                />
                <button
                  type="button"
                  onClick={() => handleRemoveAttachment(att.id)}
                  className="chat-attachment-remove"
                  title="Remove image"
                  aria-label="Remove image"
                >
                  <X className="w-3 h-3" />
                </button>
                <div className="chat-attachment-info">
                  <span className="chat-attachment-name">{att.name}</span>
                  <span className="chat-attachment-size">
                    {formatFileSize(att.size)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Input Field and Action Controls Row */}
        <div className="chat-input-main-row">
          {/* Add Image Button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="chat-btn-attach"
            title="Attach image (or paste with ⌘V / Ctrl+V)"
            aria-label="Attach image"
            disabled={isStreaming || isProcessingImage}
          >
            {isProcessingImage ? (
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
            ) : (
              <ImagePlus className="w-4 h-4" />
            )}
          </button>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              attachments.length > 0
                ? "Ask about attached image(s)..."
                : `Message InTab AI (${activeModel})...`
            }
            rows={1}
            className="chat-textarea"
            disabled={isStreaming}
          />

          <div className="chat-input-controls">
            {isStreaming ? (
              <button
                type="button"
                onClick={handleStop}
                className="chat-btn-stop"
                title="Stop Generation"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className="chat-btn-send"
                aria-label="Send message"
                title={canSend ? "Send message (Enter)" : "Enter text or attach an image"}
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      <span className="chat-disclaimer">
        AI responses can contain inaccuracies. Verify critical code and credentials.
      </span>
    </div>
  );
}

