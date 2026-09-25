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
// Two things are scoped tighter than they look:
//
//   • STATUS IS DERIVED, NOT STORED. Each row's glyph comes from
//     ../lib/conversation-status, so "which of these is running, which is
//     waiting on me, which finished while I was away" is a rule with a test
//     rather than four flags that drift. The page computes it (it already holds
//     the stream); this component only draws it.
//   • THE ROW IS A BUTTON WITH BUTTONS BESIDE IT. A `div[role="button"]`
//     containing four of them put interactive controls inside an interactive
//     control, and made the row's own hit target ambiguous. The row is a
//     `listitem` holding one button plus its actions, and the list is a
//     roving-focus list: Tab enters it once, arrows walk it (see handleRowKeys).
//
// The rules with a right answer (ordering, the changed-file sum, what search
// matches) are in ../lib/conversation-groups.ts, where they are tested.
// ============================================================

import React from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  Check,
  Copy,
  GitBranch,
  History,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  CircleMinus,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { SearchInput } from "@/components/ui/search-input";
import { DeleteConfirmPopover } from "@/components/ui/DeleteConfirmPopover";
import { useLocalStorageState } from "@/hooks/useLocalStorageState";
import { useNarrowLayout } from "./useNarrowLayout";
import type { ChatConversation } from "../types";
import { useChatStore } from "@/stores/chat.store";
import {
  conversationMatchesQuery,
  conversationRowMeta,
  groupConversationsByRepository,
  type ConversationGroup,
  type RepoIdentity,
} from "../lib/conversation-groups";
import {
  groupStatus,
  IDLE_STATUS,
  type ConversationStatus,
} from "../lib/conversation-status";
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
  /**
   * Start a chat with NO repository — the "ask anything" entry at the top of
   * the list.
   *
   * The store inherits the active chat's repo for a new thread unless it is
   * told otherwise, which is right for the per-repo `+` and wrong for this one:
   * the first entry in the list is the way OUT of the repo you are in.
   */
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
  /**
   * Detach a REPOSITORY from the sidebar — the button on the repo row.
   *
   * This, and only this, is what makes a repository leave the sidebar:
   * deleting a chat never does. Empty rows (repos whose chats are all
   * deleted) carry the button too, because a row with no chats is exactly
   * the one the user is looking at when they decide the repo is done.
   */
  onDetachRepo?: (owner: string, repo: string) => void;
  onOpenSettings?: () => void;
  /** What each thread is doing, keyed by conversation id (lib/conversation-status) */
  statuses: Record<string, ConversationStatus>;
}

/**
 * The one glyph a row wears.
 *
 * Running and failed use icons because they are shapes worth recognising at a
 * glance; waiting and unread are dots, because "there is something here for
 * you" is a position in the row rather than a picture. Every state carries its
 * words for a screen reader — a coloured dot on its own says nothing.
 */
