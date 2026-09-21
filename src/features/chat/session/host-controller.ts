// ============================================================
// Host Controller — Stream Ownership Inside the Session Host
// ============================================================
// Runs the model stream in the SharedWorker so it survives page
// reloads. One active turn at a time. Responsibilities:
//
//  - walk the client-ranked candidate list with the same retry
//    semantics as the in-page InTab loop (retryable provider/network
//    failures → next candidate; key/credit errors → surface).
//  - hedge for time-to-first-token across the top two candidates
//    (reuses lib/stream-race, which is DOM-free).
//  - ask the page for fresh candidates when the list is exhausted
//    mid-turn (REROUTE) — learning-router memory lives in the page.
//  - fan out deltas/tool-calls/usage/telemetry to every attached
//    page, plus a replayable snapshot for late attachers.
//  - orphan guard: if all pages detach (reload), grace-wait; if no
//    page re-attaches, abort the stream so free-tier daily caps
//    aren't burned by a zombie stream.
//
// Worker-safe by construction: no window/document/localStorage.

import {
  HOST_MAX_ATTEMPTS,
  HOST_ORPHAN_GRACE_MS,
  HOST_HEDGE_TRIGGER_MS,
  OUTPUT_RESERVE_TOKENS,
} from "../constants";
import { streamChat, OpenRouterError } from "../lib/openrouter-client";
import { raceStreams } from "../lib/stream-race";
import { recordModelFailure, recordModelSuccess } from "../lib/intab-llm";
import type { ToolCallRequest, UsageInfo } from "../types";
import type {
  HostCandidate,
  HostEndReason,
  HostStartTurnPayload,
  HostTelemetryEvent,
} from "./protocol";
import { logTurnEvent } from "./turn-log";

/** Retryable provider/network failures — mirrors the in-page loop */
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

function isRateLimitError(err: unknown): boolean {
  return err instanceof OpenRouterError && err.status === 429;
}

/** Daily-cap heuristic (mirrors the in-page loop) */
function isDailyCapFailure(err: unknown): boolean {
  if (!isRateLimitError(err)) return false;
  const oerr = err as OpenRouterError;
  const headers = oerr.rateLimitHeaders;
  if (headers) {
    const raw =
      headers["x-ratelimit-reset"] ??
      headers["x-ratelimit-limit-reqs-reset"] ??
      headers["x-ratelimit-limit-tokens-reset"] ??
      headers["retry-after"];
    if (raw) {
      const iso = Date.parse(raw);
      const delayMs = Number.isNaN(iso) ? parseFloat(raw) * 1000 : iso - Date.now();
      if (Number.isFinite(delayMs) && delayMs >= 30 * 60_000) return true;
    }
  }
  return /free-model|daily|per-day/i.test(oerr.message);
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
  status: "starting" | "streaming" | "reroute";
  controller: AbortController;
  apiKey: string;
  systemPrompt: string;
  temperature: number;
  maxTokens?: number;
  /** Per-candidate tier state snapped to each model's capabilities */
  requestStateByModel?: Record<string, Record<string, unknown>>;
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
  telemetryQueue: HostTelemetryEvent[];
  turnKind: string;
  /** Last retryable-attempt error, surfaced if the pool runs dry */
  lastError?: string;
}

const SNAPSHOT_MAX_CHARS = 200_000;

/**
 * Core host state machine. Instantiated once per SharedWorker.
 * Event delivery is delegated to a HostEventSink so the shell stays
 * testable (unit tests inject a fake sink + fake stream fn).
 */
