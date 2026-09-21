// ============================================================
// Repo Picker — Attach a GitHub Repo to the Conversation
// ============================================================
// Search-as-you-type dropdown over the user's accessible repos
// (fetched once per session via the GitHub client). Selecting a repo
// sets conversation.repoContext, which arms the agent tools. Shows a
// compact chip when a repo is attached with detach + open-on-GitHub.

import React from "react";
import { Check, ChevronDown, GitBranch, Loader2, Search, SquareArrowOutUpRight, X } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { listUserRepos, type GitHubRepo } from "../lib/github-client";
import type { RepoContext } from "../types";

/** Repo selection payload (attachedAt is stamped by the store) */
export type RepoSelection = Omit<RepoContext, "attachedAt">;

interface RepoPickerProps {
  repoContext?: RepoContext;
  /** GitHub token; picker renders nothing meaningful without one */
  token: string;
  onChange: (repo: RepoSelection | undefined) => void;
}

export function RepoPicker({ repoContext, token, onChange }: RepoPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [repos, setRepos] = React.useState<GitHubRepo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadedOnce, setLoadedOnce] = React.useState(false);
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
        return listUserRepos(token);
      })
      .then((list) => {
        if (cancelled) return;
        setRepos(list);
        setLoadedOnce(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        addToast({
          message: err instanceof Error ? err.message : "Could not load your repositories.",
          type: "error",
          duration: 5000,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, loadedOnce, token, addToast]);

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

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos.slice(0, 40);
    return repos
      .filter((r) => r.fullName.toLowerCase().includes(q))
      .slice(0, 40);
  }, [repos, query]);

  const handleSelect = (repo: GitHubRepo) => {
    // attachedAt is stamped by the store action on commit
    onChange({
      owner: repo.owner,
      repo: repo.name,
      branch: repo.defaultBranch,
    });
    setOpen(false);
    setQuery("");
  };

  // ── Attached chip state ──
  if (repoContext) {
    return (
      <span className="chat-repo-chip">
        <GitBranch className="h-3 w-3 chat-repo-chip-icon" aria-hidden="true" />
        <span className="chat-repo-chip-name" title={`${repoContext.owner}/${repoContext.repo} @ ${repoContext.branch}`}>
          {repoContext.owner}/{repoContext.repo}
        </span>
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
        <SimpleTooltip content="Detach repository" side="bottom">
          <button
            type="button"
            className="chat-repo-chip-btn"
            onClick={() => onChange(undefined)}
            aria-label="Detach repository"
          >
            <X className="h-3 w-3" />
          </button>
        </SimpleTooltip>
      </span>
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

      {open && (
        <div className="chat-repo-menu" role="listbox" aria-label="Repositories">
          <div className="chat-repo-search">
            <Search className="h-3.5 w-3.5 chat-repo-search-icon" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter repositories…"
              className="chat-repo-search-input"
              autoFocus
              aria-label="Filter repositories"
            />
            {loading && <Loader2 className="h-3.5 w-3.5 chat-repo-spinner" />}
          </div>

          <div className="chat-repo-list">
            {!loading && filtered.length === 0 && (
              <div className="chat-repo-empty">
                {loadedOnce ? "No repositories match." : "Loading repositories…"}
              </div>
            )}
            {filtered.map((repo) => (
              <button
                key={repo.fullName}
                type="button"
                className="chat-repo-item"
                role="option"
                aria-selected={false}
                onClick={() => handleSelect(repo)}
              >
                <span className="chat-repo-item-name" title={repo.fullName}>
                  {repo.fullName}
                </span>
                {repo.private && <span className="chat-repo-item-badge">private</span>}
                {repo.language && <span className="chat-repo-item-lang">{repo.language}</span>}
                {repos.find((r) => r.fullName === repo.fullName) && <Check className="h-3 w-3 chat-repo-item-check" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
