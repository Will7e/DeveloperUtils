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
  type WorkspaceEvent,
  type WorkspaceOwner,
} from "./container-host";
import { registerScopedResource } from "../identity/scoped-resources";
import {
  fileInTree,
  prepareWorkspace,
  ensureDependencies,
  serializeWorkspaceWork,
} from "./container-executor";
import type { MountPlan } from "./mount-plan";
import { normalizePackageManager } from "./run-plan";
import { injectPreviewControl } from "./preview-control-bridge";

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

/**
 * How long the output reader may take to finish before a failure is described.
 *
 * Long enough for a flushed stream to deliver its last chunk, short enough that a
 * stream nobody closed cannot delay the report the user is waiting for.
 */
const OUTPUT_DRAIN_MS = 750;

/** The two ways waiting for a dev server can end */
type StartupOutcome =
  | { ok: true; url: string; port: number }
  | { ok: false; error: string; exitCode?: number };

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

/**
 * The key a preview session is filed under: the repository it serves.
 *
 * Sessions are PER-REPO because that is the unit the user thinks in — the
 * sidebar already groups chats by repository, and a preview belongs to the
 * repo's checkout, not to one conversation. `owner/repo` is stable across
 * threads and revisions.
 */
export function repoKeyOf(owner: string | null | undefined, repo: string | null | undefined): string | null {
  const o = (owner ?? "").trim();
  const r = (repo ?? "").trim();
  if (!o || !r) return null;
  return `${o}/${r}`;
}

/** One repo's remembered preview, shown again when the user returns to it */
interface RepoSession {
  state: PreviewState;
  /** The conversation that owned the live session when it was archived */
  ownerThreadId: string | null;
  /**
   * When this record last changed (any setState, archive, or terminal state).
   *
   * A record is a claim about a server the user cannot currently see; its AGE
   * is part of the claim — "failed" ten seconds ago and "failed" yesterday are
   * different reasons to press Retry.
   */
  changedAt: number;
}

/**
 * Per-repo SESSIONS over the one physical server.
 *
 * The server itself stays single — one workspace lease, one filesystem, one
 * port space; that is WebContainer physics and no amount of bookkeeping changes
 * it. What is per-repo is the RECORD: when the user switches repositories, the
 * live session's state is archived under its repo and the view moves to the
 * other repo's record. Each repo's status, notes and console errors therefore
 * survive the switch and follow their repo home — a failed start is read in the
 * thread it belongs to, not by whichever thread happens to be active.
 */
const sessions = new Map<string, RepoSession>();
/** Which repo the view is showing (null = whatever is live, for a page with no repo context) */
let viewKey: string | null = null;
/** The repo the LIVE session belongs to (null = nothing live) */
let liveKey: string | null = null;

/*
 * Registered, not exempt, because the records hold thread-owned state (each one
 * remembers the conversation that owned its live session): a deleted thread's
 * repo entry describes nothing that exists, so it is dropped on that thread's
 * deletion alone — a repository moving to another thread must not blank some
 * other thread's view of the SAME repo. The structural test in
 * identity/registry.test.ts requires every module-level cache to declare itself;
 * an undeclared one is how the previous thread's state kept being served after
 * a move.
 */
registerScopedResource({
  name: "preview-bridge.sessions",
  scope: "thread",
  release: ({ transition }) => {
    if (transition.type !== "thread.deleted") return;
    for (const [key, session] of sessions) {
      if (session.ownerThreadId === transition.threadId) {
        sessions.delete(key);
        if (viewKey === key) viewKey = null;
        emitRevision();
      }
    }
  },
});

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

/**
 * Why the server's output stream could not be read, if it could not.
 *
 * Kept apart from `outputTail` on purpose. An empty tail has two very different
 * meanings — the command printed nothing, or nobody was able to listen — and a
 * failure report that cannot tell them apart sends the reader looking for a bug
 * in a script that may not have one.
 */
let outputUnreadable: string | null = null;

