// ============================================================
// Auto-Verify — regression tests
// ============================================================
// The properties that matter: a burst collapses into one run, a run in
// flight is never overlapped, "nothing to check" and "could not check"
// record NOTHING (absence must never look like a pass), and a recorded
// result is stamped with the revision that existed when the check started.
//
// The typecheck worker is not available in the unit-test DOM, so the
// runTypecheck import is mocked at the module boundary — the service's own
// logic (what it records, what it refuses to record, when) is what is under
// test, and lib/typecheck.test.ts owns the compiler itself.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const recordVerification = vi.fn();
const runTypecheck = vi.fn();

vi.mock("../lib/verification-ledger", () => ({
  recordVerification: (...args: unknown[]) => recordVerification(...(args as [])),
}));

vi.mock("../lib/typecheck-client", () => ({
  runTypecheck: (...args: unknown[]) => runTypecheck(...(args as [])),
}));

vi.mock("@/stores/chat.store", () => ({
  selectWorkspace: (_state: unknown, conversationId: string) => workspaces.get(conversationId) ?? null,
  useChatStore: { getState: () => ({}) },
}));

const workspaces = new Map<string, unknown>();

import {
  AUTO_VERIFY_DEBOUNCE_MS,
} from "../constants";
import {
  cancelAutoVerify,
  requestAutoVerify,
  resetAutoVerify,
  runAutoVerify,
} from "./auto-verify";

function workspaceWith(conversationId: string, files: Record<string, string>, updatedAt = 1_000): void {
  workspaces.set(conversationId, {
    conversationId,
    updatedAt,
    tree: Object.keys(files).map((path) => ({ path, type: "blob" })),
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        { path, content, baseContent: content, baseSha: null, status: "modified", updatedAt: 1 },
      ])
    ),
  });
}

function typecheckResult(errors: number, checked = 3) {
  return {
    ok: true,
    checkedFiles: checked,
    unavailableReason: undefined,
    plan: { limits: [] },
    classification: {
      reported:
        errors === 0
          ? []
          : [
              {
                file: "src/a.ts",
                line: 4,
                code: 2322,
                message: "Type 'number' is not assignable to type 'string'.",
                category: 1,
              },
            ],
      omitted: 0,
      suppressed: 0,
      suppressionReasons: [],
    },
    report: "",
  };
}

describe("runAutoVerify — what records and what stays silent", () => {
  beforeEach(() => {
    resetAutoVerify();
    workspaces.clear();
    recordVerification.mockClear();
    runTypecheck.mockReset();
  });

  it("records a clean check against the revision it read", async () => {
    workspaceWith("c1", { "src/a.ts": "export const a = 1;" });
    runTypecheck.mockResolvedValue(typecheckResult(0));
    await runAutoVerify("c1");
    expect(recordVerification).toHaveBeenCalledTimes(1);
    const event = recordVerification.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(event.kind).toBe("typecheck");
    expect(event.ok).toBe(true);
    expect(event.workspaceUpdatedAt).toBe(1_000);
    expect(event.source).toBe("auto-verify");
    expect(String(event.summary)).toContain("0 errors");
  });

  it("records failures with the first diagnostics as details", async () => {
    workspaceWith("c1", { "src/a.ts": "export const a: string = 2;" });
    runTypecheck.mockResolvedValue(typecheckResult(1));
    await runAutoVerify("c1");
    const event = recordVerification.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(event.ok).toBe(false);
    const details = event.details as string[];
    expect(details[0]).toContain("src/a.ts:4");
    expect(details[0]).toContain("TS2322");
  });

  it("records NOTHING when there are no compilable sources", async () => {
    workspaceWith("c1", { "README.md": "# hi" });
    await runAutoVerify("c1");
    expect(runTypecheck).not.toHaveBeenCalled();
    expect(recordVerification).not.toHaveBeenCalled();
  });

  it("records NOTHING when there is no workspace", async () => {
    await runAutoVerify("missing");
    expect(runTypecheck).not.toHaveBeenCalled();
    expect(recordVerification).not.toHaveBeenCalled();
  });

  it("records NOTHING when the check could not run — unavailability is not a pass", async () => {
    workspaceWith("c1", { "src/a.ts": "export const a = 1;" });
    runTypecheck.mockResolvedValue({
      ...typecheckResult(0),
      ok: false,
      unavailableReason: "the in-browser compiler could not be started",
    });
    await runAutoVerify("c1");
    expect(recordVerification).not.toHaveBeenCalled();
  });

  it("stays silent when the check itself throws", async () => {
    workspaceWith("c1", { "src/a.ts": "export const a = 1;" });
    runTypecheck.mockRejectedValue(new Error("worker gone"));
    await expect(runAutoVerify("c1")).resolves.toBeUndefined();
    expect(recordVerification).not.toHaveBeenCalled();
  });

  it("deletes a file from consideration (tombstones are not sources)", async () => {
    workspaceWith("c1", {});
    const ws = workspaces.get("c1") as {
      files: Record<string, { status: string; path?: string; content?: string; baseContent?: string; baseSha?: string | null; updatedAt?: number }>;
    };
    ws.files["src/dead.ts"] = {
      path: "src/dead.ts",
      content: "",
      baseContent: "",
      baseSha: null,
      status: "deleted",
      updatedAt: 1,
    };
    await runAutoVerify("c1");
    expect(runTypecheck).not.toHaveBeenCalled();
  });
});

describe("requestAutoVerify — the debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAutoVerify();
    workspaces.clear();
    recordVerification.mockClear();
    runTypecheck.mockReset().mockResolvedValue(typecheckResult(0));
  });

  it("runs once after the quiet window, not once per write", async () => {
    workspaceWith("c1", { "src/a.ts": "export const a = 1;" });
    requestAutoVerify("c1");
    requestAutoVerify("c1");
    requestAutoVerify("c1");
    vi.advanceTimersByTime(AUTO_VERIFY_DEBOUNCE_MS + 10);
    await vi.runAllTimersAsync();
    expect(recordVerification).toHaveBeenCalledTimes(1);
  });

  it("cancelAutoVerify prevents the run entirely", async () => {
    workspaceWith("c1", { "src/a.ts": "export const a = 1;" });
    requestAutoVerify("c1");
    cancelAutoVerify("c1");
    vi.advanceTimersByTime(AUTO_VERIFY_DEBOUNCE_MS + 10);
    expect(recordVerification).not.toHaveBeenCalled();
  });
});
