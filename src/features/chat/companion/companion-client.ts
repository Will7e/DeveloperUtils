// ============================================================
// Companion Client — The Page's Side Of The Local Runner
// ============================================================
// Same shape as the session-host client, and for the same reasons: a
// capability PROBE before any work, a version HANDSHAKE so a stale install is
// a named outcome rather than a subtle one, and every failure expressed as an
// outcome the caller must handle rather than an exception that escapes.
//
// The probe is deliberately tokenless (`/health`), because the question it
// answers — "is there a companion here at all?" — has to be answerable before
// the app has anything to send. Its absence is the normal case for most
// users, so the client never throws for it: `available: false` with a reason
// is what the agent needs in order to say "this change is unverified"
// honestly.
// ============================================================

import type { CompanionCapabilities as ProtocolCapabilities } from "./protocol";

export const COMPANION_DEFAULT_PORT = 5280;
export const COMPANION_DEFAULT_ORIGIN = `http://127.0.0.1:${COMPANION_DEFAULT_PORT}`;

/**
 * The protocol's own capability list, not a second copy of it: a hand-written
 * duplicate is how a capability the app asks about reads as "absent" from a
 * companion that answers yes.
 */
export type CompanionCapabilities = ProtocolCapabilities;

export interface CompanionProbe {
  available: boolean;
  origin: string;
  protocolVersion: number | null;
  capabilities: CompanionCapabilities | null;
  /** Why it is unavailable, in a sentence a user can act on */
  error?: string;
}

export interface CompanionExecRequest {
  origin: string;
  token: string;
  conversationId: string;
  command: string;
  /** Change set to write before running — the workspace's state on disk */
  writes: { path: string; content: string }[];
  deletes: string[];
  /** Base commit to check out, so the tree is the whole project */
  repo?: { url: string; ref: string };
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface CompanionExecOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  command: string;
  cwd: string;
  notes: string[];
}

export type CompanionExecResult =
  | { ok: true; outcome: CompanionExecOutcome }
  | { ok: false; error: string };

export interface CompanionDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * The turn's abort signal, so Stop reaches the request itself.
   *
   * Without it the loop only checked for an abort BETWEEN tools, and a
   * command may legitimately run for ten minutes — so pressing Stop during
   * `npm install` left the turn visibly working on a command the user had
   * just cancelled.
   */
  signal?: AbortSignal;
}

/** The saved pairing, as the settings store holds it. Every field optional. */
export interface SavedCompanion {
  origin?: string | null;
  token?: string | null;
}

/** Which source supplied the origin — the user is told, so a surprise is visible. */
export type CompanionCredentialSource = "env" | "settings" | "default";

export interface CompanionCredentials {
  /** Where the companion is, or null when this build has none */
  origin: string | null;
  /** The pairing token, or null when it is missing */
  token: string | null;
  /** Who supplied the origin (null when nothing did) */
  source: CompanionCredentialSource | null;
  /**
   * Why there is no usable pairing, in a sentence a user can act on, or null
   * when both halves are present. This used to be hardcoded null, so every
   * failure read as "no companion is running" at the call site — including
   * the case where one is running and only the token is missing, which is a
   * two-click fix and a totally different instruction.
   */
  error: string | null;
}

/** One instruction, used wherever the agent or the UI reports an unpaired build. */
export const COMPANION_UNPAIRED_HELP =
  "Pair a companion under Chat settings → Companion (start it with `npm run companion` and paste the token it prints), " +
  "or set VITE_COMPANION_ORIGIN and VITE_COMPANION_TOKEN.";

/**
 * Normalizes a user-supplied origin: trims, drops trailing slashes, and
 * refuses anything that is not an http(s) URL.
 *
 * Refused rather than passed through, because the origin is pasted from a
 * terminal and a typo would otherwise become a request to somewhere that
 * cannot exist — a failure that reads like the companion is down when the
 * real problem is a missing colon.
 */
export function normalizeCompanionOrigin(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return value.replace(/\/+$/, "");
}

/**
 * True when an origin is the machine the app is running on.
 *
 * Load-bearing for the settings copy: a loopback companion runs commands on
 * the user's own machine, while a remote one runs them somewhere else. Those
 * are different trust statements and the UI has to say which one is in play.
 */
