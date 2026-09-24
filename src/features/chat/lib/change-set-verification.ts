// ============================================================
// Change Set Verification — The Only Per-File Claim The Ledger Supports
// ============================================================
// The Changes pane shows one row per changed file, which invites a tick per row.
// That would be a lie, and the temptation to add it is the reason this module
// exists as its own tested thing.
//
// The ledger records evidence per (conversation, revision, TIER) — `ci`,
// `command`, `typecheck`. There is no such thing as "this file is verified": a
// passing test suite says nothing about which files it exercised, and a passing
// type check covers the whole program, not the file you are looking at. So a
// green dot per file would be an invention.
//
// A FAILURE is the opposite case. A type check that fails against the current
// revision names files, one diagnostic per line, and marking those rows is a
// claim the evidence actually carries: this file, at this revision, has an error
// the compiler reported. Everything else about verification belongs to the
// change set as a whole, which is where the pane's badge puts it.
//
// Stale failures are ignored: they describe bytes that are no longer here, and
// pointing at a file for a mistake that was already fixed is the other way this
// feature could teach a reader to distrust it.

import type { VerificationEvidence } from "./verification-ledger";

/** The placeholder the type-check report uses for project-wide diagnostics */
const PROJECT_WIDE = "(project)";

/**
 * The files a fresh failure names, as a path set.
 *
 * Diagnostic detail lines are formatted as `path:line TSxxxx: message` by
 * services/agent-actions.ts when it records type-check evidence. Parsing is
 * deliberately forgiving of the line number and code being absent (a
 * project-wide error has no file, and a future producer may omit the code):
 * what must not happen is a crash or a silent "everything is fine" on a format
 * change, so anything unrecognised is skipped rather than guessed at.
 */
export function failingPaths(evidence: readonly VerificationEvidence[]): Set<string> {
  const out = new Set<string>();
  for (const entry of evidence) {
    if (entry.status !== "fresh-fail") continue;
    for (const line of entry.details ?? []) {
      const path = pathOfDiagnostic(line);
      if (path) out.add(path);
    }
  }
  return out;
}

/** The path a diagnostic line names, or null when it names no file */
function pathOfDiagnostic(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith(PROJECT_WIDE)) return null;
  // The line/code tail is optional; the path is whatever precedes it.
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;
  const head = trimmed.slice(0, colon);
  // A Windows drive letter ("C:\…") puts a colon inside the path, and a
  // diagnostic may legitimately start after it. Only treat the head as a path
  // when it does not read as the tail of a different field.
  if (head.length === 1) {
    const next = trimmed.indexOf(":", colon + 1);
    if (next <= 0) return null;
    return trimmed.slice(0, next);
  }
  return head;
}

/**
 * Whether anything passed against the revision being looked at.
 *
 * Exposed for the one cross-surface rule the transcript needs: a turn that wrote
 * source and ran nothing is worth a note only while the change set is actually
 * unverified. Once a check has passed against this revision, the header chip says
 * so, and the transcript saying the opposite would be two surfaces disagreeing
 * about the same bytes.
 */
export function hasFreshPass(evidence: readonly VerificationEvidence[]): boolean {
  return evidence.some((entry) => entry.status === "fresh-pass");
}
