// ============================================================
// Turn Log — In-Memory Ring Buffer of Turn Lifecycle Events
// ============================================================
// Enterprise observability for the session layer: every turn start,
// model attempt, failover, resume, watchdog firing, and orphan
// abort lands here with a timestamp. Bounded (ring buffer) so a
// long-lived session can't grow it forever. Exported from the dev
// console via window.__intabTurnLog for debugging.

export type TurnLogPhase =
  | "turn-start"
  | "model-attempt"
  | "model-failure"
  | "failover"
  | "race-decided"
  | "stream-end"
  | "tool-phase"
  | "completion-gate"
  | "resume"
  | "orphan-abort"
  | "reroute"
  | "abort"
  | "error";

export interface TurnLogEntry {
  at: number;
  turnId: string | null;
  conversationId: string | null;
  phase: TurnLogPhase;
  /** Model id when the phase concerns a specific model */
  modelId?: string;
  /** Short human-readable detail (failure kind, resume reason…) */
  detail?: string;
}

const RING_CAPACITY = 500;
const ring: TurnLogEntry[] = [];
let ringStart = 0;
const subscribers = new Set<(entry: TurnLogEntry) => void>();

/**
 * Mirrors every entry to a listener. The session host (SharedWorker)
 * uses this to forward its own log to the pages — the interesting
 * events (model attempts, failover, race decisions, orphan aborts)
 * happen in the worker, and a debugger without them only sees the
 * half of the turn that went right.
 */
export function subscribeTurnLog(listener: (entry: TurnLogEntry) => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/** Appends one entry; evicts the oldest when the ring is full */
export function logTurnEvent(
  entry: Omit<TurnLogEntry, "at"> & { at?: number }
): void {
  const full: TurnLogEntry = { at: entry.at ?? Date.now(), ...entry };
  for (const listener of [...subscribers]) {
    try {
      listener(full);
    } catch {
      /* a bad log consumer must not break a turn */
    }
  }
  if (ring.length < RING_CAPACITY) {
    ring.push(full);
  } else {
    ring[ringStart] = full;
    ringStart = (ringStart + 1) % RING_CAPACITY;
  }
}

/** Chronological snapshot of the ring (oldest first) */
export function getTurnLog(): TurnLogEntry[] {
  if (ring.length < RING_CAPACITY) return [...ring];
  return [...ring.slice(ringStart), ...ring.slice(0, ringStart)];
}

/** Clears the log (tests) */
export function resetTurnLog(): void {
  ring.length = 0;
  ringStart = 0;
}

// Debug handle: the session layer spans a page, a SharedWorker, and a
// fallback path, so "what actually happened to my turn" has to be
// answerable from the console. Page-side only (the worker has its own
// module instance and no window).
if (typeof window !== "undefined") {
  (window as unknown as { __intabTurnLog?: unknown }).__intabTurnLog = {
    entries: getTurnLog,
    print: () => formatTurnLog(),
    clear: resetTurnLog,
  };
}

/** Formats the log as an readable multi-line string (console export) */
export function formatTurnLog(): string {
  return getTurnLog()
    .map((e) => {
      const t = new Date(e.at).toISOString().slice(11, 23);
      const model = e.modelId ? ` [${e.modelId}]` : "";
      const detail = e.detail ? ` ${e.detail}` : "";
      const conv = e.conversationId ? ` conv=${e.conversationId.slice(0, 8)}` : "";
      const turn = e.turnId ? ` turn=${e.turnId.slice(0, 8)}` : "";
      return `${t}${turn}${conv} ${e.phase}${model}${detail}`;
    })
    .join("\n");
}
