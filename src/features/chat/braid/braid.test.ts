// ============================================================
// Braid P1/P2/P3 tests — probe diff, fork/restore, braid decision,
// strand surface + risk policy, fixed-size working state
// ============================================================

import { describe, it, expect } from "vitest";
import {
  captureProbeBaseline,
  diffProbe,
  probeFiles,
  probeNotice,
} from "./probe";
import { forkWorkspace, restoreWorkspace } from "./fork";
import {
  decideBraid,
  braidNote,
  workspaceChangeStats,
  adoptStrandWorkspace,
} from "./braid-decide";
import {
  assertStrandCall,
  isStrandCall,
  shouldForkStrands,
  pickStrandModels,
  STRAND_TOOL_NAMES,
  STRAND_MAX_ROUNDS,
  strandRefusalText,
} from "./strand";
import { rebuildBraidState, renderBraidState } from "./state-file";
import { strandCheckOk } from "./strand-exec";
import { strandForkIsStale } from "./strand-launch";
import type { TypecheckResult } from "../lib/typecheck-client";
import type { WorkspaceState, AgentPlan } from "../types";
import type { VerificationEvidence } from "../lib/verification-ledger";

// ── Fixtures ─────────────────────────────────────────────────

function ws(over: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    conversationId: "c1",
    owner: "acme",
    repo: "app",
    branch: "main",
    baseCommitSha: "abc",
    createdAt: Date.now(),
    updatedAt: 1_000,
    tree: [
      { path: "src/a.ts", type: "blob" },
      { path: "src/b.ts", type: "blob" },
    ],
    files: {},
    ...over,
  } as WorkspaceState;
}

function typecheckResult(
  reported: Array<{ file?: string | null; line?: number; code: number; message: string }>,
  ok = true
): TypecheckResult {
  return {
    ok,
    report: "report",
    classification: {
      reported: reported as never[],
      omitted: 0,
      suppressed: 0,
      suppressionReasons: [],
    },
    plan: {
      rootNames: [],
      compilerOptions: {},
      typescriptVersion: "5.0",
      limits: [],
      empty: false,
    },
    checkedFiles: 2,
  };
}

function plan(steps: Array<{ status: AgentPlan["steps"][number]["status"]; text: string }>): AgentPlan {
  return {
    steps: steps.map((s, i) => ({ id: `s${i}`, text: s.text, status: s.status })),
    updatedAt: Date.now(),
    complete: steps.every((s) => s.status === "done"),
  };
}

// ── P1: probe ────────────────────────────────────────────────

