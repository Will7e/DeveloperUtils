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
// Mentions: "@" opens the repository-file picker; the picked path is
// inserted as text and resolved to file CONTENTS at send time (see
// services/mention-context.ts). The menu appears only when there are
// matching files, so prose like "install @types/node" is unaffected.
// Attachments: paperclip picker, clipboard image paste, and file
// drop — image files become multimodal attachments, text files are
// inlined as fenced code blocks in the draft. While this
// conversation streams, the send button becomes Stop (keeps partial
// output). When a stream runs in another conversation, the composer
// is disabled with a clear hint.

import React, { useRef, useState } from "react";
import {
  ArrowUp,
  Clock,
  FileText,
  ImagePlus,
  Paperclip,
  Slash,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useFileDrop } from "@/hooks/useFileDrop";
import { DropOverlay } from "@/hooks/DropOverlay";
import { useAppStore } from "@/stores/app.store";
import { importChatFiles, MAX_ATTACHMENTS } from "../lib/attachments";
import { CHAT_COMMANDS, CHAT_COMMAND_BY_ID, commandsFor, type ChatCommand } from "../lib/commands";
import { resolveSlashInput } from "../lib/slash";
import { CommandMenu, type CommandMenuMode } from "./CommandMenu";
import { MentionMenu } from "./MentionMenu";
import { applyMention, findMentionQuery, rankMentionCandidates } from "../lib/mentions";
import { CURATED_FALLBACK_MODELS, PINNED_MODEL_IDS } from "../constants";
import type {
  AgentSuggestion,
  ChatAttachment,
  ChatMode,
  ModelInfo,
  QueuedUserMessage,
} from "../types";

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
  /** Agent mode — surfaces a read-only notice while Plan is active */
  mode?: ChatMode;
  /**
   * Runs a picked slash command with everything typed after it.
   * The page clears the draft; the menu stays open for submenus
   * (hasSubmenu) so the user can keep typing an argument.
   */
  onRunCommand?: (command: ChatCommand, arg: string) => void;
  /** Switch model for this conversation (submenu pick) */
  onModelChange?: (modelId: string) => void;
  /**
   * Repository paths the "@" picker may offer. Empty (or unattached repo)
   * simply means no mention menu — the token stays plain text.
   */
  mentionPaths?: string[];
  /**
   * Clickable next steps the agent offered (`suggest_next`). They render
   * above the input because that is where the NEXT message comes from.
   */
  suggestions?: AgentSuggestion[];
  /** Sends one offered next step */
  onSuggestion?: (prompt: string) => void;
  /**
   * Messages sent while the reply in progress was still running. They are
   * waiting for the next round boundary, so they are shown as queued rather
   * than as sent — with a way to take one back before it is delivered.
   */
  queued?: QueuedUserMessage[];
  onRemoveQueued?: (id: string) => void;
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
  mode = "build",
  onRunCommand,
  onModelChange,
  mentionPaths = [],
  suggestions = [],
  onSuggestion,
  queued = [],
  onRemoveQueued,
}: ComposerProps) {
  const innerRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [cmdHighlighted, setCmdHighlighted] = useState(0);
  const [cmdMode, setCmdMode] = useState<CommandMenuMode>("commands");
  // Caret position is needed by the mention rules (an "@" only counts when
  // the caret is inside it), and a mention candidate set is only shown when
  // it is non-empty, so "install @types/node" never opens a menu.
  const [caret, setCaret] = useState(0);
  const [mentionHighlighted, setMentionHighlighted] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  const setRefs = React.useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (inputRef) inputRef.current = el;
    },
    [inputRef]
  );

  const heightForWidth = React.useRef(0);

  const grow = React.useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    heightForWidth.current = el.clientWidth;
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

  /**
   * Auto-grow when the BOX resizes, which a window listener cannot see.
   *
   * Opening the Changes panel (and dragging its split handle) narrows this
   * container without a window resize event, so the height computed for the
   * old width survived: the same draft that fitted in two lines was then
   * clipped behind an inner scrollbar, and widening again left the box
   * standing taller than its content. Only a change of WIDTH recomputes the
   * height — the observer also fires for the heights this function sets, and
   * reacting to those would be a loop.
   */
  React.useEffect(() => {
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== heightForWidth.current) grow();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [grow]);

  const hasImages = attachments.length > 0;
  // A draft IS sendable while this conversation is replying: it is queued
  // and delivered at the next round boundary (the runner decides that; the
  // button must not lie about it, which is what `!isStreaming` did here).
  // `disabled` still means a stream owns the page in ANOTHER conversation.
  const canSend = (value.trim().length > 0 || hasImages) && !disabled;

  // ── Slash command menu state ──
  // Three related flags, deliberately separate:
  //  · isSlashDraft — the draft starts with "/".
  //  · slashIsProse — the draft starts with "/" and is a SENTENCE, not a
  //    command attempt: an unknown token that carries arguments
  //    ("/usr/bin/env is broken", a path, a quoted line). The resolver
  //    calls this a message, so the composer must let it be sent —
  //    swallowing Enter for it made the only way out of a slash draft a
  //    mouse click on Send.
  //  · menuVisible — the list is on screen. Escape hides the list but
  //    leaves the guard (and the text) in place, so Escape can't turn
  //    a half-typed command into a sent message.
  const isSlashDraft = value.startsWith("/") && !disabled;
  const [menuDismissed, setMenuDismissed] = useState(false);
  const slashIsProse =
    isSlashDraft && resolveSlashInput(value, CHAT_COMMANDS).kind === "message";
  const menuVisible = isSlashDraft && !menuDismissed && !slashIsProse;

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

  // ── @-mention menu state ──
  // Unlike the slash menu this one is NOT modal: the draft is ordinary
  // prose that happens to contain an @-token, so Enter still sends unless
  // the menu is actually showing rows.
  const mentionQuery = findMentionQuery(value, caret);
  const mentionCandidates = React.useMemo(
    () =>
      mentionQuery.active && mentionPaths.length > 0
        ? rankMentionCandidates(mentionQuery.query, mentionPaths)
        : [],
    [mentionQuery.active, mentionQuery.query, mentionPaths]
  );
  const mentionVisible =
    mentionQuery.active && !mentionDismissed && mentionCandidates.length > 0 && !isSlashDraft && !disabled;

  /** Edits reopen a dismissed menu (typing again is a new intent) */
  const handleChange = (next: string, nextCaret?: number) => {
    if (menuDismissed) setMenuDismissed(false);
    if (mentionDismissed) setMentionDismissed(false);
    setCaret(nextCaret ?? next.length);
    onChange(next);
  };

  const insertMention = (path: string) => {
    const out = applyMention(value, mentionQuery, path);
    setMentionHighlighted(0);
    setCaret(out.caret);
    onChange(out.text);
    // Restore the caret after React writes the new value.
    requestAnimationFrame(() => {
      const el = innerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(out.caret, out.caret);
    });
  };

  const filteredModels = React.useMemo(() => {
    if (!modelMode) return [];
    const q = cmdArg.toLowerCase();
    // Real models only — the catalog IS the list.
    const catalog = models.length > 0 ? models : CURATED_FALLBACK_MODELS;
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

  // Keep the mention highlight inside the shrinking candidate list.
  if (mentionHighlighted >= mentionCandidates.length && mentionCandidates.length > 0) {
    setMentionHighlighted(mentionCandidates.length - 1);
  }

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
    if (mentionVisible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionHighlighted((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionHighlighted((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        // The menu owns Enter only while it is showing rows — that is the
        // one case where the user is picking a file rather than sending.
        e.preventDefault();
        const picked = mentionCandidates[mentionHighlighted];
        if (picked) insertMention(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }

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

    if (isSlashDraft && !slashIsProse) {
      // The guard that matters: while the draft is a command attempt, a
      // bare Enter never sends it. Unmatched commands keep their text
      // (and the menu explains), instead of becoming a prompt. A draft the
      // resolver reads as prose is excluded — it falls through to the
      // ordinary Enter-to-send path below.
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
    : (placeholder ??
      "Message models… (Enter to send · Shift+Enter newline · / for commands)");

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

      {/* Next steps the agent offered, and anything the user sent mid-turn.
          Both sit ABOVE the input because both are about the next message:
          one chip sends one, and a queued message is already on its way. */}
      {suggestions.length > 0 && (
        <div className="chat-suggest-row" role="group" aria-label="Suggested next steps">
          {suggestions.map((s) => (
            <button
              key={`${s.label}:${s.prompt}`}
              type="button"
              className="chat-suggest-chip"
              onClick={() => onSuggestion?.(s.prompt)}
              title={s.prompt}
            >
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      )}

      {queued.length > 0 && (
        <div className="chat-queued-row" role="status" aria-label="Messages queued for the next step">
          {queued.map((q) => (
            <span key={q.id} className="chat-queued-chip" title={q.text}>
              <Clock className="h-3 w-3" aria-hidden="true" />
              <span className="chat-queued-text">{q.text}</span>
              <button
                type="button"
                className="chat-queued-remove"
                onClick={() => onRemoveQueued?.(q.id)}
                aria-label="Remove queued message"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
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
          onChange={(e) => handleChange(e.target.value, e.target.selectionStart)}
          onKeyDown={handleKeyDown}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          placeholder={placeholderText}
          className={`chat-composer-input ${isSlashDraft ? "chat-composer-input-slash" : ""}`}
          rows={1}
          disabled={disabled}
          aria-label="Chat message"
          aria-busy={isStreaming}
          aria-expanded={menuVisible || mentionVisible}
          aria-controls={
            menuVisible ? "chat-command-listbox" : mentionVisible ? "chat-mention-listbox" : undefined
          }
          aria-activedescendant={
            menuVisible && menuRowCount > 0
              ? `chat-command-opt-${cmdHighlighted}`
              : mentionVisible
                ? `chat-mention-opt-${mentionHighlighted}`
                : undefined
          }
        />

        {/* Stop and Send are NOT alternatives: while a turn runs the user
            needs both — stop what is happening, or say something about it
            without waiting for it to finish. */}
        {isStreaming && (
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
        )}
        <SimpleTooltip
          content={isStreaming ? "Queue for the next step" : "Send message"}
          shortcut="↵"
          side="top"
        >
          <button
            type="button"
            className="chat-composer-send"
            onClick={onSend}
            disabled={!canSend}
            aria-label={isStreaming ? "Queue message" : "Send message"}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </SimpleTooltip>
      </div>

      {mentionVisible && (
        <MentionMenu
          candidates={mentionCandidates}
          highlightedIdx={mentionHighlighted}
          query={mentionQuery.query}
          onSelect={insertMention}
        />
      )}

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
        {mode === "plan" && (
          <span className="chat-composer-mode-badge" role="status">
            Plan mode — read-only: the agent proposes changes, it cannot apply them
          </span>
        )}
        <span className="chat-composer-hint">
          {disabled
            ? "You can keep browsing — sending resumes when the other chat finishes."
            : isStreaming
              ? "Replying… send to queue it for the next step · /stop ends the turn"
              : mode === "plan"
                ? "Type / for commands · /build switches back to editing"
                : "Type / for commands · /help lists them all · Responses may be inaccurate — verify important information."}
        </span>
      </div>
      <span className="chat-sr-only" aria-live="polite">
        {isStreaming ? "Assistant is responding" : ""}
      </span>
    </div>
  );
}
