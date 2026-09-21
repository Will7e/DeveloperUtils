// ============================================================
// Stream Race — Hedged Time-To-First-Token Racing
// ============================================================
// Free models are fast but their tail latency is terrible: a cold
// provider queue can leave the user staring at a spinner for tens
// of seconds. Hedged requests fix this: if the primary stream
// hasn't produced its first token within INTAB_HEDGE_TRIGGER_MS,
// the next-ranked pool model joins the race. The first stream to
// emit tokens wins; the loser is aborted and marked "slow".
//
// On free models the duplicated request costs ≈ 0, and research on
// hedged/TTFT-triggered racing shows large p95/p99 wins versus
// waiting out failures.
//
// Semantics:
//  - primary starts immediately; the hedge fires at the trigger
//    deadline OR immediately when the primary fails first (fail-fast)
//  - the first content/reasoning/tool-calls token decides the winner
//  - the loser's abort is local (per-stream controller), so the
//    user Stop button (outer signal) is unaffected
//  - a winner that fails mid-stream (after tokens) propagates the
//    error to the caller, which owns cross-model retry

import {
  INTAB_HEDGE_MAX_STREAMS,
  INTAB_HEDGE_TRIGGER_MS,
} from "../constants";
import { recordModelFailure } from "./intab-llm";
import type { ModelInfo, UsageInfo } from "../types";

export interface RaceStreamParams {
  /** Ranked candidates: [0] is primary, [1] is the hedge */
  candidates: ModelInfo[];
  /**
   * Starts one stream. Must respect `signal`. Resolves when the
   * stream completes; rejects on stream failure.
   */
  startStream: (
    model: ModelInfo,
    signal: AbortSignal,
    callbacks: {
      onChunk: (text: string) => void;
      onReasoning: (text: string) => void;
      onToolCalls: (calls: unknown[]) => void;
      onUsage: (usage: UsageInfo) => void;
    }
  ) => Promise<void>;
  /** Builds an AbortController per candidate (runner wires the outer signal) */
  makeController: () => AbortController;
  /**
   * Called the moment a winner is decided (first token), BEFORE its
   * stream completes — the runner attaches live rendering here.
   */
  onDecided?: (winner: ModelInfo) => void;
  /** Optional trigger override (tests) */
  hedgeTriggerMs?: number;
}

export interface RaceResult {
  /** The model whose stream won (first tokens) */
  winner: ModelInfo;
  /** True when the hedge joined (and won, or primary died pre-token) */
  hedged: boolean;
  /** The model that lost the race (aborted, marked slow) */
  loser?: ModelInfo;
}

interface RunState {
  model: ModelInfo;
  controller: AbortController;
  promise: Promise<void>;
  /** Resolves true on first token, false when the stream ends tokenless */
  firstToken: Promise<boolean>;
  /** Error captured from a rejected stream (for rethrow) */
  error?: unknown;
  readonly hasToken: () => boolean;
  readonly isSettled: () => boolean;
}

/**
 * Races up to INTAB_HEDGE_MAX_STREAMS models for time-to-first-token.
 * Returns the winner; aborts and marks the loser slow.
 */
