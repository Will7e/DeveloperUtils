// ============================================================
// Host Controller — Stream Ownership Inside the Session Host
// ============================================================
// Runs the model stream in the SharedWorker so it survives page
// reloads. ONE TURN PER CONVERSATION, and one stream per turn: the
// host is the app's multiplexer, so a second chat does not have to
// wait for the first, and never has to fall back to a page-local
// stream that dies with its tab.
//
// Responsibilities:
//
//  - admit turns per conversation (a second start for a conversation
//    that is already streaming replaces its turn — the reload path),
//    so unrelated conversations never block one another.
//  - walk the client-supplied candidate list on retryable
//    provider/network failures (retryable errors → next candidate;
//    key/credit errors → surface immediately).
//  - fan out deltas/tool-calls/usage to every attached page, plus a
//    replayable snapshot PER CONVERSATION for late attachers.
//  - orphan guard: if all pages detach (reload), grace-wait; if no
//    page re-attaches, abort that stream so a zombie stream can't
//    keep a paid model (or a free daily cap) burning. The guard is
//    per turn, because "the app is gone" and "this conversation has
//    no renderer" are different questions — a turn survives its page
//    navigating away by design, and is only reaped when nothing is
//    left to adopt it.
//
// The page owns model selection, so the candidate list is normally a
// single entry: the model the user actually chose. Provider-level
// failover within that model is OpenRouter's own job. Nothing here
// swaps models behind the user's back.
//
// Worker-safe by construction: no window/document/localStorage.

import {
  HOST_MAX_ATTEMPTS,
  HOST_ORPHAN_GRACE_MS,
  OUTPUT_RESERVE_TOKENS,
} from "../constants";
import { streamChat, OpenRouterError } from "../lib/openrouter-client";
import type { UsageInfo } from "../types";
import {
  HOST_PROTOCOL_VERSION,
  type HostCandidate,
  type HostEndReason,
  type HostStartTurnPayload,
} from "./protocol";
import { logTurnEvent } from "./turn-log";

/** Retryable provider/network failures — worth the next candidate */
function isRetryableModelError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // network-level failure
  if (!(err instanceof Error) || err.name === "AbortError") return false;
  if (err instanceof OpenRouterError) {
    return (
      err.status === 0 ||
      err.status === 200 ||
      err.status === 404 ||
      err.status === 408 ||
      err.status === 429 ||
      err.status >= 500
    );
  }
  return false;
}

/** Fan-out sink for host events (implemented by the worker shell) */
export interface HostEventSink {
  post(event: unknown): void;
  /** Number of live attached pages */
  readonly pageCount: number;
}

export interface ActiveTurn {
  turnId: string;
  conversationId: string;
  startedAt: number;
  status: "starting" | "streaming";
  controller: AbortController;
  apiKey: string;
  systemPrompt: string;
  temperature: number;
  maxTokens?: number;
  messages: unknown[];
  tools?: unknown[];
  candidates: HostCandidate[];
  /** Candidates already tried and failed */
  excluded: Set<string>;
  /** Completed delta seq counter (snapshot replay boundary) */
  seq: number;
  content: string;
  reasoning: string;
  /** Content chars dropped from the snapshot head (cap enforcement) */
  contentOffset: number;
  toolCalls: unknown[];
  usage: UsageInfo | null;
  winnerModelId: string | null;
  /** Last retryable-attempt error, surfaced if the list runs dry */
  lastError?: string;
  /** Per-turn orphan grace timer (armed only while no page is attached) */
  orphanTimer: ReturnType<typeof setTimeout> | null;
}

const SNAPSHOT_MAX_CHARS = 200_000;

/**
 * Core host state machine. Instantiated once per SharedWorker.
 * Event delivery is delegated to a HostEventSink so the shell stays
 * testable (unit tests inject a fake sink + fake stream fn).
 */
export class HostTurnController {
  /**
   * Live turns by turn id. A conversation has at most one (enforced in
   * `startTurn`), and unrelated conversations never touch each other's
   * entries — which is the whole point of the map.
   */
  private readonly turns = new Map<string, ActiveTurn>();

  constructor(
    private readonly sink: HostEventSink,
    /** Injectable stream fn (tests) — defaults to the real client */
    private readonly startStream: ((params: Parameters<typeof streamChat>[0]) => Promise<void>) = streamChat
  ) {}

