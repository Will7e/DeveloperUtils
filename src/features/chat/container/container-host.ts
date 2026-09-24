// ============================================================
// Container Host — One Browser Workspace, Owned By The App
// ============================================================
// A browser workspace is a page-wide singleton: the runtime boots once, holds one
// filesystem, and refuses a second instance. That makes the lifecycle an app-level
// concern rather than a per-call one, and it makes the failure modes shared — a
// leaked instance blocks every later boot in the tab, and a tree left mounted from
// another repository makes every later command evidence about the wrong code.
//
// So this module owns exactly three things:
//
//   • BOOTING, once, eagerly, behind the user's first message rather than behind
//     their first command (the expensive part then overlaps with typing);
//   • MOUNTING, which is the one place the workspace's files become files;
//   • RELEASING, registered with the scoped-resource registry so a repository
//     switch or a moved base tears the workspace down instead of leaving a green
//     result about code that is no longer in play.
//
// The runtime is reached through `@webcontainer/api` — imported DYNAMICALLY, at
// boot, so this module can be imported (and unit-tested) where there is no
// document, and so the SDK's browser-only globals are touched only in a browser.
// `containerRuntimes.ts` below is the adapter interface the executor and the
// preview bridge speak, which keeps them testable against a fake.
// ============================================================

import type { FileSystemTree, PreviewMessage } from "@webcontainer/api";
import { noteWorkspaceOutcome } from "../lib/availability";
import { registerScopedResource } from "../identity/scoped-resources";
import { readWorkspaceEnvironment, workspaceVerdict } from "./boot-probe";
import { flattenTree } from "./mount-plan";

/** A spawned process, as much of one as this app uses */
export interface ContainerProcess {
  exit: Promise<number>;
  output(): ReadableStream<string>;
  kill(): void;
}

/**
 * The runtime surface this app depends on. The SDK's class satisfies it.
 *
 * `fs` is optional and used where the app must change the filesystem rather than
 * replace it: a later revision writes into the mounted tree, and a file that
 * revision deletes has to be REMOVED from it. A runtime without `fs` still runs
 * commands; it simply cannot be told to delete, and that is reported rather than
 * discovered later as a passing run against a tree nobody wrote.
 */
export interface ContainerRuntime {
  mount(tree: FileSystemTree, options?: { mountPoint?: string }): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
  fs?: {
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  };
  spawn(command: string, args?: string[], options?: { env?: Record<string, string> }): Promise<ContainerProcess>;
  on(event: "server-ready", listener: (port: number, url: string) => void): () => void;
  on(event: "preview-message", listener: (message: PreviewMessage) => void): () => void;
  on(event: "error", listener: (error: { message: string }) => void): () => void;
  teardown(): Promise<void>;
}

/** Events the app subscribes to. Fan-out lives here, so listeners are attached once */
export type WorkspaceEvent =
  | { type: "server-ready"; port: number; url: string }
  | { type: "preview-message"; message: PreviewMessage }
  | { type: "runtime-error"; message: string };

export type ContainerState = "idle" | "unsupported" | "booting" | "ready" | "failed" | "stopped";

export interface ContainerStatus {
  state: ContainerState;
  /** Why it is not usable, when it is not — a sentence, not a code */
  reason: string | null;
  /** Where the dev server answered, once the harness started one */
  previewUrl: string | null;
  /** Node version the runtime reported, once asked */
  nodeVersion: string | null;
  /** Files in the mounted tree, and the revision it describes */
  mountedFiles: number;
  mountedRevision: number | null;
}

const IDLE: ContainerStatus = {
  state: "idle",
  reason: null,
  previewUrl: null,
  nodeVersion: null,
  mountedFiles: 0,
  mountedRevision: null,
};

let status: ContainerStatus = IDLE;
let runtime: ContainerRuntime | null = null;
let booting: Promise<ContainerRuntime | null> | null = null;

const listeners = new Set<() => void>();
const eventListeners = new Set<(event: WorkspaceEvent) => void>();
let revision = 0;

/**
 * The paths this module has put in the container's filesystem.
 *
 * Tracked so a later revision can be applied as a DELTA: the files it changed are
 * written, and the files it deleted are removed. Without this list the only way to
 * apply a revision is to mount the whole tree again, and a mount adds — so a
 * deleted file would survive in the workspace and a command could pass against a
 * tree that is not the revision it claims to be about.
 */
let mountedPaths: string[] = [];

/** The paths the mounted tree holds, in path order */
export function workspacePaths(): readonly string[] {
  return mountedPaths;
}

export function subscribeContainer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic revision of the status object, for `useSyncExternalStore` */
export function containerRevision(): number {
  return revision;
}

