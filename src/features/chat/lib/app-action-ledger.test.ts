// ============================================================
// App Action Ledger — Scoped To The Thread That Made The Action
// ============================================================
// The regression this file pins: the ledger used to clear EVERYTHING on any
// transition — deleting one chat erased every other chat's undo history, and
// any repository switch wiped records that had nothing to do with it. Entries
// are stamped with the thread whose agent made them, so a scoped release
// (thread deleted) drops only that thread's records.
//
// The ledger is module state with no reset seam (it is an in-memory undo
// history, not a cache), so tests assert against a baseline snapshot rather
// than absolute counts — the same discipline the accumulation itself teaches.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAppActions, recordAppAction } from "./app-action-ledger";
import { forgetThread, resetBindings, setAttachment } from "../identity/bindings";
import type { AppActionRecord } from "./app-action-ledger";

/** The ledger's records for one thread, from the full list */
function recordsFor(threadId: string, all: AppActionRecord[]): AppActionRecord[] {
  return all.filter((r) => r.threadId === threadId);
}

beforeEach(() => {
  resetBindings();
});

describe("app-action-ledger — a thread's deletion takes only its own records", () => {
  it("keeps other threads' undo records when one thread's chat is deleted", async () => {
    // The reported bug: undo history is per-thread, and losing it wholesale
    // meant a peer agent's change could no longer be undone.
    recordAppAction({
      family: "editor",
      action: "create_file",
      summary: "Created a.ts",
      undo: vi.fn(),
      threadId: "thread-a",
    });
    recordAppAction({
      family: "editor",
      action: "create_file",
      summary: "Created b.ts",
      undo: vi.fn(),
      threadId: "thread-b",
    });

    // A binding record must exist for the deletion to be a transition at all.
    await setAttachment("thread-a", { owner: "acme", repo: "web", branch: "main" });
    await forgetThread("thread-a");

    const remaining = listAppActions();
    expect(recordsFor("thread-a", remaining)).toHaveLength(0);
    expect(recordsFor("thread-b", remaining)).toHaveLength(1);
    expect(recordsFor("thread-b", remaining)[0]?.summary).toBe("Created b.ts");
  });

  it("drops the deleted thread's own records", async () => {
    recordAppAction({
      family: "editor",
      action: "delete_file",
      summary: "Deleted old.ts",
      undo: vi.fn(),
      threadId: "thread-a",
    });
    await setAttachment("thread-a", { owner: "acme", repo: "web", branch: "main" });

    await forgetThread("thread-a");

    expect(recordsFor("thread-a", listAppActions())).toHaveLength(0);
  });

  it("leaves the ledger alone for a thread with no recorded actions", async () => {
    // Deleting a chat whose agent never wrote anything must not disturb any
    // other entry — the release is a filter over threadId, not a clear.
    const before = listAppActions();
    await setAttachment("thread-a", { owner: "acme", repo: "web", branch: "main" });

    await forgetThread("thread-a");

    expect(listAppActions()).toHaveLength(before.length);
  });
});