  /** Newest live turn — what a caller with no conversation in mind means */
  get currentTurn(): Readonly<ActiveTurn> | null {
    return this.newest();
  }

  /** The live turn for one conversation, if that chat is streaming */
  turnFor(conversationId: string): Readonly<ActiveTurn> | null {
    for (const turn of this.turns.values()) {
      if (turn.conversationId === conversationId) return turn;
    }
    return null;
  }

  turnById(turnId: string): Readonly<ActiveTurn> | null {
    return this.turns.get(turnId) ?? null;
  }

  /** How many conversations are streaming right now */
  get liveTurnCount(): number {
    return this.turns.size;
  }

  private newest(): ActiveTurn | null {
    let best: ActiveTurn | null = null;
    for (const turn of this.turns.values()) {
      if (!best || turn.startedAt >= best.startedAt) best = turn;
    }
    return best;
  }

  private emit(event: unknown): void {
    this.sink.post(event);
  }

  // ── Turn lifecycle ─────────────────────────────────────────

  /**
   * Admits a turn and returns whether it was taken.
   *
   * Refused only when THIS conversation already has a live turn, or when
   * the turn id is already in flight. A different conversation is always
   * admitted: concurrency is the feature, not an accident.
   */
  startTurn(payload: HostStartTurnPayload): boolean {
    if (this.turnFor(payload.conversationId)) return false;
    if (this.turnById(payload.turnId)) return false;
    const turn: ActiveTurn = {
      turnId: payload.turnId,
      conversationId: payload.conversationId,
      startedAt: Date.now(),
      status: "starting",
      controller: new AbortController(),
      apiKey: payload.apiKey,
      systemPrompt: payload.systemPrompt,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      messages: payload.messages,
      tools: payload.tools,
      candidates: payload.candidates,
      excluded: new Set(),
      seq: 0,
      content: "",
      reasoning: "",
      contentOffset: 0,
      toolCalls: [],
      usage: null,
      winnerModelId: null,
      orphanTimer: null,
    };
    this.turns.set(turn.turnId, turn);
    logTurnEvent({
      turnId: payload.turnId,
      conversationId: payload.conversationId,
      phase: "turn-start",
      detail: `${payload.candidates.length} candidate(s) · ${this.turns.size} live`,
    });
    // Fire-and-forget: the turn ends via endTurn() when the loop resolves
    void this.runTurnLoop(turn);
    return true;
  }

  /**
   * Replaces the active turn with a re-send of the SAME conversation.
   * This is the reload recovery path: the old turn's output has no
   * renderer left (the original page died), and its orphan guard will
   * abort it anyway — keeping it would deadlock the host busy state
   * and force every new send into the "another conversation is
   * streaming" error. The replacement is instant: same id slot, new
   * payload, fresh loop.
   */
  replaceTurn(payload: HostStartTurnPayload): void {
    const current = this.turnFor(payload.conversationId);
    if (!current) {
      this.startTurn(payload);
      return;
    }
    current.controller.abort();
    logTurnEvent({
      turnId: current.turnId,
      conversationId: current.conversationId,
      phase: "abort",
      detail: "replaced by re-sent turn after reload",
    });
    // Removed here rather than left to the aborted loop's endTurn, so the
    // conversation's slot is free the instant the replacement starts.
    this.clearOrphanTimer(current);
    this.turns.delete(current.turnId);
    this.startTurn(payload);
  }

