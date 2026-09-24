// ============================================================
// Container Executor — One Command At A Time, In The Workspace
// ============================================================
// Four properties this module exists to guarantee, each because the alternative
// is a lie rather than an error:
//
//   1. SERIAL. The container has one filesystem and one terminal. Two commands
//      interleaved in it produce output nobody can attribute and a state nobody
//      can reason about, so every run queues behind the last one.
//
//   2. KILLABLE. Stop must reach the process, not just the turn: `npm test` can
//      legitimately run for minutes, and a Stop that returns while the tab is
//      still compiling is the user watching work they cancelled.
//
//   3. HONEST ABOUT ITS OUTPUT. WebContainer merges stdout and stderr into one
//      terminal stream ("including the stdout and stderr emitted by the spawned
//      process and its descendants" — the SDK's own words). Pretending otherwise
//      would mean inventing a stderr field, so the outcome says where the text
//      came from and `stderr` stays empty on purpose. Truncation is reported in
//      the outcome AND in the notes: a pass read out of elided output is the
//      failure this whole feature is built to avoid.
//
//   4. INSTALLED BEFORE IT JUDGES ANYTHING. A fresh tree has no `node_modules`,
//      so `npm test` would fail with "vitest: command not found" — a red result
//      about the workspace, offered to a model that will read it as a red result
//      about the code. Dependencies are the HARNESS's job (bolt.new's prompt
//      says the same thing at length: never make the model manage the dev
//      server), so the install runs here, once per revision, and every result
//      says whether it happened.
// ============================================================

import type { FileSystemTree } from "@webcontainer/api";
import { noteWorkspaceOutcome } from "../lib/availability";
import { STOPPED_BY_USER } from "../companion/companion-client";
import {
  claimWorkspace,
  containerStatus,
  ensureContainer,
  mountWorkspace,
  noteMountedRevision,
  noteNodeVersion,
  removeWorkspaceFiles,
  workspacePaths,
  writeWorkspaceFiles,
  type ContainerRuntime,
  type WorkspaceOwner,
} from "./container-host";
import { flattenTree, type MountPlan } from "./mount-plan";
import {
  CONTAINER_DEFAULT_TIMEOUT_MS,
  CONTAINER_MAX_OUTPUT_CHARS,
  CONTAINER_MAX_TIMEOUT_MS,
  capOutput,
  planInstall,
} from "./run-plan";

/** What the runtime calls this workspace's root, for a result's `cwd` field */
export const CONTAINER_CWD = "the workspace root inside the browser";

/**
 * The shell a command line is handed to.
 *
 * The runtime's own shell — the SDK spawns executables, not command lines, so
 * shell syntax (`&&`, pipes, quotes) only works because the line goes through
 * `jsh -c`, exactly as it would through `sh -c` on a machine.
 */
export const CONTAINER_SHELL = "jsh";

/**
 * Environment every command runs with.
 *
 * Non-interactive by construction: a container has no one to answer a prompt, and
 * a command that waits is a command that burns the tab's budget until its timeout.
 * Colours are off so output is comparable and small.
 */
export const CONTAINER_ENV: Record<string, string> = {
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  TERM: "dumb",
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_yes: "true",
};

export interface ContainerExecOutcome {
  exitCode: number | null;
  signal: string | null;
  /** The merged terminal output the runtime produced */
  stdout: string;
  /**
   * Always empty: the runtime merges stderr into `stdout` above. Present because
   * every consumer of an outcome already understands this shape.
   */
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  command: string;
  cwd: string;
  notes: string[];
}

export type ContainerExecResult =
  | { ok: true; outcome: ContainerExecOutcome }
  | { ok: false; error: string };

/** One command at a time. Rejections do not break the chain */
let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  tail = run.catch(() => undefined);
  return run;
}