/**
 * Identifies the startup attempt in flight.
 *
 * Incremented by every `startPreview` and by every stop, so a server that is
 * killed while it is still starting is not reported as the project's failure to
 * start one. The user pressing Stop knows what they did; they should not be told
 * their dev script is broken.
 */
let startToken = 0;

/**
 * Ends the readiness wait in flight, if there is one.
 *
 * Killing the process is not enough on its own: `waitForServerReady` settles on
 * the process EXITING, and whether a kill resolves that promise is the runtime's
 * business, not something a Stop can rely on. A stop that only killed could
 * leave the caller — and the strip, still reading "starting" — waiting out the
 * full timeout for an answer that is already known. Set while a wait is in
 * flight, cleared by it.
 */
let abortStartup: ((outcome: StartupOutcome) => void) | null = null;

/**
 * The thread whose dev server this is.
 *
 * A page runs ONE dev server — that is the design, not a limitation to work
 * around — so this is the other half of the workspace lease: when another thread
 * takes the filesystem, the files this server is serving stop existing, and a
 * preview that keeps answering from a removed directory is worse than no preview
 * at all. The `workspace-released` event tells us whose lease ended; this is how
 * we know whether it was ours.
 */
let ownerThreadId: string | null = null;

/**
 * Whose thread the running preview belongs to, or null when nothing is
 * running or the owner was never recorded.
 *
 * Exposed because the preview's state is PAGE-GLOBAL while the completion
 * gate is PER-CONVERSATION: a gate that read another thread's preview
 * exceptions would nudge a turn for an app it never touched. Absent means
 * "not yours" — and the gate treats absent as silent.
 */
export function previewOwnerThreadId(): string | null {
  return ownerThreadId;
}

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

/**
 * What the VIEW shows: the state of `viewKey`'s repo, or the live session when
 * no repo view was chosen. Callers that want the LIVE server regardless of what
 * is on screen (the completion gate, the evidence note) read `livePreviewState`
 * instead — the distinction is the whole point of the split.
 */
export function previewState(): PreviewState {
  const key = viewKey ?? liveKey;
  if (!key) return state;
  return sessions.get(key)?.state ?? INITIAL;
}

/** The LIVE session's state, whichever repo's record is on screen */
export function livePreviewState(): PreviewState {
  return state;
}

/** The repo the live session serves, or null when nothing is live */
export function livePreviewRepoKey(): string | null {
  return liveKey;
}

/** The repo the view currently shows (null = following the live session) */
export function previewViewKey(): string | null {
  return viewKey;
}

/**
 * True when the viewed record IS the live session.
 *
 * False means the user is reading an archived session — the strip and panel
 * should say so, because a "running" record that is not the live server is
 * otherwise indistinguishable from one that is, and that is exactly the
 * misreading the per-repo records exist to end.
 */
export function previewViewIsLive(): boolean {
  const key = viewKey ?? liveKey;
  return key === null || key === liveKey;
}

/**
 * How long ago the viewed record last changed, in ms (null: nothing viewed or
 * never changed). The age is part of what an archived record claims — see
 * `RepoSession.changedAt`.
 */
export function previewViewAgeMs(): number | null {
  const key = viewKey ?? liveKey;
  if (!key) return null;
  return sessions.get(key)?.changedAt ?? null;
}

/**
 * Points the view at one repo's session, archiving whatever was on screen.
 *
 * The live session is NOT stopped by this — the server keeps serving its repo
 * while the user looks at another's record. What moves is the record: the
 * previously-viewed repo keeps its state in `sessions`, and this repo's own
 * state (running-but-not-live, failed-yesterday, whatever happened) is what the
 * strip and the panel now read. Same repo is a no-op; a repo with no session
 * yet shows a fresh idle record, which is also how it enters the map.
 */
