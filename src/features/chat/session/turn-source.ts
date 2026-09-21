// ============================================================
// Turn Source — Where a Turn's Stream Actually Runs
// ============================================================
// The engine (turn-engine.ts) is transport-agnostic: it prepares a
// turn, starts it on a TurnSource, renders the events, executes
// tools between rounds, and commits. Two sources exist:
//
//  - HostTurnSource  — the SharedWorker session host. Survives page
//    reloads and SPA navigation (the whole point of the feature).
//  - LocalTurnSource — a page-local HostTurnController. Used when
//    SharedWorker is unavailable (Safari) or when the host refuses
//    or dies. Identical semantics, weaker guarantee: the stream
//    dies with the page, which is exactly what resume covers.
//
// Both drive the SAME HostTurnController state machine and emit the
// SAME HostEvent stream, so the renderer, tool loop, telemetry, and
// commit rules are written once.

import { HostTurnController } from "./host-controller";
import type { SessionHostClient, StartOutcome } from "./session-client";
import type {
  HostCandidate,
  HostEvent,
  HostSnapshot,
  HostStartTurnPayload,
} from "./protocol";

export type { StartOutcome };

/** Injectable stream function (tests replace the network call) */
export type SourceStreamFn = ConstructorParameters<typeof HostTurnController>[1];

export interface TurnSource {
  /** True when the stream outlives the calling page (worker-owned) */
  readonly survivable: boolean;
  readonly label: "host" | "local";
  startTurn(payload: HostStartTurnPayload): Promise<StartOutcome>;
  subscribe(listener: (event: HostEvent) => void): () => void;
  sendReroute(turnId: string, candidates: HostCandidate[]): void;
  abortTurn(turnId: string): void;
}

/** The SharedWorker-backed source (reload-surviving) */
export class HostTurnSource implements TurnSource {
  readonly survivable = true;
  readonly label = "host" as const;

  constructor(private readonly client: SessionHostClient) {}

  startTurn(payload: HostStartTurnPayload): Promise<StartOutcome> {
    return this.client.startTurn(payload);
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    return this.client.subscribe(listener);
  }

  sendReroute(turnId: string, candidates: HostCandidate[]): void {
    this.client.sendReroute(turnId, candidates);
  }

  abortTurn(turnId: string): void {
    this.client.abortTurn(turnId);
  }

  /** Current host snapshot (adoption of a live turn after reload) */
  fetchSnapshot(): Promise<HostSnapshot | null> {
    return this.client.fetchSnapshot();
  }
}

/**
 * The page-local source: runs the same controller in this document.
 *
 * `pageCount` is pinned at 1 because the orphan guard exists to stop
 * a *worker* stream nobody renders — a page-local stream dies with
 * the page by construction, so there is nothing to guard.
 */
export class LocalTurnSource implements TurnSource {
  readonly survivable = false;
  readonly label = "local" as const;

  private readonly controller: HostTurnController;
  private readonly listeners = new Set<(event: HostEvent) => void>();

  constructor(streamFn?: SourceStreamFn) {
    this.controller = new HostTurnController(
      {
        post: (event) => {
          for (const listener of [...this.listeners]) {
            try {
              listener(event as HostEvent);
            } catch {
              /* listener isolation — one bad renderer can't break the turn */
            }
          }
        },
        get pageCount() {
          return 1;
        },
      },
      streamFn
    );
  }

  async startTurn(payload: HostStartTurnPayload): Promise<StartOutcome> {
    this.controller.startTurn(payload);
    return { kind: "started", snapshot: this.controller.snapshot() };
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  sendReroute(turnId: string, candidates: HostCandidate[]): void {
    this.controller.addCandidates(turnId, candidates);
  }

  abortTurn(turnId: string): void {
    this.controller.abortTurn(turnId);
  }

  /** Live turn state (tests + stop routing) */
  get currentTurn() {
    return this.controller.currentTurn;
  }
}
