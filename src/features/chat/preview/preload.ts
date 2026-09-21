// ============================================================
// Preview Preload — Fetch the Files a Build Actually Needs
// ============================================================
// The workspace is lazy: file contents load on first read. The
// bundler, however, needs every module it can reach from the entry,
// so a fresh workspace used to fail with "File not loaded in the
// workspace". This walks the dependency graph from the entry —
// following local imports transitively — and fetches what the build
// needs, bounded so one preview cannot drain the API budget.
//
// Fetching is parallel (network-bound) but merging is sequential:
// a workspace is a read-modify-write value, so concurrent merges on
// one snapshot would keep only the last file.

import { readFileContent } from "../lib/github-client";
import { mergeFetchedFile } from "../workspace/workspace";
import type { WorkspaceState } from "../types";
import { createWorkspaceVfs, localImportSpecifiers } from "./vfs";

/** Files one preload pass may fetch */
export const PREVIEW_PRELOAD_MAX_FILES = 200;
/** Concurrent fetches per wave */
export const PREVIEW_PRELOAD_CONCURRENCY = 6;

export interface PreloadOutcome {
  ws: WorkspaceState;
  /** Paths fetched and folded into the workspace */
  loaded: string[];
  /** Paths that could not be loaded (binary, too large, API error) */
  failed: string[];
  /** Discovered dependencies left unfetched because the budget ran out */
  remaining: number;
}

/**
 * Loads the entry file and, transitively, the local modules it
 * imports. Returns the updated workspace; the caller decides whether
 * to publish it.
 *
 * `maxFiles` caps the total number of fetch attempts (loaded +
 * failed), so a pathological import graph cannot turn one preview
 * rebuild into hundreds of API calls.
 */
export async function preloadForPreview(
  ws: WorkspaceState,
  seeds: string[],
  token: string,
  maxFiles = PREVIEW_PRELOAD_MAX_FILES
): Promise<PreloadOutcome> {
  const inTree = (path: string) =>
    ws.tree.length === 0 || ws.tree.some((e) => e.path === path && e.type === "blob");

  let current = ws;
  const loaded: string[] = [];
  const failed: string[] = [];
  const attempted = new Set<string>();
  const queue: string[] = [];

  const enqueue = (path: string | null) => {
    if (!path || attempted.has(path)) return;
    if (current.files[path]) return; // already in the working copy
    if (!inTree(path)) return;
    if (queue.includes(path)) return;
    queue.push(path);
  };

  for (const seed of seeds) enqueue(seed);

  while (queue.length > 0 && attempted.size < maxFiles) {
    const batch: string[] = [];
    while (queue.length > 0 && batch.length < PREVIEW_PRELOAD_CONCURRENCY) {
      if (attempted.size >= maxFiles) break;
      const path = queue.shift()!;
      if (attempted.has(path) || current.files[path]) continue;
      attempted.add(path);
      batch.push(path);
    }
    if (batch.length === 0) break;

    const fetched = await Promise.all(
      batch.map(async (path) => {
        try {
          const file = await readFileContent(
            token,
            current.owner,
            current.repo,
            path,
            current.branch
          );
          return { path, file, error: null as string | null };
        } catch (err) {
          return {
            path,
            file: null,
            error: err instanceof Error ? err.message : "fetch failed",
          };
        }
      })
    );

    for (const result of fetched) {
      if (result.error || !result.file) {
        failed.push(result.path);
        continue;
      }
      const merged = mergeFetchedFile(current, result.path, result.file);
      if (!merged.ok) {
        failed.push(result.path);
        continue;
      }
      current = merged.ws;
      loaded.push(result.path);

      // Follow this file's local imports into the next wave.
      if (result.file.text !== null) {
        const vfs = createWorkspaceVfs(current);
        for (const spec of localImportSpecifiers(result.file.text, result.path)) {
          enqueue(vfs.resolveRel(result.path, spec));
        }
      }
    }
  }

  return { ws: current, loaded, failed, remaining: queue.length };
}

/** Entry point seeds for a build: the entry file plus its script src */
export function preloadSeeds(entry: {
  kind: "html" | "js";
  path: string;
  scriptSrc?: string;
} | null): string[] {
  if (!entry) return [];
  if (entry.kind === "js") return [entry.path];
  const seeds = [entry.path];
  const script = entry.scriptSrc?.replace(/^\.?\//, "");
  if (script && !/^(https?:|data:|blob:|\/\/)/i.test(script)) seeds.push(script);
  return seeds;
}
