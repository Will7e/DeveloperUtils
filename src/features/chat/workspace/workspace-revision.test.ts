// ============================================================
// Workspace Revision — Counts Code, Not Bookkeeping
// ============================================================
// `workspace.updatedAt` is the revision the verification ledger compares
// against, so it is the answer to "is this proof still about the current
// code?". It used to be stamped by anything that touched the workspace
// object — including loading a tree and folding a freshly-READ file into
// the working copy — which broke the single most common repair loop:
//
//   1. `npm test` FAILS        → recorded at revision R
//   2. read the failing file   → revision became R'
//   3. the failure reads as STALE, and the completion gate (which only
//      counts a FRESH failure) stops seeing the work the agent was told
//      not to walk away from.
//
// Same shape at the push gate: the proof section told the reviewer that a
// passing run "does not describe the current code" when nothing in the
// working copy had changed at all. A warning that is wrong in the common
// case is how the honest one gets ignored.
//
// These tests pin the contract from the field's own comment (types.ts):
// the revision moves when the code moves — writes, deletes, reverts —
// and only then.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const idb = new Map<string, string>();

vi.mock("@/services/idb-storage.service", () => ({
  readValue: vi.fn(async (key: string) => idb.get(key) ?? null),
  writeValue: vi.fn(async (key: string, value: string | null) => {
    if (value === null) idb.delete(key);
    else idb.set(key, value);
  }),
}));

vi.mock("../lib/github-client", () => ({
  readFileContent: vi.fn(async () => ({ text: null, sha: null, isBinary: true })),
}));

vi.mock("./repo-base", () => ({
  getRepoBaseTree: vi.fn(async () => ({ tree: [{ path: "src/app.ts", type: "blob" }] })),
  getRepoBaseFile: vi.fn(async () => null),
  rememberRepoBaseFile: vi.fn(),
}));

import {
  createWorkspace,
  deleteFile,
  hydrateTree,
  markPushed,
  mergeFetchedFile,
  writeFile,
} from "./workspace";
import {
  clearVerification,
  recordVerification,
  verificationEvidence,
} from "../lib/verification-ledger";
import type { WorkspaceState } from "../types";

const CONV = "chat-1";
const READ = { text: "export const answer = 1;\n", sha: "blob-1" };

/** The workspace before any of the reads that used to move the revision. */
function fresh(): WorkspaceState {
  return createWorkspace(CONV, "acme", "web", "main", "sha-base");
}

/** A read of `src/app.ts`, as `read_file` performs it. */
function readApp(ws: WorkspaceState): WorkspaceState {
  const merged = mergeFetchedFile(ws, "src/app.ts", READ);
  expect(merged.ok).toBe(true);
  return merged.ws;
}

beforeEach(() => {
  idb.clear();
  clearVerification();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the revision is the code", () => {
  it("does not move when the tree is listed", async () => {
    const ws = fresh();

    const hydrated = await hydrateTree(ws, "token");

    expect(hydrated.tree).toHaveLength(1);
    expect(hydrated.updatedAt).toBe(ws.updatedAt);
  });

  it("does not move when a file is read into the working copy", () => {
    const ws = fresh();

    const loaded = readApp(ws);

    expect(loaded.files["src/app.ts"]?.content).toBe(READ.text);
    expect(loaded.files["src/app.ts"]?.baseSha).toBe("blob-1");
    expect(loaded.updatedAt).toBe(ws.updatedAt);
  });

  it("does not move when the same file is read again", () => {
    const loaded = readApp(fresh());

    const again = mergeFetchedFile(loaded, "src/app.ts", READ);

    expect(again.ok).toBe(true);
    expect(again.ws.updatedAt).toBe(loaded.updatedAt);
  });

  it("moves when a file is written", () => {
    const loaded = readApp(fresh());
    vi.setSystemTime(2_000);

    const edited = writeFile(loaded, "src/app.ts", "export const answer = 2;\n");

    expect(edited.ok).toBe(true);
    expect(edited.ws.updatedAt).toBe(2_000);
  });

  it("moves when a file is deleted", () => {
    const loaded = readApp(fresh());
    vi.setSystemTime(2_000);

    const deleted = deleteFile(loaded, "src/app.ts");

    expect(deleted.ok).toBe(true);
    expect(deleted.ws.updatedAt).toBe(2_000);
  });

  it("does not move when a push only moves the base", () => {
    const loaded = readApp(fresh());
    const edited = writeFile(loaded, "src/app.ts", "export const answer = 2;\n");

    const pushed = markPushed(edited.ws, "sha-pushed");

    // The bytes are the ones that were just committed, so the counter that
    // says "which code" is describing the same code. The move is expressed
    // by the base commit, which the ledger's binding release already reads.
    expect(pushed.baseCommitSha).toBe("sha-pushed");
    expect(pushed.updatedAt).toBe(edited.ws.updatedAt);
  });
});

describe("what the ledger reads from it", () => {
  it("keeps a failing run FRESH across the read that follows it", () => {
    // The repair loop the gate depends on: run, fail, read, fix.
    const ws = fresh();
    recordVerification(CONV, {
      kind: "command",
      at: 1_000,
      workspaceUpdatedAt: ws.updatedAt,
      ok: false,
      summary: "`npm test` exited 1 in 812ms",
      source: "run_command",
    });

    // Step 2 of that loop. Nothing in the working copy changed.
    const afterRead = readApp(ws);
    const [evidence] = verificationEvidence(CONV, {
      workspaceUpdatedAt: afterRead.updatedAt,
    });

    expect(evidence?.status).toBe("fresh-fail");
  });

  it("retires it once the code it describes is edited", () => {
    const ws = fresh();
    recordVerification(CONV, {
      kind: "command",
      at: 1_000,
      workspaceUpdatedAt: ws.updatedAt,
      ok: true,
      summary: "`npm test` exited 0 in 812ms",
      source: "run_command",
    });

    const edited = writeFile(readApp(ws), "src/app.ts", "export const answer = 2;\n");
    const [evidence] = verificationEvidence(CONV, {
      workspaceUpdatedAt: edited.ws.updatedAt,
    });

    expect(evidence?.status).toBe("stale");
  });
});
