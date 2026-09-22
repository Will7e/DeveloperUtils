// ============================================================
// Workspace Identity — A Working Copy Belongs To A Chat AND A Repo
// ============================================================
// The record used to be keyed by the conversation id alone, with the repo
// checked afterwards and the workspace recreated when it did not match. So a
// chat that attached a second repository wrote over the first one's record on
// its next save — silently discarding whatever was uncommitted there, with no
// dialog and nothing in the logs. Attaching a repo is a routine action.
//
// These tests pin the identity, which is what makes the recovery real:
// coming back to the first repository finds the work, and deleting the chat
// still deletes everything it left behind.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const idb = new Map<string, string>();

vi.mock("@/services/idb-storage.service", () => ({
  readValue: vi.fn(async (key: string) => idb.get(key) ?? null),
  writeValue: vi.fn(async (key: string, value: string | null) => {
    if (value === null) idb.delete(key);
    else idb.set(key, value);
  }),
}));

vi.mock("../lib/github-client", () => ({
  getRepoTree: vi.fn(async () => []),
  readFileContent: vi.fn(async () => ({ text: null, sha: null, isBinary: true })),
}));

import {
  createWorkspace,
  deleteWorkspace,
  loadWorkspace,
  persistWorkspace,
  workspaceRecordKey,
} from "./workspace";
import type { WorkspaceState } from "../types";

const CHAT = "chat-1";
const WEB = { owner: "acme", repo: "web", branch: "main" };
const API = { owner: "acme", repo: "api", branch: "main" };

function withEdit(repo: typeof WEB, path: string, content: string): WorkspaceState {
  const ws = createWorkspace(CHAT, repo.owner, repo.repo, repo.branch, "sha-1");
  return {
    ...ws,
    tree: [{ path, type: "blob" }],
    files: {
      [path]: {
        path,
        content,
        baseContent: "",
        baseSha: null,
        status: "modified",
        updatedAt: 1,
      },
    },
  };
}

beforeEach(() => {
  idb.clear();
});

describe("workspace records — one per chat AND repo", () => {
  it("names the record after the repo, so two repos cannot collide", () => {
    expect(workspaceRecordKey(CHAT, WEB)).not.toBe(workspaceRecordKey(CHAT, API));
    expect(workspaceRecordKey(CHAT, WEB)).toContain("acme");
    expect(workspaceRecordKey(CHAT, WEB)).toContain("main");
    // Branch is part of the base commit, so it is part of the identity.
    expect(workspaceRecordKey(CHAT, WEB)).not.toBe(
      workspaceRecordKey(CHAT, { ...WEB, branch: "release" })
    );
  });

  it("does not let a second repository overwrite the first one's work", async () => {
    await persistWorkspace(withEdit(WEB, "src/app.tsx", "web edit"));

    // The chat moves to another repo and back.
    const afterSwitch = await loadWorkspace(CHAT, API);
    expect(afterSwitch).toBeNull();

    const recovered = await loadWorkspace(CHAT, WEB);
    expect(recovered).not.toBeNull();
    expect(recovered!.files["src/app.tsx"]?.content).toBe("web edit");
    expect(recovered!.owner).toBe("acme");
    expect(recovered!.repo).toBe("web");
  });

  it("keeps a different branch of the same repo separate", async () => {
    await persistWorkspace(withEdit(WEB, "src/app.tsx", "on main"));
    expect(await loadWorkspace(CHAT, { ...WEB, branch: "release" })).toBeNull();
    expect((await loadWorkspace(CHAT, WEB))!.files["src/app.tsx"]?.content).toBe("on main");
  });

  it("refuses a record whose contents disagree with its key", async () => {
    // A key that does not describe its value is a record this code cannot
    // trust — and trusting it would apply another repo's edits here.
    await persistWorkspace(withEdit(WEB, "src/app.tsx", "web edit"));
    idb.set(
      workspaceRecordKey(CHAT, API),
      JSON.stringify(withEdit(WEB, "src/other.ts", "not from api"))
    );
    expect(await loadWorkspace(CHAT, API)).toBeNull();
  });

  it("treats a different conversation as a different working copy", async () => {
    await persistWorkspace(withEdit(WEB, "src/app.tsx", "chat one"));
    expect(await loadWorkspace("chat-2", WEB)).toBeNull();
    expect((await loadWorkspace(CHAT, WEB))!.conversationId).toBe(CHAT);
  });

  it("deletes every workspace a conversation left behind", async () => {
    await persistWorkspace(withEdit(WEB, "src/app.tsx", "web edit"));
    await persistWorkspace(withEdit(API, "src/main.ts", "api edit"));
    expect(idb.size).toBeGreaterThanOrEqual(3); // two workspaces + the index

    await deleteWorkspace(CHAT);

    expect(await loadWorkspace(CHAT, WEB)).toBeNull();
    expect(await loadWorkspace(CHAT, API)).toBeNull();
    // The index goes with them: nothing is left to clean up later.
    expect([...idb.keys()].filter((k) => k.includes(CHAT))).toEqual([]);
  });

  it("leaves another conversation's workspaces alone", async () => {
    await persistWorkspace(withEdit(WEB, "src/app.tsx", "chat one"));
    const other = { ...withEdit(WEB, "src/app.tsx", "chat two"), conversationId: "chat-2" };
    await persistWorkspace(other);

    await deleteWorkspace(CHAT);

    expect((await loadWorkspace("chat-2", WEB))!.files["src/app.tsx"]?.content).toBe("chat two");
  });
});