describe("probe baseline + diff", () => {
  it("captures a baseline keyed by file", () => {
    const result = typecheckResult([
      { file: "src/a.ts", line: 3, code: 2304, message: "Cannot find name 'x'." },
      { file: "src/b.ts", line: 9, code: 2345, message: "Argument type mismatch." },
    ]);
    const baseline = captureProbeBaseline(ws(), result);
    expect(baseline).not.toBeNull();
    expect(baseline!.totalErrors).toBe(2);
    expect(baseline!.byFile["src/a.ts"]).toHaveLength(1);
  });

  it("no baseline from an unavailable typecheck", () => {
    const result = typecheckResult([], false);
    result.unavailableReason = "worker down";
    expect(captureProbeBaseline(ws(), result)).toBeNull();
  });

  it("diff finds new diagnostics only", () => {
    const baseline = captureProbeBaseline(
      ws(),
      typecheckResult([{ file: "src/a.ts", line: 3, code: 2304, message: "Cannot find name 'x'." }])
    );
    const outcome = diffProbe(
      baseline,
      typecheckResult([
        { file: "src/a.ts", line: 3, code: 2304, message: "Cannot find name 'x'." },
        { file: "src/b.ts", line: 1, code: 1005, message: "Unexpected token." },
      ])
    );
    expect(outcome.ran).toBe(true);
    expect(outcome.deltaErrors).toBe(1);
    expect(outcome.newDiagnostics).toHaveLength(1);
    expect(outcome.newDiagnostics[0]!.path).toBe("src/b.ts");
  });

  it("recognizes repair: negative delta, no new diagnostics", () => {
    const baseline = captureProbeBaseline(
      ws(),
      typecheckResult([
        { file: "src/a.ts", line: 3, code: 2304, message: "Cannot find name 'x'." },
        { file: "src/b.ts", line: 9, code: 2345, message: "Mismatch." },
      ])
    );
    const outcome = diffProbe(
      baseline,
      typecheckResult([{ file: "src/a.ts", line: 3, code: 2304, message: "Cannot find name 'x'." }])
    );
    expect(outcome.newDiagnostics).toHaveLength(0);
    expect(outcome.deltaErrors).toBe(-1);
  });

  it("an unavailable run is silent, never a failure", () => {
    const baseline = captureProbeBaseline(
      ws(),
      typecheckResult([{ file: "src/a.ts", line: 3, code: 2304, message: "x" }])
    );
    const failed = typecheckResult([], false);
    failed.unavailableReason = "timeout";
    const outcome = diffProbe(baseline, failed);
    expect(outcome.ran).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(probeNotice(outcome)).toBeNull();
  });

  it("notice names files and stays null on clean probes", () => {
    const baseline = captureProbeBaseline(ws(), typecheckResult([]));
    const outcome = diffProbe(
      baseline,
      typecheckResult([{ file: "src/new.ts", line: 2, code: 7006, message: "Parameter implicitly has an 'any' type." }])
    );
    const notice = probeNotice(outcome);
    expect(notice).toContain("src/new.ts:2");
    expect(notice).toContain("TS7006");

    const clean = diffProbe(baseline, typecheckResult([]));
    expect(probeNotice(clean)).toBeNull();
  });

  it("probeFiles excludes tombstones", () => {
    const state = ws({
      files: {
        "src/a.ts": { path: "src/a.ts", content: "a", baseContent: "a", baseSha: null, status: "modified", updatedAt: 1 },
        "src/dead.ts": { path: "src/dead.ts", content: "", baseContent: "x", baseSha: null, status: "deleted", updatedAt: 2 },
      } as WorkspaceState["files"],
    });
    const files = probeFiles(state);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });
});

// ── P2: fork / restore ───────────────────────────────────────

describe("fork + restore", () => {
  it("snapshot shares no mutable structure with the live value", () => {
    const state = ws({
      files: {
        "src/a.ts": { path: "src/a.ts", content: "one", baseContent: "one", baseSha: "s", status: "unchanged", updatedAt: 1 },
      } as WorkspaceState["files"],
    });
    const fork = forkWorkspace(state);
    // Mutate the live value after forking.
    state.files["src/a.ts"]!.content = "changed";
    state.updatedAt = 2_000;
    expect(fork.snapshot.files["src/a.ts"]!.content).toBe("one");
    expect(fork.snapshot.updatedAt).toBe(1_000);
  });

  it("restore reproduces exact captured bytes, tombstones included", () => {
    const state = ws({
      files: {
        "src/a.ts": { path: "src/a.ts", content: "", baseContent: "old", baseSha: null, status: "deleted", updatedAt: 2 },
        "src/new.ts": { path: "src/new.ts", content: "brand new", baseContent: "", baseSha: null, status: "added", updatedAt: 3 },
      } as WorkspaceState["files"],
    });
    const fork = forkWorkspace(state);
    const restored = restoreWorkspace(fork, ws({ updatedAt: 9_999 }));
    expect(restored.files["src/a.ts"]!.status).toBe("deleted");
    expect(restored.files["src/new.ts"]!.content).toBe("brand new");
    expect(restored.updatedAt).toBeGreaterThan(9_999);
  });

  it("restore bumps the revision past both snapshot and live", () => {
    const fork = forkWorkspace(ws({ updatedAt: 500 }));
    const restored = restoreWorkspace(fork, ws({ updatedAt: 4_000 }));
    expect(restored.updatedAt).toBeGreaterThan(4_000);
  });
});

// ── P2: braid decision ───────────────────────────────────────

