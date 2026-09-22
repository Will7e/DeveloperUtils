// ============================================================
// Companion Protocol — A Versioned Contract For A Local Runner
// ============================================================
// The companion is a process on the user's own machine that materializes a
// workspace and runs commands in it. It is the same shape of thing as the
// session host: a long-lived worker the page does not own, reached through
// a handshake that can FAIL VISIBLY.
//
// The handshake is not ceremony. A companion from an older install will
// happily answer a newer page, and the failure that produces is the worst
// kind: the request appears to succeed and the behaviour is subtly wrong.
// So both sides state a version, and a mismatch is a named outcome
// (`PROTOCOL_MISMATCH`) rather than a guess.
//
// Every message is validated at the boundary. The transport is loopback and
// paired, but a companion is a place where untrusted-adjacent input (an
// agent-authored command, a change set derived from model edits) arrives at
// a process that can run programs — so "it can only come from us" is an
// assumption that gets checked rather than assumed.
// ============================================================

/**
 * The version both sides state, so a mismatch is a named outcome rather than
 * a subtly wrong success. Bumped whenever a message or capability is added:
 * an older companion would answer a newer request with "not a request this
 * protocol understands" — true, and an answer that reads like the app is
 * broken. Stated, it reads like what it is: restart the companion.
 */
export const COMPANION_PROTOCOL_VERSION = 1;

/** Largest command output kept for the model (the rest is elided, not lost) */
export const COMPANION_MAX_OUTPUT_CHARS = 20_000;
/** A command may not run longer than this without being killed */
export const COMPANION_DEFAULT_TIMEOUT_MS = 120_000;
/** Hard ceiling on a single command's runtime, whatever the caller asks */
export const COMPANION_MAX_TIMEOUT_MS = 600_000;

export interface CompanionCapabilities {
  /** The companion will execute commands at all */
  exec: boolean;
  /** The companion can materialize a working tree */
  materialize: boolean;
  /** `process.platform` of the machine it runs on */
  platform: string;
  /** The shell a command line is handed to */
  shell: string;
  /** Directories the companion will write and run inside — and no others */
  roots: string[];
}

export interface CompanionHello {
  type: "HELLO";
  protocolVersion: number;
  /** Stable id so a restarted companion is distinguishable from a live one */
  clientId?: string;
}

export interface CompanionHelloAck {
  type: "HELLO_ACK";
  protocolVersion: number;
  capabilities: CompanionCapabilities;
}

export interface CompanionMismatch {
  type: "PROTOCOL_MISMATCH";
  /** What the companion speaks */
  protocolVersion: number;
  /** What it received */
  expected: number;
}

/**
 * The repository a tree should be a checkout OF.
 *
 * A change set alone produces a PARTIAL tree — only the files the workspace
 * happened to touch — which is enough to lint one file and a lie for a test
 * suite. With this, the companion clones the base commit first, so the tree
 * is the whole project and `npm test` means what it means locally.
 *
 * The url carries a scoped token because that is how git authenticates to a
 * private repository without a credential helper on the user's machine. It
 * travels only over loopback, to a process the user started themselves.
 */
export interface CompanionRepoRef {
  url: string;
  /** Commit sha or branch to check out */
  ref: string;
}

export interface MaterializeMessage {
  type: "MATERIALIZE";
  id: string;
  /** Conversation this tree belongs to — one tree per conversation */
  conversationId: string;
  writes: { path: string; content: string }[];
  deletes: string[];
  repo?: CompanionRepoRef;
}

export interface ExecMessage {
  type: "EXEC";
  id: string;
  conversationId: string;
  /** Run in this conversation's materialized tree */
  command: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  repo?: CompanionRepoRef;
  /**
   * The workspace state to write before running. Without this a command
   * would run against the pristine checkout and report on code the agent
   * never wrote — a green build for a change that does not exist.
   */
  writes?: { path: string; content: string }[];
  deletes?: string[];
}

