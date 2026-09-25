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
  planInstallWithoutLockfile,
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
 * from the plan, and asking the runtime would mean a boot for a decision. Only
 * text is returned — every caller asks about a manifest — and an asset's bytes
 * are `null` here the same way an absent file is.
 */
export function fileInTree(tree: FileSystemTree, path: string): string | null {
  const content = flattenTree(tree).find((file) => file.path === path)?.content ?? null;
  return typeof content === "string" ? content : null;
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
  const packageManager = packageManagerOf(packageJson);
  const hasPackageJson = Boolean(packageJson && packageJson.trim());
  const lockfiles = plan.files
    .map((file) => file.path)
    .filter((path) => !path.includes("/") && /lock|lockb|lock\.ya?ml/.test(path));
  const declared = planInstall({ packageManager, lockfiles, hasPackageJson });
  const notes: string[] = [];
  /** Notes that must survive a failure too: they are WHY the command changed */
  const substitutions: string[] = [];
  if (declared.note) notes.push(declared.note);
  if (!declared.step) {
    // Nothing to install is a finished install.
    installedRevision = revision;
    return { ok: true, installed: null, notes };
  }

  /** The install without its frozen guarantee, for when the lockfile cannot be read */
  const loose = () => planInstallWithoutLockfile({ packageManager, hasPackageJson }).step;
  let step = declared.step;

  /**
   * BEFORE the frozen command runs, the file it depends on is checked against the
   * WORKSPACE.
   *
   * The plan already said the lockfile is in this revision — that is why `npm ci`
   * was chosen — and the plan is a statement of intent about the tree, not about
   * the bytes that arrived. The two can disagree, and when they do the failure
   * lands here, in npm's own words: "`npm ci` can only install with an existing
   * package-lock.json", which names neither the file the workspace is missing nor
   * the mount that lost it. A user reads that as "my repository is broken".
   */
  if (declared.lockfile) {
    const secured = await secureLockfile({
      instance,
      path: declared.lockfile,
      fromPlan: fileInTree(plan.tree, declared.lockfile),
      notes,
    });
    if (!secured.usable) {
      const substitute = loose();
      if (!substitute) {
        return {
          ok: false,
          error: `this workspace cannot install dependencies: \`${declared.lockfile}\` ${secured.reason}, and the revision declares no package.json to install against.`,
        };
      }
      const why = `\`${declared.lockfile}\` ${secured.reason}, so \`${declared.step.command}\` was not run — the versions it would have installed are not the ones the lockfile pins, and reporting its failure would prove nothing about this revision. Dependencies were installed with \`${substitute.command}\` instead, so the versions in this workspace are whatever resolves today; a pass here is a pass against a tree the repository never declared.`;
      notes.push(why);
      substitutions.push(why);
      step = substitute;
    }
  }

  const run = (command: string) =>
    execOnce(instance, command, {
      // The install gets the workspace's full ceiling: a cold `npm ci` on a real
      // project is the slowest thing this tier does, and killing it early would
      // report a timeout as if the code were at fault.
      timeoutMs: CONTAINER_MAX_TIMEOUT_MS,
      maxChars: CONTAINER_MAX_OUTPUT_CHARS,
      ...(signal ? { signal } : {}),
    });

  const result = await run(step.command);
  if (!result.ok) return { ok: false, error: result.error };
  if (result.outcome.aborted) return { ok: false, error: STOPPED_BY_USER };
  let outcome = result.outcome;

  /**
   * A frozen install that fails against its own lockfile gets one more attempt
   * without it — announced, never silent.
   *
   * The pre-run check catches the lockfile the workspace cannot deliver (missing,
   * empty, truncated); this catches the rest of the family, including the one a
   * browser workspace meets constantly and a local terminal never does: the
   * OUT-OF-SYNC lockfile, where the revision's package.json and its lockfile
   * disagree. On a laptop that refusal is the correct, final answer — `npm install`
   * would rewrite the lockfile, editing the repository. Here the rewrite is
   * ISOLATED: the workspace tree is thrown away when the thread's repository
   * detaches or another thread takes the lease, and push is an explicit,
   * user-approved action, so the lockfile the install would rewrite exists in a
   * scratch copy of the revision, not in anyone's repository. Refusing forever
   * bought purity at the price of the whole tier: an app that cannot start cannot
   * be previewed, driven, or verified, no matter how correct the reasoning was.
   *
   * The policy is therefore bolt.diy's: install first with the manager's frozen
   * form when one exists, fall back to the non-frozen form on failure, and SAY SO
   * — the note names the substitution, the command that ran, and the weaker claim
   * a pass makes (`planInstallWithoutLockfile`'s `proves` line), so nothing about
   * the tree is implied that the repository declared.
   */
  if (outcome.exitCode !== 0 && declared.lockfile && LOCKFILE_RETRY.test(outcome.text)) {
    const substitute = loose();
    if (substitute) {
      const why = LOCKFILE_UNUSABLE.test(outcome.text)
        ? `\`${declared.step.command}\` could not use the workspace's \`${declared.lockfile}\` (npm reported it as missing, empty, or not a complete JSON document), so dependencies were installed with \`${substitute.command}\` instead — they resolve today rather than from the lockfile. The output that follows is that install's.`
        : `\`${declared.step.command}\` refused to run: the revision's \`package.json\` and \`${declared.lockfile}\` are out of sync, so dependencies were installed with \`${substitute.command}\` instead, which resolves and writes the tree the manifest now describes. In this workspace that rewrite stays in the sandbox — it reaches the repository only through an explicit push — but a pass here is a pass against the RESOLVED tree, not the one the lockfile pinned.`;
      notes.push(why);
      substitutions.push(why);
      const retry = await run(substitute.command);
      if (!retry.ok) return { ok: false, error: retry.error };
      if (retry.outcome.aborted) return { ok: false, error: STOPPED_BY_USER };
      step = substitute;
      outcome = retry.outcome;
    }
  }

  if (outcome.exitCode !== 0) {
    const tail = installFailureTail(outcome.text);
    return {
      ok: false,
      error:
        `dependencies could not be installed in the browser workspace (\`${step.command}\` ` +
        `${outcome.timedOut ? "was killed after its timeout" : `exited ${outcome.exitCode}`}). ` +
        `The install did not complete, so nothing ran against this revision and it proves nothing either way.${substitutions.length > 0 ? ` ${substitutions.join(" ")}` : ""}${tail ? `\n${tail}` : ""}`,
    };
  }
  installedRevision = revision;
  notes.push(
    `\`${step.command}\` ran in the browser workspace first, so ${step.proves}.`
  );
  // AFTER the revision's own install, because this is not part of it: nothing in
  // the repository changed, and the one file it adds is one the runtime cannot run
  // without.
  await installWasmBindings({ instance, run, notes });
  return { ok: true, installed: step.command, notes };
}

