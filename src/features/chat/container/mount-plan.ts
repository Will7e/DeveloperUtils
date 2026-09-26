// ============================================================
// Mount Plan — The Overlay As A Container Filesystem
// ============================================================
// A container has an empty filesystem; the workspace is an OVERLAY of files held
// in IndexedDB plus the agent's change set. Before anything can run, the overlay
// has to become files — and the decision of WHICH files is the materializer's
// decision, with one difference that matters: nothing we mount stays
// private.
//
// Every file written here is readable by every process that runs afterwards — an
// `npm ci` postinstall script, a dev server asked for a path, a dependency the
// agent installed. That is not a property of the container being untrusted; it is
// a property of it being a real filesystem where third-party code runs, which is
// also true of a laptop and is exactly why the app already classifies paths. KEY
// MATERIAL (`id_rsa`, `.pem`, `secrets.json`) is therefore NOT mounted, and the
// omission is REPORTED rather than silent.
//
// A committed ENV FILE is the deliberate exception. It is part of the repository
// at the pinned commit — already public to everyone who can see that commit — so
// refusing to run the project without it is stricter than the user's laptop,
// where the same `npm install` that runs here can read the very same file. The
// policy follows the commit: what the repository ships, the workspace runs with.
// A user-PASTED env file never enters a mount (it lives in the runtime-env
// store and travels only through spawn env), so "secret because I typed it" and
// "public because the repo published it" stay two different things.
//
// Path containment and the `.git` rule are not re-implemented here. They live in
// materialize-plan.ts beside this file, they are tested there, and a second copy
// is how two rule sets drift into disagreeing about `../../`.
//
// Pure: contents in, a tree out. No DOM, no container, no network.
// ============================================================

import type { DirectoryNode, FileNode, FileSystemTree } from "@webcontainer/api";
import { secretPathKindOf } from "../lib/sensitivity";
import {
  planMaterialization,
  type MaterializeBaseFile,
  type MaterializeChange,
} from "./materialize-plan";

/**
 * The ceiling for one mounted tree.
 *
 * This writes into a WASM filesystem inside a browser tab, on the user's
 * machine, competing with their other tabs for the same few gigabytes — and the
 * number that matters is not "can it hold the tree" but "can it hold the tree,
 * `node_modules`, and the dev server at once". A partial tree here is reported,
 * never silent. It sits ABOVE the hydrator's byte budget deliberately: the
 * mount must never be the bottleneck that re-drops what the hydrator decided
 * to keep (a 24 MiB hydrated tree with media in it must not die at 16).
 */
export const MOUNT_MAX_BYTES = 32 * 1024 * 1024;

/** Files beyond this are dropped with a report; the tail is not arbitrary */
export const MOUNT_MAX_FILES = 4_000;

export type MountSkipCode = "unsafe-path" | "protected-path" | "secret" | "too-large" | "too-many";

export interface MountSkip {
  path: string;
  code: MountSkipCode;
  /** One sentence a user can act on */
  message: string;
}

export interface MountPlan {
  /** The tree to hand `mount()`, directories included */
  tree: FileSystemTree;
  /** Paths that will exist in the container, in stable order */
  files: { path: string; bytes: number }[];
  bytes: number;
  /** Entries that will NOT exist, with the reason — never dropped quietly */
  skipped: MountSkip[];
  /** True when there is nothing to mount, so the caller can refuse to boot */
  empty: boolean;
}

/**
 * The decision, for one workspace revision.
 *
 * `base` is the repository tree at the pinned commit (without it, only the files
 * the workspace touched exist, and `npm test` would run against a partial
 * project). `changes` is the agent's delta on top. Deletions are resolved during
 * composition: a deleted file is simply absent from the tree we hand the
 * container, so the mount never has to remove anything.
 */
export function planMount(input: {
  base: readonly MaterializeBaseFile[];
  changes: readonly MaterializeChange[];
  maxBytes?: number;
  maxFiles?: number;
}): MountPlan {
  const maxBytes = input.maxBytes ?? MOUNT_MAX_BYTES;
  const maxFiles = input.maxFiles ?? MOUNT_MAX_FILES;

  // Composition, containment and `.git` protection are the materializer's job.
  // Its byte ceiling is passed through so its own rejection wording is used.
  const composed = planMaterialization({
    base: input.base,
    changes: input.changes,
    maxBytes,
  });

  const skipped: MountSkip[] = composed.rejected.map((entry) => ({
    path: entry.path,
    code: entry.code,
    message: entry.message,
  }));

  const files: { path: string; content: string | Uint8Array; bytes: number }[] = [];
  for (const write of composed.writes) {
    // A committed env file rides the mount; key material never does. The
    // distinction is the commit, not the shape: the same `.env` PASTED into the
    // workspace by the agent never reaches this path as a base file (it is a
    // change), and a change that merely rewrites a committed env file still
    // mounts — the commit already published the values, and the user's own edit
    // to their own checkout is exactly the work this tier exists to run.
    if (secretPathKindOf(write.path) === "key-material") {
      skipped.push({
        path: write.path,
        code: "secret",
        message: `"${write.path}" looks like key material, so it is not mounted: every dependency script and dev server in the workspace can read everything mounted here. Report anything that needs it rather than asking for it to be mounted.`,
      });
      continue;
    }
    if (files.length >= maxFiles) {
      skipped.push({
        path: write.path,
        code: "too-many",
        message: `The tree already holds ${maxFiles} files; this one is not mounted, so the workspace runs against a partial tree.`,
      });
      continue;
    }
    files.push({
      path: write.path,
      content: write.content,
      bytes: typeof write.content === "string" ? write.content.length : write.content.byteLength,
    });
  }

  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    tree: treeOf(files),
    files: files.map(({ path, bytes: size }) => ({ path, bytes: size })),
    bytes,
    skipped,
    empty: files.length === 0,
  };
}

