// ============================================================
// Braid Decide — Which Rollout's Work Survives The Join (Braid P2)
// ============================================================
// At the stop, the harness holds up to three finished rollouts: the
// main turn's own work, and up to two strand forks. Exactly one
// workspace state can survive, and this module is the whole policy.
//
//   1. GREEN WINS. A rollout whose run_checks evidence passed against
//      ITS OWN final bytes outranks everything, because "verified" is
//      the only currency this harness trades in.
//   2. Then SMALLER DIFF wins: among equally-verified rollouts, the
//      one that touched less is likelier to be the surgical fix rather
//      than the scattergun one.
//   3. Then the MAIN path wins ties: it is the transcript the user
//      already read and the model they chose.
//
// The decision is pure so it can be tested exhaustively; the runtime
// applies it by materializing the winner's workspace (adoptStrandWorkspace)
// or leaving the main path's state exactly as it is.

import { nextRevision } from "../identity/revision";
import type { WorkspaceState } from "../types";

/** What the main turn contributed to the join */
export interface MainOutcome {
  /** The main turn's own run_checks evidence passed at its final revision */
  verified: true | false | "baseline";
  /** Change stats of the main workspace vs its base */
  stats: ChangeStats;
  /** The conversation's model (tie-break context, not a rank input) */
  modelId: string;
}

/** Line-level change stats for one rollout */
export interface ChangeStats {
  files: number;
  additions: number;
  deletions: number;
}

/** A finished strand, as the join sees it */
export interface StrandOutcome {
  label: string;
  modelId: string;
  verified: boolean;
  stats: ChangeStats;
}

export type BraidDecision =
  | { winner: "main"; reason: string }
  | { winner: "strand"; label: string; reason: string }
  | { winner: "none"; reason: string };

/**
 * Picks the winner. Pure and exhaustive:
 *   • REAL-WORK RULE: a strand must have actually changed something — a
 *     strand that verified a no-op fork says nothing about the task, and
 *     adopting it would ERASE the main turn's work while claiming victory.
 *   • verified (0 or baseline-held) > unverified; among verified, smaller
 *     diff wins; main wins exact ties.
 */
export function decideBraid(main: MainOutcome, strands: StrandOutcome[]): BraidDecision {
  // A no-op strand is not a rescue candidate, full stop.
  const verifiedStrands = strands.filter(
    (s) => s.verified && (s.stats.files > 0 || s.stats.additions > 0 || s.stats.deletions > 0)
  );

  if (main.verified) {
    if (verifiedStrands.length === 0) {
      return { winner: "main", reason: "the main turn's checks are green" };
    }
    const best = minBy(verifiedStrands, (s) => diffWeight(s.stats));
    if (diffWeight(best!.stats) < diffWeight(main.stats)) {
      return {
        winner: "strand",
        label: best!.label,
        reason: `both verified, but ${best!.label}'s change is smaller (+${best!.stats.additions}/−${best!.stats.deletions} vs +${main.stats.additions}/−${main.stats.deletions})`,
      };
    }
    return { winner: "main", reason: "verified, and no smaller verified strand beat it" };
  }

  if (verifiedStrands.length > 0) {
    const best = minBy(verifiedStrands, (s) => diffWeight(s.stats));
    return {
      winner: "strand",
      label: best!.label,
      reason: `${best!.label} verified its fork (${best!.stats.files} file(s), +${best!.stats.additions}/−${best!.stats.deletions}) while the main turn could not`,
    };
  }

  return { winner: "main", reason: "nothing verified — keeping the main turn's work rather than discarding it" };
}

/** One honest transcript line for the join */
export function braidNote(decision: BraidDecision, strandLabels: string[]): string | null {
  if (strandLabels.length === 0) return null;
  const ran = `Strand rollouts (${strandLabels.join(", ")}) ran alongside this turn and were joined at the stop.`;
  if (decision.winner === "main") return `${ran} Kept this turn's work: ${decision.reason}.`;
  if (decision.winner === "strand")
    return `${ran} Continued on ${decision.label}: ${decision.reason}. Its files were adopted into this workspace.`;
  return `${ran} ${decision.reason}.`;
}

function diffWeight(stats: ChangeStats): number {
  return stats.additions + stats.deletions;
}

function minBy<T>(items: T[], weight: (item: T) => number): T | null {
  if (items.length === 0) return null;
  return items.reduce((best, item) => (weight(item) < weight(best) ? item : best), items[0]!);
}

// ── Applying the decision ────────────────────────────────────

/**
 * Materializes a winning strand's forked workspace into the value the
 * store should hold: the strand's final bytes, with a revision bumped
 * strictly past both the strand's and the live workspace's — the same
 * rule restoreWorkspace follows, so any evidence recorded against the
 * pre-adopt state goes stale exactly when the bytes change.
 */
export function adoptStrandWorkspace(strandFinal: WorkspaceState, live: WorkspaceState): WorkspaceState {
  return {
    ...strandFinal,
    updatedAt: nextRevision(Math.max(strandFinal.updatedAt, live.updatedAt)),
  };
}

/**
 * Change stats of a workspace vs its base contents. Approximates the
 * unified-diff counts with per-file line deltas over non-deleted files;
 * deletions count tombstoned files' base lines. Good enough to rank
 * rollouts — the transcript row renders these same numbers.
 */
export function workspaceChangeStats(ws: WorkspaceState): ChangeStats {
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const file of Object.values(ws.files)) {
    if (file.status === "unchanged") continue;
    files += 1;
    if (file.status === "deleted") {
      deletions += countLines(file.baseContent);
      continue;
    }
    const base = countLines(file.baseContent);
    const now = countLines(file.content);
    if (file.status === "added") {
      additions += now;
    } else {
      additions += Math.max(0, now - base);
      deletions += Math.max(0, base - now);
    }
  }
  return { files, additions, deletions };
}

function countLines(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split("\n").length;
}
