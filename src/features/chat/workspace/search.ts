// ============================================================
// Workspace Search — Local Grep Over the Agent's Working Copy
// ============================================================
// search_code hits GitHub's code search, which only indexes the
// default branch, is limited to ~10 requests/minute, and cannot see
// the agent's own unpushed edits. This module searches the working
// copy instead: files already loaded in the workspace are searched
// for free, and unloaded candidates can be fetched on demand by the
// caller (bounded, so one query can't drain the API budget).
//
// Everything here is pure and store-free so the matching rules are
// unit-testable; the caller owns the network and the store.

import type { WorkspaceState } from "../types";

/** Directories and file kinds that are never worth scanning */
const SKIP_SEGMENTS = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "vendor/",
  "coverage/",
  ".git/",
  ".next/",
  ".turbo/",
  "target/",
];

const SKIP_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".avif",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".jar",
  ".war",
  ".class",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".wasm",
  ".map",
];

const SKIP_FILENAMES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
];

/** Longest single line echoed back for a match */
const MATCH_LINE_MAX_CHARS = 240;
/** Matches reported per file before moving on */
export const SEARCH_MAX_MATCHES_PER_FILE = 8;
/** Largest file the local search will consider (bytes) */
export const SEARCH_MAX_FILE_BYTES = 200_000;
/** Unloaded files one search may fetch (API budget guard) */
export const SEARCH_MAX_FETCH_FILES = 40;
/** Hard cap on returned matches */
export const SEARCH_MAX_RESULTS = 50;

/** True when a repo path is worth scanning for text matches */
export function isSearchablePath(path: string): boolean {
  const lower = path.toLowerCase();
  if (SKIP_SEGMENTS.some((seg) => lower.includes(seg))) return false;
  if (SKIP_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
  const name = lower.split("/").pop() ?? "";
  if (SKIP_FILENAMES.some((f) => f.toLowerCase() === name)) return false;
  if (name.endsWith(".min.js") || name.endsWith(".min.css")) return false;
  return true;
}

export type SearchMode = "text" | "regex";

export interface WorkspaceSearchMatch {
  path: string;
  /** 1-based line number */
  line: number;
  /** Trimmed, length-capped line content */
  text: string;
}

export interface ContentSearchOutcome {
  matches: WorkspaceSearchMatch[];
  /** True when the per-file match cap was hit */
  capped: boolean;
}

/**
 * Finds matches of `query` in one file's content. Text mode is a
 * case-insensitive substring match; regex mode uses JavaScript regex
 * syntax (also case-insensitive). Returns the first N matches with
 * line numbers — enough for the model to open the right window.
 */
export function searchContent(
  path: string,
  content: string,
  query: string,
  mode: SearchMode,
  maxMatches = SEARCH_MAX_MATCHES_PER_FILE
): ContentSearchOutcome {
  const lines = content.split("\n");
  const needle = query.toLowerCase();
  let matcher: RegExp | null = null;

  if (mode === "regex") {
    try {
      matcher = new RegExp(query, "i");
    } catch {
      matcher = null;
    }
  }

  const matches: WorkspaceSearchMatch[] = [];
  let capped = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const hit = matcher
      ? matcher.test(raw)
      : raw.toLowerCase().includes(needle);
    if (!hit) continue;

    const trimmed = raw.trim();
    matches.push({
      path,
      line: i + 1,
      text:
        trimmed.length > MATCH_LINE_MAX_CHARS
          ? `${trimmed.slice(0, MATCH_LINE_MAX_CHARS)}…`
          : trimmed,
    });
    if (matches.length >= maxMatches) {
      capped = i < lines.length - 1;
      break;
    }
  }

  return { matches, capped };
}

export interface SearchCandidates {
  /** Files whose contents are already in the workspace (free to search) */
  loaded: string[];
  /** Repo files whose contents would have to be fetched first */
  unloaded: string[];
  /** Tracked files skipped because of their kind (binary, lockfile, vendor) */
  skipped: number;
}

/**
 * Splits the workspace into files that can be searched immediately
 * and files worth fetching. Deleted files and non-searchable kinds
 * are excluded; `pathPrefix` narrows to a subtree; files larger than
 * `maxFileBytes` are skipped (a minified bundle is not a search
 * target, and fetching one wastes the API budget).
 */
export function pickSearchCandidates(
  ws: WorkspaceState,
  pathPrefix?: string,
  maxFileBytes = SEARCH_MAX_FILE_BYTES
): SearchCandidates {
  const prefix = pathPrefix?.replace(/^\/+/, "").replace(/\/+$/, "");
  const matchesPrefix = (path: string) => !prefix || path === prefix || path.startsWith(`${prefix}/`);

  const known = new Set<string>();
  const treeSize = new Map<string, number>();
  for (const entry of ws.tree) {
    if (entry.type !== "blob" || !matchesPrefix(entry.path)) continue;
    known.add(entry.path);
    if (typeof entry.size === "number") treeSize.set(entry.path, entry.size);
  }
  for (const path of Object.keys(ws.files)) {
    if (matchesPrefix(path)) known.add(path);
  }

  const loaded: string[] = [];
  const unloaded: string[] = [];
  let skipped = 0;

  for (const path of [...known].sort()) {
    const file = ws.files[path];
    if (file) {
      // Locally deleted files must not resurrect repo content.
      if (file.status === "deleted") continue;
      if (isSearchablePath(path) && file.content.length <= maxFileBytes) loaded.push(path);
      else skipped++;
      continue;
    }
    const size = treeSize.get(path);
    if (isSearchablePath(path) && (size === undefined || size <= maxFileBytes)) unloaded.push(path);
    else skipped++;
  }

  return { loaded, unloaded, skipped };
}
