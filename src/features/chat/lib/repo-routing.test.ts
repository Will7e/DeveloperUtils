// ============================================================
// Repo Routing — What Picking A Repository Should Do
// ============================================================
// The interesting cases are all about what the user LOSES, so they are the ones
// pinned here: the chat they were in (must not be repointed without being
// asked), the thread that already has the project open (must not be
// duplicated), and the empty chat they just opened (must not be abandoned by a
// pick that creates another one).

import { describe, it, expect } from "vitest";
import {
  isSameRepo,
  planRepoPick,
  strandedChangeCount,
  type RouteCandidate,
} from "./repo-routing";
import type { RepoContext } from "../types";

const repo = (owner: string, name: string, branch = "main"): RepoContext => ({
  owner,
  repo: name,
  branch,
  attachedAt: 1,
});

function chat(
  id: string,
  title: string,
  repoContext: RepoContext | undefined,
  updatedAt = 1
): RouteCandidate {
  return { id, title, repoContext, updatedAt };
}

describe("isSameRepo", () => {
  it("ignores case, because GitHub does", () => {
    expect(isSameRepo({ owner: "Acme", repo: "Web" }, { owner: "acme", repo: "web" })).toBe(true);
  });

  it("ignores the branch — two branches are one project", () => {
    // The sidebar groups by repository, so a chat on `main` and a chat on
    // `feat/x` are two threads about one project, not two projects.
    expect(
      isSameRepo({ owner: "acme", repo: "web", branch: "main" }, repo("acme", "web", "feat/x"))
    ).toBe(true);
  });

  it("is false for a different repository, and for nothing at all", () => {
    expect(isSameRepo({ owner: "acme", repo: "web" }, { owner: "acme", repo: "api" })).toBe(false);
    expect(isSameRepo(null, { owner: "acme", repo: "web" })).toBe(false);
    expect(isSameRepo({ owner: "acme", repo: "web" }, undefined)).toBe(false);
  });
});

