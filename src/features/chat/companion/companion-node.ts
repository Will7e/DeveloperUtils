// ============================================================
// Companion Node Adapter — The Part That Touches The Machine
// ============================================================
// Two jobs: turn a plan into a directory, and run a command in it.
//
// Everything here is deliberately boring, because it is the only code in the
// product that writes files and starts processes on a user's own computer:
//
//   • containment is checked AGAIN here, against the resolved absolute path.
//     ./materialize-plan.ts already refused `../`, but a check that relies
//     on a caller's validation is a check that disappears the first time a
//     new caller appears.
//   • a command runs in its OWN PROCESS GROUP and is killed as a group. Only
//     killing the shell leaves the build it started running — which is how a
//     "cancelled" command keeps burning a laptop's battery for an hour.
//   • output is capped BEFORE it is held, not after: a runaway command that
//     prints a gigabyte must not become a gigabyte in memory first.
//
// The clock is passed in where it matters, so tests do not depend on timing.
// ============================================================

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveOutputLimit,
  resolveTimeout,
  shellArgs,
  shellFor,
  shapeOutput,
  type ExecOutcome,
} from "./protocol.ts";

export interface MaterializeTarget {
  writes: readonly { path: string; content: string }[];
  deletes: readonly string[];
}

export interface MaterializeResult {
  root: string;
  written: number;
  deleted: number;
  bytes: number;
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Extra notes carried into the outcome (materialization rejections, etc.) */
  notes?: readonly string[];
  /** Injected for tests */
  platform?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * Throws unless `target` is inside `root`.
 *
 * `path.relative` is the check rather than a string prefix, because a prefix
 * test passes for `/tmp/tree-evil` when the root is `/tmp/tree`.
 */
export function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "") return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to touch ${target}: it is outside ${root}.`);
  }
}

/**
 * A directory name that cannot escape its parent, whatever the input.
 *
 * Dots are dropped rather than escaped: a segment built from `../../etc`
 * still contains `..` even when every `/` became `_`, and while `path.join`
 * would never treat it as traversal, requiring a reader to know that is a
 * worse guarantee than not producing the string at all. Conversation ids are
 * uuids, so nothing legitimate is lost.
 */
export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.slice(0, 64) || "workspace";
}

/** The throwaway directory one conversation's tree lives in. */
export function treeRootFor(baseDir: string, conversationId: string): string {
  return path.join(baseDir, safeSegment(conversationId));
}

/**
 * Write a planned tree to disk.
 *
 * Deletions are applied first: a renamed file whose new path sits inside an
 * old directory that is about to be removed would otherwise be deleted after
 * being written.
 */
export async function materializeTree(
  root: string,
  target: MaterializeTarget
): Promise<MaterializeResult> {
  await mkdir(root, { recursive: true });
  let deleted = 0;
  for (const rel of target.deletes) {
    const absolute = path.resolve(root, rel);
    assertInside(root, absolute);
    await rm(absolute, { force: true, recursive: true });
    deleted += 1;
  }
  let written = 0;
  let bytes = 0;
  for (const file of target.writes) {
    const absolute = path.resolve(root, file.path);
    assertInside(root, absolute);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, "utf8");
    written += 1;
    bytes += file.content.length;
  }
  return { root, written, deleted, bytes };
}

/** Remove a tree entirely (the conversation ended, or the session did). */
export async function removeTree(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/**
 * Run one command line, capturing its output.
 *
 * Never rejects for a failing command: an exit code of 1 is a RESULT, and it
 * is the single most useful thing the agent can be told. It rejects only
 * when the shell itself cannot be started, which is a companion problem
 * rather than a repository one.
 */
export function runCommand(options: RunCommandOptions): Promise<ExecOutcome> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const started = now();
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const outputLimit = resolveOutputLimit(options.maxOutputChars);
  const shell = shellFor(platform, env);

  return new Promise<ExecOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, shellArgs(options.command, platform), {
        cwd: options.cwd,
        env: env as NodeJS.ProcessEnv,
        // Its own process group, so the kill below reaches the whole tree of
        // grandchildren a build spawns rather than just the shell.
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        truncated: false,
        durationMs: now() - started,
        command: options.command,
        cwd: options.cwd,
        notes: [...(options.notes ?? [])],
      });
      return;
    }

    const hardStop = outputLimit * 2;
    let out = "";
    let err = "";
    let droppedOut = 0;
    let droppedErr = 0;
    let settled = false;
    let timedOut = false;

    const keep = (buffer: string, chunk: string): [string, number] => {
      if (buffer.length >= hardStop) return [buffer, chunk.length];
      const room = hardStop - buffer.length;
      if (chunk.length <= room) return [buffer + chunk, 0];
      return [buffer + chunk.slice(0, room), chunk.length - room];
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, platform);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const [next, dropped] = keep(out, chunk.toString("utf8"));
      out = next;
      droppedOut += dropped;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const [next, dropped] = keep(err, chunk.toString("utf8"));
      err = next;
      droppedErr += dropped;
    });

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const shapedOut = shapeOutput(out, outputLimit);
      const shapedErr = shapeOutput(err, outputLimit);
      const notes = [...(options.notes ?? [])];
      if (droppedOut > 0 || droppedErr > 0) {
        notes.push(
          `Output was discarded past ${hardStop} characters (${droppedOut + droppedErr} not kept).`
        );
      }
      resolve({
        exitCode,
        signal,
        stdout: shapedOut.text,
        stderr: shapedErr.text,
        timedOut,
        truncated: shapedOut.truncated || shapedErr.truncated || droppedOut + droppedErr > 0,
        durationMs: now() - started,
        command: options.command,
        cwd: options.cwd,
        notes,
      });
    };

    // `close` rather than `exit`: it fires once stdio is drained, so the last
    // line a failing test wrote is never missing from the report.
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (err2) => {
      err += `\n${err2.message}`;
      finish(null, null);
    });
  });
}

/**
 * Kill the shell AND everything it started.
 *
 * A negative pid addresses the process group, which is the only way to stop
 * `npm test`'s children. If the group is gone (or this is Windows, where the
 * distinction does not exist) the direct kill is the fallback — and a
 * failure to kill is not rethrown, because the command's outcome still has
 * to reach the caller.
 */
function killGroup(child: ReturnType<typeof spawn>, platform: string): void {
  if (child.pid === undefined) return;
  try {
    if (platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