export function isLoopbackOrigin(origin: string | null | undefined): boolean {
  const value = (origin ?? "").trim();
  if (!value) return true; // nothing configured is not a remote anything
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function envString(env: Record<string, unknown>, key: string): string {
  return typeof env[key] === "string" ? (env[key] as string).trim() : "";
}

/**
 * The origin and token to talk to a companion with.
 *
 * Resolution, in order, per half:
 *
 *   origin — `VITE_COMPANION_ORIGIN` → the saved pairing → the loopback
 *            default in development → nothing.
 *   token  — `VITE_COMPANION_TOKEN`    → the saved pairing → nothing.
 *
 * The env var wins because it is the dev-server override: a developer who
 * exported it should not have a saved pairing silently redirect their commands
 * somewhere else. The two halves resolve INDEPENDENTLY on purpose — the common
 * real setup is the default port with a token pasted once, and requiring both
 * from one source would make that look like no companion at all.
 *
 * Development still answers the default loopback port with no configuration at
 * all, because that is where the companion runs when a developer starts it by
 * hand; a hosted build does not, because a page cannot claim `127.0.0.1` on
 * someone else's machine.
 */
export async function companionCredentials(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>,
  saved: SavedCompanion | null | undefined = null
): Promise<CompanionCredentials> {
  const envOrigin = normalizeCompanionOrigin(envString(env, "VITE_COMPANION_ORIGIN"));
  const envToken = envString(env, "VITE_COMPANION_TOKEN");
  const savedOrigin = normalizeCompanionOrigin(saved?.origin);
  const savedToken = (saved?.token ?? "").trim();

  const origin = envOrigin ?? savedOrigin ?? (env.DEV === true ? COMPANION_DEFAULT_ORIGIN : null);
  const source: CompanionCredentialSource | null = envOrigin
    ? "env"
    : savedOrigin
      ? "settings"
      : env.DEV === true
        ? "default"
        : null;
  const token = envToken || savedToken || null;

  if (!origin) {
    return { origin: null, token, source: null, error: `No companion is paired with this app. ${COMPANION_UNPAIRED_HELP}` };
  }
  if (!token) {
    // One half present: named as what it is, because "no companion is running"
    // for a running companion whose token is missing sends the user to restart
    // a process that is already up.
    return {
      origin,
      token: null,
      source,
      error: `A companion is configured at ${origin} but no pairing token is set, so it will refuse every command. ${COMPANION_UNPAIRED_HELP}`,
    };
  }
  return { origin, token, source, error: null };
}

/**
 * `VITE_COMPANION_ORIGIN`, or the loopback default in development.
 *
 * Kept for callers that only need the address (the settings tab prefills from
 * it). Prefer `companionCredentials`, which resolves the token too and says
 * WHICH source answered.
 */
export function configuredCompanionOrigin(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): string | null {
  return normalizeCompanionOrigin(envString(env, "VITE_COMPANION_ORIGIN")) 
    ?? (env.DEV === true ? COMPANION_DEFAULT_ORIGIN : null);
}

/** Whether the build itself names a companion through the environment */
export function companionCredentialSource(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): CompanionCredentialSource | null {
  return envString(env, "VITE_COMPANION_ORIGIN") ? "env" : null;
}

/** Whether the companion is running, and which protocol version it speaks. */
export async function probeCompanion(
  origin: string | null = null,
  deps: CompanionDeps = {}
): Promise<CompanionProbe> {
  const doFetch = deps.fetch ?? fetch;
  if (!origin) {
    return {
      available: false,
      origin: "",
      protocolVersion: null,
      capabilities: null,
      error: `No companion is paired with this app. ${COMPANION_UNPAIRED_HELP}`,
    };
  }
  try {
    const res = await withTimeout(
      doFetch(`${origin}/health`, { method: "GET" }),
      deps.timeoutMs ?? 2_000
    );
    if (!res.ok) {
      return { available: false, origin, protocolVersion: null, capabilities: null, error: `The companion answered HTTP ${res.status}.` };
    }
    const payload = (await res.json()) as {
      ok?: boolean;
      protocolVersion?: number;
      capabilities?: CompanionCapabilities;
    };
    if (payload.ok !== true) {
      return { available: false, origin, protocolVersion: null, capabilities: null, error: "The companion did not identify itself." };
    }
    return {
      available: true,
      origin,
      protocolVersion: payload.protocolVersion ?? null,
      capabilities: payload.capabilities ?? null,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && /timed out/i.test(err.message);
    return {
      available: false,
      origin,
      protocolVersion: null,
      capabilities: null,
      error: isTimeout
        ? `Timed out reaching ${origin} after ${deps.timeoutMs ?? 2_000}ms.`
        : `Nothing is listening at ${origin}.`,
    };
  }
}

/**
 * Run one command in a materialized tree.
 *
 * A non-zero exit is a SUCCESSFUL call with a failing outcome: the failing
 * exit code is the result the agent asked for. Only transport and protocol
 * problems come back as `ok: false`.
 */
export async function runOnCompanion(
  request: CompanionExecRequest,
  deps: CompanionDeps = {}
): Promise<CompanionExecResult> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await withTimeout(
      doFetch(`${request.origin}/v1/exec`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-companion-token": request.token },
        ...(deps.signal ? { signal: deps.signal } : {}),
        body: JSON.stringify({
          type: "EXEC",
          id: `exec-${Date.now().toString(36)}`,
          conversationId: request.conversationId,
          command: request.command,
          writes: request.writes,
          deletes: request.deletes,
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.maxOutputChars !== undefined ? { maxOutputChars: request.maxOutputChars } : {}),
          ...(request.repo ? { repo: request.repo } : {}),
        }),
      }),
      // Generous: the command's own timeout is enforced on the companion, and
      // this one only exists so a wedged socket cannot hang the turn forever.
      deps.timeoutMs ?? 15 * 60_000
    );
  } catch (err) {
    if (deps.signal?.aborted) return { ok: false, error: STOPPED_BY_USER };
    return { ok: false, error: `Could not reach the companion: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `The companion refused the command (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}` };
  }
  const payload = (await res.json().catch(() => null)) as
    | { type?: string; outcome?: CompanionExecOutcome; error?: string }
    | null;
  if (!payload?.outcome) {
    return { ok: false, error: payload?.error ?? "The companion returned no result." };
  }
  return { ok: true, outcome: payload.outcome };
}

/** Write the change set without running anything — used before a first command. */
export async function materializeOnCompanion(
  request: Omit<CompanionExecRequest, "command" | "timeoutMs" | "maxOutputChars">,
  deps: CompanionDeps = {}
): Promise<{ ok: true; root: string; written: number; partial: boolean } | { ok: false; error: string }> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await withTimeout(
      doFetch(`${request.origin}/v1/materialize`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-companion-token": request.token },
        ...(deps.signal ? { signal: deps.signal } : {}),
        body: JSON.stringify({
          type: "MATERIALIZE",
          id: `mat-${Date.now().toString(36)}`,
          conversationId: request.conversationId,
          writes: request.writes,
          deletes: request.deletes,
          ...(request.repo ? { repo: request.repo } : {}),
        }),
      }),
      deps.timeoutMs ?? 5 * 60_000
    );
    if (!res.ok) return { ok: false, error: `The companion refused the change set (HTTP ${res.status}).` };
    const payload = (await res.json()) as {
      root?: string;
      written?: number;
      partial?: boolean;
      error?: string;
    };
    if (!payload.root) return { ok: false, error: payload.error ?? "The companion wrote no tree." };
    return { ok: true, root: payload.root, written: payload.written ?? 0, partial: payload.partial ?? true };
  } catch (err) {
    if (deps.signal?.aborted) return { ok: false, error: STOPPED_BY_USER };
    return { ok: false, error: `Could not reach the companion: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The user pressed Stop, so nothing ran to completion.
 *
 * Said in the words of the person who did it, rather than as a transport
 * failure: "could not reach the companion" would send the agent looking for
 * a daemon that is running fine.
 */
export const STOPPED_BY_USER = "Stopped by the user before it finished — nothing was verified.";

/** A fetch that cannot hang forever, since a dead daemon has no socket timeout. */
async function withTimeout(promise: Promise<Response>, ms: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
