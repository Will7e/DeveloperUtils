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
   * Per-model request state (reasoning effort etc.), snapped by the
   * page to this model's declared OpenRouter capabilities. Survives
   * reroutes because the reply re-resolves candidates page-side.
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
   * Ranked model attempts. The host walks the list on retryable
   * failures exactly like the in-page InTab loop; when the list is
   * exhausted it asks the page for a fresh one (REROUTE_NEEDED).
   */
  candidates: HostCandidate[];
  /** Hedge delay override (tests); defaults to host constant */
  hedgeTriggerMs?: number;
  /** Task-kind classification (echoed in telemetry for the learning router) */
  turnKind?: string;
  /**
   * Per-candidate request state (reasoning effort etc.), snapped by
   * the page to each model's declared OpenRouter capabilities.
   * The host merges `requestStateByModel[candidateId]` into that
   * candidate's request body. Additive optional field —
   * structured-clone-safe, no protocol bump needed.
   */
  requestStateByModel?: Record<string, Record<string, unknown>>;
}

export type HostRequest =
  | { type: "HELLO"; protocolVersion: number }
  | { type: "ATTACH" }
  | { type: "DETACH" }
  | { type: "START_TURN"; payload: HostStartTurnPayload }
  | { type: "ABORT_TURN"; turnId: string }
  | { type: "HEARTBEAT" }
  | { type: "REROUTE_REPLY"; turnId: string; candidates: HostCandidate[] }
  | { type: "STATUS" };

// ── Events: host → page ─────────────────────────────────────

export type HostTurnStatus = "starting" | "streaming" | "reroute" | "ended";

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
  | "exhausted"
  | "reroute-needed";

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

/** Learning-router event the host observed; the page persists it */
export interface HostTelemetryEvent {
  turnId: string;
  /** Task-kind the turn was classified as (learning-router key) */
  turnKind: string;
  kind:
    | { type: "modelSuccess"; modelId: string }
    | { type: "modelFailure"; modelId: string; reason: "rate" | "hard" | "daily" | "slow"; headers?: Record<string, string> }
    | { type: "dailyRequest"; modelId: string }
    | { type: "turnSuccess"; modelId: string }
    | { type: "turnEmpty"; modelId: string }
    | { type: "turnAbort"; modelId: string }
    | { type: "turnFailover"; modelId: string };
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
  | { type: "REROUTE_NEEDED"; turnId: string; excluded: string[] }
  | { type: "TELEMETRY"; event: HostTelemetryEvent }
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
      "REROUTE_REPLY",
      "STATUS",
    ].includes((data as { type: string }).type)
  );
}
