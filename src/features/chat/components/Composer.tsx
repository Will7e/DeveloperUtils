// ============================================================
// Composer — Message Input with Slash Commands, Attachments & Send
// ============================================================
// Auto-growing textarea. Enter sends, Shift+Enter adds a newline.
// Slash commands: a draft starting with "/" opens the command menu
// above the input — arrows navigate, Enter/Tab runs, Esc closes;
// /model swaps in the model catalog as an inline submenu.
//
// Hard rule enforced here: a draft that starts with "/" is NEVER sent
// as a message. Enter/Tab always belong to the menu while a slash
// draft is present, so a half-typed command can't leak into the
// transcript as a prompt (it used to, whenever the token wasn't an
// exact command id). The menu also opens while a reply is streaming,
// which is what makes /stop reachable from the keyboard.
// Attachments: paperclip picker, clipboard image paste, and file
// drop — image files become multimodal attachments, text files are
// inlined as fenced code blocks in the draft. While this
// conversation streams, the send button becomes Stop (keeps partial
// output). When a stream runs in another conversation, the composer
// is disabled with a clear hint.

import React, { useRef, useState } from "react";
import {
  ArrowUp,
  FileText,
  ImagePlus,
  Paperclip,
  Slash,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useFileDrop } from "@/hooks/useFileDrop";
import { DropOverlay } from "@/hooks/DropOverlay";
import { useAppStore } from "@/stores/app.store";
import { importChatFiles, MAX_ATTACHMENTS } from "../lib/attachments";
import { CHAT_COMMAND_BY_ID, commandsFor, type ChatCommand } from "../lib/commands";
import { CommandMenu, type CommandMenuMode } from "./CommandMenu";
import {
  CURATED_FALLBACK_MODELS,
  INTAB_MODEL_ID,
  INTAB_VIRTUAL_MODEL,
  intabTierById,
  PINNED_MODEL_IDS,
} from "../constants";
import type { ChatAttachment, ModelInfo } from "../types";

