// ============================================================
// Preview Bridge — The Harness Owns The Dev Server
// ============================================================
// A browser workspace can do something no other tier in this app can: show the
// change WORKING, in the tab, while the agent is still editing. That is the whole
// reason this feature exists, and it puts one hard constraint on the design —
// the dev server's lifecycle belongs to the APP, not to the model.
//
// bolt.new's own system prompt states the rule the long way round ("ULTRA
// IMPORTANT: do NOT re-run a dev command… assume installing dependencies will be
// picked up by the dev server"), and it is right for a reason that is not about
// prompt budget: a model that restarts a server the harness is already managing
// produces two servers fighting for one port, and neither of them is the preview
// the user is looking at. So `run_command` REFUSES server commands (see
// `run-plan.ts`), and this module starts the one server, once, keyed to the
// revision it is serving.
//
// Three consequences worth stating, because each is a decision:
//
//   • THE PREVIEW IS EVIDENCE, NOT DECORATION. Console errors and uncaught
//     exceptions inside the preview are forwarded by the runtime
//     (`preview-message`), and they are the only signal in this product about
//     whether the app WORKS rather than whether it builds. They are collected
//     here, bounded, and offered to the turn note.
//
//   • RESTART IS EXPLICIT. The file-write bridge already feeds hot reload, so a
//     new revision does NOT restart the server — the preview updates under the
//     user's hands. Restarting is offered (a change to `vite.config.ts` or a new
//     dependency needs it) and never automatic, because a restart blanks the
//     preview and loses the console history the agent was reading.
//
//   • FAILURE IS ANSWERED WITH THE SERVER'S OWN WORDS. A dev server that dies at
//     startup says why in its output, and "the preview did not start" without it
//     sends the agent to guess. The last lines are kept for exactly that.
// ============================================================

import {
  containerStatus,
  ensureContainer,
  subscribeWorkspaceEvents,
  type ContainerRuntime,
} from "./container-host";
import {
  fileInTree,
  prepareWorkspace,
  ensureDependencies,
  serializeWorkspaceWork,
} from "./container-executor";
import type { MountPlan } from "./mount-plan";
import { normalizePackageManager } from "./run-plan";

/**
 * The runtime's own message types, spelled as literals.
 *
 * `PreviewMessageType` is a runtime enum, and importing it would pull
 * `@webcontainer/api` into the eager bundle — the SDK is loaded dynamically at
 * boot for that reason, and a preview module is no excuse to undo it.
 */
const PREVIEW_CONSOLE_ERROR = "PREVIEW_CONSOLE_ERROR";
const PREVIEW_UNCAUGHT = "PREVIEW_UNCAUGHT_EXCEPTION";
const PREVIEW_UNHANDLED = "PREVIEW_UNHANDLED_REJECTION";

/** Scripts that START a server, most specific first */
const DEV_SCRIPTS = ["dev", "start", "serve", "preview"] as const;

/** How long a dev server may take to answer before the attempt is a failure */
export const PREVIEW_START_TIMEOUT_MS = 120_000;

/** Console entries kept. A hot-reloading app can produce thousands of them */
export const MAX_PREVIEW_ISSUES = 25;

/** The server's startup output kept for a failure report */
export const MAX_PREVIEW_OUTPUT_CHARS = 4_000;

export type PreviewStatus = "idle" | "starting" | "running" | "failed" | "stopped";

export interface PreviewIssue {
  kind: "console-error" | "uncaught" | "unhandled-rejection";
  message: string;
  at: number;
}

export interface PreviewState {
  status: PreviewStatus;
  /** Where the dev server answered, once it did */
  url: string | null;
  port: number | null;
  /** The command the harness started, or null when nothing started one */
  command: string | null;
  /** Why it is not running, and what happened when it tried */
  notes: string[];
  /** Preview console errors / exceptions, newest last */
  issues: PreviewIssue[];
  startedAt: number | null;
}

const INITIAL: PreviewState = {
  status: "idle",
  url: null,
  port: null,
  command: null,
  notes: [],
  issues: [],
  startedAt: null,
};

