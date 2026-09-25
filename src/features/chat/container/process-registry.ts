// ============================================================
// Process Registry — Long-Lived Processes The Harness Owns
// ============================================================
// The preview proved that a WebContainer process can outlive a turn, and
// there is a whole class of work that wants that: a type check --watch, a
// generator waiting on a schema, a seed script followed by a service. What
// the preview also proved is the ONE rule that makes it safe — the harness
// owns the lifecycle, the model only ever observes it. A process the model
// started and manages itself is a process that leaks: two watchers on the
// same tree, a server nobody can stop, output nobody keeps.
//
// So this registry owns every background process end to end:
//
//   • spawned OUTSIDE the workspace lock, exactly like the dev server — a
//     long-lived process holding the lock blocks every command for as long
//     as it lives, which is the opposite of the intent (see
//     preview-bridge.ts for the same decision in the same words);
//   • output kept in a bounded tail — the pump pattern from the preview
//     bridge, so a chatty process cannot grow a tab's memory forever;
//   • killed when the workspace lease moves — the same `workspace-released`
//     event the preview obeys, for the same reason: a process answering
//     from a tree that no longer exists is worse than no process;
//   • dev/start/serve scripts REFUSED. The dev server belongs to the
//     preview bridge; two servers fighting one port is the failure that
//     rule exists to prevent, and `run_command`'s refusal already taught
//     the model to expect it.
//
// The model's surface is observe-and-report: start (once), read, stop.
// It can never reattach, restart implicitly, or run two of the same command.
// ============================================================

import {
  containerStatus,
  ensureContainer,
  subscribeWorkspaceEvents,
  type ContainerRuntime,
  type WorkspaceOwner,
} from "./container-host";
import { prepareWorkspace, ensureDependencies, serializeWorkspaceWork } from "./container-executor";
import type { MountPlan } from "./mount-plan";

/** Scripts that START a server — refused here, because the preview owns them */
const DEV_SCRIPTS = ["dev", "start", "serve", "preview"] as const;

/** Output kept per process. A watcher can reprint its verdict on every save */
export const PROCESS_OUTPUT_MAX_CHARS = 8_000;

/** Processes one page may hold. A bounded ceiling keeps leaks impossible */
export const MAX_PROCESSES = 3;

/** Display names for a process state, in the words a model should quote */
const STATE_LABEL: Record<ProcessState, string> = {
  starting: "starting",
  running: "running",
  exited: "exited",
  killed: "killed",
};

export type ProcessState = "starting" | "running" | "exited" | "killed";

export interface ProcessEntry {
  id: string;
  /** The command line as started, for status lines and reports */
  command: string;
  /** The caller's one-line purpose, kept with the process */
  why: string | null;
  state: ProcessState;
  exitCode: number | null;
  startedAt: number;
  exitedAt: number | null;
  /** Last output, capped as it arrived */
  output: string;
  /** Why the output stream could not be read, when it could not */
  outputUnreadable: string | null;
}

interface OwnedProcess extends ProcessEntry {
  handle: ContainerProcessHandle;
}

/** As much of a spawned process as this module holds on to */
type ContainerProcessHandle = Awaited<ReturnType<ContainerRuntime["spawn"]>>;

const processes = new Map<string, OwnedProcess>();
let seq = 0;

/** Test seam: forget everything, killing nothing (tests hold fake handles) */
export function resetProcessRegistry(): void {
  for (const p of processes.values()) {
    try {
      p.handle.kill();
    } catch {
      // Already gone.
    }
  }
  processes.clear();
  seq = 0;
}

/** Every process, oldest first — the order a listing should read in */
export function listProcesses(): ProcessEntry[] {
  return [...processes.values()].map(toEntry);
}

/** One process, or null */
export function processById(id: string): ProcessEntry | null {
  const found = processes.get(id);
  return found ? toEntry(found) : null;
}

function toEntry(p: OwnedProcess): ProcessEntry {
  return {
    id: p.id,
    command: p.command,
    why: p.why,
    state: p.state,
    exitCode: p.exitCode,
    startedAt: p.startedAt,
    exitedAt: p.exitedAt,
    output: p.output,
    outputUnreadable: p.outputUnreadable,
  };
}

function update(id: string, patch: Partial<OwnedProcess>): void {
  const found = processes.get(id);
  if (!found) return;
  processes.set(id, { ...found, ...patch });
}

/**
 * Drops entries for processes that exited or were killed, keeping the map a
 * record of live work plus (until the next start) a recent-dead tail.
 *
 * Called before the cap check, so dead entries never wedge the registry: the
 * cap is about RESOURCES, and an exited process holds none.
 */
