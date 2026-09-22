// ============================================================
// Chat Store — Conversation Context Clearing (/clear)
// and what a new chat starts from
// ============================================================
// /clear is the one command that deliberately makes a conversation
// forget. It must do that WITHOUT destroying anything: the session
// log is the audit trail of what the model saw, so clearing hides
// messages (recoverable) and drops the rolling summary (which would
// otherwise keep feeding the model the context being cleared).

import { describe, it, expect, beforeEach, vi } from "vitest";

/** The fake IndexedDB, so "the records are gone" is checkable */
const idb = new Map<string, string>();

vi.mock("@/services/idb-storage.service", () => ({
  readValue: vi.fn(async (key: string) => idb.get(key) ?? null),
  writeValue: vi.fn(async (key: string, value: string | null) => {
    if (value === null) idb.delete(key);
    else idb.set(key, value);
  }),
}));

// ensureWorkspace needs a write-capable base commit; in these tests there is
// none, which is exactly the branch that must NOT fall back to a stale
// workspace from another repository.
vi.mock("@/features/chat/lib/github-write", () => ({
  getBranchHead: vi.fn(async () => {
    throw new Error("no write access in tests");
  }),
}));

import { useChatStore } from "./chat.store";
import { visibleMessages } from "@/features/chat/types";
import type { RepoContext, WorkspaceState, WorkspaceFile } from "@/features/chat/types";
import { persistWorkspace } from "@/features/chat/workspace/workspace";

const WEB: RepoContext = { owner: "acme", repo: "web", branch: "main", attachedAt: 1 };

describe("workspace summary in the chat list", () => {
  function file(path: string, status: "modified" | "unchanged"): WorkspaceFile {
    return {
      path,
      content: status === "modified" ? "edited" : "base",
      baseContent: "base",
      baseSha: "sha",
      status,
      updatedAt: 1,
    };
  }

  function workspaceWith(changed: number, conversationId: string): WorkspaceState {
    const files: Record<string, WorkspaceFile> = { "src/untouched.ts": file("src/untouched.ts", "unchanged") };
    for (let i = 0; i < changed; i++) {
      files[`src/file-${i}.ts`] = file(`src/file-${i}.ts`, "modified");
    }
    return {
      conversationId,
      owner: "acme",
      repo: "web",
      branch: "main",
      baseCommitSha: "sha",
      workingBranch: null,
      tree: [],
      files,
      updatedAt: 1,
    };
  }

  it("counts only files that differ from the base", () => {
    const id = store().createConversation("model-a");
    store().setWorkspace(id, workspaceWith(3, id));
    expect(store().conversations.find((c) => c.id === id)?.pendingChanges).toBe(3);
  });

  it("follows the workspace down to zero without touching the conversation's recency", () => {
    // The list sorts by updatedAt. An agent write must not reorder the list,
    // but reverting everything must clear the badge — a stale "3 changed" on
    // a clean workspace is worse than no badge at all.
    const id = store().createConversation("model-a");
    store().setWorkspace(id, workspaceWith(2, id));
    const touched = store().conversations.find((c) => c.id === id)!.updatedAt;

    store().patchWorkspace(id, workspaceWith(0, id));
    const conv = store().conversations.find((c) => c.id === id);
    expect(conv?.pendingChanges).toBe(0);
    expect(conv?.updatedAt).toBe(touched);
  });

  it("takes the chat's working copies with it when the chat is deleted", async () => {
    // One record per repository the chat was attached to. Left behind, they
    // keep the user's un-pushed code on disk for a chat they deleted.
    const id = store().createConversation("model-a");
    store().setWorkspace(id, workspaceWith(2, id));
    await persistWorkspace(store().workspaces[id]!);
    expect([...idb.keys()].some((k) => k.includes(id))).toBe(true);

    store().deleteConversation(id);
    // The deletion is fire-and-forget (the UI must not wait on IndexedDB),
    // and it takes several awaits to read the index and clear each record.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect([...idb.keys()].filter((k) => k.includes(id))).toEqual([]);
    expect(store().workspaces[id]).toBeUndefined();
  });

  it("never hands back a workspace from another repository", async () => {
    // The in-memory guard returned whatever workspace the chat had, so
    // attaching a second repo kept editing the first one's files while every
    // record on disk named the other repository.
    // A token, because a workspace is only ever created for a repo the user
    // can read: without one there is nothing to reuse in the first place.
    useChatStore.setState({
      settings: { ...store().settings, github: { ...store().settings.github, token: "t" } },
    });
    const id = store().createConversation("model-a", { repo: WEB });
    store().setWorkspace(id, workspaceWith(1, id));
    expect(await store().ensureWorkspace(id)).toBe(store().workspaces[id]);

    store().setConversationRepo(id, { ...WEB, repo: "api" });
    // No write-capable base for the new repo in this test, so the honest
    // answer is "none" — not the old repository's working copy.
    expect(await store().ensureWorkspace(id)).toBeNull();
  });

  it("leaves other conversations' summaries alone", () => {
    const one = store().createConversation("model-a");
    const two = store().createConversation("model-a");
    store().setWorkspace(one, workspaceWith(1, one));
    store().setWorkspace(two, workspaceWith(4, two));
    expect(store().conversations.find((c) => c.id === one)?.pendingChanges).toBe(1);
    expect(store().conversations.find((c) => c.id === two)?.pendingChanges).toBe(4);
  });
});

