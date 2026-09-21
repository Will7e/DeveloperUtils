// ============================================================
// Session Protocol — Page ⇄ SharedWorker Message Contract
// ============================================================
// The session host (SharedWorker) owns the OpenRouter stream so a
// turn keeps running across page reloads and SPA navigation. Pages
// ATTACH to the host, receive a SNAPSHOT of the in-flight turn,
// then live deltas. Everything is plain structured-clone data —
// no functions, no class instances.
//
// Versioned: HOST_PROTOCOL_VERSION. The client refuses to talk to
// a host speaking an incompatible version (mismatched bundles after
// a deploy with two tabs open).

import type { TurnLogEntry } from "./turn-log";

export const HOST_PROTOCOL_VERSION = 1;

// ── Requests: page → host ───────────────────────────────────

/** One concrete model attempt the host may make, in priority order */
export interface HostCandidate {
  modelId: string;
  /** Context length for max_tokens resolution (0 when unknown) */
  contextLength?: number;
  /**
   * Per-request state (reasoning effort etc.), snapped by the page to
   * this model's declared OpenRouter capabilities and merged into the
   * request body verbatim. Empty/absent means "send no state keys".
   */
  requestState?: Record<string, unknown>;
}

export interface HostStartTurnPayload {
  /** Unique id for this user turn (generated client-side) */
  turnId: string;
  conversationId: string;
  apiKey: string;
  systemPrompt: string;
  temperature: number;
  maxTokens?: number;
  /** Wire-format messages (tool protocol fields allowed) */
  messages: unknown[];
  /** OpenAI tool definitions (agent mode) */
  tools?: unknown[];
  /**
   * Model attempts, in priority order. The page sends one entry per
   * turn (the model the user selected); the host walks the list on
   * retryable failures and surfaces the last error when it runs dry.
   * Nothing here swaps models silently.
   */
  candidates: HostCandidate[];
}

export type HostRequest =
  | { type: "HELLO"; protocolVersion: number }
  | { type: "ATTACH" }
  | { type: "DETACH" }
  | { type: "START_TURN"; payload: HostStartTurnPayload }
  | { type: "ABORT_TURN"; turnId: string }
  | { type: "HEARTBEAT" }
  | { type: "STATUS" };

// ── Events: host → page ─────────────────────────────────────

export type HostTurnStatus = "starting" | "streaming" | "ended";

/** Streaming delta; content and reasoning may both be non-empty */
export interface HostDelta {
  turnId: string;
  seq: number;
  content?: string;
  reasoning?: string;
}

/** Fully-assembled tool calls requested by the model */
export interface HostToolCalls {
  turnId: string;
  calls: unknown[];
}

export interface HostUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
}

/** Outcome kinds mirrored from the in-page loop */
export type HostEndReason =
  | "done"
  | "tool-calls"
  | "aborted"
  | "failed"
  | "exhausted";

export interface HostEndPayload {
  turnId: string;
  reason: HostEndReason;
  /** Error message when reason === "failed" */
  error?: string;
  /** Model that produced the final output (or last attempt) */
  modelId?: string;
  usage?: HostUsage;
  latencyMs?: number;
}

/**
 * Replay state for a page attaching mid-turn: everything it missed,
 * so the UI can hydrate its streaming store and render seamlessly.
 * Content is capped (see HOST_SNAPSHOT_MAX_CHARS) with the offset
 * the snapshot starts at, so late attachers know content exists
 * beyond what they received.
 */
export interface HostSnapshot {
  protocolVersion: number;
  turnId: string | null;
  status: HostTurnStatus;
  conversationId: string | null;
  /** Content BEFORE this offset was truncated away */
  contentFromOffset: number;
  content: string;
  reasoning: string;
  seq: number;
}

export type HostEvent =
  | { type: "HELLO_ACK"; protocolVersion: number; workerId: string }
  | { type: "PROTOCOL_MISMATCH"; hostVersion: number }
  /** Replay state — sent on HELLO/ATTACH (never as a start acknowledgement) */
  | { type: "SNAPSHOT"; snapshot: HostSnapshot }
  /** Correlated acknowledgement of a START_TURN that this port won */
  | { type: "TURN_STARTED"; turnId: string; snapshot: HostSnapshot }
  /** START_TURN refused: another conversation owns the host */
  | { type: "TURN_BUSY"; snapshot: HostSnapshot }
  | { type: "DELTA"; delta: HostDelta }
  | { type: "TOOL_CALLS"; payload: HostToolCalls }
  | { type: "USAGE"; turnId: string; modelId: string; usage: HostUsage }
  | { type: "STATUS"; turnStatus: HostTurnStatus; turnId: string | null }
  | { type: "END"; payload: HostEndPayload }
  /**
   * The host's own turn-log entry, mirrored to the page so one
   * console handle shows the WHOLE turn — including the work that
   * happens inside the worker (attempts, failover, race decisions,
   * orphan aborts). Additive: old pages ignore it.
   */
  | { type: "LOG"; entry: TurnLogEntry };

// ── Shared helpers ──────────────────────────────────────────

/** Validates an unknown object as a HostRequest (worker side) */
export function isHostRequest(data: unknown): data is HostRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { type?: unknown }).type === "string" &&
    [
      "HELLO",
      "ATTACH",
      "DETACH",
      "START_TURN",
      "ABORT_TURN",
      "HEARTBEAT",
      "STATUS",
    ].includes((data as { type: string }).type)
  );
}
