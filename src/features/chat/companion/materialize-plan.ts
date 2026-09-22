// ============================================================
// Materialize Plan — An Overlay Turned Into A Working Tree
// ============================================================
// The workspace is an OVERLAY: files live in IndexedDB (or the base tree
// cached per `repo@commit`), and nothing has ever existed on disk. A shell
// cannot run `npm ci` against an overlay, so before the first command the
// overlay has to become a real directory: write the base tree, then apply
// the change set on top.
//
// This module decides WHAT would be written and refuses what must never be.
// It touches no filesystem: the Node adapter does the writing, and having
// the two separate is what makes the dangerous half — path containment —
// assertable in a unit test instead of only in the presence of a disk.
//
// The threat is not hypothetical. The change set is derived from edits an
// LLM produced, and it is then written to a real directory on the user's
// machine. A single `../../` segment in a path escapes the workspace; a
// write into `.git/` is code execution, because git runs `hooks/` on the
// very next command the shell issues.
//
// Pure: paths and strings in, a plan out.
// ============================================================

export interface MaterializeBaseFile {
  path: string;
  content: string;
}

export interface MaterializeChange {
  path: string;
  /** null means the file was deleted in the workspace */
  content: string | null;
  status: string;
}

export interface MaterializePlan {
  /** Files to write, in apply order (shallowest path first) */
  writes: { path: string; content: string }[];
  /** Paths to remove from the materialized tree */
  deletes: string[];
  /** Entries that will NOT be written, with the reason */
  rejected: { path: string; code: MaterializeRejectionCode; message: string }[];
  bytes: number;
  /** True when the plan carries nothing to run against */
  empty: boolean;
}

export type MaterializeRejectionCode = "unsafe-path" | "protected-path" | "too-large";

/** Default ceiling for one materialized tree (~64 MiB, generous for source) */
export const MATERIALIZE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Paths that must never be written from a change set, however they are
 * spelled.
 *
 * `.git` is the load-bearing one: it is not data, it is a program. A single
 * write to `.git/hooks/pre-commit` executes on the next git command the
 * shell runs, so materializing an agent-authored path there is remote code
 * execution with the user's own account — the exact thing the command
 * policy refuses at the other end of the pipe.
 */
const PROTECTED_PREFIXES = [".git/", ".git\\"];

/**
 * A workspace path with no way out of the workspace, or null.
 *
 * Returns null for anything that is not a plain relative path: absolute
 * paths, Windows drive letters, backslash separators (which Windows would
 * treat as one), `.`/`..` segments, and empty segments. A rejected file is
 * REPORTED, never silently dropped — a tree that is quietly missing the file
 * the command needs produces a confusing failure much further downstream.
 */
export function normalizeWorkspacePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path) return null;
  if (path.includes("\u0000")) return null;
  // Windows separators are treated as hostile rather than converted: a
  // path that arrives with them was not produced by the workspace code,
  // and silently rewriting it would hide that.
  if (path.includes("\\")) return null;
  if (path.startsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(path)) return null;

  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  const normalized = segments.join("/");
  // A surviving `..` cannot occur, but the belt is cheap next to the braces.
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

/** Why a path may not be materialized, or null when it may. */
export function materializeRejection(
  path: string
): { code: MaterializeRejectionCode; message: string } | null {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) {
    return {
      code: "unsafe-path",
      message: `"${path}" is not a plain relative path inside the workspace — it is not written.`,
    };
  }
  for (const prefix of PROTECTED_PREFIXES) {
    if (normalized === prefix.replace(/[/\\]$/, "") || normalized.startsWith(prefix)) {
      return {
        code: "protected-path",
        message: `"${normalized}" is inside .git, which is executable: writing it could run code on the user's machine. Not written.`,
      };
    }
  }
  return null;
}

/**
 * The tree to write, given the base contents and the change set.
 *
 * Deletions win over the base; change-set entries win over base contents.
 * Files are written shallowest-first so a directory always exists before the
 * file inside it, and the byte ceiling is applied in path order so the same
 * input always produces the same plan — a partial tree is a bug the user has
 * to be able to reason about.
 */
export function planMaterialization(input: {
  base: readonly MaterializeBaseFile[];
  changes: readonly MaterializeChange[];
  maxBytes?: number;
}): MaterializePlan {
  const maxBytes = input.maxBytes ?? MATERIALIZE_MAX_BYTES;
  const rejected: MaterializePlan["rejected"] = [];
  const byPath = new Map<string, string>();
  const deleted = new Set<string>();

  for (const file of input.base) {
    const reason = materializeRejection(file.path);
    if (reason) {
      rejected.push({ path: file.path, ...reason });
      continue;
    }
    byPath.set(normalizeWorkspacePath(file.path)!, file.content);
  }

  for (const change of input.changes) {
    const reason = materializeRejection(change.path);
    if (reason) {
      rejected.push({ path: change.path, ...reason });
      continue;
    }
    const path = normalizeWorkspacePath(change.path)!;
    if (change.content === null || change.status === "deleted") {
      byPath.delete(path);
      deleted.add(path);
      continue;
    }
    byPath.set(path, change.content);
  }

  const writes: MaterializePlan["writes"] = [];
  let bytes = 0;
  for (const path of [...byPath.keys()].sort(comparePaths)) {
    const content = byPath.get(path)!;
    if (bytes + content.length > maxBytes) {
      rejected.push({
        path,
        code: "too-large",
        message: `The tree would exceed ${Math.round(maxBytes / (1024 * 1024))} MiB; this file is not written, so the command runs against a partial tree.`,
      });
      continue;
    }
    bytes += content.length;
    writes.push({ path, content });
  }

  return {
    writes,
    deletes: [...deleted].sort(comparePaths),
    rejected,
    bytes,
    empty: writes.length === 0 && deleted.size === 0,
  };
}

/** Shallowest first, then alphabetically — parents before their children. */
function comparePaths(a: string, b: string): number {
  const depth = a.split("/").length - b.split("/").length;
  return depth !== 0 ? depth : a.localeCompare(b);
}

/** One line per rejected entry, for the command's tool result. */
export function describeRejections(plan: MaterializePlan): string | null {
  if (plan.rejected.length === 0) return null;
  const shown = plan.rejected.slice(0, 5).map((r) => r.message);
  const extra = plan.rejected.length - shown.length;
  return shown.join(" ") + (extra > 0 ? ` (+${extra} more)` : "");
}