/**
 * Runs a task inside the workspace's single-threaded section.
 *
 * Exported for the preview bridge, which has one phase that must NOT overlap a
 * command — mounting the tree and installing its dependencies — and one phase
 * that must not hold the lock at all, because a dev server is supposed to keep
 * running. Two separate lock scopes rather than a second implementation: the
 * container has one filesystem, and "prepare then run" has to be ordered the same
 * way whether a person or the agent asked for it.
 */
export function serializeWorkspaceWork<T>(task: () => Promise<T>): Promise<T> {
  return enqueue(task);
}

/**
 * The revision whose dependencies are installed in the mounted tree.
 *
 * Module state rather than host status because it is the executor's own fact,
 * and because the mounted tree can only be replaced through this module. A
 * revision that moved invalidates it: the lockfile may have changed, and
 * "installed" is only ever a claim about one commit.
 */
let installedRevision: number | null = null;

/** Test seam: forget the queue and the install (a suite must not inherit either) */
export function resetContainerQueue(): void {
  tail = Promise.resolve();
  installedRevision = null;
}

/**
 * The contents of one file in a tree, or null when it is absent or binary.
 *
 * Reads the tree the caller already built rather than mounting and re-reading:
 * the question ("which install command does this revision imply?") is answerable
 * from the plan, and asking the runtime would mean a boot for a decision.
 */
export function fileInTree(tree: FileSystemTree, path: string): string | null {
  return flattenTree(tree).find((file) => file.path === path)?.content ?? null;
}

interface ExecOutcome {
  exitCode: number | null;
  text: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  droppedChars: number;
  /** Why the output stream could not be read, when it could not */
  unreadable: string | null;
}

/**
 * Runs one command line and collects its output, capped as it arrives.
 *
 * Output is drained in parallel with the exit code on purpose: a runaway build
 * can produce megabytes, and holding them all in order to throw most of them away
 * is how a tab runs out of memory while reporting a failure.
 */