let state: PreviewState = INITIAL;
let process: ContainerProcessHandle | null = null;
let outputTail = "";

/** As much of a spawned process as this module holds on to */
type ContainerProcessHandle = Awaited<ReturnType<ContainerRuntime["spawn"]>>;

const listeners = new Set<() => void>();
let revision = 0;

export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic revision of the preview state, for `useSyncExternalStore` */
export function previewRevision(): number {
  return revision;
}

export function previewState(): PreviewState {
  return state;
}

/** Test seam: forget everything, including the server process */
export function resetPreview(): void {
  process = null;
  outputTail = "";
  state = INITIAL;
  revision += 1;
}

function setState(next: Partial<PreviewState>): void {
  state = { ...state, ...next };
  revision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A UI subscriber is not allowed to break the bridge.
    }
  }
}

/**
 * Console errors and exceptions forwarded from inside the preview.
 *
 * Subscribed once, at module load, because the interesting messages arrive
 * WHILE the user is looking at the preview and there is no moment later at which
 * replaying them would still be true. Only failures are kept: `console.log` from
 * a dev server is unbounded output, and a log the agent cannot act on is
 * instruction budget spent on nothing.
 */
subscribeWorkspaceEvents((event) => {
  if (event.type !== "preview-message") return;
  const message = event.message;
  if (message.type === PREVIEW_CONSOLE_ERROR) {
    const args = "args" in message ? message.args : [];
    addIssue("console-error", describeArgs(args));
    return;
  }
  if (message.type === PREVIEW_UNCAUGHT) {
    addIssue("uncaught", "message" in message ? message.message : "an uncaught exception");
    return;
  }
  if (message.type === PREVIEW_UNHANDLED) {
    addIssue("unhandled-rejection", "message" in message ? message.message : "an unhandled rejection");
  }
});

function describeArgs(args: unknown[]): string {
  const parts = args.map((arg) => {
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });
  return parts.join(" ").slice(0, 400) || "a console error with no message";
}

function addIssue(kind: PreviewIssue["kind"], message: string): void {
  const issues = [...state.issues, { kind, message, at: Date.now() }];
  setState({ issues: issues.slice(-MAX_PREVIEW_ISSUES) });
}

/**
 * The dev server this revision implies, or null with the reason why not.
 *
 * Declared scripts only: `npm run dev` is a fact the repository states, while
 * `npx vite` is this app guessing from a dependency list. A guess that starts the
 * wrong thing is worse than saying the project declares no dev script, because
 * the failure is then blamed on the project.
 */
export function detectDevServer(input: {
  packageJson?: string | null;
}): { command: string; script: string } | null {
  const scripts = scriptsOf(input.packageJson);
  if (!scripts) return null;
  const name = DEV_SCRIPTS.find((candidate) => typeof scripts[candidate] === "string");
  if (!name) return null;
  // The manager is read from the same manifest the script came from, and
  // normalized by the SAME function the install plan uses, so this cannot report
  // `pnpm dev` after the install ran `npm ci` in that tree.
  const runner = runnerFor(normalizePackageManager(packageManagerField(input.packageJson ?? null)));
  return { command: `${runner} ${name}`, script: name };
}

function scriptsOf(packageJson: string | null | undefined): Record<string, unknown> | null {
  if (!packageJson || !packageJson.trim()) return null;
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object") return null;
    return parsed.scripts as Record<string, unknown>;
  } catch {
    return null;
  }
}

function runnerFor(packageManager: string | null): string {
  if (packageManager === "pnpm" || packageManager === "yarn" || packageManager === "bun") {
    return packageManager;
  }
  return "npm run";
}

/**
 * The `package.json` a mount plan will put in the workspace, or null.
 *
 * Read from the plan rather than from the mounted tree: "which script starts
 * this project?" has to be answered BEFORE anything is started, and asking the
 * runtime would mean a boot for a question the plan already answers.
 */