/**
 * A compiled dependency this runtime needs in its WebAssembly build.
 *
 * The browser workspace cannot load a native addon (`.node`), so a toolchain that
 * ships both a native binding and a WebAssembly one has to use the WebAssembly one
 * here — and npm will NOT install it: the package declares `cpu: wasm32`, which
 * does not match the platform the runtime reports, so the install skips it. That
 * skip is invisible until the toolchain runs, and then it is fatal in a way that
 * reads like a broken project rather than a missing file: Vite 8 bundles with
 * `rolldown`, whose binding loader falls back to downloading the package itself
 * and then refuses the one it downloaded (`ERR_NAPI_BINDING_TARGET_CONFLICT` — its
 * WebContainer fallback stamps the binding with the wrong target, where every
 * other path in the same loader sets it correctly). Installing the package the
 * loader looks for FIRST removes that fallback from the picture: the loader
 * resolves it, stamps it correctly, and the dev server starts.
 *
 * Verified in the runtime, not reasoned about: without it, `npm run dev` dies at
 * binding load with `exit status 1`; with it, Vite 8 parses this project's
 * TypeScript, bundles `vite.config.ts` and reaches `server-ready`.
 */
const WASM_BINDINGS: { host: string; binding: (version: string) => string; why: string }[] = [
  {
    host: "rolldown",
    binding: (version) => `@rolldown/binding-wasm32-wasi@${version}`,
    why: "Vite 8 bundles with rolldown, and this runtime can only load its WebAssembly build",
  },
];

/** As much of the runtime filesystem as these checks need */
type WorkspaceFileSystem = NonNullable<ContainerRuntime["fs"]> & {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
};

