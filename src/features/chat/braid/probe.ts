// ============================================================
// Probe — Mid-Turn Process Verification (Braid P1)
// ============================================================
// The type check already runs when the model ASKS for it
// (run_checks) and quietly after writes (auto-verify, at the stop).
// Both answer "is the code good" AFTER the fact. The probe asks it
// WHILE the model is working: a baseline captured at prepare time and
// compared after edit bursts, so new diagnostics are named in a
// harness notice the next round reads — before the model writes three
// more files on top of a broken one.
//
// Never a gate. The probe runs in a worker and NEVER blocks the next
// round: results arrive when they arrive and land as a notice at the
// next round boundary. A probe that fails to run (worker down, no
// sources) is silent — an absent probe cannot be a failure, because
// "typecheck unavailable" was already the world before Braid.
//
// Notice text is deliberately terse: it names the files that broke,
// one diagnostic each, capped — the model already knows what a TS
// error looks like.

import type { TypecheckResult } from "../lib/typecheck-client";
import type { WorkspaceState } from "../types";

/** One file's new diagnostics vs baseline */
export interface ProbeNewDiagnostic {
  path: string;
  code: number | string;
  message: string;
  line?: number | null;
}

export interface ProbeOutcome {
  ran: boolean;
  /** False when the probe could not run (worker unavailable, no sources) */
  ok: boolean;
  /** New diagnostics vs the baseline, capped */
  newDiagnostics: ProbeNewDiagnostic[];
  /** Error-count delta: negative means the turn is REPAIRING code */
  deltaErrors: number;
  /** The new baseline to carry forward (only when ok) */
  baseline?: ProbeBaseline;
  /** Why the probe did not run (when ran=false) */
  unavailableReason?: string;
}

/** What a baseline carries: enough to diff diagnostics per file */
export interface ProbeBaseline {
  capturedAt: number;
  /** workspace.updatedAt at capture — the revision the baseline describes */
  workspaceUpdatedAt: number;
  /** file path → diagnostic key (TScode@line@message-head) */
  byFile: Record<string, string[]>;
  totalErrors: number;
}

/** Compare at most this many new diagnostics into a notice */
export const PROBE_MAX_REPORTED = 6;

/** Capture a baseline from a raw typecheck result over the CURRENT workspace */
export function captureProbeBaseline(
  ws: WorkspaceState,
  result: TypecheckResult
): ProbeBaseline | null {
  if (!result.ok) return null; // unavailable typecheck → no baseline
  const byFile: Record<string, string[]> = {};
  let totalErrors = 0;
  for (const d of result.classification.reported) {
    const path = d.file ?? "(project)";
    const key = diagKey(d.code, d.line, d.message);
    (byFile[path] ??= []).push(key);
    totalErrors += 1;
  }
  return {
    capturedAt: Date.now(),
    workspaceUpdatedAt: ws.updatedAt,
    byFile,
    totalErrors,
  };
}

/**
 * Diffs a new typecheck result against a baseline. Pure — no worker,
 * no store — so it is unit-tested without a browser.
 */
export function diffProbe(
  baseline: ProbeBaseline | null,
  result: TypecheckResult
): ProbeOutcome {
  if (!result.ok) {
    return {
      ran: false,
      ok: false,
      newDiagnostics: [],
      deltaErrors: 0,
      unavailableReason: result.unavailableReason ?? "typecheck did not run",
    };
  }
  const current: Record<string, string[]> = {};
  let totalNow = 0;
  for (const d of result.classification.reported) {
    const path = d.file ?? "(project)";
    const key = diagKey(d.code, d.line, d.message);
    (current[path] ??= []).push(key);
    totalNow += 1;
  }

  const newDiagnostics: ProbeNewDiagnostic[] = [];
  for (const [path, keys] of Object.entries(current)) {
    const prior = new Set(baseline?.byFile[path] ?? []);
    for (let i = 0; i < keys.length; i++) {
      if (!prior.has(keys[i]!)) {
        const d = result.classification.reported.find(
          (rep) => (rep.file ?? "(project)") === path && diagKey(rep.code, rep.line, rep.message) === keys[i]!
        );
        if (d) {
          newDiagnostics.push({
            path,
            code: d.code,
            message: d.message.split("\n")[0] ?? d.message,
            ...(d.line !== undefined ? { line: d.line } : {}),
          });
        }
      }
    }
  }

  return {
    ran: true,
    ok: true,
    newDiagnostics: newDiagnostics.slice(0, PROBE_MAX_REPORTED),
    deltaErrors: totalNow - (baseline?.totalErrors ?? 0),
    // The new baseline: same shape `captureProbeBaseline` builds, stamped
    // with the caller's revision by the engine (which knows the live
    // workspace) rather than here, where there is no revision to name.
    baseline: {
      capturedAt: Date.now(),
      workspaceUpdatedAt: baseline?.workspaceUpdatedAt ?? 0,
      byFile: current,
      totalErrors: totalNow,
    },
  };
}

function diagKey(code: number | string, line: number | null | undefined, message: string): string {
  return `${code}@${line ?? "-"}@${(message.split("\n")[0] ?? message).slice(0, 80)}`;
}

/** Model-facing notice text for a probe with new diagnostics */
export function probeNotice(outcome: ProbeOutcome): string | null {
  if (!outcome.ran || !outcome.ok || outcome.newDiagnostics.length === 0) return null;
  const lines: string[] = [
    `[harness probe] The type check (run between your tool calls, without being asked) found diagnostics that were NOT in the baseline captured when this turn started:`,
  ];
  for (const d of outcome.newDiagnostics) {
    lines.push(`- ${d.path}${d.line ? `:${d.line}` : ""} TS${d.code}: ${d.message}`);
  }
  if (outcome.deltaErrors < 0) {
    lines.push(`(Net errors went DOWN by ${-outcome.deltaErrors} — good, keep going.)`);
  } else {
    lines.push(
      "Fix these before continuing with new files — every later edit compounds on top of them."
    );
  }
  return lines.join("\n");
}

/**
 * Builds the workspace snapshot shape `runTypecheck` needs. Filtered to
 * non-deleted files — tombstones are not compiled.
 */
export function probeFiles(ws: WorkspaceState): Array<{ path: string; content: string }> {
  return Object.entries(ws.files)
    .filter(([, f]) => f.status !== "deleted")
    .map(([path, f]) => ({ path, content: f.content }));
}