  /**
   * Aborts ONE turn by id. Other conversations keep streaming — an abort
   * is the user's stop button, and pressing it in one chat must not stop
   * the work they left running in another.
   */
  abortTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.controller.abort();
    logTurnEvent({ turnId, conversationId: turn.conversationId, phase: "abort" });
  }

  /**
   * Snapshot for a (re)attaching page: buffered content, reasoning,
   * tool calls, and the seq boundary for delta replay.
   */
  /**
   * Snapshot for a (re)attaching page: buffered content, reasoning,
   * tool calls, and the seq boundary for delta replay.
   *
   * `conversationId` selects WHICH turn to describe. It is not optional
   * in spirit — a page adopting conversation C must be given C's stream —
   * but a caller that omits it gets the newest live turn, which is what
   * the single-turn host always meant.
   */
  snapshot(conversationId?: string) {
    const a = conversationId ? this.turnFor(conversationId) : this.newest();
    if (!a) {
      return {
        protocolVersion: HOST_PROTOCOL_VERSION,
        turnId: null,
        status: "ended" as const,
        conversationId: null,
        contentFromOffset: 0,
        content: "",
        reasoning: "",
        seq: 0,
      };
    }
    return {
      protocolVersion: HOST_PROTOCOL_VERSION,
      turnId: a.turnId,
      status: a.status,
      conversationId: a.conversationId,
      contentFromOffset: a.contentOffset,
      content: a.content,
      reasoning: a.reasoning,
      seq: a.seq,
    };
  }

  status(conversationId?: string) {
    const turn = conversationId ? this.turnFor(conversationId) : this.currentTurn;
    return {
      hasTurn: turn !== null,
      turnId: turn?.turnId ?? null,
      liveTurns: this.turns.size,
    };
  }

  /** Page count changed — arm/disarm every turn's orphan guard */
  setPageCount(count: number): void {
    for (const turn of this.turns.values()) {
      if (count > 0) this.clearOrphanTimer(turn);
      else this.armOrphanGuard(turn);
    }
  }

  private armOrphanGuard(turn: ActiveTurn): void {
    this.clearOrphanTimer(turn);
    turn.orphanTimer = setTimeout(() => {
      // Re-check at expiry: the turn may have ended, or a page may have
      // attached, in the grace window.
      if (this.turns.get(turn.turnId) !== turn) return;
      if (this.sink.pageCount > 0) return;
      logTurnEvent({
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        phase: "orphan-abort",
      });
      turn.controller.abort();
    }, HOST_ORPHAN_GRACE_MS);
  }

  private clearOrphanTimer(turn: ActiveTurn): void {
    if (turn.orphanTimer !== null) {
      clearTimeout(turn.orphanTimer);
      turn.orphanTimer = null;
    }
  }

  // ── The turn loop (candidate walk) ─────────────────────────

  /**
   * The candidate walk for ONE turn. It takes the turn as an argument
   * rather than reading shared state: with several conversations
   * streaming, "the active turn" is exactly the variable that must not
   * exist, or one loop's decisions land on another's stream.
   */
  private async runTurnLoop(turn: ActiveTurn): Promise<void> {
    const startedAt = Date.now();
    // Bounded walk: without a cap a dead provider list means minutes
    // of silent retrying before the turn says anything.
    const maxAttempts = Math.min(turn.candidates.length, HOST_MAX_ATTEMPTS);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (turn.controller.signal.aborted) {
        this.endTurn(turn, "aborted");
        return;
      }

      const candidate = turn.candidates[attempt];
      if (!candidate || turn.excluded.has(candidate.modelId)) continue;

      turn.status = "starting";
      logTurnEvent({
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        phase: "model-attempt",
        modelId: candidate.modelId,
        detail: `attempt ${attempt + 1}/${maxAttempts}`,
      });

      try {
        await this.streamOneAttempt(turn, candidate);
        // Stream completed without throwing. A completion that asked
        // for tools ends the host turn here — tool EXECUTION lives in
        // the page (workspace, verification, push gate), and the page's
        // agent loop starts the next host round with the results.
        const winner = turn.winnerModelId ?? candidate.modelId;
        if (turn.toolCalls.length > 0) {
          this.endTurn(turn, "tool-calls", winner, startedAt);
        } else {
          this.endTurn(turn, "done", winner, startedAt);
        }
        return;
      } catch (err) {
        if (turn.controller.signal.aborted) {
          this.endTurn(turn, "aborted", candidate.modelId, startedAt);
          return;
        }
        if (!isRetryableModelError(err)) {
          this.endTurn(turn, "failed", candidate.modelId, startedAt, err);
          return;
        }
        // Retryable — exclude and try the next candidate.
        turn.excluded.add(candidate.modelId);
        turn.lastError = err instanceof Error ? err.message : "unknown error";
        logTurnEvent({
          turnId: turn.turnId,
          conversationId: turn.conversationId,
          phase: "failover",
          modelId: candidate.modelId,
          detail: err instanceof Error ? err.message : "unknown error",
        });
      }
    }

    // List exhausted — surface WHY (rate limit, outage…) rather than a
    // generic give-up message.
    this.endTurn(
      turn,
      "exhausted",
      turn.winnerModelId ?? undefined,
      startedAt,
      turn.lastError ? new Error(turn.lastError) : undefined
    );
  }

  /**
   * Streams one candidate to completion (tool calls included in the
   * completion — tool EXECUTION stays in the page where the workspace
   * lives). Deltas flow straight through: there is no second racing
   * stream, so nothing needs buffering.
   */
  private async streamOneAttempt(turn: ActiveTurn, candidate: HostCandidate): Promise<void> {
    turn.winnerModelId = candidate.modelId;
    turn.status = "streaming";
    const modelId = candidate.modelId;
    const contextLength = candidate.contextLength;

    await this.startStream({
      apiKey: turn.apiKey,
      model: modelId,
      messages: turn.messages as Parameters<typeof streamChat>[0]["messages"],
      systemPrompt: turn.systemPrompt,
      temperature: turn.temperature,
      maxTokens: contextLength
        ? Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(contextLength * 0.1))
        : OUTPUT_RESERVE_TOKENS,
      tools: turn.tools as Parameters<typeof streamChat>[0]["tools"],
      requestUsage: true,
      requestState: candidate.requestState,
      signal: turn.controller.signal,
      onChunk: (chunk) => this.appendDelta(turn, { content: chunk }),
      onReasoning: (chunk) => this.appendDelta(turn, { reasoning: chunk }),
      onToolCalls: (calls) => {
        turn.toolCalls = calls;
        this.emit({ type: "TOOL_CALLS", payload: { turnId: turn.turnId, calls } });
      },
      onUsage: (usage) => {
        turn.usage = usage;
        this.emit({ type: "USAGE", turnId: turn.turnId, modelId, usage });
      },
    });
  }

  /** Buffered append + fan-out of one delta */
  private appendDelta(
    turn: ActiveTurn,
    delta: { content?: string; reasoning?: string }
  ): void {
    if (delta.content) {
      turn.content += delta.content;
      // Snapshot cap: drop head content when the buffer overflows
      if (turn.content.length > SNAPSHOT_MAX_CHARS) {
        const drop = turn.content.length - SNAPSHOT_MAX_CHARS;
        turn.content = turn.content.slice(drop);
        turn.contentOffset += drop;
      }
    }
    if (delta.reasoning) turn.reasoning += delta.reasoning;
    turn.seq += 1;
    this.emit({ type: "DELTA", delta: { turnId: turn.turnId, seq: turn.seq, ...delta } });
  }

  /** Terminal transition: emit END and clear active state */
  private endTurn(
    turn: ActiveTurn,
    reason: HostEndReason,
    modelId?: string,
    startedAt?: number,
    err?: unknown
  ): void {
    if (err) {
      logTurnEvent({
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        phase: "error",
        modelId,
        detail: err instanceof Error ? err.message : "unknown",
      });
    }
    logTurnEvent({
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      phase: "stream-end",
      modelId,
      detail: reason,
    });
    this.emit({
      type: "END",
      payload: {
        turnId: turn.turnId,
        reason,
        error: err instanceof Error ? err.message : undefined,
        modelId: modelId ?? turn.winnerModelId ?? undefined,
        usage: turn.usage
          ? {
              promptTokens: turn.usage.promptTokens,
              completionTokens: turn.usage.completionTokens,
              cost: turn.usage.cost,
              cachedTokens: turn.usage.cachedTokens ?? null,
            }
          : undefined,
        latencyMs: startedAt ? Date.now() - startedAt : undefined,
      },
    });
    this.clearOrphanTimer(turn);
    // Only ever removes its OWN entry: a replacement turn for the same
    // conversation has already taken the slot, and must not be evicted by
    // the aborted turn it replaced.
    if (this.turns.get(turn.turnId) === turn) this.turns.delete(turn.turnId);
  }
}

/** Shape of an active turn exposed for tests (no AbortController) */
export type ActiveTurnSummary = Pick<
  ActiveTurn,
  "turnId" | "status" | "content" | "reasoning" | "excluded" | "winnerModelId"
>;