export class HostTurnController {
  private active: ActiveTurn | null = null;
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sink: HostEventSink,
    /** Injectable stream fn (tests) — defaults to the real client */
    private readonly startStream: ((params: Parameters<typeof streamChat>[0]) => Promise<void>) = streamChat
  ) {}

  get currentTurn(): Readonly<ActiveTurn> | null {
    return this.active;
  }

  // ── Fan-out helpers ────────────────────────────────────────

  private emit(event: unknown): void {
    this.sink.post(event);
  }

  private telemetry(kind: HostTelemetryEvent["kind"]): void {
    if (!this.active) return;
    const event: HostTelemetryEvent = {
      turnId: this.active.turnId,
      turnKind: this.active.turnKind,
      kind,
    };
    this.active.telemetryQueue.push(event);
    this.emit({ type: "TELEMETRY", event });
  }

  private noteFailure(modelId: string, err: unknown): void {
    if (isDailyCapFailure(err)) {
      this.telemetry({ type: "modelFailure", modelId, reason: "daily" });
      recordModelFailure(modelId, "daily");
    } else if (isRateLimitError(err)) {
      const headers = (err as OpenRouterError).rateLimitHeaders;
      this.telemetry({ type: "modelFailure", modelId, reason: "rate", headers });
      recordModelFailure(modelId, "rate", headers);
    } else {
      this.telemetry({ type: "modelFailure", modelId, reason: "hard" });
      recordModelFailure(modelId, "hard");
    }
  }

  // ── Turn lifecycle ─────────────────────────────────────────

  /** Starts a turn (no-op when one is already active) */
  startTurn(payload: HostStartTurnPayload): void {
    if (this.active) return;
    this.clearOrphanTimer();
    this.active = {
      turnId: payload.turnId,
      conversationId: payload.conversationId,
      startedAt: Date.now(),
      status: "starting",
      controller: new AbortController(),
      apiKey: payload.apiKey,
      systemPrompt: payload.systemPrompt,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      requestStateByModel:
        payload.requestStateByModel ??
        Object.fromEntries(
          payload.candidates
            .filter((c) => c.requestState && Object.keys(c.requestState).length > 0)
            .map((c) => [c.modelId, c.requestState!])
        ),
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
      telemetryQueue: [],
      turnKind: payload.turnKind ?? "analysis",
    };
    logTurnEvent({
      turnId: payload.turnId,
      conversationId: payload.conversationId,
      phase: "turn-start",
      detail: `${payload.candidates.length} candidates`,
    });
    // Fire-and-forget: the turn ends via endTurn() when the loop resolves
    void this.runTurnLoop();
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
    const current = this.active;
    if (!current || current.conversationId !== payload.conversationId) return;
    current.controller.abort();
    logTurnEvent({
      turnId: current.turnId,
      conversationId: current.conversationId,
      phase: "abort",
      detail: "replaced by re-sent turn after reload",
    });
    this.active = null;
    this.startTurn(payload);
  }

  abortTurn(turnId: string): void {
    if (this.active?.turnId !== turnId) return;
    this.active.controller.abort();
    logTurnEvent({ turnId, conversationId: this.active.conversationId, phase: "abort" });
    if (this.active.status === "reroute") {
      // The turn loop is parked waiting for candidates that a Stop
      // makes moot — end it here rather than leaving a zombie.
      this.endTurn(this.active, "aborted", this.active.winnerModelId ?? undefined);
    }
  }

  /** Replaces the candidate list mid-turn (client answered REROUTE) */
  addCandidates(turnId: string, candidates: HostCandidate[]): void {
    if (this.active?.turnId !== turnId) return;
    if (candidates.length === 0) {
      // The page has nothing left to offer — the whole pool failed.
      // Surface the underlying attempt error (rate limit, outage…)
      // so the user sees WHY, not a generic give-up message.
      const lastError = this.active.lastError;
      this.endTurn(
        this.active,
        "exhausted",
        this.active.winnerModelId ?? undefined,
        undefined,
        lastError ? new Error(lastError) : undefined
      );
      return;
    }
    // Fresh candidates carry their own capability-snapped state
    // (page-side resolution), so reroutes keep per-model tuning.
    for (const c of candidates) {
      if (c.requestState) {
        this.active.requestStateByModel = {
          ...this.active.requestStateByModel,
          [c.modelId]: c.requestState,
        };
      }
    }
    this.active.candidates = candidates;
    this.active.status = "streaming";
    logTurnEvent({ turnId, conversationId: this.active.conversationId, phase: "reroute", detail: `+${candidates.length} candidates` });
    void this.runTurnLoop();
  }

  /**
   * Snapshot for a (re)attaching page: buffered content, reasoning,
   * tool calls, and the seq boundary for delta replay.
   */
  snapshot() {
    const a = this.active;
    if (!a) {
      return {
        protocolVersion: 1,
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
      protocolVersion: 1,
      turnId: a.turnId,
      status: a.status,
      conversationId: a.conversationId,
      contentFromOffset: a.contentOffset,
      content: a.content,
      reasoning: a.reasoning,
      seq: a.seq,
    };
  }

  status() {
    return { hasTurn: this.active !== null, turnId: this.active?.turnId ?? null };
  }

  /** Page count changed — arm/disarm the orphan guard */
  setPageCount(count: number): void {
    if (count > 0) {
      this.clearOrphanTimer();
    } else if (this.active) {
      this.armOrphanGuard();
    }
  }

  private armOrphanGuard(): void {
    this.clearOrphanTimer();
    this.orphanTimer = setTimeout(() => {
      if (this.active && this.sink.pageCount === 0) {
        logTurnEvent({
          turnId: this.active.turnId,
          conversationId: this.active.conversationId,
          phase: "orphan-abort",
        });
        this.active.controller.abort();
      }
    }, HOST_ORPHAN_GRACE_MS);
  }

  private clearOrphanTimer(): void {
    if (this.orphanTimer !== null) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
    }
  }

  // ── The turn loop (candidate walk + hedge race) ────────────

  private async runTurnLoop(): Promise<void> {
    const turn = this.active;
    if (!turn || turn.status === "reroute") return;

    const startedAt = Date.now();
    // Bounded walk: without a cap a dead provider pool means minutes
    // of silent retrying before the turn says anything. The page is
    // asked for fresh candidates after this many distinct attempts.
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
      // Daily-cap accounting mirrors to the page (page-side router
      // owns persistence; host fires the event per attempt)
      this.telemetry({ type: "dailyRequest", modelId: candidate.modelId });

      try {
        await this.streamOneAttempt(turn, candidate.modelId, candidate.contextLength);
        // Stream completed without throwing. A completion that asked
        // for tools ends the host turn here — tool EXECUTION lives in
        // the page (workspace, preview, push gate), and the page's
        // agent loop starts the next host round with the results.
        // Attribution goes to the race winner, which may be a later
        // candidate in the pool when the hedge picked it.
        const winner = turn.winnerModelId ?? candidate.modelId;
        this.telemetry({ type: "modelSuccess", modelId: winner });
        recordModelSuccess(winner);
        if (turn.toolCalls.length > 0) {
          this.endTurn(turn, "tool-calls", winner, startedAt);
        } else {
          this.telemetry({ type: "turnSuccess", modelId: winner });
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
        this.noteFailure(candidate.modelId, err);
        logTurnEvent({
          turnId: turn.turnId,
          conversationId: turn.conversationId,
          phase: "failover",
          modelId: candidate.modelId,
          detail: err instanceof Error ? err.message : "unknown error",
        });
      }
    }

    // List exhausted: ask the page for fresh candidates (it owns the
    // learning router). turn.status = "reroute" pauses the loop.
    turn.status = "reroute";
    this.emit({ type: "REROUTE_NEEDED", turnId: turn.turnId, excluded: [...turn.excluded] });  }

  /**
   * Streams one candidate to completion (tool calls included in the
   * completion — tool EXECUTION stays in the page where the workspace
   * lives). Hedged race across the first two candidates.
   *
   * Pre-decision semantics mirror the in-page runner: before the race
   * picks a winner, each racer buffers privately; after the decision,
   * the winner's buffered text flushes and live chunks flow through.
   * The race's own callbacks (first-token detection) always receive
   * the raw chunks — dropping them would deadlock the decision loop.
   */
  private async streamOneAttempt(
    turn: ActiveTurn,
    modelId: string,
    contextLength?: number
  ): Promise<void> {
    // Hedge across the top two un-excluded candidates
    const pool = [modelId, ...turn.candidates.map((c) => c.modelId)].filter(
      (id, i, arr) => !turn.excluded.has(id) && arr.indexOf(id) === i
    );
    const racers = pool.slice(0, 2).map((id) => {
      const c = turn.candidates.find((x) => x.modelId === id);
      return { id, contextLength: c?.contextLength };
    });

    interface RaceCallbacks {
      onChunk: (text: string) => void;
      onReasoning: (text: string) => void;
      onToolCalls: (calls: unknown[]) => void;
      onUsage: (usage: UsageInfo) => void;
    }

    const buffers = new Map<
      string,
      { content: string; reasoning: string; toolCalls: unknown[] | null }
    >();

    const startOne = (
      id: string,
      signal: AbortSignal,
      cbs?: RaceCallbacks
    ): Promise<void> => {
      const buf = { content: "", reasoning: "", toolCalls: null as unknown[] | null };
      buffers.set(id, buf);
      return this.startStream({
        apiKey: turn.apiKey,
        model: id,
        messages: turn.messages as Parameters<typeof streamChat>[0]["messages"],
        systemPrompt: turn.systemPrompt,
        temperature: turn.temperature,
        maxTokens: contextLength
          ? Math.min(OUTPUT_RESERVE_TOKENS, Math.floor(contextLength * 0.1))
          : OUTPUT_RESERVE_TOKENS,
        tools: turn.tools as Parameters<typeof streamChat>[0]["tools"],
        requestUsage: true,
        requestState: turn.requestStateByModel?.[id],
        signal,
        onChunk: (chunk) => {
          buf.content += chunk;
          if (turn.winnerModelId === id) this.appendDelta(turn, id, { content: chunk });
          cbs?.onChunk(chunk);
        },
        onReasoning: (chunk) => {
          buf.reasoning += chunk;
          if (turn.winnerModelId === id) this.appendDelta(turn, id, { reasoning: chunk });
          cbs?.onReasoning(chunk);
        },
        onToolCalls: (calls) => {
          // A tool-call frame is often the model's FIRST frame — the
          // race may not have decided yet, so buffer per racer and
          // replay the winner's calls at decision time. Dropping them
          // here would silently turn an agentic turn into plain text.
          buf.toolCalls = calls;
          if (turn.winnerModelId === id) {
            turn.toolCalls = calls;
            this.emit({ type: "TOOL_CALLS", payload: { turnId: turn.turnId, calls } });
          }
          cbs?.onToolCalls(calls);
        },
        onUsage: (u) => {
          if (turn.winnerModelId === id) {
            turn.usage = u;
            this.emit({ type: "USAGE", turnId: turn.turnId, modelId: id, usage: u });
          }
          cbs?.onUsage(u);
        },
      });
    };

    if (racers.length === 1) {
      turn.winnerModelId = racers[0]!.id;
      turn.status = "streaming";
      await startOne(racers[0]!.id, turn.controller.signal);
      return;
    }

    // Hedged race (stream-race is DOM-free; failure memory stays host-local
    // and is mirrored to the page via telemetry)
    const race = await raceStreams({
      candidates: racers.map((r) => ({ id: r.id, name: r.id, contextLength: r.contextLength })),
      hedgeTriggerMs: HOST_HEDGE_TRIGGER_MS,
      makeController: () => {
        const c = new AbortController();
        // The outer signal may already be aborted (Stop pressed while
        // the previous candidate was in flight) — in that case the
        // listener below would never fire, so mirror it immediately.
        if (turn.controller.signal.aborted) c.abort();
        else turn.controller.signal.addEventListener("abort", () => c.abort(), { once: true });
        return c;
      },
      startStream: (model, signal, cbs) => startOne(model.id, signal, cbs),
      onDecided: (winner) => {
        turn.winnerModelId = winner.id;
        turn.status = "streaming";
        // Flush the winner's pre-decision buffer into the transcript
        const buf = buffers.get(winner.id);
        if (buf?.reasoning) this.appendDelta(turn, winner.id, { reasoning: buf.reasoning });
        if (buf?.content) this.appendDelta(turn, winner.id, { content: buf.content });
        if (buf?.toolCalls) {
          turn.toolCalls = buf.toolCalls;
          this.emit({
            type: "TOOL_CALLS",
            payload: { turnId: turn.turnId, calls: buf.toolCalls },
          });
        }
        logTurnEvent({
          turnId: turn.turnId,
          conversationId: turn.conversationId,
          phase: "race-decided",
          modelId: winner.id,
        });
      },
    });
    // The loser's "slow" signal mirrors to the page
    if (race.loser) {
      this.telemetry({ type: "modelFailure", modelId: race.loser.id, reason: "slow" });
    }
  }

  /** Buffered append + fan-out of one delta */
  private appendDelta(
    turn: ActiveTurn,
    modelId: string,
    delta: { content?: string; reasoning?: string }
  ): void {
    // Pre-decision hedge buffering: only the winner (or sole stream)
    // flows into the transcript; others are dropped on the floor.
    if (turn.winnerModelId !== modelId) return;
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
            }
          : undefined,
        latencyMs: startedAt ? Date.now() - startedAt : undefined,
      },
    });
    if (this.active === turn) this.active = null;
  }
}

/** Shape of an active turn exposed for tests (no AbortController) */
export type ActiveTurnSummary = Pick<
  ActiveTurn,
  "turnId" | "status" | "content" | "reasoning" | "excluded" | "winnerModelId"
>;