function reapDeadProcesses(): void {
  for (const [id, p] of [...processes]) {
    if (p.state === "exited" || p.state === "killed") processes.delete(id);
  }
}

/**
 * The dev-script refusal, decided from the command the model chose.
 *
 * Only a `package manager run <script>` shape can name a script, and only a
 * dev-shaped script is refused: `npm run build` is a legitimate background
 * candidate (a one-shot that exits), while `npm run dev` is the preview's
 * job. Everything else — `npx vite`, a direct binary — is not a declared
 * dev script, and guessing from a dependency list is the mistake
 * `detectDevServer` exists to avoid, so it is not repeated here.
 */
export function isDevServerCommand(command: string): boolean {
  const trimmed = command.trim();
  const match = /^(?:npm run|pnpm run|pnpm|yarn|bun run|bun)\s+(\S+)/i.exec(trimmed);
  if (!match) return false;
  const script = match[1]!.toLowerCase();
  return (DEV_SCRIPTS as readonly string[]).includes(script);
}

export type StartProcessOutcome =
  | { ok: true; id: string }
  | { ok: false; error: string; status?: "too-many" | "dev-script" };

/**
 * Starts one long-lived process in the browser workspace.
 *
 * The mount and install run inside the workspace lock (same rationale as the
 * preview bridge: they are the same filesystem a command would use), the
 * process itself is started outside it. A second instance of the SAME
 * command is refused — a second watcher on one tree doubles the noise and
 * halves the honesty, and the caller can read the first one instead.
 */
export async function startProcess(input: {
  command: string;
  why: string | null;
  plan: MountPlan;
  revision: number;
  owner: WorkspaceOwner;
}): Promise<StartProcessOutcome> {
  if (isDevServerCommand(input.command)) {
    return {
      ok: false,
      status: "dev-script",
      error:
        `Refused: \`${input.command}\` starts a dev server, and the harness already owns the dev server — it is the preview. ` +
        `Start the preview from the workspace strip instead, and use read_preview for its verdict.`,
    };
  }
  // The cap counts LIVE processes only, and dead entries are reaped first.
  // A process that exited keeps its entry for read_process — but counting it
  // against the cap would let three one-shot scripts wedge run_process
  // forever: the refusal would say "stop one you no longer need", and
  // stopping an already-exited process changes nothing. Reaping keeps the
  // recent-dead tail bounded and the cap meaningful.
  const liveProcesses = listProcesses().filter((p) => p.state === "running" || p.state === "starting");
  if (liveProcesses.length + processes.size - listProcesses().length >= MAX_PROCESSES) {
    reapDeadProcesses();
  }
  const liveAfterReap = listProcesses().filter((p) => p.state === "running" || p.state === "starting");
  if (liveAfterReap.length >= MAX_PROCESSES) {
    return {
      ok: false,
      status: "too-many",
      error:
        `The workspace already holds ${MAX_PROCESSES} live processes. ` +
        (liveAfterReap.length > 0
          ? `Running: ${liveAfterReap.map((p) => `${p.id} (${p.command})`).join(", ")}. Stop the one you no longer need with stop_process.`
          : ""),
    };
  }
  const duplicate = liveAfterReap.find((p) => p.command === input.command);
  if (duplicate) {
    return {
      ok: false,
      status: "too-many",
      error: `\`${input.command}\` is already running as ${duplicate.id} — read its output with read_process instead of starting a second one.`,
    };
  }

  const id = `p${(seq += 1)}`;
  const startedAt = Date.now();
  processes.set(id, {
    id,
    command: input.command,
    why: input.why,
    state: "starting",
    exitCode: null,
    startedAt,
    exitedAt: null,
    output: "",
    outputUnreadable: null,
    // Assigned right after the spawn below; the placeholder keeps the map
    // entry honest for the lease handler that could fire in between.
    handle: null as unknown as ContainerProcessHandle,
  });

  const prepared = await serializeWorkspaceWork(async () => {
    const mounted = await prepareWorkspace(input.plan, input.revision, input.owner);
    if (!mounted.ok) return { ok: false as const, error: mounted.error };
    const installed = await ensureDependencies(input.plan, input.revision);
    if (!installed.ok) return { ok: false as const, error: installed.error };
    return { ok: true as const };
  });
  if (!prepared.ok) {
    processes.delete(id);
    return { ok: false, error: `The workspace could not be prepared: ${prepared.error}` };
  }

  const instance = await ensureContainer();
  if (!instance) {
    processes.delete(id);
    const reason = containerStatus().reason ?? "no browser workspace is available on this page";
    return { ok: false, error: reason };
  }

  let spawned: ContainerProcessHandle;
  try {
    spawned = await instance.spawn("jsh", ["-c", input.command], {
      env: { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", BROWSER: "none" },
    });
  } catch (error) {
    processes.delete(id);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `The process would not start: ${message}` };
  }

  // The lease could have been released while we mounted and spawned.
  if (!processes.has(id)) {
    try {
      spawned.kill();
    } catch {
      // Already gone.
    }
    return { ok: false, error: "the workspace was released while the process was starting" };
  }

  update(id, { handle: spawned, state: "running" });
  void pumpProcessOutput(id, spawned);
  void recordProcessExit(id, spawned);
  return { ok: true, id };
}