async function execOnce(
  instance: ContainerRuntime,
  command: string,
  options: { timeoutMs: number; maxChars: number; signal?: AbortSignal }
): Promise<{ ok: true; outcome: ExecOutcome } | { ok: false; error: string }> {
  const started = Date.now();
  let process: Awaited<ReturnType<ContainerRuntime["spawn"]>>;
  try {
    process = await instance.spawn(CONTAINER_SHELL, ["-c", command], { env: { ...CONTAINER_ENV } });
  } catch (error) {
    return {
      ok: false,
      error: `the workspace could not start the command: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let output = "";
  let dropped = 0;
  /**
   * Set when the output could not be read at all, and reported rather than
   * swallowed.
   *
   * The swallow that used to be here ("a stream that ends badly still leaves us
   * the exit code") hid the fact that `output` is a stream PROPERTY in this SDK
   * version while this module called it as a method: every command threw into this
   * catch and came back as `exit 0` with empty output — a green result nobody could
   * read, produced by the one module whose job is to make green results trustworthy.
   */
  let unreadable: string | null = null;
  const hardStop = options.maxChars * 2;
  const pump = (async () => {
    const reader = process.output.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (typeof value !== "string") continue;
      if (output.length >= hardStop) {
        dropped += value.length;
        continue;
      }
      const room = hardStop - output.length;
      if (value.length <= room) {
        output += value;
      } else {
        output += value.slice(0, room);
        dropped += value.length - room;
      }
    }
  })().catch((error: unknown) => {
    unreadable = error instanceof Error ? error.message : String(error);
  });

  let timedOut = false;
  let aborted = false;
  const kill = (reason: "timeout" | "abort") => {
    if (reason === "timeout") timedOut = true;
    else aborted = true;
    try {
      process.kill();
    } catch {
      // Already gone; the exit code is on its way.
    }
  };
  const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
  const onAbort = () => kill("abort");
  options.signal?.addEventListener("abort", onAbort);

  let exitCode: number | null;
  try {
    exitCode = await process.exit;
  } catch {
    // A process the runtime killed (our timeout, or the user's Stop) can settle
    // without a code. Null is the honest value: it did not report one.
    exitCode = null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    await pump;
  }

  return {
    ok: true,
    outcome: {
      exitCode,
      text: output,
      truncated: dropped > 0,
      timedOut,
      aborted,
      durationMs: Date.now() - started,
      droppedChars: dropped,
      unreadable,
    },
  };
}

/**
 * Makes the workspace's files the container's files, and reports how it did it.
 *
 * Two paths, deliberately different: the FIRST mount hands over a tree in one
 * operation (cheap, and it is what a fresh filesystem wants), while every later
 * revision is applied as a DELTA — the files it contains are written into the
 * mounted tree and the files it deleted are removed from it. Both halves matter:
 * the writes are what the dev server's hot reload sees (so the preview follows
 * the agent instead of blanking on every revision), and the removals are what
 * stop a deleted file from surviving in a workspace whose whole purpose is to
 * produce evidence about THIS revision. `mount()` adds; it does not delete.
 *
 * A removal the runtime refuses is REPORTED, not swallowed: a tree that still
 * holds a file this revision deleted is evidence about the wrong code, and the
 * only alternative to saying so is a green result nobody can trust.
 *
 * `owner` is the thread this tree belongs to, and passing it is what makes the
 * mount honest once two threads can run at once: the claim empties the filesystem
 * when it belonged to somebody else, so the delta below is always applied to a
 * tree that is this thread's own. See `claimWorkspace`.
 */
export async function prepareWorkspace(
  plan: MountPlan,
  revision: number,
  owner?: WorkspaceOwner
): Promise<{ ok: true; mode: "mounted" | "refreshed"; files: number; notes: string[] } | { ok: false; error: string }> {
  if (plan.empty) return { ok: false, error: "the workspace holds no files for this revision" };

  let handoff: string[] = [];
  if (owner) {
    const claim = await claimWorkspace(owner);
    if (!claim.ok) return { ok: false, error: claim.error };
    handoff = claim.notes;
  }

  const current = containerStatus();
  const neverMounted = current.mountedRevision === null;

  if (neverMounted) {
    const mounted = await mountWorkspace(plan.tree, revision);
    if (!mounted.ok) return { ok: false, error: mounted.error };
    // A new tree is a new filesystem as far as installs are concerned.
    installedRevision = null;
    await primeNodeVersion();
    return { ok: true, mode: "mounted", files: mounted.files, notes: handoff };
  }

  const files = flattenTree(plan.tree);
  const written = await writeWorkspaceFiles(files);
  if (!written.ok) return { ok: false, error: written.error };
  noteMountedRevision(revision);

  const notes: string[] = [...handoff];
  const present = new Set(files.map((file) => file.path));
  const stale = workspacePaths().filter((path) => !present.has(path));
  if (stale.length > 0) {
    const removal = await removeWorkspaceFiles(stale);
    if (removal.removed.length > 0) {
      notes.push(
        `${removal.removed.length} file(s) this revision deletes were removed from the workspace (${removal.removed
          .slice(0, 4)
          .join(", ")}${removal.removed.length > 4 ? ", …" : ""}).`
      );
    }
    if (removal.failed.length > 0) {
      notes.push(
        `${removal.failed.length} file(s) this revision deletes are STILL IN the workspace because the runtime would not remove them (${removal.failed
          .slice(0, 4)
          .map((entry) => `${entry.path}: ${entry.error}`)
          .join("; ")}${removal.failed.length > 4 ? "; …" : ""}). Treat a pass that depends on one of them as unproven.`
      );
    }
  }
  return { ok: true, mode: "refreshed", files: written.written, notes };
}

/** Asks the runtime for its Node version once, for the status line */
async function primeNodeVersion(): Promise<void> {
  if (containerStatus().nodeVersion) return;
  const instance = await ensureContainer();
  if (!instance) return;
  try {
    const probe = await instance.spawn("node", ["--version"]);
    await exitCodeOf(probe);
    const reader = probe.output.getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (typeof value === "string") text += value;
    }
    const version = text.trim().split("\n").pop()?.trim();
    if (version) noteNodeVersion(version);
  } catch {
    // A version we could not read is not a failure of the workspace; the status
    // line simply keeps saying "unknown".
  }
}

async function exitCodeOf(process: Awaited<ReturnType<ContainerRuntime["spawn"]>>): Promise<number | null> {
  try {
    return await process.exit;
  } catch {
    return null;
  }
}

/**
 * Installs the revision's dependencies, once, before anything is asked to run.
 *
 * Returns the command it ran so the caller can say so in the result: a green
 * `npm test` in a tree whose `node_modules` came from a torn-down install is
 * evidence of nothing, and a reader who is not told the install happened cannot
 * tell that case from the normal one.
 *
 * A failing install is NOT a failed command: it stops the run before it starts,
 * with the install's own output, because a test suite that could not be installed
 * never ran and reporting it as a failing suite is the single most expensive
 * mistake this tier could make.
 */
export async function ensureDependencies(
  plan: MountPlan,
  revision: number,
  signal?: AbortSignal
): Promise<{ ok: true; installed: string | null; notes: string[] } | { ok: false; error: string }> {
  if (installedRevision === revision) return { ok: true, installed: null, notes: [] };
  const instance = await ensureContainer();
  if (!instance) return { ok: false, error: containerStatus().reason ?? "no browser workspace is available on this page" };

  const packageJson = fileInTree(plan.tree, "package.json");
  const lockfiles = plan.files
    .map((file) => file.path)
    .filter((path) => !path.includes("/") && /lock|lockb|lock\.ya?ml/.test(path));
  const { step, note } = planInstall({
    packageManager: packageManagerOf(packageJson),
    lockfiles,
    hasPackageJson: Boolean(packageJson && packageJson.trim()),
  });
  const notes: string[] = [];
  if (note) notes.push(note);
  if (!step) {
    // Nothing to install is a finished install.
    installedRevision = revision;
    return { ok: true, installed: null, notes };
  }

  const result = await execOnce(instance, step.command, {
    // The install gets the workspace's full ceiling: a cold `npm ci` on a real
    // project is the slowest thing this tier does, and killing it early would
    // report a timeout as if the code were at fault.
    timeoutMs: CONTAINER_MAX_TIMEOUT_MS,
    maxChars: CONTAINER_MAX_OUTPUT_CHARS,
    ...(signal ? { signal } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error };
  if (result.outcome.aborted) return { ok: false, error: STOPPED_BY_USER };
  if (result.outcome.exitCode !== 0) {
    const tail = result.outcome.text.trim().split("\n").slice(-6).join("\n");
    return {
      ok: false,
      error:
        `dependencies could not be installed in the browser workspace (\`${step.command}\` ` +
        `${result.outcome.timedOut ? "was killed after its timeout" : `exited ${result.outcome.exitCode}`}). ` +
        `The command was NOT run, so it proves nothing either way.${tail ? `\n${tail}` : ""}`,
    };
  }
  installedRevision = revision;
  notes.push(
    `\`${step.command}\` ran in the browser workspace first, so ${step.proves}.`
  );
  return { ok: true, installed: step.command, notes };
}

/** The manager a package.json declares, or null when it does not say */
function packageManagerOf(packageJson: string | null): string | null {
  if (!packageJson) return null;
  try {
    const parsed = JSON.parse(packageJson) as { packageManager?: unknown };
    return typeof parsed.packageManager === "string" ? parsed.packageManager : null;
  } catch {
    return null;
  }
}

/**
 * Runs one command line in the workspace.
 *
 * `ok: false` is reserved for "the command did not run" — no runtime, no mounted
 * tree, a failed install, the user's Stop. A non-zero exit is `ok: true` carrying a
 * failing outcome, because that failing exit code IS the result the agent asked
 * for.
 */
export async function runInContainer(request: {
  command: string;
  plan: MountPlan;
  revision: number;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Install the revision's dependencies first (the default for a test run) */
  install?: boolean;
  signal?: AbortSignal;
  /**
   * The thread this command is being run for.
   *
   * Optional only because the local/companion tiers and the tests do not mount
   * anything; every caller that mounts a tree on this page passes it, because the
   * claim it drives is what keeps one thread's files out of another thread's
   * evidence.
   */
  owner?: WorkspaceOwner;
}): Promise<ContainerExecResult> {
  if (request.signal?.aborted) return { ok: false, error: STOPPED_BY_USER };

  return enqueue(async () => {
    if (request.signal?.aborted) return { ok: false, error: STOPPED_BY_USER };

    const instance = await ensureContainer();
    if (!instance) {
      return { ok: false, error: containerStatus().reason ?? "no browser workspace is available on this page" };
    }

    const prepared = await prepareWorkspace(request.plan, request.revision, request.owner);
    if (!prepared.ok) return { ok: false, error: prepared.error };
    const notes: string[] = [...prepared.notes];
    if (prepared.mode === "mounted") {
      notes.push(`The workspace was mounted for this revision (${prepared.files} files).`);
    }

    if (request.install !== false) {
      const installed = await ensureDependencies(request.plan, request.revision, request.signal);
      if (!installed.ok) return { ok: false, error: installed.error };
      notes.push(...installed.notes);
    }

    const timeoutMs = Math.min(request.timeoutMs ?? CONTAINER_DEFAULT_TIMEOUT_MS, CONTAINER_MAX_TIMEOUT_MS);
    const maxChars = request.maxOutputChars ?? CONTAINER_MAX_OUTPUT_CHARS;
    const result = await execOnce(instance, request.command, {
      timeoutMs,
      maxChars,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!result.ok) return { ok: false, error: result.error };

    const { outcome } = result;
    if (outcome.aborted) return { ok: false, error: STOPPED_BY_USER };
    if (outcome.unreadable) {
      // A stream this module cannot read means the exit code is the ONLY evidence
      // there is, and an unreported empty result is a green light with nothing
      // behind it.
      return {
        ok: false,
        error: `the command ran, but its output could not be read from the workspace (${outcome.unreadable}), so a zero exit code here proves only that the process ended. Do not treat this as a passing run.`,
      };
    }

    const capped = capOutput(outcome.text, maxChars);
    const truncated = capped.truncated || outcome.truncated;
    if (capped.note) notes.push(capped.note);
    if (outcome.truncated && !capped.truncated) {
      notes.push(`Output was elided as it arrived: ${outcome.droppedChars} characters are not shown.`);
    }
    if (outcome.timedOut) {
      notes.push(
        `The command was killed after ${Math.round(timeoutMs / 1000)}s. A timeout is not a failing test — report it as "it did not finish in the workspace" and say what that leaves unproven.`
      );
    }
    notes.push(
      "stdout and stderr are merged in this workspace: the runtime streams one terminal, so read the output as one log."
    );
    // Recorded here rather than by each caller: a runtime that answered a command
    // is the evidence that this page can run one, and a boot that happened two
    // tool calls ago is not a fact anybody remembers to pass along.
    noteWorkspaceOutcome("up", null);

    return {
      ok: true,
      outcome: {
        exitCode: outcome.exitCode,
        signal: null,
        stdout: capped.text,
        stderr: "",
        timedOut: outcome.timedOut,
        truncated,
        durationMs: outcome.durationMs,
        command: request.command,
        cwd: CONTAINER_CWD,
        notes,
      },
    };
  });
}

/** Exposed for the preview bridge: the tree's files, as path/content pairs */
export function filesOf(tree: FileSystemTree): { path: string; content: string }[] {
  return flattenTree(tree);
}