export function setPreviewView(key: string | null): void {
  if (key === viewKey) return;
  // Archive the outgoing view's state. `state` is the LIVE state when the view
  // follows the live session (the common case: only one repo has ever run);
  // when the view was on an archived repo, that repo's record is already
  // current in the map and the live state belongs to `liveKey`.
  const outgoing = viewKey ?? liveKey;
  if (outgoing) {
    const existing = sessions.get(outgoing);
    const isLiveView = viewKey === null || viewKey === liveKey;
    sessions.set(outgoing, {
      state: isLiveView ? state : (existing?.state ?? state),
      ownerThreadId: isLiveView ? ownerThreadId : (existing?.ownerThreadId ?? null),
      changedAt: existing?.changedAt ?? Date.now(),
    });
  }
  viewKey = key;
  revision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A UI subscriber is not allowed to break the bridge.
    }
  }
}

/** Test seam: forget everything, including the server process */
export function resetPreview(): void {
  process = null;
  outputTail = "";
  outputUnreadable = null;
  startToken = 0;
  abortStartup = null;
  ownerThreadId = null;
  liveKey = null;
  viewKey = null;
  sessions.clear();
  state = INITIAL;
  revision += 1;
}
function setState(next: Partial<PreviewState>): void {
  state = { ...state, ...next };
  // The live state IS its repo's record: whatever repo owns the server reads
  // its own status back after a switch, without a copy step to forget.
  if (liveKey) {
    const existing = sessions.get(liveKey);
    sessions.set(liveKey, {
      state,
      ownerThreadId: existing?.ownerThreadId ?? ownerThreadId,
      changedAt: Date.now(),
    });
  }
  emitRevision();
}