/**
 * Installs the WebAssembly build of any compiled dependency the install skipped.
 *
 * `--no-save` because the repository is not ours to change, and `--force` because
 * the platform check is the very thing being overridden: the package is *meant* for
 * a different `cpu`, and it is the right build for this environment. The install is
 * additive — npm reports added packages here, not changed or removed ones.
 *
 * Never fails the run. A workspace without the binding is exactly the workspace
 * this app had before this step existed, and the toolchain's own failure — with the
 * hint that names it — is a better report than a refusal from here.
 */
async function installWasmBindings(input: {
  instance: ContainerRuntime;
  run: (command: string) => Promise<{ ok: true; outcome: ExecOutcome } | { ok: false; error: string }>;
  notes: string[];
}): Promise<void> {
  const fs = input.instance.fs;
  // A runtime that cannot be asked cannot be repaired, and guessing would install
  // a package into a tree that may already hold it.
  if (!fs?.readFile) return;
  const files: WorkspaceFileSystem = fs as WorkspaceFileSystem;

  for (const entry of WASM_BINDINGS) {
    const version = await packageVersionIn(files, `node_modules/${entry.host}/package.json`);
    if (!version) continue;
    const spec = entry.binding(version);
    const name = spec.slice(0, spec.lastIndexOf("@"));
    if ((await packageVersionIn(files, `node_modules/${name}/package.json`)) !== null) continue;

    const installed = await input.run(
      `npm install --no-save --force --no-audit --no-fund ${spec}`
    );
    if (!installed.ok || installed.outcome.exitCode !== 0) {
      input.notes.push(
        `\`${spec}\` could not be installed into the workspace, so ${entry.why} — expect anything that loads it to fail, for that reason rather than for anything about the change.`
      );
      continue;
    }
    input.notes.push(
      `\`${spec}\` was installed into the workspace first: ${entry.why}, and the install skips it because the package declares \`cpu: wasm32\`. Nothing in the repository changed (it is installed with \`--no-save\`), so the versions the install put in the workspace are still the declared ones — this adds the one build the runtime is able to load.`
    );
  }
}

/** The `version` a package.json declares, or null when that file is not there */
async function packageVersionIn(files: WorkspaceFileSystem, path: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await files.readFile.call(files, path, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    // Absent, unreadable, or not JSON: all three mean "this is not a package I can
    // reason about", and the caller skips it rather than installing blind.
    return null;
  }
}

/**
 * The lines of a failed install's output that name the CAUSE.
 *
 * npm ends every error block with the same footer — the usage line, the command's
 * alias list, `Run "npm help …"`, the debug-log path — and a naive "last N lines"
 * tail is all footer and no diagnosis (the real message sits just above it). One
 * real failure this fixed: `npm ci` with no usable lockfile exits with `EUSAGE`,
 * and the tail the old code kept was the footer alone, so the modal named nothing
 * a reader could act on. The filter drops footer lines from the tail rather than
 * taking the tail of the filtered text, so footer-free output (other managers,
 * other failures) is returned exactly as it was.
 */
export function installFailureTail(text: string, maxLines = 8): string {
  const lines = text.trim().split("\n");
  const diagnosis = lines.filter((line) => !NPM_ERROR_FOOTER.test(line.trim()));
  return diagnosis.slice(-maxLines).join("\n");
}

/**
 * npm's per-error footer, matched per line. It carries no diagnosis: the usage
 * block (`Usage:` and its flag lines, which wrap so they are matched by PREFIX,
 * not by a whole-line shape), the alias list, the `Run "npm help …"` pointer,
 * and the debug-log path. Bare `npm error` separator lines are dropped too. The
 * `npm error` PREFIX lines are otherwise kept — the message that names the cause
 * (`npm error code EUSAGE`, the explanation) wears the same prefix, and
 * filtering it out would keep exactly the wrong half.
 */
