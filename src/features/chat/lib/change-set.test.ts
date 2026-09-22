// ============================================================
// Change Set — What the Agent Actually Changed
// ============================================================
// The panel is only as trustworthy as this function: if it lists a
// file the agent never touched, or silently drops one it did, the
// human reviewing the agent's work is reading fiction. These tests
// pin the three verdicts (added / modified / deleted), the ordering,
// the totals, and the one exclusion that matters — files that were
// only READ to be edited must not appear as changes.

import { describe, it, expect } from "vitest";
import { collectChangeSet, summarizeChangeSet } from "./change-set";
import type { WorkspaceFile, WorkspaceState } from "../types";

function file(over: Partial<WorkspaceFile> & { path: string }): WorkspaceFile {
  return {
    content: "",
    baseContent: "",
    baseSha: null,
    status: "unchanged",
    updatedAt: 0,
    ...over,
  };
}

function workspace(files: WorkspaceFile[]): WorkspaceState {
  const map: Record<string, WorkspaceFile> = {};
  for (const f of files) map[f.path] = f;
  return {
    conversationId: "c1",
    owner: "acme",
    repo: "demo",
    branch: "main",
    baseCommitSha: "sha-base",
    workingBranch: null,
    tree: Object.keys(map).map((path) => ({ path, type: "blob" as const })),
    files: map,
    updatedAt: 0,
  };
}

describe("collectChangeSet", () => {
  it("is empty for a missing or untouched workspace", () => {
    expect(collectChangeSet(undefined).empty).toBe(true);
    expect(collectChangeSet(null).empty).toBe(true);
    expect(
      collectChangeSet(workspace([file({ path: "src/a.ts", content: "same", baseContent: "same" })])).empty
    ).toBe(true);
  });

  it("does not report a file that was only read", () => {
    // The workspace holds read files so an edit can be applied to real
    // text. They are not changes, and listing them would bury the real
    // edits under everything the agent looked at.
    const set = collectChangeSet(
      workspace([
        file({ path: "src/read-only.ts", content: "content", baseContent: "content", status: "unchanged" }),
      ])
    );
    expect(set.fileCount).toBe(0);
  });

  it("diffs a modified file and counts its lines", () => {
    const set = collectChangeSet(
      workspace([
        file({
          path: "src/a.ts",
          status: "modified",
          baseContent: "one\ntwo\nthree",
          content: "one\nTWO\nthree\nfour",
        }),
      ])
    );
    expect(set.fileCount).toBe(1);
    expect(set.files[0]!.path).toBe("src/a.ts");
    expect(set.files[0]!.status).toBe("modified");
    expect(set.additions).toBe(2); // TWO, four
    expect(set.deletions).toBe(1); // two
    expect(set.files[0]!.patch).toContain("+++ b/src/a.ts");
    expect(set.files[0]!.patch).toContain("+TWO");
    expect(set.files[0]!.patch).toContain("-two");
  });

  it("renders an added file against /dev/null", () => {
    const set = collectChangeSet(
      workspace([file({ path: "src/new.ts", status: "added", content: "hello" })])
    );
    expect(set.files[0]!.status).toBe("added");
    expect(set.files[0]!.patch).toContain("--- /dev/null");
    expect(set.additions).toBe(1);
  });

  it("renders a deletion as the removal of the file's content", () => {
    const set = collectChangeSet(
      workspace([file({ path: "src/gone.ts", status: "deleted", baseContent: "bye\nbye2" })])
    );
    expect(set.files[0]!.status).toBe("deleted");
    expect(set.files[0]!.patch).toContain("+++ /dev/null");
    expect(set.deletions).toBe(2);
  });

  it("orders files by path and totals the whole change set", () => {
    const set = collectChangeSet(
      workspace([
        file({ path: "z/last.ts", status: "added", content: "z" }),
        file({ path: "a/first.ts", status: "added", content: "a\nb" }),
        file({ path: "m/mid.ts", status: "deleted", baseContent: "m" }),
      ])
    );
    expect(set.files.map((f) => f.path)).toEqual(["a/first.ts", "m/mid.ts", "z/last.ts"]);
    expect(set.fileCount).toBe(3);
    expect(set.additions).toBe(3);
    expect(set.deletions).toBe(1);
  });

  it("summarizes itself for headers", () => {
    expect(summarizeChangeSet(collectChangeSet(null))).toBe("No changes yet");
    const set = collectChangeSet(
      workspace([file({ path: "a.ts", status: "modified", baseContent: "x", content: "y" })])
    );
    expect(summarizeChangeSet(set)).toBe("1 file · +1 −1");
  });
});