describe("braid decision", () => {
  const stats = (a: number, d: number, files = 1) => ({ files, additions: a, deletions: d });

  it("main wins when nothing verified", () => {
    const decision = decideBraid(
      { verified: false, stats: stats(10, 2), modelId: "m" },
      [{ label: "strand A", modelId: "m", verified: false, stats: stats(4, 1) }]
    );
    expect(decision.winner).toBe("main");
  });

  it("a verified strand beats an unverified main", () => {
    const decision = decideBraid(
      { verified: false, stats: stats(10, 2), modelId: "m" },
      [{ label: "strand A", modelId: "m", verified: true, stats: stats(40, 9) }]
    );
    expect(decision.winner).toBe("strand");
    expect((decision as { label?: string }).label).toBe("strand A");
  });

  it("main wins when both verified and main is smaller", () => {
    const decision = decideBraid(
      { verified: true, stats: stats(5, 1), modelId: "m" },
      [{ label: "strand A", modelId: "m", verified: true, stats: stats(40, 9) }]
    );
    expect(decision.winner).toBe("main");
  });

  it("the smaller verified strand beats a verified main", () => {
    const decision = decideBraid(
      { verified: true, stats: stats(80, 20), modelId: "m" },
      [{ label: "strand B", modelId: "m", verified: true, stats: stats(6, 2) }]
    );
    expect(decision.winner).toBe("strand");
  });

  it("main wins exact verified ties", () => {
    const decision = decideBraid(
      { verified: true, stats: stats(5, 5), modelId: "m" },
      [{ label: "strand A", modelId: "m", verified: true, stats: stats(5, 5) }]
    );
    expect(decision.winner).toBe("main");
  });

  it("the note is null when no strands ran", () => {
    expect(braidNote(decideBraid({ verified: true, stats: stats(1, 0), modelId: "m" }, []), [])).toBeNull();
  });

  it("the note names the winner honestly", () => {
    const note = braidNote(
      decideBraid(
        { verified: false, stats: stats(3, 0), modelId: "m" },
        [{ label: "strand A", modelId: "m", verified: true, stats: stats(9, 1) }]
      ),
      ["strand A"]
    );
    expect(note).toContain("strand A");
    expect(note).toContain("verified");
  });

  it("adoption bumps the revision strictly past both states", () => {
    const strandFinal = ws({ updatedAt: 100 });
    const live = ws({ updatedAt: 900 });
    const adopted = adoptStrandWorkspace(strandFinal, live);
    expect(adopted.updatedAt).toBeGreaterThan(900);
  });

  it("change stats count added/modified/deleted correctly", () => {
    const state = ws({
      files: {
        "a.ts": { path: "a.ts", content: "l1\nl2\nl3", baseContent: "l1", baseSha: null, status: "added", updatedAt: 1 },
        "b.ts": { path: "b.ts", content: "x", baseContent: "a\nb\nc\nd", baseSha: null, status: "modified", updatedAt: 2 },
        "c.ts": { path: "c.ts", content: "", baseContent: "one\ntwo", baseSha: null, status: "deleted", updatedAt: 3 },
      } as WorkspaceState["files"],
    });
    const statsOut = workspaceChangeStats(state);
    expect(statsOut.files).toBe(3);
    expect(statsOut.additions).toBe(3 + Math.max(0, 1 - 4));
    expect(statsOut.deletions).toBe(Math.max(0, 4 - 1) + 2);
  });
});

// ── P2: strand surface + risk policy ─────────────────────────