/** Keeps the last of the process's output (the preview bridge's pump) */
async function pumpProcessOutput(id: string, handle: ContainerProcessHandle): Promise<void> {
  try {
    const reader = handle.output.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (typeof value !== "string") continue;
      const found = processes.get(id);
      if (!found) return;
      processes.set(id, {
        ...found,
        output: `${found.output}${value}`.slice(-PROCESS_OUTPUT_MAX_CHARS),
      });
    }
  } catch (error) {
    // Recorded, not swallowed: an unreadable output stream must not read as
    // a process that printed nothing (the preview bridge learned this too).
    const found = processes.get(id);
    if (found) {
      processes.set(id, {
        ...found,
        outputUnreadable: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Resolves when the process exits, and records the verdict */
async function recordProcessExit(id: string, handle: ContainerProcessHandle): Promise<void> {
  try {
    const code = await handle.exit;
    const found = processes.get(id);
    if (!found) return;
    if (found.state === "killed") return; // the kill already told the story
    processes.set(id, {
      ...found,
      state: "exited",
      exitCode: code,
      exitedAt: Date.now(),
    });
  } catch {
    // The exit promise rejected (process torn down with the runtime) — the
    // kill path or teardown owns the story in that case.
  }
}

/** The tool-facing record of one process, with its output tail */
export function processTail(id: string): ProcessEntry | { error: string } {
  const found = processes.get(id);
  if (!found) {
    const known = listProcesses().map((p) => `${p.id} (${p.command}, ${STATE_LABEL[p.state]})`);
    return {
      error:
        known.length > 0
          ? `No process matches "${id}". Running or known: ${known.join(", ")}.`
          : `No process matches "${id}" — no background process has been started.`,
    };
  }
  return toEntry(found);
}

/**
 * Stops one process. Stopping an exited or unknown process is REPORTED,
 * not an error: the caller asked for a state change, and "already gone"
 * is that state.
 */
export function stopProcess(id: string): { ok: boolean; state: ProcessState | null; message: string } {
  const found = processes.get(id);
  if (!found) {
    return { ok: false, state: null, message: `No process matches "${id}".` };
  }
  if (found.state === "exited" || found.state === "killed") {
    return { ok: true, state: found.state, message: `Process ${id} had already ${found.state}.` };
  }
  try {
    found.handle.kill();
  } catch {
    // Already gone — the exit recorder will reconcile the state.
  }
  update(id, { state: "killed", exitedAt: Date.now() });
  return { ok: true, state: "killed", message: `Process ${id} stopped.` };
}

/**
 * Ends every process when the workspace lease moves.
 *
 * Same driver and same reason as the preview's: the tree the processes were
 * started against is about to belong to another thread, and a watcher
 * answering from removed files produces verdicts about nothing. Kill is
 * best-effort per process; one failure does not stop the rest, and the
 * registry clears so the new lease starts clean.
 */
function handleWorkspaceReleased(event: { type: string; threadId?: string; reason?: string }): void {
  if (event.type !== "workspace-released") return;
  if (processes.size === 0) return;
  for (const p of processes.values()) {
    if (p.state === "exited" || p.state === "killed") continue;
    try {
      p.handle.kill();
    } catch {
      // Already gone.
    }
    update(p.id, { state: "killed", exitedAt: Date.now() });
  }
  processes.clear();
}

subscribeWorkspaceEvents(handleWorkspaceReleased);

/** Test seam: fire the release handler without a real runtime */
export function noteWorkspaceReleasedForTest(threadId: string, reason: string): void {
  handleWorkspaceReleased({ type: "workspace-released", threadId, reason });
}