/** Draft-level attachment state lives in ChatPage as ChatAttachment[] */

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** True while THIS conversation is streaming */
  isStreaming: boolean;
  /** True when a stream is running in a different conversation */
  disabled?: boolean;
  /** Placeholder hint, e.g. active model */
  placeholder?: string;
  /** Optional external handle so the page can focus the input */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Pending image attachments (page-owned state) */
  attachments?: ChatAttachment[];
  /** Replace the pending image list */
  onAttachmentsChange?: (next: ChatAttachment[]) => void;
  /** Append inlined text-file content into the draft */
  onTextFilesImported?: (markdown: string) => void;
  /** Whether the resolved model advertises image input (null = unknown) */
  modelSupportsImages?: boolean | null;
  /** Live model catalog for the /model submenu */
  models?: ModelInfo[];
  /** True while the catalog request is in flight */
  modelsLoading?: boolean;
  /** Model id active for this conversation (checkmark in submenu) */
  activeModelId?: string;
  /**
   * Runs a picked slash command with everything typed after it.
   * The page clears the draft; the menu stays open for submenus
   * (hasSubmenu) so the user can keep typing an argument.
   */
  onRunCommand?: (command: ChatCommand, arg: string) => void;
  /** Switch model for this conversation (submenu pick) */
  onModelChange?: (modelId: string) => void;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  disabled = false,
  placeholder,
  inputRef,
  attachments = [],
  onAttachmentsChange,
  onTextFilesImported,
  modelSupportsImages = null,
  models = [],
  modelsLoading = false,
  activeModelId,
  onRunCommand,
  onModelChange,
}: ComposerProps) {
  const innerRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [cmdHighlighted, setCmdHighlighted] = useState(0);
  const [cmdMode, setCmdMode] = useState<CommandMenuMode>("commands");
  const addToast = useAppStore((s) => s.addToast);

  const setRefs = React.useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (inputRef) inputRef.current = el;
    },
    [inputRef]
  );

  const grow = React.useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  // Auto-grow as the value changes and when window resizing reflows
  // the text into more/fewer lines.
  React.useEffect(() => {
    grow();
  }, [value, grow]);

  React.useEffect(() => {
    window.addEventListener("resize", grow);
    return () => window.removeEventListener("resize", grow);
  }, [grow]);

  const hasImages = attachments.length > 0;
  const canSend = (value.trim().length > 0 || hasImages) && !isStreaming && !disabled;

  // ── Slash command menu state ──
  // Two related flags, deliberately separate:
  //  · isSlashDraft — the draft starts with "/". While true, Enter
  //    and Tab belong to the menu and NEVER send the text.
  //  · menuVisible — the list is on screen. Escape hides the list but
  //    leaves the guard (and the text) in place, so Escape can't turn
  //    a half-typed command into a sent message.
  const isSlashDraft = value.startsWith("/") && !disabled;
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menuVisible = isSlashDraft && !menuDismissed;

  const afterSlash = isSlashDraft ? value.slice(1) : "";
  const spaceIdx = afterSlash.indexOf(" ");
  const cmdToken = isSlashDraft ? (spaceIdx === -1 ? afterSlash : afterSlash.slice(0, spaceIdx)) : "";
  const cmdQuery = cmdToken;
  const cmdArg = isSlashDraft && spaceIdx !== -1 ? afterSlash.slice(spaceIdx + 1).trim() : "";
  const activeCommand = CHAT_COMMAND_BY_ID.get(cmdToken);
  const modelMode = menuVisible && activeCommand?.hasSubmenu === true;

  const filteredCommands = React.useMemo(
    () => (isSlashDraft ? commandsFor(cmdQuery, { isStreaming }) : []),
    [isSlashDraft, cmdQuery, isStreaming]
  );
  const commandsValid = filteredCommands.some((c) => c.id === cmdToken);

  /** Edits reopen a dismissed menu (typing again is a new intent) */
  const handleChange = (next: string) => {
    if (menuDismissed) setMenuDismissed(false);
    onChange(next);
  };

  const filteredModels = React.useMemo(() => {
    if (!modelMode) return [];
    const q = cmdArg.toLowerCase();
    const baseCatalog = models.length > 0 ? models : CURATED_FALLBACK_MODELS;
    // A single "InTab Flash" entry leads the submenu — the quality
    // tier lives in the header's TierPicker, not the model list.
    const injected = baseCatalog.some((m) => m.id === INTAB_MODEL_ID)
      ? baseCatalog.filter((m) => !intabTierById(m.id))
      : [INTAB_VIRTUAL_MODEL, ...baseCatalog.filter((m) => !intabTierById(m.id))];
    const catalog = injected.some((m) => m.id === INTAB_VIRTUAL_MODEL.id)
      ? injected
      : [INTAB_VIRTUAL_MODEL, ...injected];
    const matches = q
      ? catalog.filter(
          (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
        )
      : catalog;
    const pinned = matches.filter((m) => PINNED_MODEL_IDS.includes(m.id));
    const rest = matches
      .filter((m) => !PINNED_MODEL_IDS.includes(m.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...pinned, ...rest].slice(0, 60);
  }, [modelMode, cmdArg, models]);

  // Highlight/highlighted list length converges on the current mode.
  const menuRowCount = modelMode ? filteredModels.length : filteredCommands.length;

  // Reset highlight to the top whenever the query or mode changes
  // (render-time adjustment — converges before commit; see
  // react.dev/learn/you-might-not-need-an-effect).
  const navKey = `${cmdQuery}|${cmdArg}|${cmdMode}|${isStreaming}`;
  const [prevNavKey, setPrevNavKey] = useState(navKey);
  if (prevNavKey !== navKey) {
    setPrevNavKey(navKey);
    setCmdHighlighted(0);
  } else if (cmdHighlighted >= menuRowCount && menuRowCount > 0) {
    setCmdHighlighted(menuRowCount - 1);
  }

  const handleFiles = React.useCallback(
    async (files: File[]) => {
      if (disabled || isStreaming) return;
      setImporting(true);
      try {
        const outcome = await importChatFiles(files);
        outcome.rejected.forEach(({ name, reason }) =>
          addToast({ message: `${name}: ${reason}`, type: "error", duration: 3500 })
        );
        if (outcome.attachments.length > 0 && onAttachmentsChange) {
          onAttachmentsChange([...attachments, ...outcome.attachments].slice(0, MAX_ATTACHMENTS));
        }
        if (outcome.textBlocks && onTextFilesImported) {
          onTextFilesImported(outcome.textBlocks);
        }
      } finally {
        setImporting(false);
      }
    },
    [attachments, disabled, isStreaming, addToast, onAttachmentsChange, onTextFilesImported]
  );

  const { isOver, dropHandlers } = useFileDrop(handleFiles, disabled || isStreaming);

  const handlePaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/")
      );
      if (files.length > 0) {
        e.preventDefault();
        void handleFiles(files);
      }
    },
    [handleFiles]
  );

  const clearDraft = () => {
    onChange("");
    setMenuDismissed(false);
    setCmdMode("commands");
  };

  /** Runs a command from the menu (click or keyboard). */
  const runCommand = (command: ChatCommand) => {
    if (!onRunCommand) return;
    if (command.hasSubmenu) {
      // With an argument typed, run directly (e.g. "/model sonnet").
      if (cmdArg.trim()) {
        onRunCommand(command, cmdArg);
        clearDraft();
        innerRef.current?.focus();
      } else {
        setCmdMode("model");
      }
      return;
    }
    // Argument-taking commands (/tier light, /rename …) must receive
    // what was typed after the token; passing "" here made every one
    // of them run their usage/no-argument branch instead.
    onRunCommand(command, cmdArg);
    clearDraft();
    innerRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuVisible) {
      // Navigation works whenever there is a selectable row.
      if (menuRowCount > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setCmdHighlighted((i) => (i + 1) % menuRowCount);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setCmdHighlighted((i) => (i - 1 + menuRowCount) % menuRowCount);
          return;
        }
      }

      if (e.key === "Tab" || e.key === "Enter") {
        // The menu owns Enter/Tab for ANY slash draft — matched or
        // not. Unmatched input keeps its text and is never sent.
        e.preventDefault();
        if (modelMode) {
          const picked = filteredModels[cmdHighlighted];
          if (picked && onModelChange) {
            onModelChange(picked.id);
            setCmdMode("commands");
            clearDraft();
            innerRef.current?.focus();
          }
          return;
        }
        if (activeCommand?.hasSubmenu && !cmdArg.trim()) {
          // "/model" with no argument opens the model list.
          setCmdMode("model");
          return;
        }
        const picked = commandsValid ? activeCommand : filteredCommands[cmdHighlighted];
        if (picked) runCommand(picked);
        return;
      }
    }

    if (isSlashDraft) {
      // The guard that matters: while the draft is a slash draft, a
      // bare Enter never sends it. Unmatched commands keep their text
      // (and the menu explains), instead of becoming a prompt.
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        return;
      }

      if (e.key === "Escape") {
        // First Escape closes the menu and keeps what was typed (the
        // draft is often an argument being written); a second one
        // clears it.
        e.preventDefault();
        if (modelMode) {
          setCmdMode("commands");
        } else {
          setMenuDismissed(true);
        }
        innerRef.current?.focus();
        return;
      }

      if (e.key === " " && !modelMode && !activeCommand && menuRowCount > 0) {
        // Complete the highlighted command and keep typing its
        // argument ("comp" → "compact ").
        const picked = filteredCommands[cmdHighlighted];
        if (picked) {
          e.preventDefault();
          setCmdMode("commands");
          handleChange(`/${picked.id} `);
        }
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const imageWarning = hasImages && modelSupportsImages === false;

  const placeholderText = disabled
    ? "Generating a response in another chat…"
    : placeholder ?? "Message models… (Enter to send · Shift+Enter newline · / for commands)";

  return (
    <div
      className="chat-composer-wrap"
      {...dropHandlers}
      onPaste={handlePaste as unknown as React.ClipboardEventHandler<HTMLDivElement>}
    >
      <DropOverlay show={isOver} label="Drop files to attach" />

      {/* Hidden image picker for the paperclip */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void handleFiles(files);
          e.target.value = "";
        }}
      />

      {hasImages && (
        <div className="chat-attach-chips" role="list" aria-label="Attached images">
          {attachments.map((att) => (
            <div key={att.id} className="chat-attach-chip" role="listitem">
              {att.dataUrl ? (
                <img src={att.dataUrl} alt={att.name} className="chat-attach-thumb" />
              ) : (
                <FileText className="chat-attach-thumb chat-attach-thumb-placeholder" />
              )}
              <div className="chat-attach-meta">
                <span className="chat-attach-name" title={att.name}>{att.name}</span>
                <span className="chat-attach-size">{formatBytes(att.size)}</span>
              </div>
              <button
                type="button"
                className="chat-attach-remove"
                onClick={() => onAttachmentsChange?.(attachments.filter((a) => a.id !== att.id))}
                aria-label={`Remove ${att.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {attachments.length >= MAX_ATTACHMENTS && (
            <span className="chat-attach-cap">Max {MAX_ATTACHMENTS} images</span>
          )}
        </div>
      )}

      {imageWarning && (
        <div className="chat-attach-warning" role="status">
          <TriangleAlert className="h-3 w-3" />
          <span>Current model may not support images — pick a vision model for best results.</span>
        </div>
      )}

      <div className={`chat-composer ${isStreaming ? "chat-composer-streaming" : ""}`}>
        <SimpleTooltip content="Attach images" side="top">
          <button
            type="button"
            className="chat-composer-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || isStreaming}
            aria-label="Attach images"
          >
            {importing ? <ImagePlus className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
          </button>
        </SimpleTooltip>

        {isSlashDraft && (
          <span className="chat-command-indicator" aria-hidden="true">
            <Slash className="h-3 w-3" />
          </span>
        )}

        <textarea
          ref={setRefs}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholderText}
          className={`chat-composer-input ${isSlashDraft ? "chat-composer-input-slash" : ""}`}
          rows={1}
          disabled={disabled}
          aria-label="Chat message"
          aria-busy={isStreaming}
          aria-expanded={menuVisible}
          aria-controls={menuVisible ? "chat-command-listbox" : undefined}
          aria-activedescendant={
            menuVisible && menuRowCount > 0 ? `chat-command-opt-${cmdHighlighted}` : undefined
          }
        />

        {isStreaming ? (
          <SimpleTooltip content="Stop generating" side="top">
            <button
              type="button"
              className="chat-composer-stop"
              onClick={onStop}
              aria-label="Stop generating"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          </SimpleTooltip>
        ) : (
          <SimpleTooltip content="Send message" shortcut="↵" side="top">
            <button
              type="button"
              className="chat-composer-send"
              onClick={onSend}
              disabled={!canSend}
              aria-label="Send message"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </SimpleTooltip>
        )}
      </div>

      {menuVisible && (
        <CommandMenu
          query={cmdQuery}
          arg={cmdArg}
          models={models}
          activeModelId={activeModelId ?? ""}
          modelsLoading={modelsLoading}
          highlightedIdx={cmdHighlighted}
          mode={cmdMode}
          filteredCommands={filteredCommands}
          filteredModels={filteredModels}
          isStreaming={isStreaming}
          onSelectCommand={runCommand}
          onSelectModel={(id) => {
            onModelChange?.(id);
            clearDraft();
            innerRef.current?.focus();
          }}
        />
      )}

      <div className="chat-composer-footer">
        <span className="chat-composer-hint">
          {disabled
            ? "You can keep browsing — sending resumes when the other chat finishes."
            : isStreaming
              ? "Replying… type / and press Enter for /stop · /status · /context"
              : "Type / for commands · /help lists them all · Responses may be inaccurate — verify important information."}
        </span>
      </div>
      <span className="chat-sr-only" aria-live="polite">
        {isStreaming ? "Assistant is responding" : ""}
      </span>
    </div>
  );
}
