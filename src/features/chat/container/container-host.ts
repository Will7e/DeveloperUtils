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
import { RUNTIME_ORIGIN, declaredCoep } from "./isolation";
import { flattenTree } from "./mount-plan";

/** The SDK's module, and the instance its `boot` resolves with, for the seam below */
type WebContainerApi = typeof import("@webcontainer/api");
type BootedInstance = Awaited<ReturnType<WebContainerApi["WebContainer"]["boot"]>>;

/**
 * A spawned process, as much of one as this app uses.
 *
 * `output` is a STREAM PROPERTY (`process.output`), not the method older versions
 * of the SDK exposed (`process.output()`). Declaring it as a method was another
 * assumption the fakes agreed with and the runtime did not: every call threw
 * "process.output is not a function" into the pump's own `catch`, so every command
 * reported `exit 0` with empty output — a silent success, which is the one outcome
 * this tier exists to make impossible.
 */
export interface ContainerProcess {
  exit: Promise<number>;
  output: ReadableStream<string>;
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
  /**
   * The filesystem lives under `fs`, NOT on the instance.
   *
   * This is the shape the SDK actually has (`WebContainer.fs` is a
   * `fs.promises`-alike), and getting it wrong is invisible to every unit test
   * that fakes the runtime: a fake implements whatever interface it is handed. It
   * was wrong — `writeFile` declared on the instance — so the FIRST mount worked
   * and every later revision failed with "instance.writeFile is not a function",
   * which is a `run_command` that cannot run anything after its first call.
   */
  fs?: {
    /** `data` takes bytes too — the SDK writes a `Uint8Array` as a binary file */
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    /** Optional so "this runtime cannot delete" stays an expressible, tested state */
    rm?(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    /**
     * Optional, and the only way to ask what a file in the workspace CONTAINS.
     *
     * Every other question about the tree is answered from the plan, and the plan
     * is a statement of intent: it says which files the revision has, not which
     * bytes arrived. The two can disagree — a mount that skipped a path, a copy
     * that is empty where the plan has 275 KiB — and the only evidence about the
     * workspace itself is the workspace. The install checks the lockfile it is
     * about to depend on through here, because `npm ci` failing to find a
     * lockfile says "you have no lockfile", not "your mount lost it".
     */
    readFile?(path: string, encoding: "utf-8"): Promise<string>;
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
  | { type: "runtime-error"; message: string }
  /** Another thread took the one filesystem; whoever held it has lost it */
  | { type: "workspace-released"; threadId: string; label: string; reason: string };

/**
 * The thread that a workspace operation belongs to.
 *
 * `threadId` is the conversation id — one thread per conversation, forever — so
 * the identity here is the same one the binding layer, the claim registry and the
 * per-conversation turn actors use. A label rides along purely to be READ: the
 * interesting moment is a takeover, and "the shared workspace now holds THIS
 * thread's revision instead of the one titled …" is the sentence a person and a
 * model both need.
 */
export interface WorkspaceOwner {
  threadId: string;
  /** Short human label, for the sentence that reports a handoff */
  label: string;
}

/** Who the one filesystem currently describes, and since when */
export interface WorkspaceHolder extends WorkspaceOwner {
  since: number;
}

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

/**
 * The live runtime, held on the PAGE rather than in this module's variables.
 *
 * The SDK allows exactly one instance per page and has no accessor for it, so a
 * module that forgets its reference is worse than useless — every later `boot()`
 * fails with "Only a single WebContainer instance can be booted" and the tier is
 * dead until the page is reloaded.
 *
 * That is not hypothetical: in development every hot update re-evaluates this
 * module and clears module state while the SDK's instance keeps running, so the
 * FIRST successful boot made every subsequent one fail — which reads as "the agent
 * cannot run anything" with no error the user can act on. Any re-evaluation now
 * re-adopts the instance that is already alive.
 */
const RUNTIME_SLOT = "__intabWorkspaceRuntime__";

let status: ContainerStatus = IDLE;
let booting: Promise<ContainerRuntime | null> | null = null;

function adoptedRuntime(): ContainerRuntime | null {
  const held = (globalThis as Record<string, unknown>)[RUNTIME_SLOT];
  return (held as ContainerRuntime | undefined) ?? null;
}

function rememberRuntime(instance: ContainerRuntime | null): void {
  (globalThis as Record<string, unknown>)[RUNTIME_SLOT] = instance ?? undefined;
}

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

/**
 * The thread the mounted tree belongs to.
 *
 * A page has ONE filesystem, and a filesystem describes ONE revision. Two agents
 * running at once is therefore not a scheduling problem but an ownership one: the
 * moment a second thread's tree is written into the container, every file the
 * first thread never had is still in it, and a passing command becomes evidence
 * about a repository state that exists nowhere. So the mount carries its owner,
 * and a change of owner is a change of filesystem — emptied first, or refused.
 */
let holder: WorkspaceHolder | null = null;

/** The paths the mounted tree holds, in path order */
export function workspacePaths(): readonly string[] {
  return mountedPaths;
}

/** Who the mounted tree belongs to, or null before anything was mounted */
export function workspaceHolder(): WorkspaceHolder | null {
  return holder;
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
  rememberRuntime(null);
}

/** Test seam: forget everything, including the status, the paths and the owner */
export function resetContainerHost(): void {
  rememberRuntime(null);
  booting = null;
  status = IDLE;
  mountedPaths = [];
  holder = null;
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
  if (env.coep === "require-corp" || env.coep === "credentialless") return env.coep;
  return declaredCoep();
}

/**
 * How long a boot may take before it is reported as a failure.
 *
 * The runtime is a download, so this is generous — and it exists because the
 * failure that actually happened does not reject: when the runtime iframe is
 * blocked by a Content-Security-Policy, `boot()` hangs forever. A turn whose
 * `run_command` never returns is the worst shape of bug this tier can have, so a
 * silent hang is converted into a stated reason naming the two causes.
 */
export const CONTAINER_BOOT_TIMEOUT_MS = 90_000;

/**
 * Boots the workspace, at most once per page.
 *
 * Failures are recorded as status rather than thrown at every call site: the
 * interesting failure is "this page is not isolated", which is a fact about the
 * deployment, and it should be reported once with its fix rather than re-derived
 * by each tool that asks.
 */
export async function ensureContainer(): Promise<ContainerRuntime | null> {
  const existing = adoptedRuntime();
  if (existing) return existing;
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
      const boot = WebContainer.boot({
        coep: coepForEnvironment(),
        // Load-bearing opt-in: without it the runtime forwards NOTHING from
        // inside the preview, and the console errors that are this tier's only
        // evidence about the running app never arrive. The failure is silent in
        // both directions — the preview looks healthy and the note is empty —
        // which is why it is stated here rather than left to a default.
        forwardPreviewErrors: true,
      });
      const instance = await bootWithin(boot, CONTAINER_BOOT_TIMEOUT_MS);
      rememberRuntime(instance as unknown as ContainerRuntime);
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
      return adoptedRuntime();
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

/**
 * Takes the workspace for one thread, emptying it when it belonged to another.
 *
 * Three outcomes, and the difference between them is the whole point:
 *
 *   • THE SAME THREAD ASKS AGAIN. Nothing to do: this is the common case, and a
 *     revision delta is applied to a tree that is already this thread's.
 *
 *   • ANOTHER THREAD HELD IT. The previous thread's files are REMOVED before the
 *     new owner is recorded, because `mount()` adds and never deletes — a stale
 *     file from the other thread is exactly the evidence mismatch this module
 *     exists to prevent. The removal is reported to the loser through
 *     `workspace-released`, so a preview serving those files stops instead of
 *     serving a directory that no longer exists.
 *
 *   • THE FILES CANNOT BE REMOVED. A runtime with no `fs`, or a removal that
 *     failed, leaves a mixture of two trees. That is refused rather than
 *     attempted: mounting on top of it produces a green result about code that
 *     exists in no repository, and a refusal costs the caller a fallback tier
 *     that works. The refusal is a sentence, so the agent can say WHY it did not
 *     run there.
 *
 * Serialized by the caller (see `serializeWorkspaceWork`), so a claim can never
 * land in the middle of another thread's command.
 */
export async function claimWorkspace(
  owner: WorkspaceOwner
): Promise<{ ok: true; notes: string[]; takenFrom: WorkspaceOwner | null } | { ok: false; error: string }> {
  const previous = holder;
  if (!previous || previous.threadId === owner.threadId) {
    holder = { ...owner, since: previous?.since ?? Date.now() };
    return { ok: true, notes: [], takenFrom: null };
  }

  if (mountedPaths.length > 0) {
    const cleaned = await emptyMountedTree();
    if (!cleaned.ok) return { ok: false, error: cleaned.error };
  }

  holder = { ...owner, since: Date.now() };
  const reason = `the browser workspace now holds \`${owner.label}\`'s revision instead of \`${previous.label}\`'s — one page has one filesystem, so the tree was emptied before it was replaced`;
  emit({ type: "workspace-released", threadId: previous.threadId, label: previous.label, reason });
  return {
    ok: true,
    takenFrom: { threadId: previous.threadId, label: previous.label },
    notes: [
      `The browser workspace is shared by every thread on this page and it was holding \`${previous.label}\`'s files, so it was emptied and re-mounted for this revision. \`${previous.label}\` will re-mount (and re-install) the next time it runs a command here.`,
    ],
  };
}

/**
 * Removes every path this module put in the container, and forgets them.
 *
 * The mounted path list is the only record of what is in there, which is why it
 * is updated even when a write failed part-way (see `writeWorkspaceFiles`): a path
 * this module has forgotten is a path it can never remove, and the removal is what
 * stands between "this tree is the revision" and "this tree contains the
 * revision".
 */
async function emptyMountedTree(): Promise<{ ok: true } | { ok: false; error: string }> {
  const instance = adoptedRuntime();
  const fs = instance?.fs;
  // `rm` is optional in the runtime surface on purpose (a runtime that cannot
  // delete is a state this app states rather than assumes), so it is checked here
  // with everything else that has to be present before a tree can be emptied.
  if (!instance || !fs || !fs.rm) {
    return {
      ok: false,
      error: `the browser workspace still holds a different thread's files and this runtime exposes no way to remove them, so this thread's revision cannot be mounted without running commands against a mixture of two trees. Run this on the companion, or use a verification tier that does not depend on this page's workspace.`,
    };
  }
  const failed: string[] = [];
  for (const path of mountedPaths) {
    try {
      await fs.rm(relative(path), { recursive: true, force: true });
    } catch {
      failed.push(path);
    }
  }
  if (failed.length > 0) {
    return {
      ok: false,
      error: `the browser workspace could not be emptied (${failed.length} of ${mountedPaths.length} path(s) would not remove, e.g. \`${failed[0]}\`), so this thread's revision was not mounted — a command here would have run against two threads' files at once. Run this on the companion, or use a verification tier that does not depend on this page's workspace.`,
    };
  }
  mountedPaths = [];
  // A fresh filesystem as far as every later reader is concerned: the revision is
  // unknown again (`prepareWorkspace` reads that as "mount, do not delta") and the
  // install that was done for the previous tree is gone with it.
  setStatus({ mountedFiles: 0, mountedRevision: null });
  return { ok: true };
}

/**
 * A boot that reports a failure instead of hanging.
 *
 * A blocked iframe does not reject the promise `boot()` returns — it simply never
 * settles — so without a deadline the symptom is a tool call that never comes
 * back, and the cause (a CSP or an isolation header) is invisible. A late boot is
 * torn down rather than adopted: the caller already has its answer, and a second
 * live instance would block every later boot in the tab.
 */
async function bootWithin(
  boot: ReturnType<WebContainerApi["WebContainer"]["boot"]>,
  timeoutMs: number
): Promise<BootedInstance> {
  let settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `it did not answer within ${Math.round(timeoutMs / 1000)}s. The usual cause is a Content-Security-Policy that forbids the runtime frame on ${RUNTIME_ORIGIN} (frame-src/child-src), or a page that is not cross-origin isolated — the console names which if it is the first.`
        )
      );
    }, timeoutMs);
    boot.then(
      (instance) => {
        if (settled) {
          // Arrived after the deadline: nobody is waiting for it, and a leaked
          // instance blocks every later boot in this tab.
          void instance.teardown();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(instance);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
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
  files: readonly { path: string; content: string | Uint8Array }[]
): Promise<{ ok: true; written: number } | { ok: false; error: string }> {
  const instance = await ensureContainer();
  if (!instance) return { ok: false, error: status.reason ?? "no workspace runtime is available" };
  const fs = instance.fs;
  if (!fs) {
    // Said plainly rather than discovered as a per-file failure: without a
    // filesystem there is no way to apply this revision, and a run against the
    // previous one would still exit 0.
    return { ok: false, error: "this runtime exposes no filesystem, so the revision's files cannot be written into the workspace" };
  }
  const known = new Set(mountedPaths);
  let written = 0;
  try {
    for (const file of files) {
      const path = relative(file.path);
      // A revision can add a file in a directory the mounted tree never had, and
      // `writeFile` does not promise to create one. `mkdir` is idempotent, so this
      // costs a call and removes a whole class of "no such directory" failures.
      const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (directory) await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path, file.content);
      written += 1;
      known.add(file.path);
    }
    return { ok: true, written };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    // Tracked even when a write failed part-way: the files that DID land are in
    // the container, and a path this module forgets is a path it can never
    // remove — which is exactly the stale-file case the removal exists for.
    mountedPaths = [...known].sort((a, b) => a.localeCompare(b));
    setStatus({ mountedFiles: mountedPaths.length });
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
  const rm = instance.fs?.rm;
  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const path of paths) {
    if (!rm) {
      failed.push({ path, error: "this runtime exposes no remove operation" });
      continue;
    }
    try {
      await rm.call(instance.fs, relative(path), { recursive: true, force: true });
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
  const instance = adoptedRuntime();
  rememberRuntime(null);
  booting = null;
  // The filesystem goes with the runtime: keeping this list would have the next
  // mount think it is refreshing a tree that no longer exists, and keeping the
  // owner would have it believe the next thread is the same one that just left.
  mountedPaths = [];
  holder = null;
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
  rememberRuntime(fake);
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
