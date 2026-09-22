// ============================================================
// Conversation Groups — Chats, Filed Under Their Repository
// ============================================================
// The workspace model says a thread belongs to a repository, but a flat list
// of chats says the opposite: it repeats `acme/web` down the column, mixes two
// projects into one recency order, and cannot answer the two questions the
// user actually has — "what am I working on in this repo?" and "how much of it
// is not pushed yet?".
//
// So the list is grouped by repository, and each group carries the facts that
// belong to the repo rather than to any one thread: its threads, the branches
// they are on, and the number of changed files across all of them.
//
// Kept out of the component because this is logic, not layout: ordering,
// summation and search all have right answers, and each one gets a test.
// ============================================================

import type { ChatConversation } from "../types";

/** A repository, without the per-chat attachment stamp */
export interface RepoIdentity {
  owner: string;
  repo: string;
}

/**
 * The repository a thread works on, or null when it has none that can be used.
 *
 * Defensive on purpose, and not out of paranoia: this reads PERSISTED
 * conversations, which outlive the code that wrote them. A record from an
 * older build — or one written by an attach path that had no branch — reaches
 * here with a missing field, and the first version of this file called
 * `.toLowerCase()` on it and took the entire page down with an empty screen.
 * A malformed record must cost its own row, never the application.
 *
 * A repo with no owner or name is treated as NO repository: there is nothing
 * to group it under and nothing honest to show for it.
 */
export function conversationRepoIdentity(
  conversation: ChatConversation
): (RepoIdentity & { branch: string }) | null {
  const context = conversation.repoContext;
  const owner = typeof context?.owner === "string" ? context.owner.trim() : "";
  const repo = typeof context?.repo === "string" ? context.repo.trim() : "";
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    branch: typeof context?.branch === "string" ? context.branch.trim() : "",
  };
}

export interface ConversationGroup {
  /**
   * Stable identity for the group: `owner/repo`, lowercased (GitHub treats
   * owner and repo names case-insensitively, and two groups for `Acme/Web`
   * and `acme/web` would be a bug the user could see but not explain).
   * Chats with no repository share the empty key.
   */
  key: string;
  /** null for the chats that are not attached to anything yet */
  repo: RepoIdentity | null;
  /** What the header shows: `owner/repo` as first seen, or `No repository` */
  label: string;
  /** This group's threads, pinned first, then most recent */
  conversations: ChatConversation[];
  /** Changed files across every thread in the group — not yet pushed */
  pendingChanges: number;
  /** Distinct branches in the group, in first-seen order */
  branches: string[];
  /** True when any thread here is pinned, which floats the whole group */
  pinned: boolean;
  /** The newest thread's timestamp, for ordering groups */
  updatedAt: number;
}

/** The group every chat with no repository lands in */
export const NO_REPO_GROUP_KEY = "";

export const NO_REPO_GROUP_LABEL = "No repository";

/**
 * Files a thread has changed but not pushed.
 *
 * Read from the conversation, which is the only place it is derived (see the
 * workspace setters in chat.store): two threads on one repo are two
 * workspaces, so the group total is the sum rather than any single count.
 */
function changesOf(conversation: ChatConversation): number {
  const count = conversation.pendingChanges ?? 0;
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * What a row says besides its title and age.
 *
 * Extracted because the component's first version computed this inline as
 * `(showBranch || conv.pendingChanges) && <div>` — and `undefined || 0` is `0`,
 * which React renders. Every new chat in a repo therefore showed a bare `0`
 * under its title: the guard was doing double duty as a boolean and as a
 * number, and it was neither. Numbers are returned here so the caller can be
 * explicit about it, and the shape is testable without a DOM.
 */
export function conversationRowMeta(
  group: ConversationGroup,
  conversation: ChatConversation
): { branch: string | null; changed: number } {
  const identity = conversationRepoIdentity(conversation);
  return {
    // Only when this repo's threads are not all on one branch: otherwise the
    // header already says it, and a repeated chip is noise.
    branch: group.branches.length > 1 ? identity?.branch || null : null,
    changed: changesOf(conversation),
  };
}

/**
 * Whether a row has anything to show at all.
 *
 * A boolean, never a count — see conversationRowMeta for the `0` this exists to
 * prevent from reaching the DOM.
 */
export function hasRowMeta(group: ConversationGroup, conversation: ChatConversation): boolean {
  const meta = conversationRowMeta(group, conversation);
  return Boolean(meta.branch) || meta.changed > 0;
}

/** Pinned first, then most recent — the same rule at both levels */
function byPinThenRecency(a: ChatConversation, b: ChatConversation): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

/**
 * Files conversations under the repository they work on.
 *
 * Ordering is one rule applied twice, which is why it is predictable: pinned
 * first, then recency. A group with a pinned thread therefore rises above
 * groups without one, and the pinned thread rises inside its group. The
 * no-repository group is not special-cased to the bottom — it is where that
 * work goes, and pinning it should still bring it to the top.
 */
export function groupConversationsByRepository(
  conversations: readonly ChatConversation[]
): ConversationGroup[] {
  const groups = new Map<string, ConversationGroup>();

  for (const conversation of conversations) {
    const identity = conversationRepoIdentity(conversation);
    const key = identity
      ? `${identity.owner}/${identity.repo}`.toLowerCase()
      : NO_REPO_GROUP_KEY;
    const existing = groups.get(key);
    const group: ConversationGroup =
      existing ??
      {
        key,
        repo: identity ? { owner: identity.owner, repo: identity.repo } : null,
        label: identity ? `${identity.owner}/${identity.repo}` : NO_REPO_GROUP_LABEL,
        conversations: [],
        pendingChanges: 0,
        branches: [],
        pinned: false,
        updatedAt: 0,
      };

    group.conversations.push(conversation);
    group.pendingChanges += changesOf(conversation);
    if (identity?.branch && !group.branches.includes(identity.branch)) {
      group.branches.push(identity.branch);
    }
    if (conversation.pinned) group.pinned = true;
    group.updatedAt = Math.max(group.updatedAt, conversation.updatedAt);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, conversations: [...group.conversations].sort(byPinThenRecency) }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      // A stable last tiebreak, so equal timestamps do not reorder on every
      // render (which reads as flicker).
      return a.label.localeCompare(b.label);
    });
}

/**
 * Does this conversation match the search box?
 *
 * The repository is part of the match, and that is the point of grouping: with
 * chats filed under repos, "acme" is the obvious thing to type, and a search
 * that looked only at titles and messages would return nothing for it while
 * the matching group sat on screen. The branch matches too, for the same
 * reason — it is written on the row.
 */
export function conversationMatchesQuery(conversation: ChatConversation, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const identity = conversationRepoIdentity(conversation);
  if (identity) {
    if (`${identity.owner}/${identity.repo}`.toLowerCase().includes(q)) return true;
    if (identity.repo.toLowerCase().includes(q)) return true;
    if (identity.owner.toLowerCase().includes(q)) return true;
    if (identity.branch.toLowerCase().includes(q)) return true;
  }
  const title = typeof conversation.title === "string" ? conversation.title : "";
  if (title.toLowerCase().includes(q)) return true;
  return (conversation.messages ?? []).some((message) =>
    (message?.content ?? "").toLowerCase().includes(q)
  );
}