export async function raceStreams(params: RaceStreamParams): Promise<RaceResult> {
  const { candidates, startStream, makeController } = params;
  const triggerMs = params.hedgeTriggerMs ?? INTAB_HEDGE_TRIGGER_MS;
  const roster = candidates.slice(0, Math.max(1, INTAB_HEDGE_MAX_STREAMS));

  // Single candidate: no race, straight through
  if (roster.length === 1) {
    const only = startOne(roster[0]!, makeController(), startStream);
    await only.promise;
    return { winner: only.model, hedged: false };
  }

  const primary = startOne(roster[0]!, makeController(), startStream);

  let hedge: RunState | null = null;
  let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

  // All racers currently in the token race, in start order.
  const racers: RunState[] = [primary];

  // Wake-signal loop state: every racer settlement (first token OR
  // tokenless end) and every hedge start bumps the loop, which then
  // re-derives its decision from racer state. Deciding from state
  // (not from which promise resolved) makes lost or coalesced wakes
  // harmless, and a hedge that tokens first wins the race.
  let wake: (() => void) | undefined;
  let wakePromise: Promise<void> = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const bump = () => {
    const current = wake;
    wakePromise = new Promise<void>((resolve) => {
      wake = resolve;
    });
    current?.();
  };

  const fireHedge = () => {
    if (hedge) return;
    hedge = startOne(roster[1]!, makeController(), startStream);
    void hedge.firstToken.then(bump);
    racers.push(hedge);
    bump(); // let a pending decision pass see the new racer
  };

  void primary.firstToken.then(bump);
  hedgeTimer = setTimeout(fireHedge, triggerMs);

  try {
    // Decision: wait until some racer produces a first token.
    // Tokenless settlements fail-fast the hedge; if every racer dies
    // tokenless, rethrow so the candidate walk can try the next
    // model. (The all-racers-fail path is regression-tested — an
    // earlier version spun forever re-awaiting dead racers.)
    let winner: RunState | null = null;
    while (winner === null) {
      await wakePromise;
      if (racers.some((r) => r.hasToken())) {
        // Prefer the earlier-ranked racer when both tokened.
        winner = racers.find((r) => r.hasToken()) ?? racers[0]!;
        break;
      }
      // A caller-initiated abort (Stop button, turned-off page) must
      // not launch a fresh hedge: the outer signal is already aborted,
      // so the new stream would run to completion un-cancelled and
      // hold the turn open forever.
      if (primary.controller.signal.aborted) {
        throw primary.error ?? new Error("Race aborted before first token.");
      }
      // Nobody tokened yet: fail-fast the hedge, drop settled-
      // tokenless racers, and re-examine on the next wake.
      fireHedge();
      for (let i = racers.length - 1; i >= 0; i--) {
        const r = racers[i]!;
        if (r.isSettled() && !r.hasToken()) racers.splice(i, 1);
      }
      if (racers.length === 0) {
        // TS can't see fireHedge's closure assignment to `hedge`, so
        // read its error through an explicit cast.
        const hedgeState = hedge as RunState | null;
        const err =
          primary.error ??
          hedgeState?.error ??
          new Error("All race streams failed before first token.");
        throw err;
      }
    }

    // Stop + mark the loser
    const loser = winner === primary ? hedge : primary;
    if (loser && !loser.hasToken() && !loser.isSettled()) {
      recordModelFailure(loser.model.id, "slow");
      try {
        loser.controller.abort();
      } catch {
        /* abort is best-effort */
      }
    }

    // Hand the winner to the runner before its stream completes
    params.onDecided?.(winner.model);

    // Winner's stream runs to completion (errors propagate)
    await winner.promise;
    return {
      winner: winner.model,
      hedged: hedge !== null,
      loser: loser?.model,
    };
  } finally {
    if (hedgeTimer !== null) clearTimeout(hedgeTimer);
    // Any still-running stream when we exit must be stopped
    for (const run of [primary, hedge]) {
      if (run && !run.isSettled()) {
        try {
          run.controller.abort();
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

/** Starts one stream, capturing its first-token promise and error */
function startOne(
  model: ModelInfo,
  controller: AbortController,
  startStream: RaceStreamParams["startStream"]
): RunState {
  let resolveFirstToken: (v: boolean) => void = () => {};
  const firstToken = new Promise<boolean>((resolve) => {
    resolveFirstToken = resolve;
  });

  let gotToken = false;
  let settled = false;
  let error: unknown;

  const state: RunState = {
    model,
    controller,
    promise: null as unknown as Promise<void>,
    firstToken,
    error: undefined,
    hasToken: () => gotToken,
    isSettled: () => settled,
  };

  const callbacks = {
    onChunk: (text: string) => {
      if (text && !gotToken) {
        gotToken = true;
        resolveFirstToken(true);
      }
    },
    onReasoning: (text: string) => {
      if (text && !gotToken) {
        gotToken = true;
        resolveFirstToken(true);
      }
    },
    onToolCalls: () => {
      if (!gotToken) {
        gotToken = true;
        resolveFirstToken(true);
      }
    },
    onUsage: () => {
      /* usage frames don't decide the race */
    },
  };

  state.promise = startStream(model, controller.signal, callbacks)
    .then(() => {
      settled = true;
      if (!gotToken) resolveFirstToken(false);
    })
    .catch((err) => {
      settled = true;
      error = err;
      state.error = err;
      if (!gotToken) resolveFirstToken(false);
      throw err;
    });

  // The runner awaits the winner's promise; a rejected loser promise
  // is intentionally left unhandled here to avoid a process-level
  // unhandled rejection while we await the winner instead.
  state.promise.catch(() => {});

  return state;
}
