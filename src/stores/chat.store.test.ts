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

import {
  currentWorkspace,
  selectApprovalCount,
  selectCheckStartedAt,
  selectHasApprovalOfKind,
  selectPendingApproval,
  selectReconnecting,
  selectStream,
  selectStreamAborted,
  selectWorkspace,
  useChatStore,
} from "./chat.store";
import { visibleMessages } from "@/features/chat/types";
import type { RepoContext, WorkspaceState, WorkspaceFile } from "@/features/chat/types";
import { persistWorkspace } from "@/features/chat/workspace/workspace";
import {
  bindingIdOf,
  clearAttachment,
  resetBindings,
  setAttachment,
} from "@/features/chat/identity/bindings";
import type { RepoRef } from "@/features/chat/identity/identity";

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

  it("replaces the last chat with one that keeps its repository", () => {
    // Deleting the final chat emptied the store, and the fresh chat the page
    // spun up to keep the composer usable inherited NOTHING — with no active
    // chat left, there was nothing to inherit from, so the repository
    // silently detached the moment the user tidied up their chat list.
    useChatStore.setState({ conversations: [], activeConversationId: null });
    const id = store().createConversation("model-a", { repo: WEB });
    store().deleteConversation(id);

    const fresh = store().conversations[0];
    expect(fresh).toBeDefined();
    expect(fresh?.repoContext).toEqual(WEB);
  });

  it("replaces the last chat with a detached one only when it was detached", () => {
    // `repo: null` is a deliberate seed, not a fallback: the store keeps what
    // the deleted chat had, even when that was nothing.
    useChatStore.setState({ conversations: [], activeConversationId: null });
    const id = store().createConversation("model-a");
    store().deleteConversation(id);

    const fresh = store().conversations[0];
    expect(fresh).toBeDefined();
    expect(fresh?.repoContext).toBeUndefined();
  });

  it("does not spawn a replacement when other chats remain", () => {
    useChatStore.setState({ conversations: [], activeConversationId: null });
    const kept = store().createConversation("model-a", { repo: WEB });
    const deleted = store().createConversation("model-a");
    store().deleteConversation(deleted);

    expect(store().conversations.map((c) => c.id)).toEqual([kept]);
  });

  it("carries the deleted chat's mode into the replacement", () => {
    useChatStore.setState({ conversations: [], activeConversationId: null });
    const id = store().createConversation("model-a", { repo: WEB, mode: "plan" });
    store().setConversationMode(id, "plan");
    store().deleteConversation(id);

    expect(store().conversations[0]?.mode).toBe("plan");
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
    // The expensive context (tree, file reads) is per REPO, and re-attaching
    // it for every new chat made "new chat" a project reset.
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

describe("duplicateConversation — a fork of the transcript, not of the turn", () => {
  /** The source, carrying every piece of in-flight state a copy must not take */
  function sourceWithLiveTurn(): string {
    const id = store().createConversation("model-a", { repo: WEB });
    store().addMessage(id, { role: "user", content: "do the thing" });
    const withoutTurnState = store().conversations.find((c) => c.id === id)!;
    useChatStore.setState({
      conversations: [
        {
          ...withoutTurnState,
          // A workspace, so the summary below is a real count and not zero
          pendingChanges: 3,
          plan: {
            steps: [{ id: "s1", text: "edit the file", status: "active" }],
            updatedAt: 1,
            complete: false,
          },
          pendingTurn: { startedAt: 2 },
          pendingQuestion: {
            header: "Which?",
            question: "Pick one",
            options: [{ label: "a" }],
            callId: "call-1",
            askedAt: 3,
          },
          queued: [{ id: "q1", text: "and also", queuedAt: 4 }],
          // Configuration and history: these DO belong to the chat
          model: "model-a",
          mode: "plan",
          systemPrompt: "be terse",
          summary: { text: "earlier", coversCount: 2, createdAt: 5, freedTokens: 120 },
        },
        ...store().conversations.filter((c) => c.id !== id),
      ],
    });
    return id;
  }

  it("carries no unfinished-turn state into the copy", () => {
    // Each of these is user-visible on the copy and each one is false there: a
    // resume prompt for the source's turn, a question card whose answer would
    // resume a tool loop the copy never ran, queued messages waiting for a
    // round boundary the copy cannot reach, and a live plan it is not running.
    const id = sourceWithLiveTurn();
    const copyId = store().duplicateConversation(id)!;
    const copy = store().conversations.find((c) => c.id === copyId)!;

    expect(copy.pendingTurn).toBeUndefined();
    expect(copy.pendingQuestion).toBeUndefined();
    expect(copy.queued).toBeUndefined();
    expect(copy.plan).toBeUndefined();

    // The source keeps all of it: duplicating must not disturb the original.
    const source = store().conversations.find((c) => c.id === id)!;
    expect(source.pendingTurn).toEqual({ startedAt: 2 });
    expect(source.pendingQuestion?.callId).toBe("call-1");
    expect(source.queued).toHaveLength(1);
    expect(source.plan?.steps).toHaveLength(1);
  });

  it("does not claim the source's changed-file count", () => {
    // `pendingChanges` summarises a workspace the copy does not have yet: its
    // id keys nothing in `workspaces`. Inheriting the count put a "3 changed"
    // badge on a chat with no changes, and clicking it opened an empty pane.
    const id = sourceWithLiveTurn();
    const copyId = store().duplicateConversation(id)!;

    expect(store().conversations.find((c) => c.id === copyId)?.pendingChanges).toBeUndefined();
    expect(store().conversations.find((c) => c.id === id)?.pendingChanges).toBe(3);
    expect(store().workspaces[copyId]).toBeUndefined();
  });

  it("keeps what belongs to the chat and gives the copy its own messages", () => {
    const id = sourceWithLiveTurn();
    const copyId = store().duplicateConversation(id)!;
    const copy = store().conversations.find((c) => c.id === copyId)!;

    expect(copy.title).toMatch(/\(copy\)$/);
    expect(copy.repoContext).toEqual(WEB);
    expect(copy.mode).toBe("plan");
    expect(copy.systemPrompt).toBe("be terse");
    expect(copy.summary).toEqual({ text: "earlier", coversCount: 2, createdAt: 5, freedTokens: 120 });
    expect(copy.messages).toHaveLength(1);
    // Fresh ids, so a reply or an edit in one chat cannot address a message in
    // the other.
    expect(copy.messages[0]!.id).not.toBe(
      store().conversations.find((c) => c.id === id)!.messages[0]!.id
    );
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
    store().applyCompaction(
      conversationId,
      {
        text: "Earlier: the user said first, the assistant said second.",
        coversCount: 0,
        createdAt: Date.now(),
        freedTokens: 42,
      },
      []
    );
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

describe("applyCompaction", () => {
  const summary = (coversCount: number) => ({
    text: "ledger",
    coversCount,
    createdAt: 1,
    freedTokens: 10,
  });

  it("removes exactly the messages it was given, by id", () => {
    store().addMessage(conversationId, { role: "user", content: "third" });
    const [first, second, third] = messagesOf(conversationId);

    store().applyCompaction(conversationId, summary(2), [first!.id, second!.id]);

    const after = messagesOf(conversationId);
    expect(after.map((m) => m.id)).toEqual([third!.id]);
    // The store stamps the record it writes; the fold's fields are what
    // this contract is about.
    expect(store().conversations.find((c) => c.id === conversationId)?.summary).toMatchObject(
      summary(2)
    );
  });

  it("keeps cleared history the fold never covered", () => {
    // /clear hides rows instead of deleting them; a later compaction must
    // not destroy them, whatever their position in the array.
    store().clearConversationContext(conversationId);
    store().addMessage(conversationId, { role: "user", content: "after the clear" });
    const clearedIds = messagesOf(conversationId)
      .filter((m) => m.hidden)
      .map((m) => m.id);
    const live = messagesOf(conversationId).find((m) => !m.hidden)!;

    store().applyCompaction(conversationId, summary(4), [live.id]);

    const after = messagesOf(conversationId);
    expect(after.map((m) => m.id)).toEqual(clearedIds);
    expect(after.every((m) => m.hidden === true)).toBe(true);
  });

  it("changes nothing but the summary when given no ids", () => {
    const before = messagesOf(conversationId);
    store().applyCompaction(conversationId, summary(0), []);
    expect(messagesOf(conversationId).map((m) => m.id)).toEqual(before.map((m) => m.id));
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

// ============================================================
// Reading A Workspace — Fail Closed
// ============================================================
// `workspaces[threadId]` answers "what did this thread last have in memory",
// and for the few hundred milliseconds after a repository switch the honest
// answer is the repository it just left. Every caller of that map meant to ask
// "what is this thread working on NOW", and got the wrong repository's code.
//
// The accessor below is what they use instead. This is the one that matters most
// for writes: an edit that lands in the wrong working copy is invisible, is
// pushed nowhere, and looks to the user like the agent silently did nothing.

describe("selectWorkspace — a working copy, or nothing", () => {
  const WEB: RepoRef = { owner: "acme", repo: "web", branch: "main" };
  const API: RepoRef = { owner: "acme", repo: "api", branch: "main" };

  function workspaceFor(
    conversationId: string,
    ref: RepoRef,
    updatedAt = 1
  ): WorkspaceState {
    return {
      conversationId,
      owner: ref.owner,
      repo: ref.repo,
      branch: ref.branch,
      baseCommitSha: "sha",
      workingBranch: null,
      tree: [],
      files: {},
      updatedAt,
    };
  }

  beforeEach(() => {
    resetBindings();
  });

  it("hands back the workspace of the repository the thread is attached to", async () => {
    const id = store().createConversation("model-a");
    await setAttachment(id, WEB);
    store().setWorkspace(id, workspaceFor(id, WEB));

    expect(selectWorkspace(store(), id)?.repo).toBe("web");
    expect(currentWorkspace(id)?.repo).toBe("web");
  });

  it("refuses the working copy left over from the repository the thread just left", async () => {
    // The reported symptom, at the level where it does damage. The new
    // repository's working copy does not exist yet, so the ONLY acceptable
    // answers are "nothing" or a freshly derived one — never the old one.
    const id = store().createConversation("model-a");
    await setAttachment(id, WEB);
    store().setWorkspace(id, workspaceFor(id, WEB));

    await setAttachment(id, API);
    expect(selectWorkspace(store(), id)).toBeNull();
    // It is still in memory, so nothing was thrown away — it is simply not
    // readable as this thread's current working copy.
    expect(store().workspaces[id]?.repo).toBe("web");
  });

  it("refuses every workspace for a thread with nothing attached", async () => {
    // A thread that detached still has its last working copy in memory. Reading
    // it would let a tool edit a repository the user is no longer on.
    const id = store().createConversation("model-a");
    await setAttachment(id, WEB);
    store().setWorkspace(id, workspaceFor(id, WEB));
    await clearAttachment(id);

    expect(selectWorkspace(store(), id)).toBeNull();
    expect(currentWorkspace(id)).toBeNull();
  });

  it("fails closed for an unknown thread and for no thread at all", () => {
    expect(selectWorkspace(store(), "never-heard-of-it")).toBeNull();
    expect(selectWorkspace(store(), "")).toBeNull();
    expect(currentWorkspace(null)).toBeNull();
  });

  it("ignores stream deltas that belong to no live stream", () => {
    // The buffer exists exactly while the stream does, and every append names
    // its conversation. A delta that arrives after its stream ended — a
    // torn-down round, an adoption that lost a race — is dropped, rather than
    // written into whatever message is committed next.
    const id = store().createConversation("model-a");
    store().endStreaming(id, false);
    store().appendStreamingReasoning(id, "reasoning from a stream that is over");
    store().appendStreamingContent(id, "content from a stream that is over");

    expect(selectStream(store(), id)).toBeNull();

    store().beginStreaming(id);
    store().appendStreamingReasoning(id, "thinking…");
    expect(selectStream(store(), id)?.reasoning).toBe("thinking…");
    store().endStreaming(id, false);
    expect(selectStream(store(), id)).toBeNull();
  });

  it("keeps two agents' streams in their own buffers and their own messages", () => {
    // THE multi-tenancy guarantee. With one app-wide buffer these two streams
    // braided into a single string and the commit took whichever conversation
    // the slot named — one agent's words inside another agent's reply.
    const first = store().createConversation("model-a");
    const second = store().createConversation("model-a");
    store().beginStreaming(first);
    store().beginStreaming(second);
    store().appendStreamingContent(first, "alpha");
    store().appendStreamingContent(second, "beta");
    store().appendStreamingReasoning(second, "thinking about beta");

    expect(selectStream(store(), first)?.content).toBe("alpha");
    expect(selectStream(store(), second)?.content).toBe("beta");
    // Reasoning is not shared either — it landed on the thread that emitted it.
    expect(selectStream(store(), first)?.reasoning).toBe("");

    expect(store().commitStreamingMessage(second, { model: "model-a" })).not.toBeNull();
    const secondMessages = store().conversations.find((c) => c.id === second)?.messages ?? [];
    const firstMessages = store().conversations.find((c) => c.id === first)?.messages ?? [];
    expect(secondMessages.some((m) => m.content === "beta")).toBe(true);
    expect(firstMessages.some((m) => m.content.includes("beta"))).toBe(false);

    store().endStreaming(first, false);
    store().endStreaming(second, false);
  });

  it("marks a stop on the thread that was stopped", () => {
    // "You stopped this one" is a fact about a thread: an app-wide flag would
    // mark a peer agent's healthy reply as aborted too.
    const stopped = store().createConversation("model-a");
    const other = store().createConversation("model-a");
    store().beginStreaming(stopped);
    store().beginStreaming(other);

    store().endStreaming(stopped, true);

    expect(selectStreamAborted(store(), stopped)).toBe(true);
    expect(selectStreamAborted(store(), other)).toBe(false);
    // A new stream for the same thread clears the previous stop.
    store().beginStreaming(stopped);
    expect(selectStreamAborted(store(), stopped)).toBe(false);
    store().endStreaming(other, false);
    store().endStreaming(stopped, false);
  });

  it("tracks reconnecting and running checks per conversation", () => {
    const id = store().createConversation("model-a");
    const peer = store().createConversation("model-a");

    store().setReconnecting(id, true);
    store().setCheckRun(id, true);

    expect(selectReconnecting(store(), id)).toBe(true);
    expect(selectReconnecting(store(), peer)).toBe(false);
    expect(selectCheckStartedAt(store(), id)).not.toBeNull();
    expect(selectCheckStartedAt(store(), peer)).toBeNull();

    store().setReconnecting(id, false);
    store().setCheckRun(id, false);
    // A stale finally() must not blank a newer run's indicator, so clearing a
    // run that is not recorded is a no-op rather than a delete.
    store().setCheckRun(peer, false);
    expect(selectCheckStartedAt(store(), id)).toBeNull();
    store().setCheckRun(peer, true);
    store().setCheckRun(peer, false);
    expect(selectCheckStartedAt(store(), peer)).toBeNull();
  });

  it("refuses a workspace whose repository fields do not match its binding", async () => {
    // Defence in depth: even with the binding attached, a workspace that says it
    // is a copy of something else is not this thread's working copy.
    const id = store().createConversation("model-a");
    await setAttachment(id, WEB);
    store().setWorkspace(id, workspaceFor(id, API));

    expect(selectWorkspace(store(), id)).toBeNull();
  });
});

// A repository switch is a change of JOB, and two things on the conversation
// describe the job that was just left: the plan (whose steps name files in it,
// and which the completion gate reads as unfinished work) and the suggested
// next steps. Both used to survive the move.

describe("a repository switch clears the job that was left behind", () => {
  const WEB: RepoContext = { owner: "acme", repo: "web", branch: "main", attachedAt: 1 };
  const API: RepoContext = { owner: "acme", repo: "api", branch: "main", attachedAt: 2 };

  beforeEach(() => {
    resetBindings();
  });

  it("drops the plan and the suggestions when the repository changes", () => {
    const id = store().createConversation("model-a");
    store().setConversationRepo(id, WEB);
    store().setConversationPlan(id, {
      steps: [{ id: "s1", text: "wire the auth route", status: "active" }],
      updatedAt: 1,
      complete: false,
    });
    store().setSuggestions(id, [{ label: "Add tests", prompt: "Add tests for it." }]);

    store().setConversationRepo(id, API);

    const conv = store().conversations.find((c) => c.id === id);
    expect(conv?.plan).toBeUndefined();
    expect(conv?.suggestions).toBeUndefined();
  });

  it("records the era boundary, and what it moved off", () => {
    // The per-row stamp cannot date rows written before it shipped, so the
    // conversation has to say when the current era began. A chat that moved
    // BEFORE the upgrade has no stamped rows at all, and this is the only
    // thing that keeps the old checkout's file bodies out of its next request.
    const id = store().createConversation("model-a");
    store().setConversationRepo(id, WEB);
    store().setConversationRepo(id, API);

    const conv = store().conversations.find((c) => c.id === id);
    expect(conv?.bindingMove?.from).toBe("acme/web@main");
    expect(typeof conv?.bindingMove?.at).toBe("number");
  });

  it("leaves the era boundary alone when the same repository is re-attached", () => {
    // Re-attaching is not a move, so the rows above stay this repository's own
    // facts rather than being dated into a previous era and withheld.
    const id = store().createConversation("model-a");
    store().setConversationRepo(id, WEB);
    store().setConversationRepo(id, API);
    const afterMove = store().conversations.find((c) => c.id === id)?.bindingMove;

    store().setConversationRepo(id, { ...API, attachedAt: 99 });

    expect(store().conversations.find((c) => c.id === id)?.bindingMove).toEqual(afterMove);
  });

  it("keeps them when the same repository is re-attached", () => {
    // Re-attaching the same repository is not a move, and evicting a plan the
    // user is watching would be the "why did it reset" report all over again.
    const id = store().createConversation("model-a");
    store().setConversationRepo(id, WEB);
    store().setConversationPlan(id, {
      steps: [{ id: "s1", text: "wire the auth route", status: "active" }],
      updatedAt: 1,
      complete: false,
    });

    store().setConversationRepo(id, { ...WEB, attachedAt: 99 });

    expect(store().conversations.find((c) => c.id === id)?.plan?.steps).toHaveLength(1);
  });

  it("stamps every committed message with the binding it was produced under", async () => {
    // The stamp is what makes the repository boundary possible in the request
    // (context/binding-scope.ts): without provenance on the row, a later
    // request cannot tell the previous checkout's file bodies from this one's.
    const id = store().createConversation("model-a");
    store().setConversationRepo(id, WEB);
    await setAttachment(id, { owner: WEB.owner, repo: WEB.repo, branch: WEB.branch });

    store().addMessage(id, { role: "user", content: "hi" });
    store().commitToolCallsMessage(id, [
      { id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' },
    ]);
    store().commitToolResult(
      id,
      { callId: "c1", name: "read_file", ok: true, data: {}, durationMs: 1 },
      '{"content":"body"}'
    );

    const [user, callRow, resultRow] = store().conversations.find((c) => c.id === id)!.messages;
    const expected = bindingIdOf(id);
    expect(user?.bindingId).toBe(expected);
    expect(callRow?.bindingId).toBe(expected);
    expect(resultRow?.bindingId).toBe(expected);
    // …and it is the REPOSITORY, not just "attached": a switch gives a
    // different stamp, which is the whole point.
    expect(expected).toContain("acme/web@main");
  });
});

// ============================================================
// Approval Gates — and the "run tools without asking" opt-out
// ============================================================
// Two tools can act outside this machine: http_write (a request that changes
// someone else's system) and push_changes (a commit and pull request). Both
// block on a dialog by DEFAULT, and both resolve immediately when the user
// has turned on settings.autoApproveTools. These tests pin both directions,
// because the failure that matters is a gate that silently stops gating.
describe("approval gates", () => {
  const pendingHttp = {
    conversationId: "c1",
    createdAt: 1,
    method: "POST",
    url: "https://api.example.com/v1/tickets",
    headers: {},
  };
  const pendingPush = {
    conversationId: "c1",
    createdAt: 1,
    branchName: "agent/x",
    baseBranch: "main",
    commitMessage: "fix: x",
    prTitle: "fix: x",
    changes: [],
    stats: { files: 0, additions: 0, deletions: 0 },
  };

  /** The id of the oldest waiting approval, which is what a dialog answers */
  function headId(): string {
    const head = selectPendingApproval(store());
    if (!head) throw new Error("no approval is waiting");
    return head.id;
  }

  it("parks an external write on a dialog by default", async () => {
    store().updateSettings({ autoApproveTools: false });
    const decision = store().requestHttpApproval(pendingHttp);
    expect(selectPendingApproval(store())?.kind).toBe("http");
    store().resolveApproval(headId(), { approved: true });
    await expect(decision).resolves.toMatchObject({ approved: true });
    expect(selectApprovalCount(store())).toBe(0);
  });

  it("sends nothing and mounts no dialog when the request is declined", async () => {
    store().updateSettings({ autoApproveTools: false });
    const decision = store().requestHttpApproval(pendingHttp);
    store().resolveApproval(headId(), { approved: false, note: "not that record" });
    await expect(decision).resolves.toMatchObject({ approved: false, note: "not that record" });
  });

  it("auto-approves an external write with no dialog when the flag is on", async () => {
    store().updateSettings({ autoApproveTools: true });
    const decision = await store().requestHttpApproval(pendingHttp);
    // `auto` is what lets the tool result tell the model nobody was asked.
    expect(decision).toEqual({ approved: true, auto: true });
    expect(selectApprovalCount(store())).toBe(0);
  });

  it("parks a push on a dialog by default", async () => {
    store().updateSettings({ autoApproveTools: false });
    const decision = store().requestPushApproval(pendingPush);
    expect(selectPendingApproval(store())?.kind).toBe("push");
    store().resolveApproval(headId(), {
      approved: true,
      openPr: false,
      excludePaths: ["docs/x.md"],
    });
    await expect(decision).resolves.toMatchObject({
      approved: true,
      openPr: false,
      excludePaths: ["docs/x.md"],
    });
  });

  it("auto-approves a push with the dialog's own defaults when the flag is on", async () => {
    store().updateSettings({ autoApproveTools: true });
    const decision = await store().requestPushApproval(pendingPush);
    expect(decision).toEqual({ approved: true, openPr: true, auto: true });
    expect(selectApprovalCount(store())).toBe(0);
  });

  it("dismissing a parked gate resolves it as a refusal rather than hanging", async () => {
    store().updateSettings({ autoApproveTools: false });
    const decision = store().requestPushApproval(pendingPush);
    store().dismissApproval(headId(), "the push dialog was closed without a decision");
    await expect(decision).resolves.toMatchObject({ approved: false });
  });

  // ── Two agents asking at once ──

  it("queues a second agent's request instead of letting it take the first's place", async () => {
    store().updateSettings({ autoApproveTools: false });
    const peerRequest = { ...pendingHttp, conversationId: "c2", url: "https://api.example.com/v2/x" };

    const first = store().requestHttpApproval(pendingHttp);
    const second = store().requestHttpApproval(peerRequest);

    // Both are waiting, and the OLDEST is the one a dialog would show. The old
    // single slot silently replaced the first request — and the first agent's
    // promise then never resolved, which is a hung turn, not just a hidden
    // dialog.
    expect(selectApprovalCount(store())).toBe(2);
    expect(selectPendingApproval(store())?.conversationId).toBe("c1");

    store().resolveApproval(headId(), { approved: true });
    await expect(first).resolves.toMatchObject({ approved: true });
    expect(selectPendingApproval(store())?.conversationId).toBe("c2");

    store().resolveApproval(headId(), { approved: false, note: "no" });
    await expect(second).resolves.toMatchObject({ approved: false, note: "no" });
    expect(selectApprovalCount(store())).toBe(0);
  });

  it("keeps push and http requests apart in the same queue", () => {
    store().updateSettings({ autoApproveTools: false });
    void store().requestPushApproval(pendingPush);
    void store().requestHttpApproval({ ...pendingHttp, conversationId: "c2" });

    expect(selectApprovalCount(store())).toBe(2);
    expect(selectPendingApproval(store())?.kind).toBe("push");
    expect(selectHasApprovalOfKind(store(), "http")).toBe(true);
    // Resolving the push must not touch the http request behind it.
    store().resolveApproval(headId(), { approved: false });
    expect(selectPendingApproval(store())?.kind).toBe("http");
    store().dismissApprovalsFor("c2");
    expect(selectApprovalCount(store())).toBe(0);
  });

  it("drops and refuses the approvals of a thread the user stopped", async () => {
    store().updateSettings({ autoApproveTools: false });
    const stoppedPush = store().requestPushApproval(pendingPush);
    const stoppedHttp = store().requestHttpApproval(pendingHttp);
    const peerRequest = store().requestHttpApproval({ ...pendingHttp, conversationId: "c2" });

    store().dismissApprovalsFor("c1", "Stopped by the user.");

    await expect(stoppedPush).resolves.toMatchObject({
      approved: false,
      note: "Stopped by the user.",
    });
    await expect(stoppedHttp).resolves.toMatchObject({ approved: false });
    // A peer's waiting request is not the stopped agent's to drop.
    expect(selectApprovalCount(store())).toBe(1);
    expect(selectPendingApproval(store())?.conversationId).toBe("c2");
    store().resolveApproval(headId(), { approved: true });
    await expect(peerRequest).resolves.toMatchObject({ approved: true });
  });

  it("refuses a decision addressed to an approval that is already gone", () => {
    store().updateSettings({ autoApproveTools: false });
    store().requestPushApproval(pendingPush);
    const id = headId();
    store().resolveApproval(id, { approved: true });

    // A second answer for the same dialog (a double click, a stale modal) must
    // be a no-op: resolving somebody else's promise is the bug this prevents.
    const bystander = store().requestHttpApproval({ ...pendingHttp, conversationId: "c9" });
    store().resolveApproval(id, { approved: true });
    expect(selectApprovalCount(store())).toBe(1);
    expect(selectPendingApproval(store())?.conversationId).toBe("c9");
    void bystander;
    store().dismissApprovalsFor("c9");
  });
});