describe("strand surface", () => {
  it("allows exactly the strand tool set", () => {
    expect(STRAND_TOOL_NAMES.has("write_file")).toBe(true);
    expect(STRAND_TOOL_NAMES.has("edit_file")).toBe(true);
    expect(STRAND_TOOL_NAMES.has("run_checks")).toBe(true);
    expect(STRAND_TOOL_NAMES.has("push_changes")).toBe(false);
    expect(STRAND_TOOL_NAMES.has("call_mcp_tool")).toBe(false);
    expect(STRAND_TOOL_NAMES.has("ask_user")).toBe(false);
    expect(STRAND_TOOL_NAMES.has("http_write")).toBe(false);
    expect(STRAND_TOOL_NAMES.has("run_command")).toBe(false);
    expect(isStrandCall("read_file")).toBe(true);
    expect(isStrandCall("verify_with_ci")).toBe(false);
  });

  it("refuses a call outside the surface before arguments are parsed", () => {
    const refusal = assertStrandCall({
      id: "c1",
      name: "push_changes",
      arguments: '{"commitMessage": "ship it"}',
    });
    expect(refusal).not.toBeNull();
    expect(refusal!.ok).toBe(false);
    expect(strandRefusalText("push_changes")).toContain("strand");
  });

  it("returns null (allowed) for surface calls", () => {
    expect(
      assertStrandCall({ id: "c2", name: "read_file", arguments: '{"path": "src/a.ts"}' })
    ).toBeNull();
  });

  it("the round cap is bounded below the main loop's", () => {
    expect(STRAND_MAX_ROUNDS).toBeLessThanOrEqual(8);
  });
});

describe("strand fork policy", () => {
  const base = {
    stuckRefusals: 0,
    probeFailures: 0,
    checkFailing: false,
    plan: { total: 0, done: 0 },
    roundsSpent: 0,
  };

  it("does not fork on a healthy turn", () => {
    expect(shouldForkStrands(base).fork).toBe(false);
  });

  it("forks on stuck refusals", () => {
    expect(shouldForkStrands({ ...base, stuckRefusals: 1 }).fork).toBe(true);
  });

  it("forks on two probe failures, not one", () => {
    expect(shouldForkStrands({ ...base, probeFailures: 1 }).fork).toBe(false);
    expect(shouldForkStrands({ ...base, probeFailures: 2 }).fork).toBe(true);
  });

  it("forks on a failing check", () => {
    expect(shouldForkStrands({ ...base, checkFailing: true }).fork).toBe(true);
  });

  it("forks on a large stalled plan only after rounds burned", () => {
    const stalled = { plan: { total: 6, done: 1 } };
    expect(shouldForkStrands({ ...base, ...stalled, roundsSpent: 2 }).fork).toBe(false);
    expect(shouldForkStrands({ ...base, ...stalled, roundsSpent: 4 }).fork).toBe(true);
  });

  it("strand models never exceed the conversation's ceiling", () => {
    const models = pickStrandModels("m/main", ["m/cheap1", "m/cheap2", "m/cheap3"], 2);
    expect(models).toEqual(["m/cheap1", "m/cheap2"]);
    const fallback = pickStrandModels("m/main", [], 2);
    expect(fallback).toEqual(["m/main", "m/main"]);
  });
});

// ── P3: fixed-size working state ─────────────────────────────