const NPM_ERROR_FOOTER =
  /^\[.*\]$|^npm error \[|^aliases:|^npm error aliases:|^Run "npm help|^npm error Run "npm help|^A complete log of this run|^npm error A complete log of this run|^npm error Usage:|^Usage:|^npm error$/;

/**
 * What npm prints when the lockfile it was told to use cannot be used at all.
 *
 * Kept beside the install rather than in a shared table because it is not a
 * diagnosis for a reader — it is a trigger, and a trigger that fires too eagerly
 * changes what a run means. Both patterns below are npm failing to READ a
 * lockfile: the first is the message it prints for a file that is absent, empty, or
 * unparseable (verified against npm 10.8.2 inside the runtime), and the second is
 * the parse-error family for a lockfile that is present but not a whole document.
 */
const LOCKFILE_UNUSABLE =
  /can only install with an existing package-lock|npm-shrinkwrap\.json with lockfileVersion|Invalid package-lock|EJSONPARSE|Failed to parse json|Unexpected token .* in JSON|not valid JSON/i;

/**
 * The wider family that earns the fallback install: everything above, plus the
 * out-of-sync refusal (`ci`'s deliberate strictness) — which in a scratch
 * workspace is a state to move past, not information to preserve. Anything npm
 * fails at that is NEITHER of these (a network outage, a private package, a bad
 * postinstall script) gets no retry: substituting there would hide a real
 * failure behind a second install that fails the same way.
 */
const LOCKFILE_RETRY = new RegExp(
  LOCKFILE_UNUSABLE.source +
    "|can only install (omitted )?packages when your package.json and package-lock|are in sync|npm error code EUSAGE",
  "i"
);

/**
 * Whether a lockfile's TEXT is something the frozen command can read.
 *
 * Three ways to be unusable, and they are one failure to whoever reads the
 * message. The JSON check is the load-bearing one: a lockfile that was fetched,
 * cached, mounted and truncated on the way is a file that exists and that npm
 * still refuses, and nothing before this point could tell the difference.
 */
function lockfileVerdict(path: string, text: string | null): { ok: true } | { ok: false; why: string } {
  if (text === null) return { ok: false, why: "is not in the workspace" };
  if (text.trim().length === 0) return { ok: false, why: "is empty in the workspace" };
  if (/\.json$/i.test(path)) {
    try {
      JSON.parse(text);
    } catch {
      return { ok: false, why: "is not a complete JSON document in the workspace (it is truncated or corrupt)" };
    }
  }
  return { ok: true };
}

/**
 * One file as the WORKSPACE holds it, or null when this runtime cannot be asked.
 *
 * Null and the empty string are deliberately different answers: the first means
 * there is no reader and the plan's copy is the only account available, the second
 * means the runtime looked and found nothing — which is a fact about the mount and
 * must be reported as one.
 */
async function readWorkspaceFile(instance: ContainerRuntime, path: string): Promise<string | null> {
  const fs = instance.fs;
  if (!fs?.readFile) return null;
  try {
    return await fs.readFile.call(fs, path, "utf-8");
  } catch {
    // An unreadable path is a path that is not there, which is the same answer
    // npm is about to get.
    return "";
  }
}

/**
 * Makes the file a frozen install depends on real, or says why it cannot be.
 *
 * The repair matters as much as the check. A plan whose lockfile is intact and a
 * workspace whose copy is empty is a MOUNT defect, and the honest fix is to write
 * the revision's bytes again — not to give up the frozen install for every later
 * command in this thread. Only when the plan's copy is unusable too is the
 * guarantee actually unavailable, and that is reported as such.
 */
async function secureLockfile(input: {
  instance: ContainerRuntime;
  path: string;
  fromPlan: string | null;
  notes: string[];
}): Promise<{ usable: true } | { usable: false; reason: string }> {
  const present = await readWorkspaceFile(input.instance, input.path);
  // A runtime that cannot be asked leaves the plan's copy as the only evidence.
  const verdict = lockfileVerdict(input.path, present === null ? input.fromPlan : present);
  if (verdict.ok) return { usable: true };

  if (present !== null && input.fromPlan && lockfileVerdict(input.path, input.fromPlan).ok) {
    try {
      await input.instance.fs?.writeFile(input.path, input.fromPlan);
      input.notes.push(
        `\`${input.path}\` was written into the workspace from this revision before installing: the copy the workspace held ${verdict.why}, and a frozen install is only as good as the file it reads.`
      );
      return { usable: true };
    } catch (error) {
      return {
        usable: false,
        reason: `could not be written into the workspace (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  return { usable: false, reason: verdict.why };
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

/** Exposed for the preview bridge: the tree's files, as path/content pairs (bytes for assets) */
export function filesOf(tree: FileSystemTree): { path: string; content: string | Uint8Array }[] {
  return flattenTree(tree);
}
