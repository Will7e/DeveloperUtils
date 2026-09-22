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
}

/**
 * The origin and token to talk to a companion with.
 *
 * The pairing token is printed by the companion at startup and pasted into
 * `VITE_COMPANION_TOKEN`; `VITE_COMPANION_ORIGIN` names where it listens. A
 * build without the token simply has no companion, which is the safe default
 * — the agent then says its change is unverified instead of hanging.
 */
export async function companionCredentials(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): Promise<{ origin: string | null; token: string | null; error: string | null }> {
  const envToken = configuredCompanionToken(env);
  const envOrigin = configuredCompanionOrigin(env);
  return { origin: envOrigin, token: envToken || null, error: null };
}

/**
 * The pairing token, from `VITE_COMPANION_TOKEN`.
 *
 * Environment rather than settings for now: the token is printed by the
 * companion at startup and pasted once, and putting it in the encrypted
 * settings store (with the UI that implies) is its own change. Until then a
 * build without it simply cannot drive a companion, which is the safe
 * default rather than a silent half-configuration.
 */
export function configuredCompanionToken(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): string {
  return typeof env.VITE_COMPANION_TOKEN === "string"
    ? (env.VITE_COMPANION_TOKEN as string).trim()
    : "";
}

/**
 * `VITE_COMPANION_ORIGIN`, or the loopback default in development.
 *
 * Production with no variable set returns null rather than a URL that cannot
 * exist: a hosted page cannot reach `127.0.0.1` on the *user's* machine, so
 * claiming an origin there would turn "no companion" into a timeout.
 */
export function configuredCompanionOrigin(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): string | null {
  const explicit =
    typeof env.VITE_COMPANION_ORIGIN === "string" ? (env.VITE_COMPANION_ORIGIN as string).trim() : "";
  if (explicit) return explicit.replace(/\/+$/, "");
  return env.DEV === true ? COMPANION_DEFAULT_ORIGIN : null;
}

/** Whether the companion is running, and which protocol version it speaks. */
export async function probeCompanion(
  origin: string | null = configuredCompanionOrigin(),
  deps: CompanionDeps = {}
): Promise<CompanionProbe> {
  const doFetch = deps.fetch ?? fetch;
  if (!origin) {
    return {
      available: false,
      origin: "",
      protocolVersion: null,
      capabilities: null,
      error: "No companion origin is configured for this build.",
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
  } catch {
    return {
      available: false,
      origin,
      protocolVersion: null,
      capabilities: null,
      error: `Nothing is listening at ${origin}.`,
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
    return { ok: false, error: `Could not reach the companion: ${err instanceof Error ? err.message : String(err)}` };
  }
}

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