export function containerStatus(): ContainerStatus {
  return status;
}

export function subscribeWorkspaceEvents(listener: (event: WorkspaceEvent) => void): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

function setStatus(next: Partial<ContainerStatus>): void {
  status = { ...status, ...next };
  revision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One bad subscriber must not stop the others from learning the truth.
    }
  }
}

function emit(event: WorkspaceEvent): void {
  for (const listener of eventListeners) {
    try {
      listener(event);
    } catch {
      // Same rule as above: a UI subscriber is not allowed to break the runtime.
    }
  }
}

/** Test seam: load a fake instead of the SDK */
type ModuleLoader = () => Promise<typeof import("@webcontainer/api")>;
let loadModule: ModuleLoader = () => import("@webcontainer/api");

export function setContainerModuleLoader(loader: ModuleLoader): void {
  loadModule = loader;
  booting = null;
  runtime = null;
}

/** Test seam: forget everything, including the status and the mounted paths */
export function resetContainerHost(): void {
  runtime = null;
  booting = null;
  status = IDLE;
  mountedPaths = [];
  revision += 1;
}

/** Whether this page can host a workspace at all, and why not when it cannot */
export function containerSupport(): ReturnType<typeof workspaceVerdict> {
  return workspaceVerdict(readWorkspaceEnvironment());
}

/**
 * The COEP value to boot with.
 *
 * The SDK requires it to MATCH the response header, and warns that a later boot
 * cannot change it. Read from the document when the browser exposes it, so the
 * value reflects reality rather than this app's intention.
 */
export function coepForEnvironment(env = readWorkspaceEnvironment()): "require-corp" | "credentialless" {
  return env.coep === "require-corp" ? "require-corp" : "credentialless";
}

/**
 * Boots the workspace, at most once per page.
 *
 * Failures are recorded as status rather than thrown at every call site: the
 * interesting failure is "this page is not isolated", which is a fact about the
 * deployment, and it should be reported once with its fix rather than re-derived
 * by each tool that asks.
 */
export async function ensureContainer(): Promise<ContainerRuntime | null> {
  if (runtime) return runtime;
  if (booting) return booting;

  const verdict = containerSupport();
  if (!verdict.supported) {
    setStatus({ state: "unsupported", reason: verdict.summary });
    return null;
  }

  setStatus({ state: "booting", reason: null });
  booting = (async () => {
    try {
      const { WebContainer } = await loadModule();
      const instance = await WebContainer.boot({
        coep: coepForEnvironment(),
        // Load-bearing opt-in: without it the runtime forwards NOTHING from
        // inside the preview, and the console errors that are this tier's only
        // evidence about the running app never arrive. The failure is silent in
        // both directions — the preview looks healthy and the note is empty —
        // which is why it is stated here rather than left to a default.
        forwardPreviewErrors: true,
      });
      runtime = instance as unknown as ContainerRuntime;
      instance.on("server-ready", (port, url) => {
        setStatus({ previewUrl: url });
        emit({ type: "server-ready", port, url });
      });
      instance.on("preview-message", (message) => {
        emit({ type: "preview-message", message });
      });
      instance.on("error", (error) => {
        emit({ type: "runtime-error", message: error?.message ?? "the workspace reported an error" });
      });
      setStatus({ state: "ready", reason: null });
      // Learned by doing, and the most reliable evidence there is that this page
      // can host a workspace. Everything downstream (the turn note, the tier
      // plan, the router in `run_command`) reads it from here rather than
      // re-deriving it from headers.
      noteWorkspaceOutcome("up", null);
      return runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = `The workspace runtime would not start: ${message}`;
      setStatus({ state: "failed", reason });
      noteWorkspaceOutcome("down", reason);
      return null;
    } finally {
      booting = null;
    }
  })();
  return booting;
}

/**
 * Starts the boot without waiting for it.
 *
 * Called when a turn begins, so the several seconds of boot happen while the user
 * reads an answer or types the next message instead of after they press Run. The
 * promise is deliberately dropped: `ensureContainer` re-surfaces the outcome, and
 * an unhandled rejection here would be a crash caused by eagerness.
 */
export function primeContainer(): void {
  void ensureContainer().catch(() => {
    // Recorded as status by ensureContainer; nothing to add.
  });
}

