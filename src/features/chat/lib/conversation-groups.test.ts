import { describe, it, expect } from "vitest";
import {
  NO_REPO_GROUP_KEY,
  conversationMatchesQuery,
  conversationRowMeta,
  groupConversationsByRepository,
  hasRowMeta,
} from "./conversation-groups";
import type { ChatConversation } from "../types";

function conversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: overrides.id ?? "c1",
    title: overrides.title ?? "Chat",
    messages: overrides.messages ?? [],
    createdAt: 0,
    updatedAt: overrides.updatedAt ?? 1_000,
    ...overrides,
  };
}

function onRepo(owner: string, repo: string, branch = "main") {
  return { owner, repo, branch, attachedAt: 0 };
}

describe("groupConversationsByRepository", () => {
  it("files each chat under its repository, and never merges two repos", () => {
    const groups = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("acme", "web") }),
      conversation({ id: "b", repoContext: onRepo("acme", "api") }),
      conversation({ id: "c", repoContext: onRepo("acme", "web") }),
    ]);

    const byLabel = new Map(groups.map((g) => [g.label, g]));
    expect([...byLabel.keys()].sort()).toEqual(["acme/api", "acme/web"]);
    expect(byLabel.get("acme/web")?.conversations.map((c) => c.id)).toEqual(["a", "c"]);
    expect(byLabel.get("acme/api")?.conversations.map((c) => c.id)).toEqual(["b"]);
  });

  it("keeps one group per repo even when the casing differs", () => {
    // GitHub owner/repo names are case-insensitive, and two headers for
    // `Acme/Web` and `acme/web` is a bug the user can see but not explain.
    const groups = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("Acme", "Web") }),
      conversation({ id: "b", repoContext: onRepo("acme", "web") }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.conversations).toHaveLength(2);
    // The first spelling seen is the one shown.
    expect(groups[0]!.label).toBe("Acme/Web");
  });

  it("sums the changed files across the repo's threads", () => {
    // The number the group header exists for: what is in flight on this repo,
    // whichever thread put it there.
    const groups = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("acme", "web"), pendingChanges: 3 }),
      conversation({ id: "b", repoContext: onRepo("acme", "web"), pendingChanges: 2 }),
      conversation({ id: "c", repoContext: onRepo("acme", "api"), pendingChanges: 5 }),
    ]);

    const web = groups.find((g) => g.label === "acme/web")!;
    expect(web.pendingChanges).toBe(5);
    expect(groups.find((g) => g.label === "acme/api")!.pendingChanges).toBe(5);
  });

  it("collects the branches in use, so a diverged repo can say so", () => {
    const groups = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("acme", "web", "main") }),
      conversation({ id: "b", repoContext: onRepo("acme", "web", "feat/lunch") }),
      conversation({ id: "c", repoContext: onRepo("acme", "web", "main") }),
    ]);
    expect(groups[0]!.branches).toEqual(["main", "feat/lunch"]);
  });

  it("groups the chats with no repository together", () => {
    const groups = groupConversationsByRepository([
      conversation({ id: "a" }),
      conversation({ id: "b", repoContext: onRepo("acme", "web") }),
    ]);
    const scratch = groups.find((g) => g.key === NO_REPO_GROUP_KEY)!;
    expect(scratch.repo).toBeNull();
    expect(scratch.label).toBe("No repository");
    expect(scratch.conversations.map((c) => c.id)).toEqual(["a"]);
  });

  it("puts the most recently worked-on repo first", () => {
    const groups = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("acme", "web"), updatedAt: 100 }),
      conversation({ id: "b", repoContext: onRepo("acme", "api"), updatedAt: 900 }),
      conversation({ id: "c", repoContext: onRepo("acme", "web"), updatedAt: 500 }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["acme/api", "acme/web"]);
    // …and within the group, the same rule.
    expect(groups[1]!.conversations.map((c) => c.id)).toEqual(["c", "a"]);
  });

  it("floats a repo above recency when one of its chats is pinned", () => {
    // Pinning is an explicit "keep this in front of me". Grouping must not
    // quietly demote it to "whatever I touched last".
    const groups = groupConversationsByRepository([
      conversation({ id: "old", repoContext: onRepo("acme", "web"), updatedAt: 10, pinned: true }),
      conversation({ id: "recent", repoContext: onRepo("acme", "api"), updatedAt: 9_000 }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["acme/web", "acme/api"]);
    expect(groups[0]!.pinned).toBe(true);
  });

  it("orders rows inside a group by pin, then recency", () => {
    const groups = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("acme", "web"), updatedAt: 300 }),
      conversation({ id: "b", repoContext: onRepo("acme", "web"), updatedAt: 100, pinned: true }),
      conversation({ id: "c", repoContext: onRepo("acme", "web"), updatedAt: 200 }),
    ]);
    expect(groups[0]!.conversations.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("never drops a chat, however many repos are in play", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      conversation({
        id: `c${i}`,
        repoContext: i % 3 === 0 ? undefined : onRepo("acme", `repo-${i % 5}`),
      })
    );
    const groups = groupConversationsByRepository(many);
    const total = groups.reduce((sum, g) => sum + g.conversations.length, 0);
    expect(total).toBe(25);
  });

  it("is stable for equal timestamps instead of flickering", () => {
    const conversations = [
      conversation({ id: "a", repoContext: onRepo("acme", "web"), updatedAt: 100 }),
      conversation({ id: "b", repoContext: onRepo("acme", "api"), updatedAt: 100 }),
    ];
    const first = groupConversationsByRepository(conversations).map((g) => g.label);
    const second = groupConversationsByRepository([...conversations].reverse()).map((g) => g.label);
    expect(first).toEqual(second);
  });

  it("survives a persisted record with fields missing", () => {
    // These are PERSISTED conversations: a record from an older build, or from
    // an attach path that had no branch, reaches this code after the code that
    // wrote it is gone. The first version of this file called `.toLowerCase()`
    // on a missing branch and took the whole page down — a malformed record
    // must cost its own row and nothing more.
    const missingBranch = conversation({
      id: "no-branch",
      repoContext: { owner: "acme", repo: "web", attachedAt: 0 } as never,
    });
    const missingRepo = conversation({
      id: "no-repo-name",
      repoContext: { owner: "acme", branch: "main", attachedAt: 0 } as never,
    });

    const groups = groupConversationsByRepository([missingBranch, missingRepo]);
    expect(groups.find((g) => g.label === "acme/web")?.conversations.map((c) => c.id)).toEqual([
      "no-branch",
    ]);
    expect(groups.find((g) => g.label === "acme/web")?.branches).toEqual([]);
    // No repository to name means it belongs with the chats that have none.
    expect(groups.find((g) => g.key === NO_REPO_GROUP_KEY)?.conversations.map((c) => c.id)).toEqual([
      "no-repo-name",
    ]);

    // …and searching must not throw on any of it.
    expect(conversationMatchesQuery(missingBranch, "acme")).toBe(true);
    expect(conversationMatchesQuery(missingBranch, "nothing")).toBe(false);
    // An owner with no repo name is no repository to match against — which is
    // a miss, not an exception.
    expect(conversationMatchesQuery(missingRepo, "acme")).toBe(false);
    expect(conversationMatchesQuery(missingRepo, "nothing")).toBe(false);
  });

  it("treats a missing or unusable change count as zero", () => {
    const groups = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("acme", "web") }),
      conversation({ id: "b", repoContext: onRepo("acme", "web"), pendingChanges: 0 }),
    ]);
    expect(groups[0]!.pendingChanges).toBe(0);
  });
});

