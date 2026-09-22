// ============================================================
// Chat Sidebar — Conversations, Filed Under Their Repository
// ============================================================
// Doubles as an off-canvas drawer below 860px (open state is controlled by the
// page via `open`/`onClose`).
//
// The list is grouped by repository because that is what a thread belongs to:
// the workspace model makes a chat a session on a repo, and a flat list says
// the opposite. Repeating `acme/web` down eight rows spends the scarce width
// on the same word, mixes two projects into one recency order, and cannot
// answer the two questions the user actually has — "what am I working on in
// this repo?" and "how much of it is not pushed yet?". Both of those are
// properties of the GROUP, so they live on its header.
//
// The rules with a right answer (ordering, the changed-file sum, what search
// matches) are in ../lib/conversation-groups.ts, where they are tested.
// ============================================================

import React from "react";
import {
  ChevronRight,
  Check,
  Copy,
  GitBranch,
  GitFork,
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
import { useLocalStorageState } from "@/hooks/useLocalStorageState";
import type { ChatConversation } from "../types";
import {
  conversationMatchesQuery,
  conversationRowMeta,
  groupConversationsByRepository,
  hasRowMeta,
  type ConversationGroup,
  type RepoIdentity,
} from "../lib/conversation-groups";
import { formatRelativeTime } from "../lib/relative-time";

/** Where a group header's "new chat here" attaches the new thread */
export interface RepoSelectionSeed extends RepoIdentity {
  branch: string;
}

interface ChatSidebarProps {
  conversations: ChatConversation[];
  activeId: string | null;
  /** Off-canvas drawer open state (below 860px only) */
  open: boolean;
  /** Request to close the drawer (scrim click / selection) */
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  /**
   * Start a chat ON this repository, without going through attach-then-switch.
   *
   * The whole reason to group by repo is that "another thread about this
   * project" is the common case. Making the user create a chat and then
   * re-attach the repo they are already looking at is the friction the
   * grouping is supposed to remove.
   */
  onNewInRepo?: (repo: RepoSelectionSeed) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onTogglePin: (id: string) => void;
  onOpenSettings?: () => void;
}

export function ChatSidebar({
  conversations,
  activeId,
  open,
  onClose,
  onSelect,
  onNew,
  onNewInRepo,
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
  /** Collapsed group keys, remembered across reloads — folding a repo away is
      a statement about how you work, not about this session. */
  const [collapsedKeys, setCollapsedKeys] = useLocalStorageState<string[]>(
    "intab_chat_collapsed_repos",
    []
  );

  // Disarm a pending delete when the pointer leaves that row or the
  // target changes, so the armed state never goes stale.
  React.useEffect(() => {
    if (!confirmDeleteId) return;
    const t = window.setTimeout(() => setConfirmDeleteId(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirmDeleteId]);

  /**
   * What a new chat will start from.
   *
   * The store hands a new chat the active chat's repository, so the button
   * that creates one says so. An inherited context that nothing announces is
   * indistinguishable from a bug when it is wrong, and from nothing at all
   * when it is right.
   */
  const inheritedRepo = React.useMemo(
    () => conversations.find((c) => c.id === activeId)?.repoContext,
    [conversations, activeId]
  );

  const searching = query.trim().length > 0;

  const groups = React.useMemo(() => {
    const list = searching
      ? conversations.filter((c) => conversationMatchesQuery(c, query))
      : conversations;
    return groupConversationsByRepository(list);
  }, [conversations, query, searching]);

  const matchedCount = React.useMemo(
    () => groups.reduce((sum, group) => sum + group.conversations.length, 0),
    [groups]
  );

  const toggleGroup = (key: string) => {
    setCollapsedKeys((keys) =>
      keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
    );
  };

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

  const renderRow = (conv: ChatConversation, group: ConversationGroup) => {
    const isActive = conv.id === activeId;
    const isRenaming = conv.id === renamingId;
    const isConfirmingDelete = conv.id === confirmDeleteId;
    const lastMessage = conv.messages[conv.messages.length - 1];
    const preview =
      lastMessage && lastMessage.compactedFrom === undefined
        ? lastMessage.content.slice(0, 60)
        : "";
    // The branch (only when this repo's threads are not all on one, which is
    // when it tells you something) and the changed count. Decided in
    // ../lib/conversation-groups so the rule is testable — and so this is a
    // BOOLEAN. Computing it inline as `(showBranch || conv.pendingChanges) &&`
    // made `undefined || 0` — the number zero — render under every new chat.
    const meta = conversationRowMeta(group, conv);
    const showMeta = hasRowMeta(group, conv);

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
                  {formatRelativeTime(conv.updatedAt)}
                </span>
              </div>
              {showMeta && (
                <div className="chat-conv-item-repo">
                  {meta.branch && (
                    <span className="chat-conv-item-repo-chip">
                      <GitBranch className="h-3 w-3" aria-hidden="true" />
                      <span className="chat-conv-item-repo-name">{meta.branch}</span>
                    </span>
                  )}
                  {/* Which of the group's threads is holding the unreleased
                      work. The header totals it; this says where it is. */}
                  {meta.changed > 0 && (
                    <span
                      className="chat-conv-item-changes"
                      title={`${meta.changed} file${meta.changed === 1 ? "" : "s"} changed in this chat's workspace, not yet pushed`}
                    >
                      {meta.changed} changed
                    </span>
                  )}
                </div>
              )}
              {preview && <div className="chat-conv-item-preview">{preview}</div>}
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
                  onMouseLeave={() => setConfirmDeleteId((id) => (id === conv.id ? null : id))}
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
          <SimpleTooltip
            content={
              inheritedRepo
                ? `New chat in ${inheritedRepo.owner}/${inheritedRepo.repo}`
                : "New chat"
            }
            shortcut="⌘⇧N"
            side="bottom"
          >
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
            placeholder="Search chats, repos, branches…"
            className="chat-sidebar-search-input"
            aria-label="Search chats by title, message, repository or branch"
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
          {matchedCount === 0 && (
            <div className="chat-sidebar-empty">
              {searching ? (
                <>
                  Nothing matches <strong>“{query}”</strong> — not a chat title, a
                  message, a repository or a branch.
                </>
              ) : (
                "No chats yet — start one!"
              )}
            </div>
          )}

          {groups.map((group) => {
            // A fold folds. The group holding the active thread is NOT exempt:
            // clicking a header and having nothing happen is worse than the
            // outcome it was guarding against (the thread is still on screen
            // to the right), and rule-excepted controls are how a UI stops
            // being predictable. A search hit is the one thing that must never
            // hide behind a fold.
            const collapsed = !searching && collapsedKeys.includes(group.key);

            return (
              <section
                key={group.key}
                className="chat-repo-group"
                aria-label={group.label}
              >
                <div className="chat-repo-group-header">
                  <button
                    type="button"
                    className="chat-repo-group-toggle"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={!collapsed}
                  >
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 chat-repo-group-chevron",
                        !collapsed && "chat-repo-group-chevron-open"
                      )}
                      aria-hidden="true"
                    />
                    {group.repo ? (
                      <GitFork className="h-3.5 w-3.5 chat-repo-group-icon" aria-hidden="true" />
                    ) : (
                      <MessageSquareText
                        className="h-3.5 w-3.5 chat-repo-group-icon"
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className={cn(
                        "chat-repo-group-name",
                        !group.repo && "chat-repo-group-name-muted"
                      )}
                      // The branches live here rather than as their own chip.
                      // A sidebar is ~265px wide: one branch chip plus the
                      // changed pill left room for `acme…`, and the repository
                      // NAME is what this header is for. Rows still carry the
                      // branch, but only when there is more than one to tell
                      // apart — which is the case where it says anything.
                      title={
                        group.repo
                          ? `${group.label}${
                              group.branches.length === 1
                                ? ` @ ${group.branches[0]}`
                                : group.branches.length > 1
                                  ? ` — threads on ${group.branches.join(", ")}`
                                  : ""
                            }`
                          : "Chats with no repository attached"
                      }
                    >
                      {group.label}
                    </span>
                    {/* The repo's work in flight, across every thread on it,
                        which is the number a per-repo header exists to show.
                        Spelled the way the rows spell it — a bare `5` in this
                        position reads as a count of something, and the number
                        of what is the only thing that makes it useful. */}
                    {group.pendingChanges > 0 && (
                      <span
                        className="chat-repo-group-changes"
                        title={`${group.pendingChanges} changed file${
                          group.pendingChanges === 1 ? "" : "s"
                        } across ${group.conversations.length} chat${
                          group.conversations.length === 1 ? "" : "s"
                        } on ${group.label}, not yet pushed`}
                      >
                        {group.pendingChanges} changed
                      </span>
                    )}
                    {/* How many threads are inside — but only while the group
                        is folded. Expanded, the rows below say it. */}
                    {collapsed && (
                      <span className="chat-repo-group-count">
                        {group.conversations.length} chat
                        {group.conversations.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </button>
                  {group.repo && onNewInRepo && (
                    <SimpleTooltip content={`New chat in ${group.label}`} side="left">
                      <button
                        type="button"
                        className="chat-repo-group-new"
                        onClick={() =>
                          onNewInRepo({
                            owner: group.repo!.owner,
                            repo: group.repo!.repo,
                            branch: group.branches[0] ?? "main",
                          })
                        }
                        aria-label={`New chat in ${group.label}`}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </SimpleTooltip>
                  )}
                </div>

                {!collapsed && (
                  <div className="chat-repo-group-body">
                    {group.conversations.map((conv) => renderRow(conv, group))}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {/* Sidebar Footer */}
        {onOpenSettings && (
          <div className="chat-sidebar-footer">
            <SimpleTooltip content="Agents Settings" side="top">
              <button
                type="button"
                className="chat-sidebar-footer-btn"
                onClick={onOpenSettings}
                aria-label="Agents Settings"
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
