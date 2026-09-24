// ============================================================
// Repo Routing — What Picking A Repository Should Do
// ============================================================
// The header picker used to answer this question with one answer: repoint the
// chat you are in at the repository you picked. For the case the picker is most
// often reached in — "let me work on that project" — it hijacked a
// conversation that had nothing to do with it, and, because a repository no
// chat has ever used was ONLY reachable through this picker, there was no other
// way in. Starting fresh work on a new repository therefore cost the
// conversation you were having.
//
// The decision is a pure function of three facts, which is what makes the
// policy readable and testable rather than spread across a click handler:
//
//   • what this chat is already on (nothing, this repo, another one);
//   • whether some OTHER chat is already on the repository being picked;
//   • whether the user asked for a switch explicitly.
//
// The rule, in one sentence: picking a repository opens the chat that already
// has it, or opens a new one — and only ever moves THIS chat when this chat has
// nothing attached yet, or when the user said so.
// ============================================================

import type { RepoContext } from "../types";

/** The repository a pick names. Branch is only meaningful at attach time. */
export interface RepoPick {
  owner: string;
  repo: string;
  branch?: string;
}

/**
 * What the user meant by picking.
 *
 * `auto` is the plain click and reads the situation; `switch` is the explicit
 * "move this chat to it" item in the menu, which must do exactly that and
 * nothing clever — an explicit gesture that gets second-guessed is worse than
 * no explicit gesture.
 */
export type RepoPickIntent = "auto" | "switch";

export type RepoRouting =
  /** This chat is already on that repository — nothing to do. */
  | { action: "none" }
  /** This chat has no repository yet: attach it here, do not open a new chat. */
  | { action: "attach" }
  /** Move this chat to the picked repository (explicit, or re-attaching). */
  | { action: "switch" }
  /** Another chat already has it: go there rather than making a second one. */
  | { action: "open-chat"; conversationId: string; title: string }
  /** Nobody has it: this is new work, so it gets its own chat. */
  | { action: "new-chat" };

/** The bit of a conversation this decision needs */
export interface RouteCandidate {
  id: string;
  title: string;
  repoContext?: RepoContext;
  updatedAt: number;
}

/**
 * How many un-pushed files a move off this repository would leave behind.
 *
 * A count, not a boolean, because the confirmation has to say how much work is
 * staying: "3 changed files stay with this chat" is a decision, "you have
 * unsaved changes" is a scare. Non-finite input becomes 0 deliberately — the
 * count is persisted with the conversation, and a corrupted or NaN value must
 * not be able to keep a modal in front of the user forever (a comparison
 * against NaN is false, but the count is also rendered, and "NaN changed
 * files" is the kind of copy that makes a user distrust the whole app).
 */
export function strandedChangeCount(pendingChanges: number | undefined): number {
  const count = Math.floor(pendingChanges ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Same repository, ignoring case and the branch.
 *
 * Branch is excluded deliberately: the sidebar groups chats BY REPOSITORY, so
 * `acme/web@main` and `acme/web@feat/x` are two threads about one project, and
 * treating them as unrelated would open a third. Which branch to work on is a
 * decision inside the chat, not a reason to start another one.
 */
export function isSameRepo(a: RepoPick | null | undefined, b: RepoPick | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.owner.trim().toLowerCase() === b.owner.trim().toLowerCase() &&
    a.repo.trim().toLowerCase() === b.repo.trim().toLowerCase()
  );
}

/**
 * Where a pick should land.
 *
 * `current` is the chat on screen — null when there is none, which is a real
 * case (`/clear` leaves the store empty for a moment, and the composer spins up
 * a chat lazily). With no chat to move, a pick can only create one.
 */
export function planRepoPick(input: {
  pick: RepoPick;
  intent?: RepoPickIntent;
  current: RouteCandidate | null;
  /** Every conversation, including the current one */
  conversations: RouteCandidate[];
}): RepoRouting {
  const { pick, current, conversations } = input;
  const intent = input.intent ?? "auto";
  const onRepoAlready = Boolean(current && isSameRepo(current.repoContext, pick));

  // The tick row: picking what is already attached is not an instruction.
  if (onRepoAlready) return { action: "none" };

  // An explicit switch is explicit. Even for a repository no chat has, moving
  // this chat is what the user asked for.
  if (intent === "switch") return { action: "switch" };

  // Nothing to move: this chat has no repository, so attaching is the same
  // gesture as arming a new chat — and creating one instead would leave the
  // empty chat the user was just looking at abandoned.
  if (!current || !current.repoContext) return { action: "attach" };

  // Someone else is already on it. Reuse beats duplication: a second thread on
  // one project is a thing the user can ask for (the sidebar's +), not a thing
  // to do on their behalf.
  const existing = conversations
    .filter((c) => c.id !== current.id && isSameRepo(c.repoContext, pick))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (existing) {
    return { action: "open-chat", conversationId: existing.id, title: existing.title };
  }

  return { action: "new-chat" };
}