describe("conversationRowMeta", () => {
  // The reported bug: a bare `0` under every new chat in a repo. The row's
  // guard was `(showBranch || conv.pendingChanges) && <div>`, and `undefined ||
  // 0` is `0`, which React renders. These pin the values that caused it.
  it("reports nothing to show for a fresh chat on a single-branch repo", () => {
    const groups = groupConversationsByRepository([
      conversation({ id: "fresh", repoContext: onRepo("acme", "web") }),
    ]);
    const group = groups[0]!;
    const row = conversationRowMeta(group, group.conversations[0]!);
    expect(row).toEqual({ branch: null, changed: 0 });
    expect(hasRowMeta(group, group.conversations[0]!)).toBe(false);
  });

  it("shows the branch only when the repo's threads disagree on one", () => {
    const groups = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("acme", "web", "main") }),
      conversation({ id: "b", repoContext: onRepo("acme", "web", "feat/x") }),
    ]);
    const group = groups[0]!;
    const first = group.conversations.find((c) => c.id === "a")!;
    expect(conversationRowMeta(group, first).branch).toBe("main");
    expect(hasRowMeta(group, first)).toBe(true);

    const single = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("acme", "web", "main") }),
    ])[0]!;
    expect(conversationRowMeta(single, single.conversations[0]!).branch).toBeNull();
  });

  it("shows the branch on the row being READ even when its neighbours agree", () => {
    // The open row is the one place the branch is context rather than noise:
    // "which branch is this chat on?" is a question about the thread in front,
    // and it is asked of a repo whose threads are all on `main` too.
    const groups = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("acme", "web", "main") }),
      conversation({ id: "b", repoContext: onRepo("acme", "web", "main") }),
    ]);
    const group = groups[0]!;
    const first = group.conversations.find((c) => c.id === "a")!;
    expect(conversationRowMeta(group, first)).toEqual({ branch: null, changed: 0 });
    expect(conversationRowMeta(group, first, { alwaysBranch: true }).branch).toBe("main");
  });

  it("still reports no branch to show for a chat with no repository", () => {
    // `alwaysBranch` asks for the branch, it does not invent one.
    const groups = groupConversationsByRepository([conversation({ id: "none" })]);
    const group = groups[0]!;
    expect(conversationRowMeta(group, group.conversations[0]!, { alwaysBranch: true }).branch).toBeNull();
  });

  it("shows the changed count on the thread that holds the work", () => {
    const groups = groupConversationsByRepository([
      conversation({ id: "a", repoContext: onRepo("acme", "web"), pendingChanges: 3 }),
    ]);
    const group = groups[0]!;
    expect(conversationRowMeta(group, group.conversations[0]!)).toEqual({
      branch: null,
      changed: 3,
    });
    expect(hasRowMeta(group, group.conversations[0]!)).toBe(true);
  });
});

