// ============================================================
// Revision — Freshness Regression Suite
// ============================================================
// The bug these pin is the one that made "verified" mean nothing: freshness was
// decided by comparing a single timestamp, so two repositories whose working
// copies were created in the same millisecond compared equal.
// ============================================================

import { describe, it, expect } from "vitest";
import { isSameCode, isSameRevision, nextRevision, revisionOf, type Revision } from "./revision";

const A: Revision = {
  bindingId: "thread-1::william/DeveloperUtils@main",
  baseCommitSha: "aaa111",
  updatedAt: 1_000,
};

describe("revisionOf", () => {
  it("reads a revision off a stored value", () => {
    expect(revisionOf({ bindingId: "t::a", baseCommitSha: "sha", updatedAt: 7 })).toEqual({
      bindingId: "t::a",
      baseCommitSha: "sha",
      updatedAt: 7,
    });
  });

  it("answers null for anything incomplete", () => {
    expect(revisionOf({ baseCommitSha: "sha", updatedAt: 7 })).toBeNull();
    expect(revisionOf({ bindingId: "t::a", updatedAt: 7 })).toBeNull();
    expect(revisionOf({ bindingId: "t::a", baseCommitSha: "sha" })).toBeNull();
    expect(revisionOf({ bindingId: "", baseCommitSha: "sha", updatedAt: 7 })).toBeNull();
    expect(revisionOf(null)).toBeNull();
  });
});

describe("isSameRevision", () => {
  it("is true only for the identical revision", () => {
    expect(isSameRevision(A, { ...A })).toBe(true);
  });

  it("is false across bindings even when the timestamps collide", () => {
    // THE bug. Attach one repository, switch to another inside the same
    // millisecond, and a single-timestamp comparison says the first
    // repository's passing run is proof about the second.
    const other: Revision = { ...A, bindingId: "thread-1::william/other-repo@main" };
    expect(isSameRevision(A, other)).toBe(false);
  });

  it("is false when the base commit moved under the same binding", () => {
    expect(isSameRevision(A, { ...A, baseCommitSha: "bbb222" })).toBe(false);
  });

  it("is false when the working copy has been edited since", () => {
    expect(isSameRevision(A, { ...A, updatedAt: 1_001 })).toBe(false);
  });

  it("is false whenever either side cannot name its revision", () => {
    // Fail closed: "I cannot say" must never be reported as "still good".
    expect(isSameRevision(null, A)).toBe(false);
    expect(isSameRevision(A, null)).toBe(false);
    expect(isSameRevision(null, null)).toBe(false);
  });
});

describe("nextRevision", () => {
  it("moves forward when the clock does", () => {
    const at = Date.now();
    expect(nextRevision(at - 5_000)).toBeGreaterThanOrEqual(at);
  });

  it("still moves forward when the clock does not", () => {
    // Two edits in the same millisecond are an agent writing a file and
    // then fixing it. Equal counters would leave the FIRST edit's failing
    // run looking like proof about the fixed code.
    const now = Date.now();
    expect(nextRevision(now)).toBe(now + 1);
    expect(nextRevision(now + 1)).toBe(now + 2);
  });

  it("does not go backwards when the clock does", () => {
    // A corrected clock or a restored backup must not hand evidence back
    // to a revision that has already been replaced.
    const future = Date.now() + 60_000;
    expect(nextRevision(future)).toBe(future + 1);
  });
});

describe("isSameCode", () => {
  it("ignores the counter, so a no-op write does not invalidate evidence", () => {
    expect(isSameCode(A, { ...A, updatedAt: 9_999 })).toBe(true);
  });

  it("still refuses a different binding or base", () => {
    expect(isSameCode(A, { ...A, bindingId: "t::other@main" })).toBe(false);
    expect(isSameCode(A, { ...A, baseCommitSha: "zzz" })).toBe(false);
    expect(isSameCode(null, A)).toBe(false);
  });
});
