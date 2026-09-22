// ============================================================
// Repo Picker — Attach a GitHub Repo to the Conversation
// ============================================================
// Search-as-you-type dropdown over the user's accessible repos
// (fetched once per session via the GitHub client). Selecting a repo
// sets conversation.repoContext, which arms the agent tools. Shows a
// compact chip when a repo is attached with detach + open-on-GitHub.

import React from "react";
import { Check, ChevronDown, GitBranch, Loader2, Search, SquareArrowOutUpRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { listUserRepos, type GitHubRepo } from "../lib/github-client";
import { describeRelativeTime, formatRelativeTime } from "../lib/relative-time";
import type { RepoContext } from "../types";

/** GitHub's page size here, and the point at which the list admits it is cut */
const REPO_PAGE = 40;

/** Repo selection payload (attachedAt is stamped by the store) */
export type RepoSelection = Omit<RepoContext, "attachedAt">;

interface RepoPickerProps {
  repoContext?: RepoContext;
  /** GitHub token; picker renders nothing meaningful without one */
  token: string;
  onChange: (repo: RepoSelection | undefined) => void;
}

export function RepoPicker({ repoContext, token, onChange }: RepoPickerProps) {
  /**
   * This chat's unreleased work in the attached repo.
   *
   * Read from the store rather than passed in, because it is a fact about the
   * WORKSPACE (per chat + repo), not about the chip: the picker is the place
   * the user changes that pairing, so it is where the consequences have to be
   * said out loud.
   */
  const pendingChanges = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.activeConversationId)?.pendingChanges ?? 0
  );
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [repos, setRepos] = React.useState<GitHubRepo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadedOnce, setLoadedOnce] = React.useState(false);
  /**
   * Why the list is empty, when it is empty for a reason.
   *
   * A failed load used to show "Loading repositories…" forever: the toast
   * faded, and the menu kept claiming it was still working. Forever-loading is
   * the least debuggable state a list can be in, so the failure is shown where
   * the list would be, with the way out.
   */
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  /** Keyboard cursor into `filtered`; clamped at render, never trusted */
  const [activeIndex, setActiveIndex] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const addToast = useAppStore((s) => s.addToast);

  // Load repos on first open. setState calls are deferred into the
  // async chain so the effect body itself never triggers cascading
  // renders (same pattern as ChatPage's catalog loader).
  React.useEffect(() => {
    if (!open || loadedOnce || !token) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => {
        setLoading(true);
        setLoadError(null);
        return listUserRepos(token);
      })
      .then((list) => {
        if (cancelled) return;
        setRepos(list);
        setLoadedOnce(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Could not load your repositories.";
        setLoadError(message);
        addToast({ message, type: "error", duration: 5000 });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, loadedOnce, token, addToast, attempt]);

  // Close on outside click / Escape
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The server sorts these by last push (`sort=pushed`), which is the order a
  // developer expects: the repo I was in yesterday is near the top. Filtering
  // preserves it.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos.slice(0, REPO_PAGE);
    return repos.filter((r) => r.fullName.toLowerCase().includes(q)).slice(0, REPO_PAGE);
  }, [repos, query]);

  // Clamped rather than reset in an effect: the index can only ever point at
  // something on screen, and narrowing the list never needs a second render to
  // become safe.
  const active = filtered.length ? Math.min(activeIndex, filtered.length - 1) : -1;

  /**
   * Is this the repository already attached to this chat?
   *
   * Both halves matter: the branch is pinned at attach time, so `main` here
   * and `feat/lunch` there are two different working copies, and showing a
   * tick for the second one would say the work is already open when it is not.
   */
  const isAttached = (repo: GitHubRepo) =>
    Boolean(
      repoContext &&
        repoContext.owner.toLowerCase() === repo.owner.toLowerCase() &&
        repoContext.repo.toLowerCase() === repo.name.toLowerCase()
    );

  /**
   * Says where the work being left behind went.
   *
   * A workspace is persisted per (chat, repo@branch), so changing the repo is
   * no longer destructive — but silence here reads as loss, and the old
   * behaviour really did lose it. One sentence, and only when there is
   * something to lose.
   */
  const announceKept = (leaving: RepoContext | undefined) => {
    if (!leaving || pendingChanges === 0) return;
    addToast({
      message:
        `${pendingChanges} changed file${pendingChanges === 1 ? "" : "s"} kept for ` +
        `${leaving.owner}/${leaving.repo} — they come back when you re-attach it to this chat.`,
      type: "info",
      duration: 6000,
    });
  };

  const handleSelect = (repo: GitHubRepo) => {
    // attachedAt is stamped by the store action on commit
    announceKept(repoContext);
    onChange({
      owner: repo.owner,
      repo: repo.name,
      branch: repo.defaultBranch,
    });
    setOpen(false);
    setQuery("");
  };

  /**
   * Arrow keys, Home/End and Enter over the list.
   *
   * The menu announced itself as a `listbox` from the start, and a listbox you
   * cannot arrow through is a promise the keyboard user cannot collect on. The
   * input keeps focus (the list is virtual, addressed by
   * `aria-activedescendant`), so typing and arrowing are the same gesture —
   * filter, then press Enter — and the cursor is never one click away.
   */
  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (!filtered.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(Math.min(active + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(Math.max(active - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(filtered.length - 1);
    } else if (e.key === "Enter") {
      const repo = filtered[active];
      if (repo) {
        e.preventDefault();
        handleSelect(repo);
      }
    }
  };

  /**
   * The menu, shared by both states.
   *
   * Built once and rendered under whichever trigger is showing, because the
   * chips used to be a dead end: with a repo attached the picker early-returned
   * the chip, so switching repositories meant detach (which announces what it
   * is keeping) and then attach — two decisions for one intention. The chip's
   * name is now a trigger, and the row for the current repo is the one with the
   * tick.
   */
  const menu = open && (
    <div
      className="chat-repo-menu"
      role="listbox"
      aria-label="Repositories"
      aria-activedescendant={active >= 0 ? `repo-option-${active}` : undefined}
      onKeyDown={handleListKeyDown}
    >
      <div className="chat-repo-search">
        <Search className="h-3.5 w-3.5 chat-repo-search-icon" aria-hidden="true" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // The cursor points into a list that just changed under it.
            setActiveIndex(0);
          }}
          placeholder="Filter repositories…"
          className="chat-repo-search-input"
          autoFocus
          aria-label="Filter repositories"
        />
        {loading && <Loader2 className="h-3.5 w-3.5 chat-repo-spinner" />}
      </div>

      <div className="chat-repo-list">
        {!loading && loadError && (
          <div className="chat-repo-empty chat-repo-error">
            <span>{loadError}</span>
            <button
              type="button"
              className="chat-repo-retry"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        )}
        {!loading && !loadError && filtered.length === 0 && (
          <div className="chat-repo-empty">
            {!token ? (
              // A repo stays attached on a machine whose token has since been
              // removed, and "Loading repositories…" forever is then a lie:
              // nothing is loading. Say what is actually missing.
              <>
                <span>Connect GitHub to list your repositories.</span>
                <button
                  type="button"
                  className="chat-repo-retry"
                  onClick={() => useChatStore.getState().setSettingsOpen(true, "github")}
                >
                  Open GitHub settings
                </button>
              </>
            ) : loadedOnce ? (
              `No repository matches “${query.trim()}”.`
            ) : (
              "Loading repositories…"
            )}
          </div>
        )}
        {filtered.map((repo, index) => (
          <button
            key={repo.fullName}
            id={`repo-option-${index}`}
            type="button"
            className={cn(
              "chat-repo-item",
              index === active && "chat-repo-item-active",
              isAttached(repo) && "chat-repo-item-attached"
            )}
            role="option"
            aria-selected={isAttached(repo)}
            ref={(el) => {
              // Keep the cursor on screen while arrowing: a listbox that
              // scrolls away from its own selection looks broken.
              if (el && index === active) el.scrollIntoView({ block: "nearest" });
            }}
            onClick={() => handleSelect(repo)}
            onMouseEnter={() => setActiveIndex(index)}
          >
            <span className="chat-repo-item-name" title={repo.fullName}>
              {repo.fullName}
            </span>
            {isAttached(repo) ? (
              <span
                className="chat-repo-item-attached-tag"
                title={`This chat works on ${repoContext?.owner}/${repoContext?.repo} @ ${repoContext?.branch}`}
              >
                <Check className="h-3 w-3" aria-hidden="true" />
              </span>
            ) : null}
            {repo.private && <span className="chat-repo-item-badge">private</span>}
            {repo.language && <span className="chat-repo-item-lang">{repo.language}</span>}
            {repo.updatedAt > 0 && (
              <span className="chat-repo-item-when" title={describeRelativeTime(repo.updatedAt)}>
                {formatRelativeTime(repo.updatedAt)}
              </span>
            )}
          </button>
        ))}
      </div>

      {repos.length > filtered.length && (
        // Why the list is shorter than the account: without this, a missing
        // repo reads as "no access" rather than "keep typing".
        <div className="chat-repo-footer">
          Showing {filtered.length} of {repos.length} repositories — type to narrow.
        </div>
      )}
    </div>
  );

  // ── Attached: the chip, and the same menu behind its name ──
  if (repoContext) {
    return (
      <div className="chat-repo-picker chat-repo-picker-attached" ref={rootRef}>
      <span className="chat-repo-chip">
        <GitBranch className="h-3 w-3 chat-repo-chip-icon" aria-hidden="true" />
        <SimpleTooltip
          content={`${repoContext.owner}/${repoContext.repo} @ ${repoContext.branch} — click to switch repository`}
          side="bottom"
        >
          <button
            type="button"
            className="chat-repo-chip-name chat-repo-chip-name-btn"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={`Repository ${repoContext.owner}/${repoContext.repo}, change it`}
          >
            {repoContext.owner}/{repoContext.repo}
            <ChevronDown className="h-3 w-3 chat-repo-chevron" aria-hidden="true" />
          </button>
        </SimpleTooltip>
        <SimpleTooltip content="Open on GitHub" side="bottom">
          <a
            href={`https://github.com/${repoContext.owner}/${repoContext.repo}`}
            target="_blank"
            rel="noreferrer"
            className="chat-repo-chip-btn"
            aria-label="Open repository on GitHub"
            onClick={(e) => e.stopPropagation()}
          >
            <SquareArrowOutUpRight className="h-3 w-3" />
          </a>
        </SimpleTooltip>
        {pendingChanges > 0 && (
          <span
            className="chat-repo-chip-changes"
            title={`${pendingChanges} changed file${pendingChanges === 1 ? "" : "s"} in this chat's workspace, not yet pushed`}
          >
            {pendingChanges} changed
          </span>
        )}
        <SimpleTooltip
          content={
            pendingChanges > 0
              ? `Detach — ${pendingChanges} changed file${pendingChanges === 1 ? "" : "s"} stay with this chat`
              : "Detach repository"
          }
          side="bottom"
        >
          <button
            type="button"
            className="chat-repo-chip-btn"
            onClick={() => {
              announceKept(repoContext);
              onChange(undefined);
            }}
            aria-label="Detach repository"
          >
            <X className="h-3 w-3" />
          </button>
        </SimpleTooltip>
      </span>
        {menu}
      </div>
    );
  }

  if (!token) {
    return (
      <SimpleTooltip content="Connect GitHub in Chat Settings to work with a repo" side="bottom">
        <button
          type="button"
          className="chat-header-prompt-badge"
          onClick={() => useChatStore.getState().setSettingsOpen(true, "github")}
        >
          <GitBranch className="h-3 w-3" />
          <span>GitHub</span>
        </button>
      </SimpleTooltip>
    );
  }

  return (
    <div className="chat-repo-picker" ref={rootRef}>
      <SimpleTooltip content="Attach a GitHub repo for agent mode" side="bottom">
        <button
          type="button"
          className="chat-header-prompt-badge"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="listbox"
        >
          <GitBranch className="h-3 w-3" />
          <span>Attach repo</span>
          <ChevronDown className="h-3 w-3 chat-repo-chevron" aria-hidden="true" />
        </button>
      </SimpleTooltip>

      {menu}
    </div>
  );
}