function StatusGlyph({ status, className }: { status: ConversationStatus; className?: string }) {
  if (status.kind === "idle") {
    // The slot is drawn even when empty: a column of titles that shifts left
    // whenever a thread goes quiet is a column you have to re-read.
    return <span className={cn("chat-conv-status", className)} aria-hidden="true" />;
  }
  return (
    <span
      className={cn("chat-conv-status", `chat-conv-status-${status.kind}`, className)}
      title={status.label}
    >
      {status.kind === "running" && <Loader2 className="h-3 w-3 spin" aria-hidden="true" />}
      {status.kind === "failed" && <TriangleAlert className="h-3 w-3" aria-hidden="true" />}
      {(status.kind === "waiting" || status.kind === "unread") && (
        <span className="chat-conv-status-dot" aria-hidden="true" />
      )}
      <span className="chat-sr-only">{status.label}</span>
    </span>
  );
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
  onDetachRepo,
  onOpenSettings,
  statuses,
}: ChatSidebarProps) {
  const [query, setQuery] = React.useState("");
  /** The search field lives in the header band, collapsed until asked for */
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  /**
   * The conversation awaiting delete confirmation, and where its popover is
   * anchored. NOT click-again-to-delete: that armed state expired on a
   * mouse-leave and a 4s timer, which made a slow deliberate click read as a
   * cancel, and the context menu's Delete skipped the whole dance and deleted
   * on the first click. One popover, both entry points, Cancel and Escape.
   */
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const [deleteAnchor, setDeleteAnchor] = React.useState<{ top: number; left: number } | null>(
    null
  );
  /** The row whose right-click menu is open, and where it was asked for */
  const [menu, setMenu] = React.useState<{ id: string; x: number; y: number } | null>(null);
  /** Collapsed group keys, remembered across reloads — folding a repo away is
      a statement about how you work, not about this session. */
  const [collapsedKeys, setCollapsedKeys] = useLocalStorageState<string[]>(
    "intab_chat_collapsed_repos",
    []
  );

  const asideRef = React.useRef<HTMLElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const searchToggleRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const drawer = useNarrowLayout();

  // ── Pinned repositories ──
  // The sidebar's repo rows are PINS, not projections of the chat list: a row
  // survives its chats, and only the row's Detach button removes it. Every
  // repo rendered here (from the store's persisted `pinnedRepos`) is written
  // back through pinRepoToSidebar — an idempotent upsert — so "a row that
  // exists is a row that stays" holds from either side: attach a repo in a
  // chat and the row appears; delete the chat and the row remains.
  const pinnedRepos = useChatStore((s) => s.pinnedRepos);
  const pinRepoToSidebar = useChatStore((s) => s.pinRepoToSidebar);
  React.useEffect(() => {
    for (const conv of conversations) {
      if (conv.repoContext) {
        pinRepoToSidebar({
          owner: conv.repoContext.owner,
          repo: conv.repoContext.repo,
          branch: conv.repoContext.branch ?? "",
        });
      }
    }
    // The sync runs when the conversation list changes shape or any repo
    // binding changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conversations,
    conversations.map((c) => c.repoContext?.owner).join(),
    conversations.map((c) => c.repoContext?.repo).join(),
    conversations.map((c) => c.repoContext?.branch).join(),
  ]);

  /**
   * The band's one button, both ways.
   *
   * It used to be a magnifier that handed off to a separate close button, so
   * `aria-expanded` could only ever say `false` and closing the field dropped
   * focus on `<body>` — the element wearing focus was being unmounted. One
   * button that swaps its icon keeps the state legible and gives focus
   * somewhere to come back TO.
   */
  const openSearch = React.useCallback(() => {
    setSearchOpen(true);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  const closeSearch = React.useCallback(() => {
    setQuery("");
    setSearchOpen(false);
    window.setTimeout(() => searchToggleRef.current?.focus(), 0);
  }, []);

  // ── Searching ──
  // ⌘⇧F rather than ⌘K: the command palette owns ⌘K app-wide, and a shortcut
  // that opens two different things depending on where you are is worse than a
  // second shortcut. Escape closes the field before it clears it.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
        return;
      }
      if (e.key === "Escape" && searchOpen) {
        const inside = document.activeElement === searchRef.current;
        if (query && !inside) return;
        e.preventDefault();
        if (query) setQuery("");
        else closeSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, query, openSearch, closeSearch]);

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

  /**
   * The History section: the most recent threads with something to say, the
   * most recent first — the "Pick up where you left off" list that used to
   * live on the welcome screen, where it was only reachable when the thread
   * you opened was empty.
   *
   * NOT capped and NOT a second archive of the same rows: the grouped list
   * below files by project, this files by WHEN, and a chat with no messages is
   * not history. The ACTIVE thread is included — on it the row reads as "this
   * one", which is true rather than wrong, and omitting it would shift the
   * other rows as soon as you replied.
   */
  const history = React.useMemo(
    () =>
      [...conversations]
        .filter((c) => c.messages.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations]
  );
  /** Whether the History fold is open. A STATE, not a ref-count: the section
      is one toggle the user owns, remembered across reloads like the repo
      folds, and it does not silently reopen because a count moved. */
  const [historyOpen, setHistoryOpen] = useLocalStorageState<boolean>(
    "intab_chat_history_open",
    false
  );

  /**
   * Every row's status in one pass, so a group header can roll its threads up
   * without walking them again per render.
   */
  const statusOf = React.useCallback(
    (id: string): ConversationStatus => statuses[id] ?? IDLE_STATUS,
    [statuses]
  );

  const toggleGroup = (key: string) => {
    setCollapsedKeys((keys) =>
      keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
    );
  };

  // ── Delete confirmation ──
  // One popover for both entry points (hover trash, context menu), anchored
  // under whichever button asked for it — the same control the file list
  // deletes with, so "delete a chat" and "delete a file" are the same gesture.
  // The anchor is REQUIRED: the popover only draws with one, and a popover
  // that mounts invisible behind a full-screen backdrop is a dead click.
  const requestDelete = (id: string, anchor: { top: number; left: number }) => {
    setMenu(null);
    setConfirmDeleteId(id);
    setDeleteAnchor(anchor);
  };

  const confirmDelete = () => {
    if (confirmDeleteId) onDelete(confirmDeleteId);
    cancelDelete();
  };

  const cancelDelete = () => {
    setConfirmDeleteId(null);
    setDeleteAnchor(null);
  };

  const startRename = (conv: ChatConversation) => {
    setRenamingId(conv.id);
    setRenameValue(conv.title);
    cancelDelete();
    setMenu(null);
  };

  const commitRename = () => {
    if (renamingId) {
      onRename(renamingId, renameValue);
    }
    setRenamingId(null);
  };

  // ── The right-click menu ──
  // Two actions on hover (pin, delete) and the rest behind a context menu, the
  // way a file list has always worked: hover can afford to be small, and the
  // full set is one gesture away instead of hidden behind it.
  const openMenu = (conv: ChatConversation, x: number, y: number) => {
    setMenu({ id: conv.id, x, y });
    cancelDelete();
  };

  React.useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenu(null);
      }
    };
    const onScroll = () => setMenu(null);
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    // The menu is placed once, from the click: it must not outlive the layout
    // it was pointing at.
    const first = menuRef.current?.querySelector<HTMLElement>("[role='menuitem']");
    first?.focus();
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [menu]);

  // ── Roving focus ──
  // One Tab stop for the whole list, arrows inside it. Every row used to be
  // `tabIndex={0}` — thirty chats meant thirty Tab presses to reach the row
  // after them.
  const handleRowKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-conv-row]") ?? []
    );
    if (rows.length === 0) return;
    const from = rows.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (from === -1) next = e.key === "ArrowDown" ? 0 : rows.length - 1;
    else next = (from + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    e.preventDefault();
    rows[next]?.focus();
  };

  // ── Drawer duties (below 860px only) ──
  // The column is translated off-canvas rather than unmounted, so while it is
  // closed it must be unreachable: `inert` keeps Tab out of a panel nobody can
  // see, and Escape belongs to the drawer while it is open.
  //
  // Closing hands focus back to whatever opened it. The opener lives in the
  // header, which this component does not own, so the element is captured on
  // open rather than looked up: a panel that closes and drops focus on <body>
  // makes the keyboard start the page over.
  const openerRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!drawer) return;
    if (open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [drawer, open]);

  React.useEffect(() => {
    if (!drawer || !open) return;
    const node = asideRef.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer, open, onClose]);

  const renderRow = (conv: ChatConversation, group: ConversationGroup) => {
    const isActive = conv.id === activeId;
    const isRenaming = conv.id === renamingId;
    const status = statusOf(conv.id);
    // The branch at rest is decided by the repo (only when its threads disagree,
    // where it tells you something); the row being READ asks for it always,
    // because "which branch is this chat on?" is a question about the thread in
    // front of you. Both rules live in ../lib/conversation-groups.
    const restMeta = conversationRowMeta(group, conv);
    const openMeta = conversationRowMeta(group, conv, { alwaysBranch: true });
    // Two facts fit on one line at 264px and no more (see the meta metrics in
    // chat.css): the branch and the work in flight. A message preview was tried
    // here and rendered as three letters — the two facts ahead of it are, unlike
    // the preview, things the transcript beside the column cannot tell you.
    const hasMeta = Boolean(openMeta.branch) || openMeta.changed > 0;
    // Only the row the menu belongs to draws it, and `menu` is guaranteed
    // non-null inside that guard.
    const menuAt = menu?.id === conv.id ? menu : null;

    return (
      <div
        key={conv.id}
        className={cn("chat-conv-item", isActive && "chat-conv-item-active")}
        role="listitem"
        aria-current={isActive ? "true" : undefined}
        onContextMenu={(e) => {
          if (isRenaming) return;
          e.preventDefault();
          openMenu(conv, e.clientX, e.clientY);
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
            <button
              type="button"
              className="chat-conv-item-main"
              data-conv-row={conv.id}
              // Reserved action space narrows the title, so the full one stays
              // reachable without hovering the row you are trying to read.
              title={conv.title}
              onClick={() => onSelect(conv.id)}
            >
              <StatusGlyph status={status} />
              <span className="chat-conv-item-content">
                <span className="chat-conv-item-top">
                  <span className="chat-conv-item-title">{conv.title}</span>
                  {conv.pinned && (
                    <Pin className="chat-conv-item-pin h-3 w-3" aria-label="Pinned" />
                  )}
                  {restMeta.branch && (
                    <span className="chat-conv-item-chip" title={`Branch ${restMeta.branch}`}>
                      <GitBranch className="h-3 w-3" aria-hidden="true" />
                      <span className="chat-conv-item-chip-text">{restMeta.branch}</span>
                    </span>
                  )}
                  <span className="chat-conv-item-time" aria-hidden="true">
                    {formatRelativeTime(conv.updatedAt)}
                  </span>
                </span>
                {isActive && hasMeta && (
                  <span className="chat-conv-item-meta">
                    {openMeta.branch && (
                      <span className="chat-conv-item-meta-branch" title={openMeta.branch}>
                        {openMeta.branch}
                      </span>
                    )}
                    {openMeta.changed > 0 && (
                      <span
                        className="chat-conv-item-meta-changed"
                        title={`${openMeta.changed} file${
                          openMeta.changed === 1 ? "" : "s"
                        } changed in this chat's workspace, not yet pushed`}
                      >
                        {openMeta.changed} changed
                      </span>
                    )}
                  </span>
                )}
              </span>
            </button>
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
              <SimpleTooltip content="Delete" side="top">
                <button
                  type="button"
                  className="chat-conv-action chat-conv-action-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    requestDelete(conv.id, {
                      // Centered under the 24px button, matching the file list's
                      // popover anchor (half the 236px popover either side).
                      top: rect.bottom + 6,
                      left: rect.left + rect.width / 2 - 118,
                    });
                  }}
                  aria-label={`Delete conversation ${conv.title}`}
                  aria-haspopup="dialog"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </SimpleTooltip>
            </div>
            {menuAt &&
              createPortal(
                <div
                  ref={menuRef}
                  className="chat-row-menu"
                  role="menu"
                  aria-label={`Actions for ${conv.title}`}
                  style={{
                    top: Math.max(8, Math.min(menuAt.y, window.innerHeight - 180)),
                    left: Math.max(8, Math.min(menuAt.x, window.innerWidth - 216)),
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-row-menu-item"
                    onClick={() => startRename(conv)}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-row-menu-item"
                    onClick={() => {
                      onDuplicate(conv.id);
                      setMenu(null);
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    Duplicate
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-row-menu-item"
                    onClick={() => {
                      onTogglePin(conv.id);
                      setMenu(null);
                    }}
                  >
                    {conv.pinned ? (
                      <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {conv.pinned ? "Unpin" : "Pin to top"}
                  </button>
                  <div className="chat-row-menu-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-row-menu-item chat-row-menu-item-danger"
                    onClick={() =>
                      // No button rect to anchor to here, so the popover takes
                      // the point the menu was asked for, centered on it.
                      requestDelete(conv.id, { top: menuAt.y + 6, left: menuAt.x - 118 })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Delete…
                  </button>
                </div>,
                document.body
              )}
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
      <aside
        ref={asideRef}
        className={cn(
          "chat-sidebar",
          open && "chat-sidebar-open",
          drawer && !open && "chat-sidebar-drawer-closed"
        )}
        // Unreachable while it is off-canvas: a translated panel is still in the
        // tab order, so Tab would walk into a column nobody can see. Boolean,
        // not the legacy `inert=""` string: React 19 types the attribute as a
        // boolean and the string form is what broke `tsc -b`.
        inert={drawer && !open}
        tabIndex={-1}
      >
        <div className="chat-sidebar-band">
          {searchOpen ? (
            <SearchInput
              ref={searchRef}
              size="sm"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onClear={() => setQuery("")}
              placeholder="Search chats…"
              aria-label="Search chats by title, message, repository or branch"
              className="chat-sidebar-search-input"
            />
          ) : (
            <span className="chat-sidebar-title">Chats</span>
          )}
          <SimpleTooltip
            content={searchOpen ? "Close search" : "Search chats"}
            shortcut="⌘⇧F"
            side="bottom"
          >
            <button
              ref={searchToggleRef}
              type="button"
              className="chat-sidebar-icon-btn"
              aria-label={searchOpen ? "Close search" : "Search chats"}
              aria-expanded={searchOpen}
              onClick={() => (searchOpen ? closeSearch() : openSearch())}
            >
              {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
          </SimpleTooltip>
        </div>

        <div className="chat-sidebar-list" ref={listRef} onKeyDown={handleRowKeys}>
          {/* The way OUT of a repo. Pinned above the groups, because "ask
              something with no project attached" is the one intent the grouped
              list cannot express: every other entry in this column starts a
              thread somewhere specific. */}
          <SimpleTooltip
            content="Starts a chat with no repository attached"
            side="bottom"
          >
            <button
              type="button"
              className="chat-new-chat"
              onClick={onNew}
              aria-keyshortcuts="Meta+Shift+N Control+Shift+N"
            >
              <Plus className="h-3.5 w-3.5 chat-new-chat-icon" aria-hidden="true" />
              <span className="chat-new-chat-label">New chat</span>
              <kbd className="chat-new-chat-kbd">⌘⇧N</kbd>
            </button>
          </SimpleTooltip>

          {/* ── History — "Pick up where you left off" ──────────
              Moved here from the welcome screen, where it only appeared when
              the current chat was empty. The header is a BUTTON that folds the
              list open and closed (state remembered across reloads, like the
              repository folds below); open, it shows EVERY chat with a
              conversation to resume, newest first — not a capped sample.

              Hidden while a search is running: results for the query sit
              directly below, and an unrelated "pick up where you left off"
              above them reads as a bug. */}
          {history.length > 0 && !searching && (
            <section className="chat-history" aria-label="Chat history">
              <button
                type="button"
                className="chat-history-toggle"
                onClick={() => setHistoryOpen((v) => !v)}
                aria-expanded={historyOpen}
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 chat-history-chevron",
                    historyOpen && "chat-history-chevron-open"
                  )}
                  aria-hidden="true"
                />
                <History className="chat-history-icon" aria-hidden="true" />
                <span className="chat-history-title">Pick up where you left off</span>
                <span className="chat-history-count">{history.length}</span>
              </button>
              {historyOpen && (
                <div className="chat-history-list" role="list">
                  {history.map((conv) => (
                    <button
                      key={conv.id}
                      type="button"
                      role="listitem"
                      className={cn(
                        "chat-history-item",
                        conv.id === activeId && "chat-history-item-active"
                      )}
                      onClick={() => onSelect(conv.id)}
                      title={conv.title}
                      aria-current={conv.id === activeId ? "true" : undefined}
                    >
                      <span className="chat-history-item-title">{conv.title}</span>
                      <span className="chat-history-item-time">
                        {formatRelativeTime(conv.updatedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {matchedCount === 0 && (
            <div className="chat-sidebar-empty">
              {searching ? (
                <>
                  Nothing matches <strong>“{query}”</strong> — not a chat title, a
                  message, a repository or a branch.
                </>
              ) : (
                "No chats yet — the button above starts one."
              )}
            </div>
          )}

          <div className="chat-sidebar-groups" role="list" aria-label="Chats by repository">
            {groups.map((group) => {
              // A fold folds. The group holding the active thread is NOT exempt:
              // clicking a header and having nothing happen is worse than the
              // outcome it was guarding against (the thread is still on screen
              // to the right), and rule-excepted controls are how a UI stops
              // being predictable. A search hit is the one thing that must never
              // hide behind a fold.
              const collapsed = !searching && collapsedKeys.includes(group.key);
              const rolling = groupStatus(group.conversations.map((c) => statusOf(c.id).kind));

              return (
                <section key={group.key} className="chat-repo-group" aria-label={group.label}>
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
                      {/* No repository glyph beside the name: at 98px of name
                          width the icon was taking 20 of them, and a fork icon
                          next to `acme/platform-monorepo` names the same thing
                          the name does. The muted name still marks the group
                          that has no repository. */}
                      <span
                        className={cn(
                          "chat-repo-group-name",
                          !group.repo && "chat-repo-group-name-muted"
                        )}
                        // The branches live in the tooltip rather than as their
                        // own chip: a sidebar is ~265px wide, and the repository
                        // NAME is what this header is for.
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
                      {/* What the repo is doing, rolled up from its threads: one
                          glyph on the header answers "is anything in here
                          running, or waiting on me?" without opening it. */}
                      <StatusGlyph status={rolling} className="chat-repo-group-status" />
                      {/* The repo's work in flight, across every thread on it,
                          which is the number a per-repo header exists to show.
                          The only count in the column allowed to be blue, and
                          the loudest thing the header may say. */}
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
                    {onNewInRepo && (
                      <SimpleTooltip
                        content={
                          group.repo ? `New chat in ${group.label}` : "New chat with no repository"
                        }
                        side="left"
                      >
                        <button
                          type="button"
                          className="chat-repo-group-new"
                          // The no-repository group's `+` makes another chat with
                          // no repository — the same thing the sticky entry does,
                          // in the one group where it belongs.
                          onClick={() => {
                            if (group.repo && group.branches[0]) {
                              onNewInRepo({
                                owner: group.repo.owner,
                                repo: group.repo.repo,
                                branch: group.branches[0],
                              });
                              return;
                            }
                            onNew();
                          }}
                          aria-label={
                            group.repo ? `New chat in ${group.label}` : "New chat with no repository"
                          }
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

            {/* ── Repositories with no chats left ──────────────
                A pinned repo whose threads are all deleted keeps its row: this
                is the whole point of the pin. The row says so in words, offers
                the same "new chat here" the occupied rows do, and carries the
                one button that can actually remove it — Detach. Hidden while a
                search runs, where "no chats match" already says the state. */}
            {!searching &&
              pinnedRepos
                .filter(
                  (pinned) =>
                    !groups.some(
                      (g) =>
                        g.repo &&
                        g.repo.owner.toLowerCase() === pinned.owner.toLowerCase() &&
                        g.repo.repo.toLowerCase() === pinned.repo.toLowerCase()
                    )
                )
                .map((pinned) => {
                  const key = `${pinned.owner}/${pinned.repo}`.toLowerCase();
                  const collapsed = collapsedKeys.includes(key);
                  return (
                    <section
                      key={key}
                      className="chat-repo-group chat-repo-group-empty"
                      aria-label={`${pinned.owner}/${pinned.repo} — no chats`}
                    >
                      <div className="chat-repo-group-header">
                        <button
                          type="button"
                          className="chat-repo-group-toggle"
                          onClick={() => toggleGroup(key)}
                          aria-expanded={!collapsed}
                        >
                          <ChevronRight
                            className={cn(
                              "h-3 w-3 chat-repo-group-chevron",
                              !collapsed && "chat-repo-group-chevron-open"
                            )}
                            aria-hidden="true"
                          />
                          <span className="chat-repo-group-name" title={`${pinned.owner}/${pinned.repo}`}>
                            {pinned.owner}/{pinned.repo}
                          </span>
                          <span
                            className="chat-repo-group-count"
                            title={`No chats on ${pinned.owner}/${pinned.repo} — deleted chats leave the repository pinned here`}
                          >
                            no chats
                          </span>
                        </button>
                        {onNewInRepo && pinned.branch && (
                          <SimpleTooltip content={`New chat in ${pinned.owner}/${pinned.repo}`} side="left">
                            <button
                              type="button"
                              className="chat-repo-group-new"
                              onClick={() =>
                                onNewInRepo({
                                  owner: pinned.owner,
                                  repo: pinned.repo,
                                  branch: pinned.branch,
                                })
                              }
                              aria-label={`New chat in ${pinned.owner}/${pinned.repo}`}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </SimpleTooltip>
                        )}
                        {onDetachRepo && (
                          <SimpleTooltip
                            content={`Detach ${pinned.owner}/${pinned.repo} — removes it from this sidebar`}
                            side="left"
                          >
                            <button
                              type="button"
                              className="chat-repo-group-detach"
                              onClick={() => onDetachRepo(pinned.owner, pinned.repo)}
                              aria-label={`Detach ${pinned.owner}/${pinned.repo}`}
                            >
                              <CircleMinus className="h-3 w-3" />
                            </button>
                          </SimpleTooltip>
                        )}
                      </div>
                      {!collapsed && (
                        <div className="chat-repo-group-body chat-repo-group-empty-body">
                          No chats on this repository. New chats here start from
                          {pinned.branch ? ` ${pinned.branch}` : " its default branch"}.
                        </div>
                      )}
                    </section>
                  );
                })}
          </div>
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

      {/* Delete confirmation — one popover for the hover trash and the
          context menu's Delete…, anchored to whichever asked. The file list
          confirms with this same control, so a destructive gesture reads the
          same everywhere in the app. */}
      <DeleteConfirmPopover
        open={Boolean(confirmDeleteId)}
        file={
          confirmDeleteId
            ? {
                id: confirmDeleteId,
                name:
                  conversations.find((c) => c.id === confirmDeleteId)?.title ?? "this chat",
              }
            : null
        }
        anchor={deleteAnchor}
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
      />
    </>
  );
}
