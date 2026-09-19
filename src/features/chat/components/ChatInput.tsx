// ============================================================
// ChatInput — Enterprise Composer with Slash Commands,
// Active Skill Indicator, Draft Token Counter & Multimodal Vision
// ============================================================

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  ArrowUp,
  Square,
  ImagePlus,
  X,
  FileImage,
  Loader2,
  Sparkles,
  Terminal,
  ShieldAlert,
  FlaskConical,
  Trash2,
  Layers,
} from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
import { useAppStore } from "@/stores/app.store";
import { executeChatStream, stopChatStream } from "../services/chat-runner";
import { PROVIDER_LABELS, type ChatImageAttachment } from "../types";
import { processImageFile, formatFileSize } from "../utils/image-utils";
import { estimateTokens } from "../utils/token-counter";

interface SlashCommand {
  id: string;
  command: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  action: () => void;
}

export function ChatInput() {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [selectedSlashIdx, setSelectedSlashIdx] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const conversations = useChatStore((s) => s.conversations);
  const settings = useChatStore((s) => s.settings);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const createConversation = useChatStore((s) => s.createConversation);
  const addMessage = useChatStore((s) => s.addMessage);
  const toggleSkill = useChatStore((s) => s.toggleSkill);
  const clearActiveConversation = useChatStore((s) => s.clearActiveConversation);

  const activeProvider = settings?.activeProvider || "openai";
  const activeModel = settings?.activeModel || "gpt-4o";
  const apiKeys = settings?.apiKeys || { openai: "", anthropic: "", gemini: "" };
  const activeKey = apiKeys[activeProvider]?.trim();
  const hasKey = Boolean(activeKey);

  // Active skill list
  const activeSkills = (settings.skills || []).filter((s) => s.enabled);
  const primarySkill = activeSkills[0];

  // Slash commands registry
  const slashCommands: SlashCommand[] = [
    {
      id: "architect",
      command: "/architect",
      title: "Full-Stack Architect",
      description: "Clean architecture, modular TypeScript, production design",
      icon: Layers,
      action: () => {
        toggleSkill("full-stack-architect");
        setInput("");
        useAppStore.getState().addToast({
          message: "Skill toggled: Full-Stack Architect",
          type: "info",
          duration: 2500,
        });
      },
    },
    {
      id: "review",
      command: "/review",
      title: "Strict Code Reviewer",
      description: "Security audit, OWASP vulnerabilities, memory leaks",
      icon: ShieldAlert,
      action: () => {
        toggleSkill("code-reviewer");
        setInput("");
        useAppStore.getState().addToast({
          message: "Skill toggled: Strict Code Reviewer",
          type: "info",
          duration: 2500,
        });
      },
    },
    {
      id: "test",
      command: "/test",
      title: "Test & QA Engineer",
      description: "Vitest test suites, mock fixtures, edge cases",
      icon: FlaskConical,
      action: () => {
        toggleSkill("test-qa-engineer");
        setInput("");
        useAppStore.getState().addToast({
          message: "Skill toggled: Test & QA Engineer",
          type: "info",
          duration: 2500,
        });
      },
    },
    {
      id: "servicenow",
      command: "/servicenow",
      title: "ServiceNow Specialist",
      description: "Scoped Script Includes, GlideRecordSecure, ACLs",
      icon: Terminal,
      action: () => {
        toggleSkill("servicenow-specialist");
        setInput("");
        useAppStore.getState().addToast({
          message: "Skill toggled: ServiceNow Specialist",
          type: "info",
          duration: 2500,
        });
      },
    },
    {
      id: "clear",
      command: "/clear",
      title: "Clear Active Chat",
      description: "Reset conversation messages",
      icon: Trash2,
      action: () => {
        clearActiveConversation();
        setInput("");
        useAppStore.getState().addToast({
          message: "Conversation cleared",
          type: "info",
          duration: 2000,
        });
      },
    },
  ];

  // Filter slash commands
  const filteredSlashCommands = slashCommands.filter((cmd) =>
    cmd.command.toLowerCase().includes(input.toLowerCase().trim())
  );

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(
        textareaRef.current.scrollHeight,
        220
      )}px`;
    }
  }, [input]);

  // Open slash menu when input starts with /
  useEffect(() => {
    if (input.startsWith("/") && !input.includes(" ")) {
      setSlashMenuOpen(true);
      setSelectedSlashIdx(0);
    } else {
      setSlashMenuOpen(false);
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
      textareaRef.current?.focus();
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleAddFiles(e.target.files);
      e.target.value = "";
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

  // Global window paste handler
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
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
    if (!isDragging) setIsDragging(true);
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

    // Clear input & attachments
    setInput("");
    setAttachments([]);
    setSlashMenuOpen(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    // Add user message
    addMessage(targetConvId, {
      role: "user",
      content: trimmed,
      images: currentAttachments.length > 0 ? currentAttachments : undefined,
    });

    // Execute streaming completion
    executeChatStream(targetConvId);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash menu navigation
    if (slashMenuOpen && filteredSlashCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedSlashIdx((prev) => (prev + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedSlashIdx(
          (prev) => (prev - 1 + filteredSlashCommands.length) % filteredSlashCommands.length
        );
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const selected = filteredSlashCommands[selectedSlashIdx];
        if (selected) {
          selected.action();
          setSlashMenuOpen(false);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
    }

    // Send message on Enter (without Shift)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = () => {
    stopChatStream();
  };

  const estimatedDraftTokens = estimateTokens(input);

  return (
    <div className="chat-bottom-bar relative">
      {/* Composer Container */}
      <div
        ref={containerRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`chat-input-wrapper-container relative ${isDragging ? "chat-drag-active" : ""}`}
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

        {/* Slash Command Palette Popup */}
        {slashMenuOpen && filteredSlashCommands.length > 0 && (
          <div className="chat-slash-palette">
            <div className="chat-slash-header flex items-center justify-between">
              <span>Commands</span>
              <span>↑↓ to navigate</span>
            </div>
            <div className="chat-slash-list">
              {filteredSlashCommands.map((cmd, idx) => {
                const IconComponent = cmd.icon;
                const isSelected = idx === selectedSlashIdx;
                return (
                  <div
                    key={cmd.id}
                    onClick={() => {
                      cmd.action();
                      setSlashMenuOpen(false);
                    }}
                    className={`chat-slash-item ${isSelected ? "selected" : ""}`}
                  >
                    <IconComponent className="w-4 h-4 text-accent shrink-0" />
                    <div className="flex flex-col min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="chat-slash-command">{cmd.command}</span>
                        <span className="text-[11px] font-medium text-text-1 truncate">
                          {cmd.title}
                        </span>
                      </div>
                      <span className="chat-slash-desc">{cmd.description}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Attached Images Preview Tray */}
        {attachments.length > 0 && (
          <div className="chat-attachments-tray">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="chat-attachment-chip"
                title={`${att.name} (${formatFileSize(att.size)})`}
              >
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

        {/* Composer Meta Bar: Active Skill & Draft Token Estimator */}
        {(primarySkill || input.length > 10) && (
          <div className="chat-composer-status-bar">
            {primarySkill ? (
              <div
                className="chat-composer-active-skill"
                title={`Active Persona: ${primarySkill.description}`}
              >
                <Sparkles className="w-3 h-3" />
                <span>{primarySkill.name}</span>
              </div>
            ) : <div />}

            {input.length > 10 && (
              <div className="chat-composer-token-estimate">
                ~{estimatedDraftTokens} tokens
              </div>
            )}
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
                : `Message InTab AI (${activeModel}) or type / for commands...`
            }
            rows={1}
            className="chat-textarea"
            disabled={isStreaming}
          />

          {/* Clear Draft button when text entered */}
          {input.length > 0 && !isStreaming && (
            <button
              type="button"
              onClick={() => setInput("")}
              className="p-1.5 text-text-3 hover:text-text-1 transition-colors rounded"
              title="Clear draft"
              aria-label="Clear draft"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

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