export function packageJsonOf(plan: MountPlan): string | null {
  return fileInTree(plan.tree, "package.json");
}

/**
 * Starts the revision's dev server, if it declares one.
 *
 * The mount and the install run inside the workspace lock (they are the same
 * filesystem a command would use), and the server itself is started outside it —
 * a long-lived process holding the lock would block every command for as long as
 * the preview is open, which is precisely the opposite of the intent.
 */
export async function startPreview(input: {
  plan: MountPlan;
  revision: number;
  mountNotes?: string[];
}): Promise<{ ok: true; url: string; port: number } | { ok: false; error: string }> {
  if (state.status === "starting") return { ok: false, error: "the preview is already starting" };

  // A second dev server on the same port is the failure this module exists to
  // prevent, and the guard above only covers the window before the first one
  // answers: pressing Restart on a live preview used to spawn another process,
  // orphan the first, and leave `process` — the only handle Stop has — pointing
  // at the newer of two servers.
  if (process) {
    const previous = process;
    // Cleared BEFORE the kill, so a kill that throws cannot leave the module
    // believing it still owns a server it has just tried to stop.
    process = null;
    try {
      previous.kill();
    } catch {
      // Already gone.
    }
    setState({ status: "stopped", url: null, port: null });
  }

  const packageJson = packageJsonOf(input.plan);
  const detected = detectDevServer({ packageJson });
  if (!detected) {
    const note =
      "This revision declares no dev/start/serve/preview script, so there is nothing for the app to start. The workspace itself still runs commands.";
    setState({ status: "failed", notes: [...(input.mountNotes ?? []), note], url: null, port: null });
    return { ok: false, error: note };
  }

  setState({
    status: "starting",
    command: detected.command,
    url: null,
    port: null,
    notes: [...(input.mountNotes ?? [])],
    issues: [],
    startedAt: Date.now(),
  });

  const prepared = await serializeWorkspaceWork(async () => {
    const mounted = await prepareWorkspace(input.plan, input.revision);
    if (!mounted.ok) return { ok: false as const, error: mounted.error };
    const installed = await ensureDependencies(input.plan, input.revision);
    if (!installed.ok) return { ok: false as const, error: installed.error };
    return { ok: true as const, notes: [...mounted.notes, ...installed.notes] };
  });
  if (!prepared.ok) {
    setState({ status: "failed", notes: [...state.notes, prepared.error] });
    return { ok: false, error: prepared.error };
  }
  setState({ notes: [...state.notes, ...prepared.notes] });

  const instance = await ensureContainer();
  if (!instance) {
    const error = containerStatus().reason ?? "no browser workspace is available on this page";
    setState({ status: "failed", notes: [...state.notes, error] });
    return { ok: false, error };
  }

  outputTail = "";
  let spawned: ContainerProcessHandle;
  try {
    spawned = await instance.spawn("jsh", ["-c", detected.command], {
      env: { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", BROWSER: "none" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState({ status: "failed", notes: [...state.notes, `The dev server would not start: ${message}`] });
    return { ok: false, error: `The dev server would not start: ${message}` };
  }
  process = spawned;
  void pumpOutput(spawned);

  const outcome = await waitForServerReady(spawned, PREVIEW_START_TIMEOUT_MS);
  if (!outcome.ok) {
    try {
      spawned.kill();
    } catch {
      // Already gone.
    }
    process = null;
    const tail = outputTail.trim();
    const note = `\`${detected.command}\` ${outcome.error}`;
    setState({
      status: "failed",
      notes: [...state.notes, note, ...(tail ? [`The dev server's output:\n${tail}`] : [])],
    });
    return { ok: false, error: note };
  }

  setState({ status: "running", url: outcome.url, port: outcome.port });
  return { ok: true, url: outcome.url, port: outcome.port };
}

function packageManagerField(packageJson: string | null): string | null {
  if (!packageJson) return null;
  try {
    const parsed = JSON.parse(packageJson) as { packageManager?: unknown };
    return typeof parsed.packageManager === "string" ? parsed.packageManager : null;
  } catch {
    return null;
  }
}

/**
 * Resolves when the runtime reports a server, or on timeout, or when the process
 * exits first — which is the case that matters most, because a dev server that
 * dies instantly never emits `server-ready`, and waiting the full two minutes to
 * report it wastes exactly the time the user needed the answer.
 */
function waitForServerReady(
  spawned: ContainerProcessHandle,
  timeoutMs: number
): Promise<{ ok: true; url: string; port: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: true; url: string; port: number } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = subscribeWorkspaceEvents((event) => {
      if (event.type === "server-ready") finish({ ok: true, url: event.url, port: event.port });
      if (event.type === "runtime-error") finish({ ok: false, error: `reported an error: ${event.message}` });
    });
    const timer = setTimeout(
      () => finish({ ok: false, error: `did not answer within ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs
    );
    void spawned.exit.then(() => finish({ ok: false, error: "exited before it served anything" })).catch(() => undefined);
  });
}

/** Keeps the last of the server's output, for a failure report */
async function pumpOutput(spawned: ContainerProcessHandle): Promise<void> {
  try {
    const reader = spawned.output().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (typeof value !== "string") continue;
      outputTail = `${outputTail}${value}`.slice(-MAX_PREVIEW_OUTPUT_CHARS);
    }
  } catch {
    // A stream that ends badly is reported as the server's exit, which is below.
  }
}

/**
 * Stops the dev server. The workspace stays up — commands still run in it, and
 * tearing it down would throw away the installed tree for a decision about one
 * process.
 */
export function stopPreview(reason: string): void {
  const running = process;
  process = null;
  if (running) {
    try {
      running.kill();
    } catch {
      // Already gone.
    }
  }
  setState({ status: running ? "stopped" : state.status, url: null, port: null, notes: [reason] });
}

/** Records that the mounted revision moved under a running preview */
export function notePreviewRevision(revisionNumber: number): void {
  if (state.status !== "running") return;
  if (state.startedAt === null) return;
  // The file-write bridge feeds hot reload, so a new revision does NOT refresh
  // the server here. This exists so the status line can say which revision the
  // preview is serving, rather than implying it is always the newest one.
  setState({ notes: [...state.notes, `The preview has been serving since revision ${revisionNumber}.`] });
}

/**
 * Runtime evidence for the turn note.
 *
 * Returns "" when there is nothing to say, which is the common case: a preview
 * with no errors is not information. When there IS something, it is stated as
 * evidence about the running app — the only evidence of its kind this product
 * has, since neither a type check nor a test suite ever saw the app boot.
 */
export function previewEvidenceNote(): string {
  if (state.status === "failed") {
    return `# Preview\nThe app's dev server did not start: ${state.notes.slice(-2).join(" ")}. Do not describe the change as working in the browser.`;
  }
  if (state.issues.length === 0) return "";
  const errors = state.issues.filter((issue) => issue.kind !== "console-error").length;
  const head = `# Preview\nThe app is running in the browser workspace and it reported ${state.issues.length} problem(s) at runtime${errors > 0 ? `, including ${errors} exception(s)` : ""} — this is the running app, not the build:`;
  const lines = state.issues
    .slice(-5)
    .map((issue) => `- ${issue.kind}: ${issue.message.split("\n")[0]}`)
    .join("\n");
  return `${head}\n${lines}\nFix these before claiming the change works — a build that passes with a broken page is exactly what this catches.`;
}

/** Test seam: feed the bridge console messages without a runtime */
export function notePreviewMessageForTest(message: {
  type: string;
  args?: unknown[];
  message?: string;
}): void {
  if (message.type === PREVIEW_CONSOLE_ERROR) {
    addIssue("console-error", describeArgs(message.args ?? []));
    return;
  }
  if (message.type === PREVIEW_UNCAUGHT) addIssue("uncaught", message.message ?? "");
  if (message.type === PREVIEW_UNHANDLED) addIssue("unhandled-rejection", message.message ?? "");
}
