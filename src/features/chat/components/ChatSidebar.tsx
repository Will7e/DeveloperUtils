// ============================================================
// Chat Sidebar — Conversation List with Search & Management
// ============================================================
// Doubles as an off-canvas drawer below 860px (open state is
// controlled by the page via `open`/`onClose`).

import React from "react";
import {
  Check,
  Copy,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { ChatConversation } from "../types";

interface ChatSidebarProps {
  conversations: ChatConversation[];
  activeId: string | null;
  /** Off-canvas drawer open state (below 860px only) */
  open: boolean;
  /** Request to close the drawer (scrim click / selection) */
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onTogglePin: (id: string) => void;
  onOpenSettings?: () => void;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ChatSidebar({
  conversations,
  activeId,
  open,
  onClose,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onDuplicate,
  onTogglePin,
  onOpenSettings,
}: ChatSidebarProps) {
  const [query, setQuery] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);

  // Disarm a pending delete when the pointer leaves that row or the
  // target changes, so the armed state never goes stale.
  React.useEffect(() => {
    if (!confirmDeleteId) return;
    const t = window.setTimeout(() => setConfirmDeleteId(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirmDeleteId]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? conversations.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            c.messages.some((m) => m.content.toLowerCase().includes(q))
        )
      : conversations;
    // Pinned first, then by recency
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }, [conversations, query]);

  const startRename = (conv: ChatConversation) => {
    setRenamingId(conv.id);
    setRenameValue(conv.title);
    setConfirmDeleteId(null);
  };

  const commitRename = () => {
    if (renamingId) {
      onRename(renamingId, renameValue);
    }
    setRenamingId(null);
  };

  const handleDelete = (id: string) => {
    if (confirmDeleteId === id) {
      onDelete(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
    }
  };

  return (
    <>
      {/* Scrim only exists under 860px (display: none above) */}
      {open && (
        <button
          type="button"
          className="chat-sidebar-scrim"
          onClick={onClose}
          aria-label="Close conversation list"
          tabIndex={-1}
        />
      )}
      <aside className={cn("chat-sidebar", open && "chat-sidebar-open")}>
        <div className="chat-sidebar-header">
          <div className="chat-sidebar-title">
            <MessageSquareText className="h-4 w-4" />
            <span>Chats</span>
          </div>
          <SimpleTooltip content="New chat" shortcut="⌘⇧N" side="bottom">
            <button
              type="button"
              className="chat-sidebar-new-btn"
              onClick={onNew}
              aria-label="New chat"
            >
              <Plus className="h-4 w-4" />
            </button>
          </SimpleTooltip>
        </div>

        <div className="chat-sidebar-search">
          <Search className="h-3.5 w-3.5 chat-sidebar-search-icon" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="chat-sidebar-search-input"
          />
          {query && (
            <button
              type="button"
              className="chat-sidebar-search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className="chat-sidebar-list">
          {filtered.length === 0 && (
            <div className="chat-sidebar-empty">
              {query ? (
                <>
                  No chats match <strong>“{query}”</strong>.
                </>
              ) : (
                "No chats yet — start one!"
              )}
            </div>
          )}

          {filtered.map((conv) => {
            const isActive = conv.id === activeId;
            const isRenaming = conv.id === renamingId;
            const isConfirmingDelete = conv.id === confirmDeleteId;
            const lastMessage = conv.messages[conv.messages.length - 1];
            const preview =
              lastMessage && lastMessage.compactedFrom === undefined
                ? lastMessage.content.slice(0, 60)
                : "";

            return (
              <div
                key={conv.id}
                className={cn("chat-conv-item", isActive && "chat-conv-item-active")}
                onClick={() => !isRenaming && onSelect(conv.id)}
                role="button"
                tabIndex={0}
                aria-current={isActive ? "true" : undefined}
                onKeyDown={(e) => {
                  if (isRenaming) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(conv.id);
                  }
                }}
              >
                {isRenaming ? (
                  <div className="chat-conv-rename">
                    <input
                      type="text"
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={commitRename}
                      className="chat-conv-rename-input"
                      aria-label="Conversation name"
                    />
                    <button
                      type="button"
                      className="chat-conv-action"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        commitRename();
                      }}
                      aria-label="Confirm rename"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="chat-conv-item-content">
                      <div className="chat-conv-item-top">
                        <span className="chat-conv-item-title">{conv.title}</span>
                        <span className="chat-conv-item-time">
                          {formatRelative(conv.updatedAt)}
                        </span>
                      </div>
                      {preview && (
                        <div className="chat-conv-item-preview">{preview}</div>
                      )}
                    </div>
                    <div className="chat-conv-item-actions">
                      <SimpleTooltip content={conv.pinned ? "Unpin" : "Pin"} side="top">
                        <button
                          type="button"
                          className="chat-conv-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            onTogglePin(conv.id);
                          }}
                          aria-label={conv.pinned ? "Unpin conversation" : "Pin conversation"}
                        >
                          {conv.pinned ? (
                            <PinOff className="h-3.5 w-3.5" />
                          ) : (
                            <Pin className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </SimpleTooltip>
                      <SimpleTooltip content="Rename" side="top">
                        <button
                          type="button"
                          className="chat-conv-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(conv);
                          }}
                          aria-label="Rename conversation"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </SimpleTooltip>
                      <SimpleTooltip content="Duplicate" side="top">
                        <button
                          type="button"
                          className="chat-conv-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDuplicate(conv.id);
                          }}
                          aria-label="Duplicate conversation"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </SimpleTooltip>
                      <SimpleTooltip
                        content={isConfirmingDelete ? "Click again to delete" : "Delete"}
                        side="top"
                      >
                        <button
                          type="button"
                          className={cn(
                            "chat-conv-action chat-conv-action-danger",
                            isConfirmingDelete && "chat-conv-action-confirm"
                          )}
                          onMouseLeave={() =>
                            setConfirmDeleteId((id) => (id === conv.id ? null : id))
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(conv.id);
                          }}
                          aria-label={
                            isConfirmingDelete
                              ? "Click again to confirm delete"
                              : "Delete conversation"
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </SimpleTooltip>
                    </div>
                    {conv.pinned && <div className="chat-conv-pin-dot" />}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Sidebar Footer */}
        {onOpenSettings && (
          <div className="chat-sidebar-footer">
            <SimpleTooltip content="AI Chat Settings" side="top">
              <button
                type="button"
                className="chat-sidebar-footer-btn"
                onClick={onOpenSettings}
                aria-label="AI Chat Settings"
              >
                <div className="chat-sidebar-footer-icon-wrap">
                  <Settings className="h-4 w-4 chat-sidebar-settings-icon" />
                </div>
                <span className="chat-sidebar-footer-label">Settings</span>
              </button>
            </SimpleTooltip>
          </div>
        )}
      </aside>
    </>
  );
}