/** The mounted tree and the revision it describes */
export async function mountWorkspace(tree: FileSystemTree, revision: number): Promise<{ ok: true; files: number } | { ok: false; error: string }> {
  const instance = await ensureContainer();
  if (!instance) return { ok: false, error: status.reason ?? "no workspace runtime is available" };
  try {
    await instance.mount(tree);
    mountedPaths = flattenTree(tree).map((file) => file.path);
    setStatus({ mountedFiles: mountedPaths.length, mountedRevision: revision });
    return { ok: true, files: mountedPaths.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Writes the workspace's current files into the mounted tree.
 *
 * This is the file-write bridge: the same call refreshes the tree before a
 * command AND feeds the dev server's hot reload, which is why the preview shows
 * the work in progress rather than a snapshot taken once.
 */
export async function writeWorkspaceFiles(
  files: readonly { path: string; content: string }[]
): Promise<{ ok: true; written: number } | { ok: false; error: string }> {
  const instance = await ensureContainer();
  if (!instance) return { ok: false, error: status.reason ?? "no workspace runtime is available" };
  const known = new Set(mountedPaths);
  let written = 0;
  try {
    for (const file of files) {
      const path = relative(file.path);
      // A revision can add a file in a directory the mounted tree never had, and
      // `writeFile` does not promise to create one. `mkdir` is idempotent, so this
      // costs a call and removes a whole class of "no such directory" failures.
      const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (directory && instance.fs) await instance.fs.mkdir(directory, { recursive: true });
      await instance.writeFile(path, file.content);
      written += 1;
      known.add(file.path);
    }
    mountedPaths = [...known].sort((a, b) => a.localeCompare(b));
    setStatus({ mountedFiles: mountedPaths.length });
    return { ok: true, written };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Removes paths from the mounted tree — the other half of applying a revision.
 *
 * Best-effort and never throwing: a removal that fails leaves a file that this
 * revision does not contain, and the caller turns that into a stated note. Silence
 * here would be the one thing worse than a stale file — a stale file nobody was
 * told about, under a claim that the tree is the revision.
 */
export async function removeWorkspaceFiles(
  paths: readonly string[]
): Promise<{ removed: string[]; failed: { path: string; error: string }[] }> {
  const instance = await ensureContainer();
  if (!instance) {
    const error = status.reason ?? "no workspace runtime is available";
    return { removed: [], failed: paths.map((path) => ({ path, error })) };
  }
  const fs = instance.fs;
  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const path of paths) {
    if (!fs) {
      failed.push({ path, error: "this runtime exposes no remove operation" });
      continue;
    }
    try {
      await fs.rm(relative(path), { recursive: true, force: true });
      removed.push(path);
    } catch (error) {
      failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (removed.length > 0) {
    const gone = new Set(removed);
    mountedPaths = mountedPaths.filter((path) => !gone.has(path));
    setStatus({ mountedFiles: mountedPaths.length });
  }
  return { removed, failed };
}

/** The revision the mounted tree currently describes, after a delta write */
export function noteMountedRevision(revisionNumber: number): void {
  setStatus({ mountedRevision: revisionNumber, mountedFiles: mountedPaths.length });
}

/** Paths are workdir-relative; a leading slash is not a path, it is a habit */
function relative(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

/** Records the Node version the runtime answered with, for the status line */
export function noteNodeVersion(version: string): void {
  setStatus({ nodeVersion: version });
}

export function notePreviewUrl(url: string | null): void {
  setStatus({ previewUrl: url });
}

/** Stops the workspace and everything running in it. Never throws. */
export async function stopContainer(reason: string): Promise<void> {
  const instance = runtime;
  runtime = null;
  booting = null;
  // The filesystem goes with the runtime: keeping this list would have the next
  // mount think it is refreshing a tree that no longer exists.
  mountedPaths = [];
  setStatus({ state: instance ? "stopped" : status.state, reason, previewUrl: null, mountedFiles: 0, mountedRevision: null });
  if (!instance) return;
  try {
    await instance.teardown();
  } catch {
    // A runtime that will not tear down is still released from this module's
    // point of view; reporting the failure cannot make it stop, and the next
    // boot would fail either way.
  }
}

/** Test seam: hand the host a fake runtime */
export function adoptRuntimeForTest(fake: ContainerRuntime | null): void {
  runtime = fake;
}

/**
 * A mounted tree describes ONE repository at ONE commit.
 *
 * Every reason below is the same reason: a workspace left mounted after the code
 * underneath changed produces evidence about the wrong revision, and the ledger
 * would record it as fresh for a change it never saw. That is worse than losing an
 * install, which is why this releases rather than repairs.
 */
registerScopedResource({
  name: "container.runtime",
  scope: "binding",
  release: ({ transition }) => {
    if (transition.type === "thread.created") return;
    return stopContainer(
      transition.type === "base.moved"
        ? "the base revision moved, so the workspace was released rather than left describing the previous commit"
        : "the thread's repository changed, so the workspace was released"
    );
  },
});
