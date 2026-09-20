// ============================================================
// ChatSidebar — Minimalist, robust conversation history sidebar
// Clean layout matching ApiSidebar theme without unnecessary clutter
// ============================================================

import React, { useState, useMemo } from "react";
import {
  Plus,
  MessageSquare,
  Trash2,
  Edit2,
  Check,
  X,
  ShieldCheck,
  Search,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Copy,
  Download,
} from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { SearchInput } from "@/components/ui/search-input";
import type { ChatConversation } from "../types";
import { ProviderIcon } from "./ProviderIcon";
import "../chat.css";

function exportConversationAsMarkdown(conv: ChatConversation): void {
  const lines: string[] = [
    `# ${conv.title}`,
    `Date: ${new Date(conv.createdAt).toLocaleString()}`,
    `Model: ${conv.model} (${conv.provider})`,
    "",
    "---",
    "",
  ];

  for (const msg of conv.messages) {
    const roleLabel = msg.role === "user" ? "User" : `InTab AI (${conv.model})`;
    const timeStr = new Date(msg.timestamp).toLocaleTimeString();
    lines.push(`### ${roleLabel} • ${timeStr}`);
    lines.push(msg.content);
    lines.push("");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${conv.title.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

interface ChatSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * Format timestamp into human-readable relative time
 */
function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1d";
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Groups conversation list by chronological buckets and pinned status
 */
function groupConversationsByDate(items: ChatConversation[]) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfLast7Days = startOfToday - 6 * 86400000;

  const pinnedItems: ChatConversation[] = [];
  const todayItems: ChatConversation[] = [];
  const yesterdayItems: ChatConversation[] = [];
  const past7DaysItems: ChatConversation[] = [];
  const olderItems: ChatConversation[] = [];

  const sorted = [...items].sort(
    (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
  );

  for (const conv of sorted) {
    if (conv.pinned) {
      pinnedItems.push(conv);
      continue;
    }
    const time = conv.updatedAt || conv.createdAt || Date.now();
    if (time >= startOfToday) {
      todayItems.push(conv);
    } else if (time >= startOfYesterday) {
      yesterdayItems.push(conv);
    } else if (time >= startOfLast7Days) {
      past7DaysItems.push(conv);
    } else {
      olderItems.push(conv);
    }
  }

  const result: { label: string; items: ChatConversation[] }[] = [];
  if (pinnedItems.length > 0) result.push({ label: "Pinned", items: pinnedItems });
  if (todayItems.length > 0) result.push({ label: "Today", items: todayItems });
  if (yesterdayItems.length > 0) result.push({ label: "Yesterday", items: yesterdayItems });
  if (past7DaysItems.length > 0) result.push({ label: "Previous 7 Days", items: past7DaysItems });
  if (olderItems.length > 0) result.push({ label: "Older", items: olderItems });

  return result;
}

export function ChatSidebar({ collapsed, onToggleCollapse }: ChatSidebarProps) {
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const createConversation = useChatStore((s) => s.createConversation);
  const selectConversation = useChatStore((s) => s.selectConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const togglePinConversation = useChatStore((s) => s.togglePinConversation);
  const duplicateConversation = useChatStore((s) => s.duplicateConversation);
  const setSettingsModalOpen = useChatStore((s) => s.setSettingsModalOpen);

  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const handleStartRename = (id: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setEditTitle(currentTitle);
  };

  const handleSaveRename = (id: string) => {
    if (editTitle.trim()) {
      renameConversation(id, editTitle.trim());
    }
    setEditingId(null);
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteConversation(id);
  };

  // Filter conversations by search term
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const q = searchQuery.toLowerCase().trim();
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.model.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q))
    );
  }, [conversations, searchQuery]);

  // Group filtered conversations by chronological date categories
  const groups = useMemo(() => {
    if (searchQuery.trim()) {
      return [
        {
          label: `Search Results (${filteredConversations.length})`,
          items: filteredConversations,
        },
      ];
    }
    return groupConversationsByDate(filteredConversations);
  }, [filteredConversations, searchQuery]);

  return (
    <aside className={`chat-sidebar ${collapsed ? "chat-sidebar-collapsed" : ""}`}>
      {/* 48px Header matching ApiSidebar */}
      <div className="chat-sidebar-header">
        <div className="chat-sidebar-header-brand">
          <div className="chat-sidebar-brand-icon-wrap">
            <MessageSquare className="h-4 w-4 text-accent" />
          </div>
          <span className="chat-sidebar-header-title">AI Chat</span>
        </div>

        <SimpleTooltip
          content={collapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          side={collapsed ? "right" : "bottom"}
        >
          <button
            type="button"
            className="chat-sidebar-toggle-btn"
            onClick={onToggleCollapse}
            aria-label={collapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </SimpleTooltip>
      </div>

      {/* Action Area: New Chat & Search */}
      <div className="chat-sidebar-action-bar">
        {collapsed ? (
          <SimpleTooltip content="New Chat (⌘N)" side="right">
            <button
              type="button"
              className="chat-sidebar-icon-new-btn"
              onClick={() => createConversation()}
              aria-label="New Chat"
            >
              <Plus className="h-4 w-4 text-accent" />
            </button>
          </SimpleTooltip>
        ) : (
          <>
            <button
              type="button"
              onClick={() => createConversation()}
              className="chat-sidebar-browse-btn"
              aria-label="New Chat"
            >
              <div className="flex items-center gap-2">
                <Plus className="h-4 w-4 text-accent" />
                <span className="font-semibold">New Chat</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="chat-sidebar-shortcut-badge">⌘N</span>
              </div>
            </button>

            {conversations.length > 0 && (
              <div className="w-full">
                <SearchInput
                  placeholder="Search conversations..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onClear={() => setSearchQuery("")}
                  size="sm"
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Main Content Area: Conversations History List */}
      <div className="chat-sidebar-content">
        {collapsed ? (
          /* Collapsed Icon-Only list */
          <div className="flex flex-col items-center gap-1.5 pt-2">
            {conversations.slice(0, 15).map((conv) => {
              const isActive = conv.id === activeConversationId;
              return (
                <SimpleTooltip
                  key={conv.id}
                  content={conv.title}
                  side="right"
                >
                  <button
                    type="button"
                    onClick={() => selectConversation(conv.id)}
                    className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                      isActive
                        ? "bg-accent/15 text-accent"
                        : "text-text-3 hover:text-text-0 hover:bg-bg-2"
                    }`}
                  >
                    <ProviderIcon
                      provider={conv.provider}
                      modelId={conv.model}
                      className="h-4 w-4"
                    />
                  </button>
                </SimpleTooltip>
              );
            })}
          </div>
        ) : conversations.length === 0 ? (
          <div className="chat-history-empty">
            <MessageSquare className="h-5 w-5 opacity-30" />
            <span className="chat-history-empty-title">No Chats Yet</span>
            <p className="chat-history-empty-desc">
              Start a conversation to generate code, troubleshoot errors, and query AI models.
            </p>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="chat-history-empty">
            <Search className="h-4 w-4 opacity-30" />
            <span className="chat-history-empty-title">No Results</span>
            <p className="chat-history-empty-desc">
              No conversation matched &ldquo;{searchQuery}&rdquo;.
            </p>
          </div>
        ) : (
          <div className="chat-conversations-list">
            {groups.map((group) => (
              <div key={group.label} className="chat-group-container">
                {!searchQuery && (
                  <div className="chat-group-title">{group.label}</div>
                )}
                {group.items.map((conv) => {
                  const isActive = conv.id === activeConversationId;
                  const isEditing = conv.id === editingId;

                  return (
                    <div
                      key={conv.id}
                      className={`chat-conv-card-wrapper ${isActive ? "active" : ""}`}
                    >
                      {isEditing ? (
                        <div
                          className="chat-conv-rename-wrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ProviderIcon
                            provider={conv.provider}
                            modelId={conv.model}
                            className="h-3.5 w-3.5 shrink-0 opacity-70"
                          />
                          <input
                            type="text"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSaveRename(conv.id);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            onBlur={() => handleSaveRename(conv.id)}
                            autoFocus
                            className="chat-conv-rename-input"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveRename(conv.id)}
                            className="chat-conv-rename-btn success"
                            aria-label="Save title"
                          >
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="chat-conv-rename-btn"
                            aria-label="Cancel"
                          >
                            <X className="h-3.5 w-3.5 text-text-3" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={`chat-conv-card ${isActive ? "active" : ""}`}
                            onClick={() => selectConversation(conv.id)}
                            title={conv.title}
                          >
                            <div className="chat-conv-icon-wrap">
                              <ProviderIcon
                                provider={conv.provider}
                                modelId={conv.model}
                                className="h-3.5 w-3.5 shrink-0"
                              />
                            </div>

                            <span className="chat-conv-title truncate flex items-center gap-1">
                              {conv.pinned && (
                                <Pin className="w-2.5 h-2.5 text-accent shrink-0 fill-accent" />
                              )}
                              <span className="truncate">{conv.title}</span>
                            </span>

                            <span className="chat-conv-time shrink-0">
                              {formatRelativeTime(conv.updatedAt || conv.createdAt)}
                            </span>
                          </button>

                          <div
                            className="chat-card-actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <SimpleTooltip
                              content={conv.pinned ? "Unpin" : "Pin to top"}
                              side="top"
                            >
                              <button
                                type="button"
                                className={`chat-card-action-btn ${conv.pinned ? "text-accent" : ""}`}
                                onClick={() => togglePinConversation(conv.id)}
                                aria-label={conv.pinned ? "Unpin conversation" : "Pin conversation"}
                              >
                                {conv.pinned ? (
                                  <PinOff className="h-3 w-3" />
                                ) : (
                                  <Pin className="h-3 w-3" />
                                )}
                              </button>
                            </SimpleTooltip>

                            <SimpleTooltip content="Duplicate" side="top">
                              <button
                                type="button"
                                className="chat-card-action-btn"
                                onClick={() => duplicateConversation(conv.id)}
                                aria-label="Duplicate conversation"
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                            </SimpleTooltip>

                            <SimpleTooltip content="Export Markdown" side="top">
                              <button
                                type="button"
                                className="chat-card-action-btn"
                                onClick={() => exportConversationAsMarkdown(conv)}
                                aria-label="Export conversation"
                              >
                                <Download className="h-3 w-3" />
                              </button>
                            </SimpleTooltip>

                            <SimpleTooltip content="Rename" side="top">
                              <button
                                type="button"
                                className="chat-card-action-btn"
                                onClick={(e) => handleStartRename(conv.id, conv.title, e)}
                                aria-label="Rename conversation"
                              >
                                <Edit2 className="h-3 w-3" />
                              </button>
                            </SimpleTooltip>

                            <SimpleTooltip content="Delete" side="top">
                              <button
                                type="button"
                                className="chat-card-action-btn delete"
                                onClick={(e) => handleDelete(conv.id, e)}
                                aria-label="Delete conversation"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </SimpleTooltip>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 48px Footer matching ApiSidebar — Single, canonical place for Chat Settings */}
      <div className="chat-sidebar-footer">
        <SimpleTooltip
          content="Chat Settings"
          side={collapsed ? "right" : "top"}
        >
          <button
            type="button"
            className="chat-sidebar-footer-btn"
            onClick={() => setSettingsModalOpen(true)}
            aria-label="Chat Settings"
          >
            <div className="chat-sidebar-footer-icon-wrap">
              <Settings className="h-4 w-4 chat-sidebar-settings-icon" />
            </div>
            <span className="chat-sidebar-footer-label">Settings</span>
          </button>
        </SimpleTooltip>

        {!collapsed && (
          <div
            className="chat-sidebar-vault-badge"
            title="Locally encrypted using AES-256-GCM"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            <span>Vault</span>
          </div>
        )}
      </div>
    </aside>
  );
}