export interface ReleaseMessage {
  type: "RELEASE";
  id: string;
  conversationId: string;
}

export type CompanionRequest =
  | CompanionHello
  | MaterializeMessage
  | ExecMessage
  | ReleaseMessage;

export interface ExecOutcome {
  /** null when the process was killed by a signal */
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Killed because it exceeded its timeout */
  timedOut: boolean;
  /** Output was elided to the character ceiling */
  truncated: boolean;
  durationMs: number;
  /** The command, echoed back so a result is never orphaned from its line */
  command: string;
  /** Where it ran, for the record */
  cwd: string;
  /** Rejections from the materialization this command depended on */
  notes: string[];
}

export type CompanionResult =
  | {
      type: "MATERIALIZED";
      id: string;
      root: string;
      written: number;
      deleted: number;
      bytes: number;
      rejected: string[];
    }
  | { type: "EXEC_RESULT"; id: string; outcome: ExecOutcome }
  | { type: "RELEASED"; id: string }
  | { type: "COMPANION_ERROR"; id: string; error: string };

export type CompanionEvent = CompanionHelloAck | CompanionMismatch | CompanionResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/**
 * Whether an inbound message is one this protocol version understands.
 *
 * Deliberately strict about shape and lenient about nothing: an `EXEC` with
 * no command is a bug on the far side, and treating it as an empty command
 * would run a shell for no reason.
 */
export function isCompanionRequest(value: unknown): value is CompanionRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "HELLO":
      return typeof value.protocolVersion === "number";
    case "MATERIALIZE":
      return (
        isId(value.id) &&
        isId(value.conversationId) &&
        Array.isArray(value.writes) &&
        value.writes.every(
          (w) => isRecord(w) && typeof w.path === "string" && typeof w.content === "string"
        ) &&
        (value.deletes === undefined ||
          (Array.isArray(value.deletes) && value.deletes.every((d) => typeof d === "string")))
      );
    case "EXEC":
      return (
        isId(value.id) &&
        isId(value.conversationId) &&
        typeof value.command === "string" &&
        value.command.trim().length > 0 &&
        (value.writes === undefined ||
          (Array.isArray(value.writes) &&
            value.writes.every(
              (w) => isRecord(w) && typeof w.path === "string" && typeof w.content === "string"
            )))
      );
    case "RELEASE":
      return isId(value.id) && isId(value.conversationId);
    default:
      return false;
  }
}

/** The shell a command line is handed to on this platform. */
export function shellFor(platform: string, env: Record<string, string | undefined>): string {
  if (platform === "win32") return env.ComSpec ?? "cmd.exe";
  return env.SHELL && /^\/[^\s]+$/.test(env.SHELL) ? env.SHELL : "/bin/sh";
}

/** Args that turn a shell string into an executed command line. */
export function shellArgs(command: string, platform: string): string[] {
  return platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
}

/**
 * A timeout clamped to the protocol's own ceiling.
 *
 * A caller cannot ask for a command that runs forever, and it cannot ask for
 * a negative or absurd one either — a NaN here would become
 * `setTimeout(fn, NaN)`, which fires immediately and kills a legitimate
 * build in the first millisecond.
 */
export function resolveTimeout(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return COMPANION_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(requested), COMPANION_MAX_TIMEOUT_MS);
}

/** The output ceiling, clamped the same way. */
export function resolveOutputLimit(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 200) {
    return COMPANION_MAX_OUTPUT_CHARS;
  }
  return Math.min(Math.floor(requested), COMPANION_MAX_OUTPUT_CHARS * 4);
}

/**
 * Output a model is shown, with the elision STATED.
 *
 * Silence about truncation is what makes an agent conclude a failing test
 * passed: the exit line was in the part nobody kept.
 */
export function shapeOutput(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(text.length - Math.floor(limit * 0.3));
  return {
    text: `${head}\n… ${text.length - limit} characters elided …\n${tail}`,
    truncated: true,
  };
}