describe("braid state file", () => {
  const evidence: VerificationEvidence[] = [
    {
      kind: "workspace",
      at: Date.now(),
      workspaceUpdatedAt: 1_000,
      ok: true,
      summary: "`npm test` exited 0",
      status: "fresh-pass",
      ageMs: 0,
    },
    {
      kind: "typecheck",
      at: Date.now(),
      workspaceUpdatedAt: 1_000,
      ok: false,
      summary: "2 error(s) across 5 file(s)",
      details: ["src/a.ts:3 TS2304: Cannot find name 'x'"],
      status: "fresh-fail",
      ageMs: 0,
    },
  ];

  it("derives all fields from plan + evidence", () => {
    const state = rebuildBraidState({
      taskText: "fix the flaky checkout flow",
      plan: plan([
        { status: "done", text: "reproduce the flake" },
        { status: "active", text: "stabilize the cart reducer" },
        { status: "pending", text: "re-run the suite" },
      ]),
      evidence,
      workspaceUpdatedAt: 1_000,
    });
    expect(state.goal).toContain("fix the flaky checkout flow");
    expect(state.decisions).toHaveLength(2);
    expect(state.facts.some((f) => f.includes("npm test"))).toBe(true);
    expect(state.openThreads.some((t) => t.includes("stabilize"))).toBe(true);
    expect(state.openThreads.some((t) => t.includes("2 error"))).toBe(true);
    expect(state.nextAction).toContain("stabilize");
  });

  it("is capped — it cannot grow", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `s${i}`,
      text: `step ${i} with a very long description that keeps going and going`.repeat(3),
      status: "pending" as const,
    }));
    const state = rebuildBraidState({
      taskText: "t".repeat(2_000),
      plan: { steps: many, updatedAt: Date.now(), complete: false },
      evidence: Array.from({ length: 30 }, () => evidence[0]!).map((e, i) => ({
        ...e,
        summary: `pass number ${i}`,
      })),
      probeFindings: Array.from({ length: 20 }, (_, i) => `probe finding ${i}`),
    });
    expect(state.decisions.length).toBeLessThanOrEqual(8);
    expect(state.facts.length).toBeLessThanOrEqual(8);
    expect(state.openThreads.length).toBeLessThanOrEqual(8);
    expect(state.goal.length).toBeLessThanOrEqual(400);
    const rendered = renderBraidState(state);
    // A pathological turn still renders a bounded block (< ~1.5k tokens).
    expect(rendered.length).toBeLessThan(6_000);
  });

  it("clears next action when the turn is settled", () => {
    const state = rebuildBraidState({
      taskText: "t",
      plan: plan([{ status: "pending", text: "not done" }]),
      evidence: [],
      turnSettled: true,
    });
    expect(state.nextAction).toBeNull();
  });

  it("renders empty-ish state without crashing", () => {
    const state = rebuildBraidState({ taskText: "", evidence: [] });
    expect(state.goal).toBe("(in progress)");
    expect(renderBraidState(state)).toContain("WORKING STATE");
  });
});

// ── Audit fixes: staleness, no-op strands, relative verification ──

describe("strand fork staleness (revision-based)", () => {
  it("a fork at the live revision is fresh", () => {
    expect(strandForkIsStale(1_000, 1_000)).toBe(false);
  });

  it("a fork behind the live revision is stale — main keeps editing after the fork", () => {
    expect(strandForkIsStale(1_001, 1_000)).toBe(true);
    expect(strandForkIsStale(9_999, 1_000)).toBe(true);
  });

  it("revisions are compared, never timestamps — a 3-hour-old fork at the same revision is fresh", () => {
    // If this were comparing Date.now() against a revision, any fork older
    // than one edit would already read as stale; the forkedAtRevision field
    // exists precisely so this cannot happen.
    const forkedThreeHoursAgo = 1_000_000_000;
    expect(strandForkIsStale(forkedThreeHoursAgo, forkedThreeHoursAgo)).toBe(false);
  });
});

describe("relative strand verification (dirty-baseline repos)", () => {
  it("strict standard when no baseline is known", () => {
    expect(strandCheckOk(null, 0)).toBe(true);
    expect(strandCheckOk(null, 1)).toBe(false);
  });

  it("holds the baseline on a dirty repo — no regression is a pass", () => {
    expect(strandCheckOk(5, 5)).toBe(true);
    expect(strandCheckOk(5, 3)).toBe(true);
  });

  it("a regression fails even on a dirty baseline", () => {
    expect(strandCheckOk(5, 6)).toBe(false);
  });
});

describe("no-op strand protection", () => {
  const stats = (files: number, a = 0, d = 0) => ({ files, additions: a, deletions: d });

  it("a strand that changed nothing cannot win, even when 'verified'", () => {
    const decision = decideBraid(
      { verified: false, stats: stats(3, 40, 4), modelId: "m" },
      [{ label: "strand A", modelId: "m", verified: true, stats: stats(0) }]
    );
    expect(decision.winner).toBe("main");
  });

  it("a strand with real changes still wins when verified", () => {
    const decision = decideBraid(
      { verified: false, stats: stats(3, 40, 4), modelId: "m" },
      [{ label: "strand A", modelId: "m", verified: true, stats: stats(2, 12, 1) }]
    );
    expect(decision.winner).toBe("strand");
  });
});
