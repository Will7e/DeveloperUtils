// ============================================================
// Session Protocol — Page ⇄ SharedWorker Message Contract
// ============================================================
// The session host (SharedWorker) owns the OpenRouter stream so a
// turn keeps running across page reloads and SPA navigation. Pages
// ATTACH to the host, receive a SNAPSHOT of the in-flight turn,
// then live deltas. Everything is plain structured-clone data —
// no functions, no class instances.
//
// The host owns ONE TURN PER CONVERSATION, and as many streams at
// once as the user has conversations running. That is why the
// snapshot is a question about a conversation rather than a peek at
// "the" turn, and why it carries the requestId of the ATTACH that
// asked: with several turns in flight, adopting the wrong one would
// render another chat's answer in this transcript.
//
// Versioned: HOST_PROTOCOL_VERSION. The client refuses to talk to
// a host speaking an incompatible version (mismatched bundles after
// a deploy with two tabs open).

import type { TurnLogEntry } from "./turn-log";

/**
 * 2 — the host became multi-turn (per-conversation admission, snapshot
 *     and status), which changed the ATTACH request and the SNAPSHOT and
 *     STATUS replies. A v1 page talking to a v2 host would ask for "the"
 *     turn and could adopt another conversation's stream, so the version
 *     bump is what makes the mixed-deploy case fall back safely instead
 *     of silently.
 */
export const HOST_PROTOCOL_VERSION = 2;

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
  /**
   * Asks for a conversation's turn replay. `conversationId` narrows the
   * question to one chat; without it the host answers with its newest
   * live turn. `requestId` is echoed on the SNAPSHOT reply, so a page
   * that asked about conversation C cannot be satisfied by conversation
   * D's stream — or by a snapshot still in flight from a previous ask.
   */
  | { type: "ATTACH"; requestId?: string; conversationId?: string }
  | { type: "DETACH" }
  | { type: "START_TURN"; payload: HostStartTurnPayload }
  | { type: "ABORT_TURN"; turnId: string }
  | { type: "HEARTBEAT" }
  | { type: "STATUS"; conversationId?: string };

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
  /** Prompt tokens served from the provider's cache (discounted) */
  cachedTokens?: number | null;
  /** Output tokens spent on reasoning (starvation detection) */
  reasoningTokens?: number | null;
  /** The upstream provider that actually answered (`X-Provider-Name`) */
  providerName?: string;
  /** OpenRouter's response-cache verdict, when the header was readable */
  cacheStatus?: string;
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
  /**
   * Model that produced the final output (or last attempt).
   *
   * This is the model that ANSWERED, not the one that was requested: with
   * in-request failover the two can differ, and OpenRouter reports the real one
   * in the stream. Attributing a reply to a model that did not write it is the
   * one lie a multi-model harness cannot afford.
   */
  modelId?: string;
  usage?: HostUsage;
  latencyMs?: number;
  /**
   * Structured reasoning blocks from this turn, for echo-back on the next
   * request (see `ChatMessage.reasoningDetails`). Carried on END because the
   * blocks are only complete once the stream is.
   */
  reasoningDetails?: unknown[];
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
  /** Replay state — the answer to an ATTACH, echoing the asker's requestId */
  | { type: "SNAPSHOT"; snapshot: HostSnapshot; requestId?: string }
  /** Correlated acknowledgement of a START_TURN that this port won */
  | { type: "TURN_STARTED"; turnId: string; snapshot: HostSnapshot }
  /**
   * START_TURN refused. No longer means "another conversation is
   * streaming" — that is now allowed — but "this conversation already
   * owns a live turn the host did not replace" (a duplicate turn id).
   * Retained rather than removed so a page never has to interpret an
   * unexplained silence as either success or failure.
   */
  | { type: "TURN_BUSY"; snapshot: HostSnapshot }
  | { type: "DELTA"; delta: HostDelta }
  | { type: "TOOL_CALLS"; payload: HostToolCalls }
  | { type: "USAGE"; turnId: string; modelId: string; usage: HostUsage }
  | {
      type: "STATUS";
      turnStatus: HostTurnStatus;
      turnId: string | null;
      /** Live turns in the host, across every conversation */
      liveTurns?: number;
    }
  | { type: "END"; payload: HostEndPayload }
  /**
   * The host's own turn-log entry, mirrored to the page so one
   * console handle shows the WHOLE turn — including the work that
   * happens inside the worker (attempts, failover, race decisions,
   * orphan aborts). Additive: old pages ignore it.
   */
  | { type: "LOG"; entry: TurnLogEntry };

/**
 * No SNAPSHOT is sent on HELLO any more, and that is deliberate: HELLO
 * is a protocol handshake with no conversation attached, so any snapshot
 * it carried was a guess — and with several turns live it would be an
 * ambiguous one. A page that wants replay names its conversation with
 * ATTACH, which is also the only place `requestId` can be correlated.
 */

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