/** Bumps the store revision and wakes the subscribers — the notify half of both setState and the session bookkeeping */
function emitRevision(): void {
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
  if (event.type === "workspace-released") {
    handleWorkspaceReleased(event);
    return;
  }
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

/**
 * Gives the dev server up when this thread loses the filesystem.
 *
 * Driven by the workspace's own event, so it lands at the moment the removal
 * happens rather than at the next interaction: in between, the server would
 * happily answer from files that are no longer there.
 */
function handleWorkspaceReleased(event: Extract<WorkspaceEvent, { type: "workspace-released" }>): void {
  if (!ownerThreadId || event.threadId !== ownerThreadId) return;
  const running = process;
  process = null;
  ownerThreadId = null;
  // The dead session stays filed under its repo — the record with the release
  // reason in its notes is what the user reads when they return. `liveKey`
  // clears only AFTER the setState below, which files the terminal state under
  // the repo that owned the session; clearing first would strand the record at
  // "running" forever.
  // The release ends any startup in flight too, so it must not be reported later
  // as that attempt failing on its own.
  endStartupWait();
  startToken += 1;
  if (running) {
    try {
      running.kill();
    } catch {
      // Already gone.
    }
  }
  setState({
    status: running ? "stopped" : state.status,
    url: null,
    port: null,
    notes: [
      ...state.notes,
      `The dev server was stopped because ${event.reason}. A preview runs in this thread's own tree, so one thread losing the workspace ends its preview.`,
    ],
  });
  liveKey = null;
}

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
  /** The thread whose revision this server serves; see `ownerThreadId` */
  owner?: WorkspaceOwner;
  /** The repo this session belongs to ("owner/repo"); see `sessions` */
  repoKey?: string | null;
}): Promise<{ ok: true; url: string; port: number } | { ok: false; error: string }> {
  if (state.status === "starting") return { ok: false, error: "the preview is already starting" };

  const attempt = (startToken += 1);

  // Claimed BEFORE the prepare below, so the release event a takeover emits for
  // the thread being evicted is never mistaken for this thread losing its own
  // workspace.
  if (input.owner) ownerThreadId = input.owner.threadId;
  // Captured before `liveKey` is re-pointed: the takeover below needs to know
  // which repo's server it is stopping, and by then the answer has changed.
  const previousLiveKey = liveKey;
  // The session's identity rides the start: everything `setState` writes from
  // here lands in this repo's record, and the view follows the new live repo —
  // the user just asked for THIS repo's preview, so this repo is what they see.
  liveKey = input.repoKey ?? liveKey;
  if (liveKey) viewKey = liveKey;

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
    // The takeover's "stopped" belongs to the PREVIOUS repo's record, not to
    // the repo being started: `liveKey` was already re-pointed above, so the
    // setState above filed B's "stopped" into B. This moves it home — without
    // it, starting repo B's preview marked repo A stopped though nothing had
    // touched it, and A's thread read a stopped preview that was never A's.
    if (previousLiveKey && previousLiveKey !== liveKey) {
      const record = sessions.get(previousLiveKey);
      if (record) {
        sessions.set(previousLiveKey, {
          ...record,
          state: { ...record.state, status: "stopped", url: null, port: null },
          changedAt: Date.now(),
        });
      }
    }
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

  // The control bootstrap rides the tree BEFORE it is mounted, so the served
  // page carries the listener from its first byte and no restart is needed
  // later. A project without an index.html-shaped document is left alone —
  // there is nothing to inject into, and that is a normal outcome, not a
  // failure (the interaction tools report the missing capability honestly).
  const control = injectPreviewControl(input.plan);
  if (control.note) setState({ notes: [...state.notes, control.note] });

  const prepared = await serializeWorkspaceWork(async () => {
    const mounted = await prepareWorkspace(input.plan, input.revision, input.owner);
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
  outputUnreadable = null;
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
  // A Stop pressed while this was still mounting and spawning arrived before
  // `process` existed to kill, so it bumped the token and nothing else. The
  // process it left behind is the server the user just stopped: killed here,
  // before anything waits on it, rather than waited out and then blamed on the
  // project's dev script.
  if (attempt !== startToken) {
    try {
      spawned.kill();
    } catch {
      // Already gone.
    }
    setState({ status: "stopped", url: null, port: null });
    return { ok: false, error: "the preview was stopped while it was starting" };
  }

  process = spawned;
  const pump = pumpOutput(spawned);

  const outcome = await waitForServerReady(spawned, PREVIEW_START_TIMEOUT_MS);

  // A deliberate stop is not a failure to start, and saying it was reads as a bug
  // in the project's dev script. Checked before the output is drained: there is
  // no failure to explain, so there is nothing here worth waiting for.
  if (attempt !== startToken) {
    try {
      spawned.kill();
    } catch {
      // Already gone.
    }
    process = null;
    return { ok: false, error: "the preview was stopped while it was starting" };
  }

  // Drained before the failure is described, because the tail is filled by a
  // reader running alongside this await: the last line a dying dev server prints
  // — the one naming the cause — is the most likely to still be in flight, and
  // reading the tail the instant the process is known to be gone reported an
  // empty output for a command that had plenty to say.
  await settleWithin(pump, OUTPUT_DRAIN_MS);
  if (!outcome.ok) {
    try {
      spawned.kill();
    } catch {
      // Already gone.
    }
    process = null;

    const tail = outputTail.trim();
    const note = `\`${detected.command}\` ${outcome.error}`;
    const hint = diagnoseDevServerFailure(tail, outcome.exitCode ?? null, declaredScripts(input.plan));
    setState({
      status: "failed",
      notes: [
        ...state.notes,
        note,
        ...(hint ? [hint] : []),
        ...(tail ? [`The dev server's output:\n${tail}`] : []),
        ...(outputUnreadable
          ? [`Its output could not be read (${outputUnreadable}), so the exit status is all the evidence there is.`]
          : []),
      ],
    });
    return { ok: false, error: note };
  }

  setState({ status: "running", url: outcome.url, port: outcome.port });
  return { ok: true, url: outcome.url, port: outcome.port };
}

/**
 * What an exit means when no server ever answered.
 *
 * The status is the whole difference between two unrelated situations: a script
 * that runs and finishes on its own is not a server at all, while a non-zero
 * status is the script refusing to run — and "exited before it served anything"
 * left the reader to guess which one they had.
 */
export function describeDevServerExit(code: number | null): string {
  if (code === 0) return "ran and finished without starting a server";
  if (code === null) return "exited before it served anything";
  return `exited before it served anything (exit status ${code})`;
}

/**
 * The cause behind a failed start, when the evidence names one.
 *
 * Every hint is keyed to something the process actually printed. This is not a
 * guess at what went wrong: a wrong cause is worse than no cause, because it
 * sends the reader to fix a thing that is not broken. When nothing matches, the
 * output itself is the report.
 */
export function diagnoseDevServerFailure(
  output: string,
  exitCode: number | null,
  otherScripts: string[] = []
): string | null {
  if (exitCode === 0) {
    const also = otherScripts.length > 0 ? ` This revision also declares ${otherScripts.map((s) => `\`${s}\``).join(", ")}.` : "";
    return `The script finished instead of staying up. A preview needs a script that keeps a server alive — a build or a one-shot task looks exactly like this.${also}`;
  }

  const evidence = output.trim();
  if (!evidence) return null;
  for (const { pattern, hint } of FAILURE_HINTS) {
    if (pattern.test(evidence)) return hint;
  }
  return null;
}

/**
 * What the printed evidence means, most specific first.
 *
 * These are the failures a browser workspace produces for reasons that have
 * nothing to do with the project's code, which is exactly when a reader needs to
 * be told so: each one looks like an ordinary crash in a terminal.
 */
const FAILURE_HINTS: { pattern: RegExp; hint: string }[] = [
  {
    pattern: /requires Node\.js version|Unsupported engine|engine "node" is incompatible|You are using Node\.js/i,
    hint: "It refuses the workspace's Node.js version. That version belongs to the browser runtime, not to this project, so this dev script cannot run here at all — which is a limit of the preview, not a bug in the code.",
  },
  {
    // Two shapes of the same problem, and they need the same answer. A native
    // addon (`*.node`) cannot be loaded here at all; a WASM build of one can be
    // loaded and still fail, because the runtime's environment is not the one the
    // binding's generated loader expects — `ERR_NAPI_BINDING_TARGET_CONFLICT` is
    // what a napi-rs loader throws when the same binding is stamped twice. Both
    // read as an ordinary crash, and neither is the project's fault, so the hint
    // is stated once for both rather than leaving the second to look like a bug.
    pattern:
      /Cannot load native addon|invalid ELF header|not a valid (ELF|Win32)|not a shared object|\.node: cannot open|__napiBindingTarget|ERR_NAPI_BINDING_TARGET_CONFLICT|Cannot find native binding/i,
    hint: "It loads a compiled binding — a native addon, or the WebAssembly build of one. The workspace runs in WebAssembly and cannot load native addons, however cleanly the install finished, so this dev script cannot run here at all. The code is not at fault: run this project in another tier, or start it with a tool that has no compiled binding.",
  },
  {
    pattern: /EADDRINUSE|address already in use/i,
    hint: "Something is already listening on its port. Stop the preview and start it again.",
  },
  {
    pattern: /command not found|: not found|npm error code 127|Cannot find module|ERR_MODULE_NOT_FOUND/i,
    hint: "A command or module it needs is missing from the workspace, which points at the install rather than at the project: the lockfile install may have skipped or changed that dependency.",
  },
];

/** Every script this revision declares, other than the one that was started */
function declaredScripts(plan: MountPlan): string[] {
  const scripts = scriptsOf(packageJsonOf(plan));
  if (!scripts) return [];
  return Object.keys(scripts).filter((name) => !(DEV_SCRIPTS as readonly string[]).includes(name));
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
function waitForServerReady(spawned: ContainerProcessHandle, timeoutMs: number): Promise<StartupOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: StartupOutcome) => {
      if (settled) return;
      settled = true;
      if (abortStartup === finish) abortStartup = null;
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
    abortStartup = finish;
    // The status is carried out rather than turned into prose here: a cause needs
    // the code (an exit of 0 and an exit of 1 are different reports) and only the
    // caller has the process's output to read it against.
    void spawned.exit
      .then((code) => finish({ ok: false, error: describeDevServerExit(code), exitCode: code }))
      .catch(() => undefined);
  });
}

/** Settles the readiness wait in flight, as the cancellation it actually is */
function endStartupWait(): void {
  abortStartup?.({ ok: false, error: "the preview was stopped while it was starting" });
}

/**
 * Waits for `work`, but never longer than `ms`.
 *
 * Bounded because the work is a reader over a live stream: a stream that ends
 * badly, or not at all, must not hold the failure report hostage.
 */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([
    work.catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  ]);
}

/** Keeps the last of the server's output, for a failure report */
async function pumpOutput(spawned: ContainerProcessHandle): Promise<void> {
  try {
    const reader = spawned.output.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (typeof value !== "string") continue;
      outputTail = `${outputTail}${value}`.slice(-MAX_PREVIEW_OUTPUT_CHARS);
    }
  } catch (error) {
    // Recorded, not swallowed: the one time this was silent, every command
    // reported success with empty output — and a failure that cannot show output
    // reads exactly like a process that printed none.
    outputUnreadable = error instanceof Error ? error.message : String(error);
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
  ownerThreadId = null;
  // Closing the startup attempt in flight: a server killed while starting exits
  // like a server that crashed, and only this flag tells the two apart.
  endStartupWait();
  startToken += 1;
  if (running) {
    try {
      running.kill();
    } catch {
      // Already gone.
    }
  }
  // The record stays under its repo (as "stopped", with the reason); liveness
  // clears after the setState that files it — the same order the release uses.
  setState({ status: running ? "stopped" : state.status, url: null, port: null, notes: [reason] });
  liveKey = null;
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

/** Defaults and caps for `waitForPreviewSettle` */
export const PREVIEW_SETTLE_DEFAULT_QUIET_MS = 2_000;
export const PREVIEW_SETTLE_MAX_QUIET_MS = 10_000;
export const PREVIEW_SETTLE_DEFAULT_TIMEOUT_MS = 15_000;
export const PREVIEW_SETTLE_MAX_TIMEOUT_MS = 30_000;

/**
 * Resolves when the preview has SETTLED: it reached `running` (or was already
 * there) and no new issue arrived for `quietMs`, or it reached `failed`, or
 * `timeoutMs` elapsed first.
 *
 * Built for a model that just wrote files and wants to know what the running
 * app thinks: hot reload takes a moment, and an error often trails the change
 * by a second or two — so the quiet window is what separates "read too early"
 * from "the app is genuinely quiet". The failed status settles EARLY, because
 * a server that just refused to start has nothing further to say and the
 * diagnosis is already on the state.
 *
 * Never throws and never inspects the server process: it reads the same state
 * every other subscriber reads, so it cannot race `startPreview`.
 */
export function waitForPreviewSettle(options: {
  quietMs?: number;
  timeoutMs?: number;
} = {}): Promise<void> {
  const quietMs = Math.min(
    Math.max(0, options.quietMs ?? PREVIEW_SETTLE_DEFAULT_QUIET_MS),
    PREVIEW_SETTLE_MAX_QUIET_MS
  );
  const timeoutMs = Math.min(
    Math.max(100, options.timeoutMs ?? PREVIEW_SETTLE_DEFAULT_TIMEOUT_MS),
    PREVIEW_SETTLE_MAX_TIMEOUT_MS
  );

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      clearTimeout(deadline);
      unsubscribe();
      resolve();
    };

    const armQuietWindow = () => {
      if (timer) clearTimeout(timer);
      if (quietMs <= 0) {
        finish();
        return;
      }
      timer = setTimeout(finish, quietMs);
    };

    const deadline = setTimeout(finish, timeoutMs);
    const unsubscribe = subscribePreview(() => {
      if (state.status === "failed") {
        finish();
        return;
      }
      if (state.status !== "running") return;
      // A new issue restarts the quiet window — the app just said something.
      armQuietWindow();
    });

    // Not running yet: the deadline (or a later transition) ends the wait —
    // arming the quiet window here would report a settled `idle` preview.
    if (state.status === "running") armQuietWindow();
  });
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
  // Evidence belongs to the LIVE server, not to whichever repo is on screen:
  // a turn for repo B must not quote repo A's console errors just because the
  // user was looking at B when the evidence was gathered.
  const state = livePreviewState();
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

/**
 * Test seam: move the preview state directly, for tests of code that reads
 * state transitions (the settle wait). Production never calls this.
 */
export function setStateForTest(patch: Partial<PreviewState>): void {
  setState(patch);
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