describe("createConversation — what a new chat inherits", () => {
  it("starts in the same repository as the chat it came from", () => {
    // The expensive context (tree, file reads, preview build) is per REPO,
    // and re-attaching it for every new chat made "new chat" a project reset.
    const first = store().createConversation("model-a", { repo: WEB });
    store().selectConversation(first);

    const second = store().createConversation("model-a");
    const conv = store().conversations.find((c) => c.id === second);
    expect(conv?.repoContext).toEqual(WEB);
    // A different thread, though: its own id, and its own workspace record.
    expect(second).not.toBe(first);
  });

  it("keeps a chat with no repository possible", () => {
    const first = store().createConversation("model-a", { repo: WEB });
    store().selectConversation(first);

    const detached = store().createConversation("model-a", { repo: null });
    expect(store().conversations.find((c) => c.id === detached)?.repoContext).toBeUndefined();
  });

  it("takes a different repository when the caller names one", () => {
    const first = store().createConversation("model-a", { repo: WEB });
    store().selectConversation(first);

    const api: RepoContext = { ...WEB, repo: "api" };
    const other = store().createConversation("model-a", { repo: api });
    expect(store().conversations.find((c) => c.id === other)?.repoContext).toEqual(api);
  });

  it("inherits the agent mode, because it is a choice about this work", () => {
    const first = store().createConversation("model-a", { repo: WEB, mode: "plan" });
    store().selectConversation(first);
    store().setConversationMode(first, "plan");

    const second = store().createConversation("model-a");
    expect(store().conversations.find((c) => c.id === second)?.mode).toBe("plan");
  });

  it("inherits nothing when there is no chat to inherit from", () => {
    useChatStore.setState({ conversations: [], activeConversationId: null });
    const only = store().createConversation("model-a");
    expect(store().conversations.find((c) => c.id === only)?.repoContext).toBeUndefined();
  });
});

function store() {
  return useChatStore.getState();
}

function messagesOf(conversationId: string) {
  return store().conversations.find((c) => c.id === conversationId)?.messages ?? [];
}

let conversationId = "";
let otherId = "";

beforeEach(() => {
  otherId = store().createConversation("model-a");
  store().addMessage(otherId, { role: "user", content: "untouched conversation" });
  conversationId = store().createConversation("model-a");
  store().addMessage(conversationId, { role: "user", content: "first" });
  store().addMessage(conversationId, { role: "assistant", content: "second" });
});

describe("clearConversationContext", () => {
  it("hides every stored message without deleting any", () => {
    const before = messagesOf(conversationId);
    expect(visibleMessages(before)).toHaveLength(2);

    store().clearConversationContext(conversationId);

    const after = messagesOf(conversationId);
    expect(after).toHaveLength(before.length); // nothing destroyed
    expect(visibleMessages(after)).toHaveLength(0); // nothing sent
    expect(after.every((m) => m.hidden === true)).toBe(true);
    // Content survives for the session log / export
    expect(after.map((m) => m.content)).toEqual(["first", "second"]);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
  });

  it("drops the rolling summary that described the cleared history", () => {
    store().applyCompaction(conversationId, {
      text: "Earlier: the user said first, the assistant said second.",
      coversCount: 0,
      createdAt: Date.now(),
      freedTokens: 42,
    });
    expect(store().conversations.find((c) => c.id === conversationId)?.summary).toBeTruthy();

    store().clearConversationContext(conversationId);

    expect(store().conversations.find((c) => c.id === conversationId)?.summary).toBeUndefined();
  });

  it("leaves other conversations alone", () => {
    store().clearConversationContext(conversationId);
    const other = messagesOf(otherId);
    expect(visibleMessages(other)).toHaveLength(1);
    expect(other[0]!.hidden ?? false).toBe(false);
  });
});

// ============================================================
// Composer drafts — one per thread, keyed by the thread
// ============================================================
describe("composer drafts", () => {
  it("keeps each conversation's text to itself", () => {
    // The bug this prevents: a single shared draft carried what you typed in
    // one chat into another, where Enter would send it to the wrong thread.
    store().setComposerDraft(conversationId, "typing here");
    store().setComposerDraft(otherId, "and here");

    expect(store().composerDrafts[conversationId]?.draft).toBe("typing here");
    expect(store().composerDrafts[otherId]?.draft).toBe("and here");
  });

  it("applies a functional update, which is how imported files are appended", () => {
    store().setComposerDraft(conversationId, "start ");
    store().setComposerDraft(conversationId, (previous) => previous + "appended");
    expect(store().composerDrafts[conversationId]?.draft).toBe("start appended");
  });

  it("keeps the attachments next to the text they belong to", () => {
    const image = { id: "a1", name: "shot.png", size: 12, mime: "image/png", dataUrl: "data:," };
    store().setComposerImages(conversationId, [image]);
    store().setComposerDraft(conversationId, "look at this");

    expect(store().composerDrafts[conversationId]?.images).toHaveLength(1);
    expect(store().composerDrafts[conversationId]?.draft).toBe("look at this");
    expect(store().composerDrafts[otherId]).toBeUndefined();
  });

  it("goes away with the chat, attachments and all", () => {
    store().setComposerDraft(otherId, "unsent");
    store().setComposerImages(otherId, [
      { id: "a2", name: "big.png", size: 12, mime: "image/png", dataUrl: "data:," },
    ]);

    store().deleteConversation(otherId);

    expect(store().composerDrafts[otherId]).toBeUndefined();
    // …and only that chat's.
    expect(store().composerDrafts[conversationId]?.draft ?? "").toBe("");
  });

  it("ignores a write with no conversation to attach it to", () => {
    store().setComposerDraft("", "orphan");
    expect(store().composerDrafts[""]).toBeUndefined();
  });
});