describe("planRepoPick", () => {
  const pick = { owner: "acme", repo: "billing" };

  it("does nothing when the pick is what the chat is already on", () => {
    // The tick row. Not an instruction — and it must not be, or clicking the
    // row you are "on" (easy to do while looking) would restart the workspace.
    const current = chat("a", "billing chat", repo("acme", "billing"));
    expect(planRepoPick({ pick, current, conversations: [current] })).toEqual({ action: "none" });
    // Even when asked to switch: there is nothing to switch to.
    expect(
      planRepoPick({ pick, intent: "switch", current, conversations: [current] })
    ).toEqual({ action: "none" });
  });

  it("attaches in place when this chat has no repository yet", () => {
    // The arming gesture. Opening a second chat here would abandon the empty
    // one the user is looking at, which is the friction this picker exists to
    // remove, not add.
    const current = chat("a", "New chat", undefined);
    expect(planRepoPick({ pick, current, conversations: [current] })).toEqual({ action: "attach" });
  });

  it("opens a chat when there is no chat on screen to attach to", () => {
    // The store can genuinely be empty (deleting the last conversation clears
    // it), so "attach" has to mean "make one and attach it".
    expect(planRepoPick({ pick, current: null, conversations: [] })).toEqual({ action: "attach" });
  });

  it("opens a new chat for a repository nothing has open", () => {
    // THE reported case: fresh work on a project the user has never used. The
    // conversation they were having is not repointed, and the work is not
    // started inside it.
    const current = chat("a", "web chat", repo("acme", "web"));
    expect(planRepoPick({ pick, current, conversations: [current] })).toEqual({
      action: "new-chat",
    });
  });

  it("goes to the chat that already has the repository", () => {
    const current = chat("a", "web chat", repo("acme", "web"));
    const billing = chat("b", "billing work", repo("acme", "billing"), 50);
    expect(planRepoPick({ pick, current, conversations: [current, billing] })).toEqual({
      action: "open-chat",
      conversationId: "b",
      title: "billing work",
    });
  });

  it("goes to the MOST RECENT chat when several have it", () => {
    const current = chat("a", "web chat", repo("acme", "web"));
    const old = chat("b", "billing (old)", repo("acme", "billing"), 10);
    const recent = chat("c", "billing (recent)", repo("acme", "billing"), 90);
    expect(planRepoPick({ pick, current, conversations: [current, old, recent] })).toEqual({
      action: "open-chat",
      conversationId: "c",
      title: "billing (recent)",
    });
  });

  it("counts a chat on another BRANCH of the repository as having it open", () => {
    const current = chat("a", "web chat", repo("acme", "web"));
    const otherBranch = chat("b", "billing on a branch", repo("acme", "billing", "feat/x"), 20);
    expect(planRepoPick({ pick, current, conversations: [current, otherBranch] })).toEqual({
      action: "open-chat",
      conversationId: "b",
      title: "billing on a branch",
    });
  });

  it("switches THIS chat when the user asked for a switch", () => {
    // The escape hatch, and it must win even when another chat has the
    // repository: the user looked at that chat's existence and chose anyway.
    const current = chat("a", "web chat", repo("acme", "web"));
    const billing = chat("b", "billing work", repo("acme", "billing"), 50);
    expect(
      planRepoPick({ pick, intent: "switch", current, conversations: [current, billing] })
    ).toEqual({ action: "switch" });
  });

  it("honours an explicit switch for a repository nobody has, and for an empty chat", () => {
    const current = chat("a", "web chat", repo("acme", "web"));
    expect(planRepoPick({ pick, intent: "switch", current, conversations: [current] })).toEqual({
      action: "switch",
    });
    const empty = chat("a", "New chat", undefined);
    expect(planRepoPick({ pick, intent: "switch", current: empty, conversations: [empty] })).toEqual(
      { action: "switch" }
    );
  });

  it("never routes to the chat it is already in", () => {
    // `conversations` includes the current chat. If it were eligible for
    // `open-chat`, a re-pick would "navigate" to where the user already is and
    // report success without doing anything.
    const current = chat("a", "web chat", repo("acme", "billing"));
    expect(
      planRepoPick({ pick, current, conversations: [current, chat("b", "other", undefined)] })
    ).toEqual({ action: "none" });
  });

  it("matches a repository regardless of the case the account uses", () => {
    const current = chat("a", "web chat", repo("acme", "web"));
    const billing = chat("b", "billing work", repo("ACME", "Billing"), 50);
    expect(
      planRepoPick({
        pick: { owner: "acme", repo: "billing" },
        current,
        conversations: [current, billing],
      })
    ).toMatchObject({ action: "open-chat", conversationId: "b" });
  });

  it("states the work a move would leave behind, as a count", () => {
    // The confirmation is only worth showing when there IS work to leave, and it
    // has to be able to say how much: "3 changed files stay with this chat" is a
    // decision, "unsaved changes" is a scare.
    expect(strandedChangeCount(3)).toBe(3);
    expect(strandedChangeCount(0)).toBe(0);
    expect(strandedChangeCount(undefined)).toBe(0);
  });

  it("refuses to render a nonsensical count at a user", () => {
    // `pendingChanges` is persisted with the conversation, so it arrives from
    // storage as well as from the workspace. A corrupted value must not be able
    // to keep a modal in front of the user forever, and "NaN changed files" is
    // the kind of copy that makes someone distrust the whole feature.
    expect(strandedChangeCount(NaN)).toBe(0);
    expect(strandedChangeCount(-4)).toBe(0);
    expect(strandedChangeCount(Infinity)).toBe(0);
    // A fraction is still work, and it rounds down to a whole file rather than
    // claiming more than exists.
    expect(strandedChangeCount(2.7)).toBe(2);
  });

  it("opens a new chat for a repo whose only near-match is a different owner", () => {
    const current = chat("a", "web chat", repo("acme", "web"));
    const other = chat("b", "someone else's billing", repo("other", "billing"), 90);
    expect(
      planRepoPick({
        pick: { owner: "acme", repo: "billing" },
        current,
        conversations: [current, other],
      })
    ).toEqual({ action: "new-chat" });
  });
});
