// ============================================================
// Push selection — regression tests
// ============================================================
// The gate is the last human checkpoint before a commit, so the failure
// modes that matter are the quiet ones: an exclusion that silently does
// not apply (unreviewed code ships), and an exclusion that applies too
// widely (reviewed work vanishes). Both are asserted here.

import { describe, expect, it } from "vitest";
import { describeExclusions, partitionPushChanges } from "./push-selection";
import { markPushed } from "./workspace";
import type { PushFile } from "./workspace";
import type { WorkspaceState, WorkspaceFile } from "../types";

function file(path: string, status: PushFile["status"] = "modified"): PushFile {
  return { path, content: `content of ${path}`, baseSha: "sha0", status };
}

function wsFile(path: string, status: WorkspaceFile["status"], content: string): WorkspaceFile {
  return {
    path,
    content,
    baseContent: "base",
    baseSha: "sha0",
    status,
    updatedAt: 0,
  };
}

function workspace(): WorkspaceState {
  return {
    conversationId: "c1",
    owner: "acme",
    repo: "app",
    branch: "main",
    baseCommitSha: "commit0",
    workingBranch: null,
    files: {
      "src/a.ts": wsFile("src/a.ts", "modified", "new a"),
      "src/b.ts": wsFile("src/b.ts", "modified", "new b"),
      "src/new.ts": wsFile("src/new.ts", "added", "brand new"),
      "src/gone.ts": wsFile("src/gone.ts", "deleted", "old"),
      "src/untouched.ts": wsFile("src/untouched.ts", "unchanged", "same"),
    },
    tree: [],
    mutations: [
      { path: "src/a.ts", before: null, after: null as never, description: "edited a" },
      { path: "src/b.ts", before: null, after: null as never, description: "edited b" },
    ],
    updatedAt: 0,
  } as unknown as WorkspaceState;
}

describe("partitionPushChanges", () => {
  const changes = [file("src/a.ts"), file("src/b.ts"), file("src/new.ts")];

  it("pushes everything when nothing is excluded", () => {
    expect(partitionPushChanges(changes).push).toHaveLength(3);
    expect(partitionPushChanges(changes, []).excluded).toEqual([]);
    expect(partitionPushChanges(changes, null).push).toHaveLength(3);
  });

  it("holds back exactly the named paths", () => {
    const { push, excluded } = partitionPushChanges(changes, ["src/b.ts"]);
    expect(push.map((f) => f.path)).toEqual(["src/a.ts", "src/new.ts"]);
    expect(excluded.map((f) => f.path)).toEqual(["src/b.ts"]);
  });

  it("preserves the change-set order and never mutates the input", () => {
    const input = [file("src/b.ts"), file("src/a.ts")];
    const { push } = partitionPushChanges(input, ["src/b.ts"]);
    expect(push.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(input.map((f) => f.path)).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("ignores paths that are not in the change set", () => {
    // A stale modal (the file was renamed since it rendered) must not be
    // able to drop a real file from the commit by naming something else.
    const { push, excluded } = partitionPushChanges(changes, ["src/nope.ts", "../../etc/passwd"]);
    expect(push).toHaveLength(3);
    expect(excluded).toEqual([]);
  });

  it("tolerates the path spellings a UI round-trip can introduce", () => {
    const { excluded } = partitionPushChanges(changes, [" ./src/b.ts ", "src//b.ts"]);
    expect(excluded.map((f) => f.path)).toEqual(["src/b.ts"]);
  });

  it("can hold back every file, which the caller must treat as nothing-to-push", () => {
    const { push, excluded } = partitionPushChanges(changes, changes.map((c) => c.path));
    expect(push).toHaveLength(0);
    expect(excluded).toHaveLength(3);
  });
});

describe("describeExclusions", () => {
  it("states that the files were not pushed and were not discarded", () => {
    const note = describeExclusions([file("src/b.ts")]);
    expect(note).toContain("src/b.ts");
    expect(note).toContain("NOT pushed");
    expect(note).toMatch(/still pending in the workspace/);
  });

  it("truncates a long list but keeps the true count", () => {
    const many = Array.from({ length: 9 }, (_, i) => file(`src/f${i}.ts`));
    const note = describeExclusions(many);
    expect(note).toContain("9 files");
    expect(note).not.toContain("src/f8.ts");
  });

  it("says nothing when nothing was held back", () => {
    expect(describeExclusions([])).toBe("");
  });
});

/** Strict-index-access helper: a missing file is a test failure, not a crash. */
function at(ws: WorkspaceState, path: string): WorkspaceFile {
  const f = ws.files[path];
  if (!f) throw new Error(`expected ${path} in the workspace`);
  return f;
}

describe("markPushed with a partial push", () => {
  it("resets only the committed files and leaves the rest pending", () => {
    const next = markPushed(workspace(), "commit1", ["src/a.ts", "src/new.ts"]);

    expect(at(next, "src/a.ts").status).toBe("unchanged");
    expect(at(next, "src/a.ts").baseContent).toBe("new a");
    expect(at(next, "src/new.ts").status).toBe("unchanged");
    // A deletion the user held back also stays pending — the file is still
    // gone locally but still present on the branch, which is the truth.
    expect(at(next, "src/gone.ts").status).toBe("deleted");
    expect(at(next, "src/untouched.ts").status).toBe("unchanged");

    // Held back: still dirty, still diffable, still holding its content.
    expect(at(next, "src/b.ts").status).toBe("modified");
    expect(at(next, "src/b.ts").content).toBe("new b");
    expect(at(next, "src/b.ts").baseContent).toBe("base");

    expect(next.baseCommitSha).toBe("commit1");
  });

  it("keeps the effect log only for files that are still pending", () => {
    const next = markPushed(workspace(), "commit1", ["src/a.ts"]);
    expect(next.mutations?.map((m) => m.path)).toEqual(["src/b.ts"]);
  });

  it("drops a committed deletion from the workspace", () => {
    const next = markPushed(workspace(), "commit1", ["src/gone.ts"]);
    expect(next.files["src/gone.ts"]).toBeUndefined();
    expect(at(next, "src/a.ts").status).toBe("modified");
  });

  it("still clears everything when no path list is given", () => {
    const next = markPushed(workspace(), "commit1");
    expect(Object.keys(next.files).sort()).toEqual(["src/a.ts", "src/b.ts", "src/new.ts", "src/untouched.ts"]);
    expect(at(next, "src/b.ts").status).toBe("unchanged");
    expect(next.mutations).toEqual([]);
  });
});