describe("conversationMatchesQuery", () => {
  it("matches the repository, because that is what the list is grouped by", () => {
    const c = conversation({ title: "Fix the lunch page", repoContext: onRepo("acme", "web") });
    expect(conversationMatchesQuery(c, "acme")).toBe(true);
    expect(conversationMatchesQuery(c, "acme/web")).toBe(true);
    expect(conversationMatchesQuery(c, "web")).toBe(true);
  });

  it("matches the branch, which is written on the row", () => {
    const c = conversation({ repoContext: onRepo("acme", "web", "feat/lunch") });
    expect(conversationMatchesQuery(c, "feat")).toBe(true);
  });

  it("still matches a title or a message", () => {
    const c = conversation({
      title: "Menu filter",
      messages: [{ id: "m", role: "user", content: "the noise texture is missing", timestamp: 0 }],
    });
    expect(conversationMatchesQuery(c, "menu")).toBe(true);
    expect(conversationMatchesQuery(c, "texture")).toBe(true);
    expect(conversationMatchesQuery(c, "nothing here")).toBe(false);
  });

  it("matches everything when the box is empty or blank", () => {
    const c = conversation({ repoContext: onRepo("acme", "web") });
    expect(conversationMatchesQuery(c, "")).toBe(true);
    expect(conversationMatchesQuery(c, "   ")).toBe(true);
  });
});
