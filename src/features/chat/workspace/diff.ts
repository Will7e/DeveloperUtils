// ============================================================
// Workspace Diff — Unified Diff Generation for Workspace Changes
// ============================================================
// Pure functions: base content vs working content → unified diff
// with +/− stats. Used by the push-approval UI and to summarize
// write_file results for the model. No store or DOM dependencies.

import type { WorkspaceChange } from "../types";

const MAX_PATCH_LINES = 400;

interface DiffStats {
  additions: number;
  deletions: number;
  lines: string[];
}

/**
 * Line-based diff via LCS dynamic programming. Suited to file-scale
 * inputs (≤ ~2k lines); write_file results are capped well below
 * pathological sizes by the workspace and tool budget.
 */
function lineDiff(a: string[], b: string[]): DiffStats {
  const n = a.length;
  const m = b.length;
  const lines: string[] = [];
  let additions = 0;
  let deletions = 0;

  // Guard: pathological sizes degrade to a whole-file replace
  if (n * m > 4_000_000) {
    for (const l of a) {
      lines.push(`-${l}`);
      deletions++;
    }
    for (const l of b) {
      lines.push(`+${l}`);
      additions++;
    }
    return { additions, deletions, lines };
  }

  // LCS length table
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    const row = dp[i]!;
    const prev = dp[i - 1]!;
    for (let j = 1; j <= m; j++) {
      row[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, row[j - 1] ?? 0);
    }
  }

  // Backtrack to emit diff lines
  let i = n;
  let j = m;
  const out: string[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.push(` ${a[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dp[i]![j - 1] ?? 0) >= (dp[i - 1]![j] ?? 0))) {
      out.push(`+${b[j - 1]}`);
      additions++;
      j--;
    } else {
      out.push(`-${a[i - 1]}`);
      deletions++;
      i--;
    }
  }
  out.reverse();
  lines.push(...out);
  return { additions, deletions, lines };
}

/** Collapse long runs of unchanged lines into fixed-context hunks */
function collapseContext(lines: string[]): string[] {
  const CONTEXT = 3;
  const isChange = (l: string) => l.startsWith("+") || l.startsWith("-");

  // Mark each index as within CONTEXT lines of a change line
  const keep = new Array<boolean>(lines.length).fill(false);
  let nextChangeAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isChange(lines[i]!)) nextChangeAt = i;
    else if (nextChangeAt !== -1 && nextChangeAt - i <= CONTEXT) keep[i] = true;
  }
  let prevChangeAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isChange(lines[i]!)) {
      keep[i] = true;
      prevChangeAt = i;
    } else if (prevChangeAt !== -1 && i - prevChangeAt <= CONTEXT) keep[i] = true;
  }

  // Emit kept lines, inserting hunk-gap markers between separated runs
  const out: string[] = [];
  let gap = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (gap && out.length > 0) out.push("…");
      gap = false;
      out.push(lines[i]!);
    } else {
      gap = out.length > 0;
    }
  }
  return out;
}

export interface FileDiffResult {
  change: WorkspaceChange;
}

/**
 * Diff one file: base content vs new content. Added/deleted files
 * get synthetic full-file diffs with /dev/null headers.
 */
export function diffFile(
  path: string,
  status: "modified" | "added" | "deleted",
  baseContent: string,
  newContent: string
): WorkspaceChange {
  let base = baseContent;
  let next = newContent;
  if (status === "added") base = "";
  if (status === "deleted") next = "";

  const a = base.length > 0 ? base.replace(/\r\n/g, "\n").split("\n") : [];
  const b = next.length > 0 ? next.replace(/\r\n/g, "\n").split("\n") : [];

  const stats = lineDiff(a, b);
  const collapsed = collapseContext(stats.lines).slice(0, MAX_PATCH_LINES);
  const truncated = collapsed.length >= MAX_PATCH_LINES;

  const header =
    status === "added"
      ? `--- /dev/null\n+++ b/${path}`
      : status === "deleted"
        ? `--- a/${path}\n+++ /dev/null`
        : `--- a/${path}\n+++ b/${path}`;

  const patch = [header, ...collapsed].join("\n") + (truncated ? "\n…[diff truncated]" : "");

  return {
    path,
    status,
    additions: stats.additions,
    deletions: stats.deletions,
    patch,
  };
}

/** Aggregate stats line for tool results / toasts */
export function summarizeChanges(changes: WorkspaceChange[]): string {
  const files = changes.length;
  const additions = changes.reduce((s, c) => s + c.additions, 0);
  const deletions = changes.reduce((s, c) => s + c.deletions, 0);
  const parts: string[] = [];
  const modified = changes.filter((c) => c.status === "modified").length;
  const added = changes.filter((c) => c.status === "added").length;
  const deleted = changes.filter((c) => c.status === "deleted").length;
  if (added) parts.push(`${added} added`);
  if (modified) parts.push(`${modified} modified`);
  if (deleted) parts.push(`${deleted} deleted`);
  return `${files} file${files === 1 ? "" : "s"} (${parts.join(", ")}), +${additions}/−${deletions}`;
}