interface PlannedFile {
  path: string;
  content: string | Uint8Array;
}

/**
 * Nested directories from flat paths, parents before children.
 *
 * Deterministic on purpose: the same revision must produce byte-identical trees,
 * or a snapshot keyed by revision describes a filesystem nobody can reproduce.
 */
function treeOf(files: readonly PlannedFile[]): FileSystemTree {
  const tree: FileSystemTree = {};
  const ordered = [...files].sort(compareByDepth);
  for (const file of ordered) {
    const segments = file.path.split("/");
    let node: FileSystemTree = tree;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]!;
      const existing = node[segment];
      if (!existing || !("directory" in existing)) {
        const created: DirectoryNode = { directory: {} };
        node[segment] = created;
        node = created.directory;
      } else {
        node = existing.directory;
      }
    }
    const name = segments[segments.length - 1]!;
    // A file and a directory can collide only when one path is a prefix of the
    // other, which composition cannot produce for a real repository — but a
    // silent overwrite would hide it, so the directory wins and the file is
    // reported by the caller's byte/file counts.
    if (!(name in node)) {
      // `contents` accepts a string OR a `Uint8Array` — the binary form is how
      // committed assets (images, fonts) reach the preview without being
      // decoded into corruption. The SDK's own `FileNode` type carries both.
      const entry: FileNode = { file: { contents: file.content } };
      node[name] = entry;
    }
  }
  return tree;
}

/** Shallowest first, then alphabetically — parents before their children */
function compareByDepth(a: PlannedFile, b: PlannedFile): number {
  const depth = a.path.split("/").length - b.path.split("/").length;
  return depth !== 0 ? depth : a.path.localeCompare(b.path);
}

/**
 * A tree back as flat path/content pairs.
 *
 * The inverse of `treeOf`, and it exists for the second and later mounts: writing
 * files into a mounted tree individually is what feeds the dev server's hot
 * reload, where re-mounting the whole tree would blank the preview on every
 * revision. Binary contents ride through as `Uint8Array` — the write bridge
 * passes them to the SDK unchanged, which accepts them natively; skipping them
 * here would silently strip every committed asset on the SECOND revision (the
 * files are already mounted, the refresh rewrites only what it is handed).
 */
export function flattenTree(
  tree: FileSystemTree,
  prefix = ""
): { path: string; content: string | Uint8Array }[] {
  const files: { path: string; content: string | Uint8Array }[] = [];
  for (const [name, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if ("file" in node) {
      // A `symlink` node has no contents; only a real file has bytes to write.
      const contents = "contents" in node.file ? node.file.contents : null;
      if (typeof contents === "string" || contents instanceof Uint8Array) {
        files.push({ path, content: contents });
      }
      continue;
    }
    if ("directory" in node) {
      files.push(...flattenTree((node as DirectoryNode).directory, path));
    }
  }
  // Path order, so a caller's writes and its counts are reproducible.
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * One line for a tool result or a status panel.
 *
 * States the size and, when anything was left out, says so in the same breath:
 * "mounted 412 files" and "mounted 412 files, 2 skipped" are different claims,
 * and only one of them lets a later failure be read correctly.
 */
export function describeMount(plan: MountPlan): string {
  if (plan.empty) return "nothing to mount — the workspace has no files for this revision.";
  const size = plan.bytes >= 1024 * 1024 ? `${(plan.bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.round(plan.bytes / 1024)} KiB`;
  const head = `${plan.files.length} file${plan.files.length === 1 ? "" : "s"} (${size})`;
  if (plan.skipped.length === 0) return `Workspace mounted: ${head}.`;
  const shown = plan.skipped.slice(0, 3).map((s) => s.path);
  const extra = plan.skipped.length - shown.length;
  return `Workspace mounted: ${head}, ${plan.skipped.length} skipped (${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""}).`;
}
